import assert from 'node:assert/strict';
import test from 'node:test';
import type { Definition, Disposable, LanguageRequest, WorkspaceReader } from '../src/api';
import { createCssModule } from '../src/languages/css';
import { createWxmlPlugin } from '../src/languages/wxml';
import type { CssOptions } from '../src/languages/css/types';
import { parseStylesheet } from '../src/languages/css/parser';

/** 在内存中构造引用图，光标用竖线标记，不依赖真实文件系统。 */
function fixture(files: Record<string, string>, entry: string, options: CssOptions = {}) {
  const root = 'file:///workspace';
  const documents = new Map(Object.entries(files).map(([file, text]) => [new URL(file, root + '/').toString(), text.replace('|', '')]));
  const reads: string[] = [];
  const source = files[entry]!;
  const uri = new URL(entry, root + '/').toString();
  const request: LanguageRequest = { document: { uri, text: source.replace('|', ''), version: 1, languageId: entry.split('.').pop()! }, offset: source.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const reader: WorkspaceReader = {
    read: async (value) => { reads.push(value); const text = documents.get(value); return text === undefined ? undefined : { text }; },
    root: () => root,
  };
  const css = createCssModule(reader, () => options);
  const features = css.plugin.setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
  /** 执行真实样式提供器，复用编辑器所使用的逻辑。 */
  const definitions = (): Promise<readonly Definition[]> => Promise.resolve(features.definition!.provide(request));
  /** 提取目标文件及原始选择区，确保没有跳到中转入口。 */
  const targets = async (): Promise<string[]> => (await definitions()).map((item) => `${decodeURIComponent(item.uri.slice(root.length + 1))}:${documents.get(item.uri)!.slice(item.range.start, item.range.end)}`);
  return { css, request, documents, reads, definitions, targets };
}

test('CSS 自定义属性穿透多层 import 和 url 导入到原始声明', async () => {
  const graph = fixture({ 'index.css': '@import "theme/index.css"; .page { color: var(--br|and); }', 'theme/index.css': '@import url(./tokens.css);', 'theme/tokens.css': ':root { --brand: red; }' }, 'index.css');
  assert.deepEqual(await graph.targets(), ['theme/tokens.css:--brand']);
});

test('引用路径跳到文件，多文件同名属性保留所有候选', async () => {
  assert.deepEqual(await fixture({ 'index.css': '@import url("the|me.css") screen;', 'theme.css': ':root {}' }, 'index.css').targets(), ['theme.css:']);
  const graph = fixture({ 'index.css': '@import "a.css"; @import "b.css"; x { color: var(--to|ne); }', 'a.css': ':root { --tone: red; }', 'b.css': '.dark { --tone: black; }' }, 'index.css');
  assert.deepEqual(await graph.targets(), ['a.css:--tone', 'b.css:--tone']);
});

test('循环和菱形导入不会无限解析或重复返回定义', async () => {
  const graph = fixture({ 'index.css': '@import "a.css"; @import "b.css"; x { color: var(--to|ne); }', 'a.css': '@import "tokens.css";', 'b.css': '@import "tokens.css";', 'tokens.css': '@import "index.css"; :root { --tone: red; }' }, 'index.css');
  assert.deepEqual(await graph.targets(), ['tokens.css:--tone']);
  assert.equal(graph.reads.filter((uri) => uri.endsWith('/tokens.css')).length, 1);
});

test('SCSS use 和多层 forward 穿透到 partial，支持别名及目录入口', async () => {
  const graph = fixture({ 'index.scss': '@use "theme" as ui; x { color: ui.$br|and; }', 'theme/_index.scss': '@forward "palette";', 'theme/_palette.scss': '@forward "tokens";', 'theme/_tokens.scss': '$brand: red;' }, 'index.scss');
  assert.deepEqual(await graph.targets(), ['theme/_tokens.scss:$brand']);
});

test('SCSS 转发前缀和 show 依据公开名称过滤', async () => {
  const files = { 'index.scss': '@use "theme" as ui; x { color: ui.$ui_br|and; }', '_theme.scss': '@forward "tokens" as ui-* show $ui-brand;', '_tokens.scss': '$brand: red; $secret: blue;' };
  assert.deepEqual(await fixture(files, 'index.scss').targets(), ['_tokens.scss:$brand']);
  assert.deepEqual(await fixture({ ...files, 'index.scss': '@use "theme" as ui; x { color: ui.$ui-se|cret; }' }, 'index.scss').targets(), []);
});

test('SCSS hide 和私有成员不会通过命名空间暴露', async () => {
  const files = { 'index.scss': '@use "theme"; x { color: theme.$se|cret; }', '_theme.scss': '@forward "tokens" hide $secret;', '_tokens.scss': '$secret: blue; $_private: red;' };
  assert.deepEqual(await fixture(files, 'index.scss').targets(), []);
  assert.deepEqual(await fixture({ ...files, 'index.scss': '@use "tokens"; x { color: tokens.$_pri|vate; }' }, 'index.scss').targets(), []);
});

test('SCSS use 不重导出成员，forward 不使成员在本文件直接可用', async () => {
  const files = { 'index.scss': '@use "theme"; x { color: theme.$br|and; }', '_theme.scss': '@use "tokens";', '_tokens.scss': '$brand: red;' };
  assert.deepEqual(await fixture(files, 'index.scss').targets(), []);
  assert.deepEqual(await fixture({ ...files, 'index.scss': '@forward "tokens"; x { color: $br|and; }' }, 'index.scss').targets(), []);
});

test('SCSS 混入、无括号命名空间混入和函数沿转发链跳转', async () => {
  const files = { '_theme.scss': '@forward "tokens";', '_tokens.scss': '@mixin center { display: flex; } @function unit() { @return 4px; }' };
  for (const statement of ['@include theme.cen|ter;', '@include theme.cen|ter();']) {
    assert.deepEqual(await fixture({ ...files, 'index.scss': `@use "theme"; .a { ${statement} }` }, 'index.scss').targets(), ['_tokens.scss:center']);
  }
  assert.deepEqual(await fixture({ ...files, 'index.scss': '@use "theme"; .a { width: theme.un|it(); }' }, 'index.scss').targets(), ['_tokens.scss:unit']);
});

test('SCSS 局部变量优先，兄弟块变量不可见，未来声明不抢占当前位置', async () => {
  const files = { 'index.scss': '@use "tokens" as *; .other { $brand: green; } .a { color: $br|and; $brand: black; }', '_tokens.scss': '$brand: red;' };
  assert.deepEqual(await fixture(files, 'index.scss').targets(), ['_tokens.scss:$brand']);
  assert.deepEqual(await fixture({ ...files, 'index.scss': '@use "tokens" as *; .a { $brand: green; color: $br|and; }' }, 'index.scss').targets(), ['index.scss:$brand']);
});

test('SCSS 参数引用定位参数，不错误穿透到外部同名变量', async () => {
  assert.deepEqual(await fixture({ 'index.scss': '$tone: red; @mixin paint($tone: blue) { color: $to|ne; }' }, 'index.scss').targets(), ['index.scss:$tone']);
  const graph = fixture({ 'index.scss': '$tone: red; @mixin paint($tone: blue) { color: $to|ne; }' }, 'index.scss');
  assert.equal((await graph.definitions())[0]?.range.start, '$tone: red; @mixin paint('.length);
});

test('Less 变量与混入可穿透引用链，并保留延迟变量语义', async () => {
  const files = { 'index.less': '@import (reference) "theme"; .a { color: @br|and; }', 'theme.less': '@import "tokens";', 'tokens.less': '@brand: red; .center() { display: flex; }' };
  assert.deepEqual(await fixture(files, 'index.less').targets(), ['tokens.less:@brand']);
  assert.deepEqual(await fixture({ ...files, 'index.less': '@import "theme"; .a { .cen|ter(); }' }, 'index.less').targets(), ['tokens.less:center']);
  assert.deepEqual(await fixture({ 'index.less': '.a { color: @br|and; @brand: blue; }' }, 'index.less').targets(), ['index.less:@brand']);
});

test('注释、普通字符串、远程引用与动态导入均不产生伪跳转', async () => {
  const files = { 'tokens.scss': '$tone: red;' };
  for (const content of ['/* @import "tokens"; */ x { color: $to|ne; }', '@import "tokens"; x { content: "$to|ne"; }', '// @import "tokens";\nx { color: $to|ne; }', '@import "https://example.com/tokens.scss"; x { color: $to|ne; }', '@import "#{theme}/tokens"; x { color: $to|ne; }']) {
    const graph = fixture({ ...files, 'index.scss': content }, 'index.scss');
    assert.deepEqual(await graph.targets(), []);
    assert.ok(!graph.reads.some((uri) => uri.startsWith('https:')));
  }
});

test('未保存的导入目标变化在下一次请求立即生效', async () => {
  const graph = fixture({ 'index.css': '@import "tokens.css"; x { color: var(--to|ne); }', 'tokens.css': ':root { --tone: red; }' }, 'index.css');
  assert.equal((await graph.definitions()).length, 1);
  graph.documents.set('file:///workspace/tokens.css', ':root { --other: red; }');
  assert.deepEqual(await graph.definitions(), []);
});

test('取消和文件预算会及时终止引用链', async () => {
  const files = { 'index.css': '@import "a.css"; x { color: var(--to|ne); }', 'a.css': '@import "b.css";', 'b.css': ':root { --tone: red; }' };
  assert.deepEqual(await fixture(files, 'index.css', { maxFiles: 1 }).targets(), []);
  const graph = fixture(files, 'index.css');
  Object.assign(graph.request.cancellation, { isCancellationRequested: true });
  assert.deepEqual(await graph.targets(), []);
  assert.deepEqual(graph.reads, []);
});

test('额外搜索目录和带空格的 URI 能定位原始文件', async () => {
  const graph = fixture({ 'pages/index.scss': '@use "theme"; x { color: theme.$br|and; }', 'shared/_theme.scss': '$brand: red;' }, 'pages/index.scss', { includePaths: ['shared'] });
  assert.deepEqual(await graph.targets(), ['shared/_theme.scss:$brand']);
  for (const reference of ['theme tokens.css', 'theme%20tokens.css']) {
    assert.deepEqual(await fixture({ 'index.css': `@import "${reference}"; x { color: var(--to|ne); }`, 'theme tokens.css': ':root { --tone: red; }' }, 'index.css').targets(), ['theme tokens.css:--tone']);
  }
});

test('模块导出的变量遵循传统 import 的声明顺序', async () => {
  const files = { 'index.scss': '@use "theme"; .a { color: theme.$br|and; }', '_theme.scss': '$brand: red; @import "tokens";', '_tokens.scss': '$brand: blue;' };
  assert.deepEqual(await fixture(files, 'index.scss').targets(), ['_tokens.scss:$brand']);
});

test('WXML 条件、下标及动态拼接不产生类跳转，表达式外的静态类继续可用', async () => {
  for (const value of ["{{ca|rd}}", "{{state === 'ca|rd' ? 'active' : ''}}", "{{classes['ca|rd']}}", "{{'ca|rd' + suffix}}", "{{('ca|rd') + (suffix)}}"]) {
    const graph = fixture({ 'index.wxml': `<view class="${value}" />`, 'index.css': '.card {}' }, 'index.wxml');
    const plugin = createWxmlPlugin(graph.css.classes).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
    assert.deepEqual(await plugin.definition!.provide(graph.request), []);
  }
  for (const value of ['{{active}} ca|rd', 'card|']) {
    const graph = fixture({ 'index.wxml': `<view class="${value}" />`, 'index.css': '.card {}' }, 'index.wxml');
    const plugin = createWxmlPlugin(graph.css.classes).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
    assert.equal((await plugin.definition!.provide(graph.request)).length, 1);
  }
});

test('WXML 三元表达式的多行、嵌套及多类名字符串定位到 SCSS 嵌套声明', async () => {
  for (const value of [
    "img {{\n cameraConfig.direction === CameraDirectionEnum.Left\n ? 'img-ro|tate'\n : ''\n}}",
    "img {{\n cameraConfig.direction === CameraDirectionEnum.Left\n ? 'img-rotate|'\n : ''\n}}",
    "{{active ? '' : 'img-ro|tate'}}",
    "{{active ? ('img-ro|tate') : ''}}",
    "{{active ? (left ? 'img-ro|tate' : '') : ''}}",
    "{{active ? '' : left ? 'img-ro|tate' : ''}}",
    "{{active ? 'img img-ro|tate other' : ''}}",
    '{{active ? "img-ro|tate" : ""}}',
    "{{active && 'img-ro|tate'}}",
    "{{active ?? 'img-ro|tate'}}",
  ]) {
    const graph = fixture({ 'index.wxml': `<image class="${value}" />`, 'index.scss': '.img { &-rotate { transform: rotate(90deg); } }' }, 'index.wxml');
    // 同时注入脚本端口，验证字符串类名不会被脚本提供器提前截走。
    const plugin = createWxmlPlugin(graph.css.classes, { resolve() { assert.fail('类名字符串不应进入脚本跳转'); } }).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
    const result = await plugin.definition!.provide(graph.request);
    assert.equal(result.length, 1, value);
    assert.equal(result[0]!.uri, 'file:///workspace/index.scss');
    assert.equal(graph.documents.get(result[0]!.uri)!.slice(result[0]!.range.start, result[0]!.range.end), '&-rotate');
    assert.equal(graph.request.document.text.slice(result[0]!.originRange.start, result[0]!.originRange.end), 'img-rotate');
  }
});

test('WXML 三元条件变量继续进入脚本端口，其他属性中的字符串不进入样式端口', async () => {
  for (const template of ["<view class=\"{{ac|tive ? 'card' : ''}}\" />", "<view title=\"{{active ? 'ca|rd' : ''}}\" />", "<view class=\"{{classes['ca|rd']}}\" />"]) {
    const graph = fixture({ 'index.wxml': template, 'index.css': '.card {}' }, 'index.wxml');
    let calls = 0;
    const plugin = createWxmlPlugin({ resolveClass() { assert.fail('脚本引用不应进入样式跳转'); } }, { resolve() { calls++; return []; } }).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
    assert.deepEqual(await plugin.definition!.provide(graph.request), []);
    assert.equal(calls, 1);
  }
});

test('WXML 三元字符串和静态 class 按前缀补全，保留引号及相邻类名', async () => {
  for (const [value, replaced, expected] of [
    ["img {{\n active ? 'img-ro|tate' : ''\n}}", 'img-rotate', "img {{\n active ? 'img-rotate' : ''\n}}"],
    ["{{active ? '' : 'img-ro|'}}", 'img-ro', "{{active ? '' : 'img-rotate'}}"],
    ["{{active ? (left ? 'img-ro|' : '') : ''}}", 'img-ro', "{{active ? (left ? 'img-rotate' : '') : ''}}"],
    ["{{active ? 'first img-ro|tate last' : ''}}", 'img-rotate', "{{active ? 'first img-rotate last' : ''}}"],
    ['{{active ? "img-ro|" : ""}}', 'img-ro', '{{active ? "img-rotate" : ""}}'],
    ["{{active ? '|' : ''}}", '', "{{active ? 'img-rotate' : ''}}"],
    ['img img-ro|tate other', 'img-rotate', 'img img-rotate other'],
    ['|', '', 'img-rotate'],
  ]) {
    const graph = fixture({ 'index.wxml': `<image class="${value}" />`, 'index.scss': '.img { &-rotate {} } .unrelated {}' }, 'index.wxml');
    const plugin = createWxmlPlugin(graph.css.classes).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
    const result = await plugin.completion!.provide(graph.request);
    const completion = result.find((item) => item.label === 'img-rotate');
    assert.ok(completion, value);
    assert.equal(completion.insertText, 'img-rotate');
    assert.equal(graph.request.document.text.slice(completion.range.start, completion.range.end), replaced);
    assert.match(completion.documentation, /index\.scss/);
    if (replaced) assert.deepEqual(result.map((item) => item.label), ['img-rotate']);
    const edited = graph.request.document.text.slice(0, completion.range.start) + completion.insertText + graph.request.document.text.slice(completion.range.end);
    assert.equal(edited, `<image class="${expected}" />`);
  }
});

test('类名补全沿同名样式、全局样式及循环导入去重，并读取未保存更新', async () => {
  const graph = fixture({
    'app.json': '{}', 'app.wxss': '@import "global.wxss";', 'global.wxss': '.img-global {} .img-rotate {}',
    'pages/index.wxml': `<image class="{{active ? 'img-|' : ''}}" />`,
    'pages/index.scss': '@use "../theme"; .img-local {}',
    '_theme.scss': '@forward "theme"; .img { &-rotate {} } .other {}',
  }, 'pages/index.wxml');
  const plugin = createWxmlPlugin(graph.css.classes).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
  assert.deepEqual((await plugin.completion!.provide(graph.request)).map((item) => item.label), ['img-global', 'img-local', 'img-rotate']);
  assert.equal(graph.reads.filter((uri) => uri.endsWith('/_theme.scss')).length, 1);
  graph.documents.set('file:///workspace/pages/index.scss', '.img-draft {}');
  assert.deepEqual((await plugin.completion!.provide(graph.request)).map((item) => item.label), ['img-draft', 'img-global', 'img-rotate']);
});

test('类名补全不进入条件变量、下标、拼接及非 class 内容，取消请求不读取样式', async () => {
  const styles = {
    /** 无效类名上下文不应访问任何样式端口。 */
    resolveClass() { assert.fail('补全不应调用定义查询'); },
    /** 条件和普通字符串不构成可补全的类名。 */
    completeClass() { assert.fail('无效上下文不应查询类名候选'); },
  };
  const plugin = createWxmlPlugin(styles).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
  for (const template of [
    `<view class="{{ac|tive ? 'card' : ''}}" />`, `<view class="{{state === 'ca|rd' ? 'active' : ''}}" />`,
    `<view class="{{classes['ca|rd']}}" />`, `<view class="{{'ca|rd' + suffix}}" />`,
    `<view title="{{active ? 'ca|rd' : ''}}" />`, `<!-- <view class="{{active ? 'ca|rd' : ''}}" /> -->`,
  ]) {
    const graph = fixture({ 'index.wxml': template }, 'index.wxml');
    assert.deepEqual(await plugin.completion!.provide(graph.request), [], template);
  }
  const graph = fixture({ 'index.wxml': `<view class="{{active ? 'ca|' : ''}}" />`, 'index.css': '.card {}' }, 'index.wxml');
  const cancelled = { ...graph.request, cancellation: { isCancellationRequested: true } };
  const features = createWxmlPlugin(graph.css.classes).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
  assert.deepEqual(await features.completion!.provide(cancelled), []);
  assert.deepEqual(graph.reads, []);
});

test('WXML 静态类名从同名样式穿透到公共样式和嵌套选择器', async () => {
  const graph = fixture({ 'app.json': '{}', 'pages/index.wxml': '<view class="card--act|ive" />', 'pages/index.scss': '@use "../theme";', '_theme.scss': '.card { &--active { color: red; } }' }, 'pages/index.wxml');
  const plugin = createWxmlPlugin(graph.css.classes).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
  const result = await plugin.definition!.provide(graph.request);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.uri, 'file:///workspace/_theme.scss');
  assert.equal(graph.documents.get(result[0]!.uri)!.slice(result[0]!.range.start, result[0]!.range.end), '&--active');
});

