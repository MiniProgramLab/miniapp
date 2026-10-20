import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { ScriptProject } from '../src/languages/typescript/project';

test('脚本图复用减少读取，依赖草稿和缺失文件创建会使缓存失效', async () => {
  const root = 'file:///performance/';
  const documents = new Map([
    [root + 'page.ts', `import {shared} from './shared';Page({data:{shared}});`],
    [root + 'shared.ts', `export const shared={title:'甲'};`],
  ]);
  const versions = new Map<string, number>();
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0), read: async (uri) => {
    reads++; const text = documents.get(uri); return text === undefined ? undefined : { text };
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{shared.title}}', version: 1, languageId: 'wxml' }, offset: 5, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  assert.ok(first);
  const firstReads = reads;
  const warm = await new ScriptProject(reader, { ...request, document: { ...request.document, text: '{{shared.}}', version: 2 } }, {}).create();
  assert.equal(warm!.program, first.program, '模板编辑不重建未变化的脚本图');
  assert.equal(reads, firstReads, '缓存命中不重复读取依赖及路径探测');
  documents.set(root + 'shared.ts', `export const shared={updated:true};`);
  versions.set(root + 'shared.ts', 1);
  const changed = await new ScriptProject(reader, request, {}).create();
  assert.notEqual(changed!.program, first.program);
  assert.match(changed!.program.getSourceFile(root + 'shared.ts')!.text, /updated/);
  documents.set(root + 'tsconfig.json', '{"compilerOptions":{"strict":true}}');
  versions.set(root + 'tsconfig.json', 1);
  const configured = await new ScriptProject(reader, request, {}).create();
  assert.notEqual(configured!.program, changed!.program, '之前不存在的配置也是缓存依赖');
  assert.equal(configured!.program.getCompilerOptions().strict, true);
});

test('无修订端口、已取消请求及不同解析设置不复用旧图', async () => {
  const uri = 'vscode-remote://ssh-remote+test/project/page.ts';
  let text = 'Page({data:{old:true}});';
  const reader: WorkspaceReader = { root: () => new URL('./', uri).href, read: async (target) => target === uri ? { text } : undefined };
  const request: LanguageRequest = { document: { uri: uri.replace('.ts', '.wxml'), text: '{{old}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  text = 'Page({data:{newer:true}});';
  const next = await new ScriptProject(reader, request, {}).create();
  assert.match(next!.entry.text, /newer/);
  assert.notEqual(first!.program, next!.program);
  const cachedReader = { ...reader, revision: () => '0' };
  const configured = await new ScriptProject(cachedReader, request, { maxFiles: 2 }).create();
  const other = await new ScriptProject(cachedReader, request, { maxFiles: 20 }).create();
  assert.notEqual(configured!.program, other!.program);
  assert.equal(await new ScriptProject(cachedReader, { ...request, cancellation: { isCancellationRequested: true } }, {}).create(), undefined);
});

test('目录探测发现循环模块并排除缺失目录，超出文件预算的图不进入缓存', async () => {
  const root = 'file:///directory/';
  const files = new Map([[root + 'page.ts', `import {shared} from './lib/shared';import absent from './missing/entry';Page({data:{shared}});`], [root + 'lib/shared.ts', `export const shared={title:'甲'};`]]);
  let probes = 0;
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', directory: async (uri) => {
    probes++; return [...files.keys()].some((file) => file.startsWith(uri.replace(/\/?$/, '/')));
  }, read: async (uri) => { const text = files.get(uri); return text === undefined ? undefined : { text }; } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{shared.title}}', languageId: 'wxml', version: 1 }, offset: 3, cancellation: { isCancellationRequested: false } };
  const project = new ScriptProject(reader, request, { maxFiles: 20 });
  const complete = await project.create();
  assert.ok(complete!.program.getSourceFile(root + 'lib/shared.ts'));
  assert.equal(project.exhausted, false);
  assert.ok(probes > 0);
  const bounded = new ScriptProject(reader, request, { maxFiles: 1 });
  const first = await bounded.create();
  assert.equal(bounded.exhausted, true);
  const repeated = await new ScriptProject(reader, request, { maxFiles: 1 }).create();
  assert.notEqual(first!.program, repeated!.program, '超预算查询不能伪装为完整缓存命中');
});
