import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createCssModule } from '../src/languages/css';
import { componentStyles } from '../src/languages/wxml/component-styles';

/** 样式与模板来自可更新的只读快照，记录请求内重复读取。 */
function fixture(text: string, files: Record<string, string> = {}, maxFiles?: number) {
  const documents = new Map(Object.entries({ 'app.json': '{}', ...files }).map(([name, text]) => ['file:///styles/' + name, { text, version: 2 }]));
  const counts = new Map<string, number>();
  const reader: WorkspaceReader = { root: () => 'file:///styles/', read: async (uri) => { counts.set(uri, (counts.get(uri) ?? 0) + 1); return documents.get(uri); } };
  const request: LanguageRequest = { document: { uri: 'file:///styles/page.wxml', languageId: 'wxml', version: 3, text }, offset: 0, cancellation: { isCancellationRequested: false } };
  const styles = createCssModule(reader, () => maxFiles === undefined ? {} : { maxFiles }).classes;
  return { request, styles, documents, counts };
}

test('组件样式图保留局部和全局来源，循环及重复导入只读取一次', async () => {
  const graph = fixture('<view/>', { 'page.scss': '@import "./shared"; .card { &--active {color:red;} }', 'app.scss': '@import "./shared"; .global { color:blue; }', 'shared.scss': '@import "./page"; .shared {color:green;}' });
  const result = await graph.styles.extractionStyles!(graph.request);
  assert.deepEqual(result.issues, []);
  assert.ok(['card', 'card--active', 'global', 'shared'].every((name) => result.classes.includes(name)));
  assert.equal(result.files.find((file) => file.uri.endsWith('/app.scss'))!.local, false);
  assert.equal(result.files.find((file) => file.uri.endsWith('/shared.scss'))!.local, true);
  assert.equal(graph.counts.get('file:///styles/shared.scss'), 1);
  assert.equal(result.files.find((file) => file.uri.endsWith('/page.scss'))!.version, 2);
  graph.documents.set('file:///styles/shared.scss', { text: '.updated {color:green;}', version: 4 });
  const next = await graph.styles.extractionStyles!(graph.request);
  assert.ok(next.classes.includes('updated') && !next.classes.includes('shared'));
  assert.equal(next.files.find((file) => file.uri.endsWith('/shared.scss'))!.version, 4);
});

test('提取样式分析区分缺失、动态、外部引用及预算，不返回伪完整结果', async () => {
  for (const [source, message] of [['@import "./missing"; .card {}', '完整源码'], ['@import #{path}; .card {}', '动态导入'], ['.card-#{$suffix} {}', '动态选择器'], ['@import "https://example.test/style.css";', '外部样式'], ['.card {', '未闭合']] as const) {
    const graph = fixture('<view/>', { 'page.scss': source });
    assert.ok((await graph.styles.extractionStyles!(graph.request)).issues.some((issue) => issue.includes(message)), source);
  }
  const budget = fixture('<view/>', { 'page.wxss': '.card{}', 'app.wxss': '.global{}' }, 1);
  assert.ok((await budget.styles.extractionStyles!(budget.request)).issues.some((issue) => issue.includes('预算')));
  const cancelled = fixture('<view/>');
  assert.ok((await cancelled.styles.extractionStyles!({ ...cancelled.request, cancellation: { isCancellationRequested: true } })).issues.some((issue) => issue.includes('取消')));
});

test('Sass 内置函数模块无需查找文件，转义选择器与 meta 样式加载不能伪装完整', async () => {
  const graph = fixture('<view/>', { 'page.scss': '@use "sass:map"; @use "sass:color"; .card {color:color.adjust(red,$lightness:1%);}' });
  assert.deepEqual((await graph.styles.extractionStyles!(graph.request)).issues, []);
  assert.ok(![...graph.counts.keys()].some((uri) => uri.includes('sass:')));
  const escaped = fixture('<view/>', { 'page.scss': '.half\\/width {}' });
  assert.ok((await escaped.styles.extractionStyles!(escaped.request)).issues.some((issue) => issue.includes('转义选择器')));
  const meta = fixture('<view/>', { 'page.scss': '@use "sass:meta"; @include meta.load-css("./more");' });
  assert.ok((await meta.styles.extractionStyles!(meta.request)).issues.length);
});

