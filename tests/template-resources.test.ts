import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckProvider, LanguageRequest, WorkspaceReader } from '../src/api';
import { templateFileDiagnostics, provideFileDefinition } from '../src/languages/wxml/file-definition';
import { createWxmlPlugin } from '../src/languages/wxml';
import { checkWorkspace } from '../src/core/workspace-check';
import { createNavigationTracking } from '../src/adapters/vscode/navigation-tracking';

/** 只读快照模拟磁盘及草稿，读取次数用于核对同次检查是否重复访问资源。 */
function fixture(text: string, files: Record<string, string> = {}, root = 'file:///resources/') {
  const uri = new URL('page.wxml', root).href;
  const documents = new Map(Object.entries({ 'page.wxml': text, ...files }).map(([name, source]) => [new URL(name, root).href, source]));
  const reads = new Map<string, number>();
  const reader: WorkspaceReader = { root: () => root, read: async (target) => {
    reads.set(target, (reads.get(target) ?? 0) + 1);
    const source = documents.get(target);
    return source === undefined ? undefined : { text: source, version: 7 };
  } };
  const request: LanguageRequest = { document: { uri, text, languageId: 'wxml', version: 3 }, offset: 0, cancellation: { isCancellationRequested: false } };
  return { reader, request, documents, reads };
}

test('资源诊断与跳转共享模板、目录入口和 WXS 的真实路径规则', async () => {
  const graph = fixture('<import src="./shared"/><include src="./folder"/><wxs module="math" src="./math.wxs"/><include src="./missing.wxml"/><wxs module="lost" src="./lost.wxs"/>', {
    'shared.wxml': '<template name="shared"/>', 'folder/index.wxml': '', 'math.wxs': 'module.exports={};',
  });
  const findings = await templateFileDiagnostics(graph.request, graph.reader);
  assert.deepEqual(findings.map((item) => graph.request.document.text.slice(item.range.start, item.range.end)), ['./missing.wxml', './lost.wxs']);
  assert.ok(findings.every((item) => item.code === 'template-resource'));
  const offset = graph.request.document.text.indexOf('./folder');
  const definitions = await provideFileDefinition({ ...graph.request, offset }, graph.reader);
  assert.equal(definitions[0]!.uri, 'file:///resources/folder/index.wxml');
  assert.equal(definitions[0]!.version, 7);
});

test('动态、外部引用、注释和内联脚本伪标签不产生缺失资源诊断', async () => {
  const graph = fixture('<!-- <include src="./comment.wxml"/> --><include src="{{templatePath}}"/><include src="https://example.com/template.wxml"/><wxs module="external" src="plugin://module/main.wxs"/><wxs module="inline">var source=\'<include src="./fake.wxml"/>\';module.exports={};</wxs>');
  assert.deepEqual(await templateFileDiagnostics(graph.request, graph.reader), []);
  assert.equal(graph.reads.size, 0);
  const untitled = { ...graph.request, document: { ...graph.request.document, uri: 'untitled:page.wxml', text: '<include src="./shared.wxml"/>' } };
  assert.deepEqual(await templateFileDiagnostics(untitled, graph.reader), []);
});

test('重复正向与负向引用共用读取，后续创建或删除资源会重新核验', async () => {
  const graph = fixture('<include src="./shared.wxml"/>'.repeat(12), { 'shared.wxml': '<view/>' });
  assert.deepEqual(await templateFileDiagnostics(graph.request, graph.reader), []);
  const target = 'file:///resources/shared.wxml';
  assert.equal(graph.reads.get(target), 1);
  graph.documents.delete(target); graph.reads.clear();
  assert.equal((await templateFileDiagnostics(graph.request, graph.reader)).length, 12);
  assert.equal(graph.reads.get(target), 1);
  graph.documents.set(target, '<text/>');
  assert.deepEqual(await templateFileDiagnostics(graph.request, graph.reader), []);
});

test('远程工作区别名沿注入解析器定位，单次检查只创建一个路径上下文', async () => {
  const graph = fixture('<include src="@views/card"/><include src="@views/card"/>', { 'actual/card.wxml': '<view/>' }, 'vscode-remote://ssh-remote+demo/project%20space/');
  let contexts = 0;
  const reader: WorkspaceReader = { ...graph.reader, fileResolver: () => {
    contexts++;
    return { candidates: async () => [new URL('actual/card.wxml', graph.reader.root(graph.request.document.uri)!).href] };
  } };
  assert.deepEqual(await templateFileDiagnostics(graph.request, reader), []);
  assert.equal(contexts, 1);
  assert.equal([...graph.reads.values()].reduce((sum, count) => sum + count, 0), 1);
});

test('资源检查在取消后丢弃结果，不继续生成部分诊断', async () => {
  const graph = fixture('<include src="./first.wxml"/><include src="./second.wxml"/>');
  const token = { isCancellationRequested: false };
  graph.reader.read = async () => { token.isCancellationRequested = true; return undefined; };
  assert.deepEqual(await templateFileDiagnostics({ ...graph.request, cancellation: token }, graph.reader), []);
  const untouched = fixture('<include src="./missing.wxml"/>');
  assert.deepEqual(await templateFileDiagnostics({ ...untouched.request, cancellation: token }, untouched.reader), []);
  assert.equal(untouched.reads.size, 0);
});

test('未打开模板复用实时资源诊断，扫描超限明确报告未完成', async () => {
  for (const count of [1, 2001]) {
    const graph = fixture('<include src="./missing.wxml"/>'.repeat(count));
    const navigation = createNavigationTracking();
    const reader = { ...graph.reader, navigation };
    const plugin = createWxmlPlugin(undefined, undefined, undefined, undefined, reader);
    const features = plugin.setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
    const provider: CheckProvider = { id: plugin.id, name: plugin.displayName, languages: plugin.languages, active: () => true, provide: features.diagnostics!.provide };
    try {
      const result = await checkWorkspace(reader, [{ uri: graph.request.document.uri, languageId: 'wxml' }], [provider], { cancellation: graph.request.cancellation });
      assert.equal(result.report.status, count === 1 ? 'complete' : 'incomplete');
      assert.equal(result.report.findings.length, Math.min(count, 2000));
      assert.ok(result.report.findings.every((item) => item.code === 'template-resource'));
      if (count > 2000) assert.ok(result.report.issues.some((item) => item.message.includes('两千')));
    } finally { navigation.dispose(); }
  }
});
