import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createFileOperations, createProjectFileResolver } from '../src/resolution';
import { templateFileReferences } from '../src/languages/wxml';
import { createCssModule } from '../src/languages/css';

/** 内存文件验证真实路径规则，业务工程始终只读。 */
function fixture(files: Record<string, string>, entry = 'page/index.wxml', maxFiles = 5000) {
  const root = 'file:///workspace/';
  const documents = new Map(Object.entries(files).map(([name, text]) => [root + name, { text, version: 1 }]));
  const reader: WorkspaceReader = { root: () => root, read: async (uri) => documents.get(uri), findFiles: async (_uri, _pattern, limit) => [...documents.keys()].slice(0, limit), fileResolver: (uri, cancellation) => createProjectFileResolver(reader, uri, cancellation) };
  const css = createCssModule(reader);
  const operations = createFileOperations(reader, (request) => request.document.languageId === 'wxml' ? templateFileReferences(request) : /^(?:wxss|scss|less|css)$/.test(request.document.languageId) ? css.references(request) : [], () => ({ maxFiles }));
  const request: LanguageRequest = { document: { uri: root + entry, text: files[entry] ?? '', version: 1, languageId: 'wxml' }, offset: 0, cancellation: { isCancellationRequested: false } };
  return { operations, request, documents, root };
}

test('关联文件列出模板、脚本、配置与实际样式导入，当前文件不重复', async () => {
  const graph = fixture({ 'page/index.wxml': '<view/>', 'page/index.ts': "import './styles.scss';Page({});", 'page/index.json': '{}', 'page/styles.scss': '.page{}' });
  const files = await graph.operations.related(graph.request);
  assert.deepEqual(files.map((file) => [file.uri.slice(graph.root.length), file.kind]), [['page/index.ts', 'script'], ['page/styles.scss', 'style'], ['page/index.json', 'configuration']]);
});

test('移动组件目录联动入站注册及出站模板和样式，普通文本保持原文', async () => {
  const graph = fixture({ 'page/index.wxml': '<card/>', 'page/index.json': '{"usingComponents":{"card":"../card"},"description":"../card"}', 'card/index.ts': "import '../shared/colors.scss';Component({});", 'card/index.wxml': '<include src="../shared/body.wxml"/><!-- <include src="../card/index.wxml"/> -->', 'shared/body.wxml': '<view/>', 'shared/colors.scss': '.page{}' });
  const edits = await graph.operations.rename(graph.request, [{ oldUri: graph.root + 'card', newUri: graph.root + 'widgets/panel' }]);
  assert.deepEqual(edits.map((edit) => [edit.uri.slice(graph.root.length), edit.oldText, edit.newText]).sort(), [['card/index.ts', '../shared/colors.scss', '../../shared/colors.scss'], ['card/index.wxml', '../shared/body.wxml', '../../shared/body.wxml'], ['page/index.json', '../card', '../widgets/panel']].sort());
});

test('WXS require 与模板 src 随文件改名更新，普通 TS 导入交给编辑器', async () => {
  const graph = fixture({ 'page/index.wxml': '<wxs module="utils" src="../utils.wxs"/>', 'utils.wxs': "var other=require('./value');module.exports=other;", 'value.wxs': 'module.exports=1;', 'page/index.ts': "import model from '../model';Page({});", 'model.ts': 'export default {}' });
  const edits = await graph.operations.rename(graph.request, [{ oldUri: graph.root + 'utils.wxs', newUri: graph.root + 'format.wxs' }, { oldUri: graph.root + 'value.wxs', newUri: graph.root + 'shared/value.wxs' }, { oldUri: graph.root + 'model.ts', newUri: graph.root + 'state.ts' }]);
  assert.deepEqual(edits.map((edit) => [edit.oldText, edit.newText]), [['../utils.wxs', '../format.wxs'], ['./value', './shared/value']]);
});

test('样式别名、Sass 部分文件与模块后缀保留引用风格', async () => {
  const graph = fixture({ 'page/index.wxml': '<view/>', 'page/index.scss': '@use "@styles/tokens" as *;', 'styles/_tokens.scss': '$brand:red;', 'page/index.ts': "import '@styles/_tokens.scss?inline';", 'tsconfig.json': '{"compilerOptions":{"paths":{"@styles/*":["styles/*"]}}}' });
  const edits = await graph.operations.rename(graph.request, [{ oldUri: graph.root + 'styles/_tokens.scss', newUri: graph.root + 'styles/_palette.scss' }]);
  assert.deepEqual(edits.map((edit) => [edit.oldText, edit.newText]).sort(), [['@styles/tokens', '@styles/palette'], ['@styles/_tokens.scss?inline', '@styles/_palette.scss?inline']].sort());
});

test('动态模板、普通对象及相似目录不会被字符串替换，取消或预算不足不返回部分编辑', async () => {
  const graph = fixture({ 'page/index.wxml': '<include src="{{path}}"/><view title="../card/index.wxml"/>', 'card/index.wxml': '<view/>', 'card-extra/index.wxml': '<view/>', 'page/index.json': '{"usingComponents":{"other":"../card-extra"}}' });
  assert.deepEqual(await graph.operations.rename(graph.request, [{ oldUri: graph.root + 'card', newUri: graph.root + 'panel' }]), []);
  assert.deepEqual(await graph.operations.rename({ ...graph.request, cancellation: { isCancellationRequested: true } }, [{ oldUri: graph.root + 'card', newUri: graph.root + 'panel' }]), []);
  const limited = fixture({ 'page/index.wxml': '<view/>', 'card/index.ts': 'Component({});' }, undefined, 1);
  await assert.rejects(() => limited.operations.rename(limited.request, [{ oldUri: limited.root + 'card', newUri: limited.root + 'panel' }]), /预算/);
});

test('Sass 文件改名保留原有隐式命名空间，显式别名不重复添加', async () => {
  const graph = fixture({ 'page/index.wxml': '<view/>', 'page/index.scss': '@use "../styles/tokens"; .page{color:tokens.$brand}', 'page/explicit.scss': '@use "../styles/tokens" as theme; .page{color:theme.$brand}', 'styles/_tokens.scss': '$brand:red;' });
  const edits = await graph.operations.rename(graph.request, [{ oldUri: graph.root + 'styles/_tokens.scss', newUri: graph.root + 'styles/_palette.scss' }]);
  assert.equal(edits.filter((edit) => edit.newText === ' as tokens').length, 1);
  assert.ok(edits.every((edit) => !edit.newText.includes('as theme')));
  assert.equal(edits.find((edit) => edit.newText === ' as tokens')?.range.start, graph.documents.get(graph.root + 'page/index.scss')!.text.indexOf(';'));
});