test('静态类只映射实际选区使用的名称，保留空白、未知类和类名大小写', async () => {
  const graph = fixture('<view class="card  Title unknown"/>', { 'page.wxss': '.card{} .Title{} .unused{}' });
  const result = componentStyles(graph.request, { start: 0, end: graph.request.document.text.length }, await graph.styles.extractionStyles!(graph.request));
  assert.deepEqual(result.bindings, [{ name: 'card', alias: 'extract-style-0' }, { name: 'Title', alias: 'extract-style-1' }]);
  assert.equal(result.edits[0]!.newText, 'extract-style-0  extract-style-1 unknown');
  assert.equal(result.source, undefined);
  assert.equal(result.edits[0]!.expectedText, graph.request.document.text);
});

test('动态类先完成插值拼接再映射，生成模块可执行且不覆盖已有 WXS 名称', async () => {
  const text = '<wxs module="__extractStyles" src="./existing.wxs"/><view class="card card-{{size}} {{active ? \'active\' : \'\'}} {{other}}"/>';
  const graph = fixture(text, { 'page.wxss': '.card{} .card-large{} .active{} .constructor{}' });
  const result = componentStyles(graph.request, { start: text.indexOf('<view'), end: text.length }, await graph.styles.extractionStyles!(graph.request));
  assert.equal(result.module, '__extractStyles1');
  assert.ok(result.edits[0]!.newText.endsWith(')}}') && !result.edits[0]!.newText.endsWith(')}}}'));
  const exports = { exports: {} as { map?: (...values: unknown[]) => string } };
  runInNewContext(result.source!, { module: exports, getRegExp: (pattern: string, flags: string) => new RegExp(pattern, flags) });
  assert.equal(exports.exports.map!(false, 'card card-', 'large', ' ', 'active', ' ', null), 'extract-style-0 extract-style-1 extract-style-2 ');
  assert.equal(exports.exports.map!(false, 'constructor\tunknown'), 'extract-style-3 unknown');
  assert.equal(exports.exports.map!(false, undefined, null, false, 0), 'false0');
});

test('单引号属性使用相反的字符串引号，样式不完整时停止映射', async () => {
  const text = "<view class='card {{size}}'/>";
  const graph = fixture(text, { 'page.wxss': '.card{}' });
  const result = componentStyles(graph.request, { start: 0, end: text.length }, await graph.styles.extractionStyles!(graph.request));
  assert.match(result.edits[0]!.newText, /map\(false, "card ", \(size\)\)/);
  assert.throws(() => componentStyles(graph.request, { start: 0, end: text.length }, { classes: [], files: [], issues: ['缺少完整源码'] }), /完整源码/);
});

test('原生悬停和占位类保留作用域，none 不得因存在同名样式而启用悬停', async () => {
  const text = '<view hover-class="none"/><view hover-class="{{hover}}"/><input placeholder-class="hint"/><custom-box placeholder-class="hint"/>';
  const graph = fixture(text, { 'page.wxss': '.none{} .hint{}' });
  const result = componentStyles(graph.request, { start: 0, end: text.length }, await graph.styles.extractionStyles!(graph.request));
  assert.equal(result.edits.length, 2);
  assert.match(result.edits[0]!.newText, /map\(true, \(hover\)\)/);
  const exports = { exports: {} as { map?: (...values: unknown[]) => string } };
  runInNewContext(result.source!, { module: exports, getRegExp: (pattern: string, flags: string) => new RegExp(pattern, flags) });
  assert.equal(exports.exports.map!(true, 'none'), 'none');
  assert.equal(exports.exports.map!(false, 'none'), 'extract-style-0');
});