test('WXML 全局样式从最近 app 根查找，不误用相邻应用', async () => {
  const graph = fixture({ 'app.wxss': '.global {}', 'apps/shop/app.json': '{}', 'apps/shop/app.wxss': '@import "common.wxss";', 'apps/shop/common.wxss': '.global {}', 'apps/shop/pages/index.wxml': '<view class="glo|bal" />' }, 'apps/shop/pages/index.wxml');
  const result = await graph.css.classes.resolveClass(graph.request, 'global', { start: 13, end: 19 });
  assert.deepEqual(result.map((item) => item.uri), ['file:///workspace/apps/shop/common.wxss']);
});

test('SCSS 中的 CSS 类名和自定义属性不能混同下划线与连字符', async () => {
  const graph = fixture({ 'index.scss': '@import "tokens"; x { color: var(--my_to|ne); }', '_tokens.scss': ':root { --my_tone: red; --my-tone: blue; }' }, 'index.scss');
  assert.deepEqual(await graph.targets(), ['_tokens.scss:--my_tone']);
});

test('样式语法复用仍保留本次版本，文本和方言变化后重新解析', () => {
  const uri = 'file:///cache/index.scss';
  const first = parseStylesheet(uri, { text: '$tone: red;', version: 1 });
  const next = parseStylesheet(uri, { text: first.text, version: 2 });
  assert.equal(next.version, 2);
  assert.equal(next.tokens, first.tokens);
  assert.equal(parseStylesheet(uri, { text: first.text }).version, undefined);
  const changed = parseStylesheet(uri, { text: '$shade: red;', version: 2 });
  assert.deepEqual(changed.symbols.map((symbol) => symbol.name), ['shade']);
  assert.deepEqual(parseStylesheet(uri, { text: first.text }, 'css').symbols, []);
  for (let index = 0; index < 20; index++) parseStylesheet(`file:///cache/${index}.scss`, { text: `$value${index}: red;` });
  assert.deepEqual(parseStylesheet(uri, { text: first.text }).symbols.map((symbol) => symbol.name), ['tone']);
});

test('CSS 插件释放时清空索引，重新解析保留相同声明及版本', () => {
  const subscriptions: Disposable[] = [];
  const reader: WorkspaceReader = { root: () => 'file:///cache', read: async () => undefined };
  createCssModule(reader).plugin.setup({ logger: { info() {}, error() {} }, subscriptions: { add: <T extends Disposable>(resource: T): T => { subscriptions.push(resource); return resource; } } });
  const content = { text: '$unload: red; .panel { color: $unload; }', version: 3 };
  const first = parseStylesheet('file:///cache/unload.scss', content);
  assert.equal(parseStylesheet(first.uri, content).tokens, first.tokens);
  for (const resource of subscriptions) resource.dispose();
  const next = parseStylesheet(first.uri, content);
  assert.notEqual(next.tokens, first.tokens);
  assert.deepEqual(next, first);
});
