import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { importIndex, importKey } from '../src/languages/typescript/import-index';
import { createProjectFileResolver } from '../src/resolution';

/** 目录集合与文件修订可独立变化，读取量验证增量更新而非只核对缓存标签。 */
function fixture(files: Record<string, string>) {
  const root = 'file:///workspace/';
  const documents = new Map(Object.entries(files).map(([name, text]) => [root + name, text]));
  const revisions = new Map<string, number>();
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(revisions.get(uri) ?? 0), read: async (uri) => { reads++; const text = documents.get(uri); return text === undefined ? undefined : { text }; }, findFiles: async (_uri, _pattern, limit) => [...documents.keys()].filter((uri) => /\.(?:[cm]?[jt]sx?|wxs|wxml)$/.test(uri)).slice(0, limit), fileResolver: (uri, cancellation) => createProjectFileResolver(reader, uri, cancellation) };
  const request: LanguageRequest = { document: { uri: root + 'entry.wxml', text: '<view/>', languageId: 'wxml', version: 1 }, offset: 0, cancellation: { isCancellationRequested: false } };
  return { request, reader, documents, revisions, reads: () => reads, root };
}

test('反向导入索引复用未变文件，修改一份源码只重新读取该记录', async () => {
  const graph = fixture({ 'first.ts': "import shared from './shared';", 'second.ts': "export {default} from './shared';", 'shared.ts': 'export default {};', 'other.ts': 'export default {};' });
  const first = await importIndex(graph.reader, graph.request);
  assert.deepEqual([...first!.reverse.get(importKey(graph.root + 'shared.ts'))!].sort(), [graph.root + 'first.ts', graph.root + 'second.ts']);
  const before = graph.reads();
  await importIndex(graph.reader, { ...graph.request });
  assert.equal(graph.reads(), before);
  graph.documents.set(graph.root + 'first.ts', "import shared from './other';"); graph.revisions.set(graph.root + 'first.ts', 1);
  const changed = await importIndex(graph.reader, { ...graph.request });
  assert.equal(graph.reads(), before + 1);
  assert.deepEqual([...changed!.reverse.get(importKey(graph.root + 'shared.ts'))!], [graph.root + 'second.ts']);
  assert.deepEqual([...changed!.reverse.get(importKey(graph.root + 'other.ts'))!], [graph.root + 'first.ts']);
});

test('新增与删除记录更新反向关系，配置别名变化会重新解析相关路径', async () => {
  const graph = fixture({ 'entry.ts': "import value from '@shared';", 'one.ts': 'export default {};', 'two.ts': 'export default {};', 'tsconfig.json': '{"compilerOptions":{"paths":{"@shared":["one.ts"]}}}' });
  const first = await importIndex(graph.reader, graph.request);
  assert.ok(first!.reverse.get(importKey(graph.root + 'one.ts'))!.has(graph.root + 'entry.ts'));
  graph.documents.set(graph.root + 'tsconfig.json', '{"compilerOptions":{"paths":{"@shared":["two.ts"]}}}'); graph.revisions.set(graph.root + 'tsconfig.json', 1);
  graph.documents.set(graph.root + 'created.ts', "import value from './two';");
  graph.documents.delete(graph.root + 'one.ts');
  const changed = await importIndex(graph.reader, { ...graph.request });
  assert.ok(changed!.reverse.get(importKey(graph.root + 'two.ts'))!.has(graph.root + 'entry.ts'));
  assert.ok(changed!.reverse.get(importKey(graph.root + 'two.ts'))!.has(graph.root + 'created.ts'));
  assert.ok(!changed!.files.includes(graph.root + 'one.ts'));
});

test('取消与预算保护不返回不完整图，没有修订端口时不复用旧记录', async () => {
  const graph = fixture({ 'one.ts': "import value from './two';", 'two.ts': 'export default {};' });
  assert.equal(await importIndex(graph.reader, { ...graph.request, cancellation: { isCancellationRequested: true } }), undefined);
  await assert.rejects(() => importIndex(graph.reader, graph.request, 1), /扫描上限/);
  const { revision: _revision, ...reader } = graph.reader;
  await importIndex(reader, graph.request);
  const before = graph.reads(); await importIndex(reader, { ...graph.request });
  assert.ok(graph.reads() > before);
});

test('WXS require 进入同一反向索引并按实际文件修订增量失效', async () => {
  const graph = fixture({ 'entry.wxs': 'module.exports=require("./bridge.wxs");', 'bridge.wxs': 'module.exports=require("./core.wxs");', 'core.wxs': 'module.exports={};', 'other.wxs': 'module.exports={};' });
  const first = await importIndex(graph.reader, graph.request);
  assert.ok(first!.reverse.get(importKey(graph.root + 'core.wxs'))?.has(graph.root + 'bridge.wxs'));
  const before = graph.reads();
  await importIndex(graph.reader, graph.request);
  assert.equal(graph.reads(), before);
  graph.documents.set(graph.root + 'bridge.wxs', 'module.exports=require("./other.wxs");'); graph.revisions.set(graph.root + 'bridge.wxs', 1);
  const changed = await importIndex(graph.reader, graph.request);
  assert.equal(graph.reads(), before + 1);
  assert.ok(!changed!.reverse.has(importKey(graph.root + 'core.wxs')));
  assert.ok(changed!.reverse.get(importKey(graph.root + 'other.wxs'))?.has(graph.root + 'bridge.wxs'));
});
