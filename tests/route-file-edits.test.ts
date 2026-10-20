import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createComponentScriptResolver, createScriptResolver } from '../src/languages/typescript';
import { createComponentResolver, createRouteContextResolver, navigatorAccesses } from '../src/languages/wxml';
import { createProjectFileResolver, createRouteResolver } from '../src/resolution';
import { routeFileEdits } from '../src/resolution/route-file-edits';

/** 真实路由端口与字面量来源共用内存快照，工程样本不写入磁盘。 */
function fixture(files: Record<string, string>) {
  const root = 'file:///workspace/';
  const documents = new Map(Object.entries(files).map(([name, text]) => [root + name, { text, version: 1 }]));
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => documents.get(uri)?.text ?? '', read: async (uri) => documents.get(uri), directory: async (uri) => [...documents.keys()].some((file) => file.startsWith(uri.replace(/\/$/, '') + '/')), findFiles: async (_uri, pattern, limit) => [...documents.keys()].filter((uri) => pattern === '**/*.wxml' ? uri.endsWith('.wxml') : pattern === '**/*.json' ? uri.endsWith('.json') : /\.(?:[cm]?[jt]sx?|wxml)$/.test(uri)).slice(0, limit), fileResolver: (uri, cancellation) => createProjectFileResolver(reader, uri, cancellation) };
  const scripts = createScriptResolver(reader);
  const inspector = (snapshot: WorkspaceReader) => createComponentScriptResolver(snapshot);
  const components = (snapshot: WorkspaceReader) => createComponentResolver(snapshot, inspector);
  const routes = createRouteResolver(reader, scripts, createRouteContextResolver(reader, components, inspector, scripts));
  const request: LanguageRequest = { document: { uri: root + 'app.json', text: files['app.json'] ?? '', version: 1, languageId: 'json' }, offset: 0, cancellation: { isCancellationRequested: false } };
  /** 编辑结果同时核对旧文本与归属，不接受普通字符串替换。 */
  const edits = (from: string, to: string) => routeFileEdits(reader, scripts, routes, navigatorAccesses, request, [...documents.keys()], [{ oldUri: root + from, newUri: root + to }]);
  return { edits, request, scripts, routes, documents, root };
}

test('页面目录移动同步主包注册、TabBar、常量和 navigator，查询字符串保留', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index"],"tabBar":{"list":[{"pagePath":"detail/index"}]}}', 'home/index.ts': `import {target} from '../paths';Page({open(){wx.reLaunch({url:target+'?id='+1})}});`, 'home/index.wxml': '<navigator url="/detail/index?id={{id}}" open-type="reLaunch"/>', 'detail/index.ts': 'Page({});', 'paths.ts': `export const target='/detail/index';const caption='/detail/index';` });
  const edits = await graph.edits('detail', 'reports/detail');
  assert.equal(edits.filter((edit) => edit.uri.endsWith('/app.json') && edit.newText === 'reports/detail/index').length, 2);
  assert.equal(edits.find((edit) => edit.uri.endsWith('/paths.ts'))?.newText, '/reports/detail/index');
  assert.equal(edits.filter((edit) => edit.uri.endsWith('/paths.ts')).length, 1);
  assert.equal(edits.find((edit) => edit.uri.endsWith('/index.wxml'))?.newText, '/reports/detail/index?id=');
  for (const edit of edits) assert.equal(graph.documents.get(edit.uri)!.text.slice(edit.range.start, edit.range.end), edit.oldText);
});

test('分包目录整体改名只更新根注册和 URL，包内页面相对注册保持原文', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index"],"subPackages":[{"root":"reports","pages":["detail/index"]}]}', 'home/index.ts': `Page({open(){wx.navigateTo({url:'/reports/detail/index'})}});`, 'reports/detail/index.ts': 'Page({});' });
  const edits = await graph.edits('reports', 'reporting');
  assert.equal(edits.find((edit) => edit.uri.endsWith('app.json'))?.newText, 'reporting');
  assert.equal(edits.find((edit) => edit.uri.endsWith('home/index.ts'))?.newText, '/reporting/detail/index');
  assert.equal(edits.length, 2);
});

test('相对路由同时考虑调用页面移动，静态包装器参数沿原声明联动', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index"]}', 'home/index.ts': `import {jump} from '../runtime';Page({open(){jump('../detail/index')}});`, 'runtime.ts': `export function jump(url:string){wx.navigateTo({url})}`, 'detail/index.ts': 'Page({});' });
  const edits = await graph.edits('home', 'area/home');
  assert.equal(edits.find((edit) => edit.uri.endsWith('home/index.ts'))?.newText, '../../detail/index');
  assert.equal(edits.find((edit) => edit.uri.endsWith('app.json'))?.newText, 'area/home/index');
});

test('拼接后的 URL 保留模板字面量与枚举来源位置', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index"]}', 'home/index.ts': 'import {Paths} from "../paths";Page({open(){wx.navigateTo({url:`${Paths.Detail}?id=${1}`})}});', 'paths.ts': 'export enum Paths { Detail="/detail/index" }', 'detail/index.ts': 'Page({});' });
  const edits = await graph.edits('detail', 'data/detail');
  assert.equal(edits.find((edit) => edit.uri.endsWith('paths.ts'))?.newText, '/data/detail/index');
});

test('应用配置导入的页面和 TabBar 常量在原始模块修改', async () => {
  const graph = fixture({ 'app.config.ts': `import {target} from './paths';export default {pages:['home/index',target],tabBar:{list:[{pagePath:target}]}};`, 'paths.ts': `export const target='detail/index';`, 'home/index.ts': 'Page({});', 'detail/index.ts': 'Page({});' });
  const edits = await graph.edits('detail', 'reports/detail');
  assert.equal(edits.length, 1);
  assert.ok(edits[0]!.uri.endsWith('paths.ts'));
  assert.equal(edits[0]!.newText, 'reports/detail/index');
});

test('共享组件的相对路由需要不同新值时拒绝部分修改', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","other/index","detail/index"]}', 'home/index.ts': 'Page({});', 'home/index.wxml': '<shared-router/>', 'home/index.json': '{"usingComponents":{"shared-router":"../shared"}}', 'other/index.ts': 'Page({});', 'other/index.wxml': '<shared-router/>', 'other/index.json': '{"usingComponents":{"shared-router":"../shared"}}', 'shared.ts': `Component({methods:{open(){this.pageRouter.navigateTo({url:'../detail/index'})}}});`, 'shared.wxml': '<view bindtap="open"/>', 'detail/index.ts': 'Page({});', 'detail/index.wxml': '<view/>' });
  await assert.rejects(() => graph.edits('home', 'area/home'), /消费位置需要不同新路径/);
});

/** 在内存中应用整批原生编辑，以检查结构迁移后的配置。 */
function apply(edits: readonly import('../src/api').TextEdit[], documents: ReadonlyMap<string, { text: string }>): Map<string, string> {
  const result = new Map([...documents].map(([uri, document]) => [uri, document.text]));
  for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) {
    const text = result.get(edit.uri)!;
    assert.equal(text.slice(edit.range.start, edit.range.end), edit.oldText);
    result.set(edit.uri, text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end));
  }
  return result;
}

test('主包页面迁入空分包数组，原注册移除且 URL 使用完整新路径', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index"],"subPackages":[{"root":"reports","pages":[]}]}', 'home/index.ts': `Page({open(){wx.navigateTo({url:'/detail/index?kept=1'})}});`, 'detail/index.ts': 'Page({});' });
  const changed = apply(await graph.edits('detail', 'reports/detail'), graph.documents);
  const config = JSON.parse(changed.get(graph.root + 'app.json')!);
  assert.deepEqual(config.pages, ['home/index']);
  assert.deepEqual(config.subPackages[0].pages, ['detail/index']);
  assert.match(changed.get(graph.root + 'home/index.ts')!, /\/reports\/detail\/index\?kept=1/);
});

test('分包页面迁回主包与迁到另一分包，保留其他注册项', async () => {
  for (const target of ['main-detail', 'other/detail']) {
    const graph = fixture({ 'app.json': '{"pages":["home/index"],"subPackages":[{"root":"reports","pages":["detail/index","kept/index"]},{"root":"other","pages":[]}]}', 'home/index.ts': 'Page({});', 'reports/detail/index.ts': 'Page({});', 'reports/kept/index.ts': 'Page({});' });
    const config = JSON.parse(apply(await graph.edits('reports/detail', target), graph.documents).get(graph.root + 'app.json')!);
    assert.deepEqual(config.subPackages[0].pages, ['kept/index']);
    assert.deepEqual(config.pages, target === 'main-detail' ? ['home/index', 'main-detail/index'] : ['home/index']);
    assert.deepEqual(config.subPackages[1].pages, target === 'other/detail' ? ['detail/index'] : []);
  }
});

test('TS 导入的注册数组跨分包迁移不改常量本身，注释与其余表达式保留', async () => {
  const graph = fixture({ 'app.config.ts': `import {main,detail} from './paths';export default {pages:main,subPackages:[{root:'reports',pages:[]}]};`, 'paths.ts': `export const detail='detail/index'; export const main=[/** 首页 */ 'home/index',detail] as const;`, 'home/index.ts': 'Page({});', 'detail/index.ts': 'Page({});' });
  const changed = apply(await graph.edits('detail', 'reports/detail'), graph.documents);
  assert.match(changed.get(graph.root + 'paths.ts')!, /detail='detail\/index'/);
  assert.match(changed.get(graph.root + 'paths.ts')!, /\/\*\* 首页 \*\/ 'home\/index'/);
  assert.ok(!changed.get(graph.root + 'paths.ts')!.includes(',detail]'));
  assert.match(changed.get(graph.root + 'app.config.ts')!, /pages:\["detail\/index"\]/);
});

test('TabBar 页面迁入分包时拒绝生成违反平台注册规则的编辑', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index"],"tabBar":{"list":[{"pagePath":"detail/index"}]},"subPackages":[{"root":"reports","pages":[]}]}', 'home/index.ts': 'Page({});', 'detail/index.ts': 'Page({});' });
  await assert.rejects(() => graph.edits('detail', 'reports/detail'), /TabBar 页面不能迁入分包/);
});

test('多静态片段覆盖完整改动范围时联合编辑，查询内容保持原文', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index"]}', 'home/index.ts': `const folder='/detail'; const leaf='/index';Page({open(){wx.navigateTo({url:folder+leaf+'?kept=1'})}});`, 'detail/index.ts': 'Page({});' });
  const changed = apply(await graph.edits('detail/index.ts', 'reports/view.ts'), graph.documents);
  assert.match(changed.get(graph.root + 'home/index.ts')!, /folder='\/reports\/view'/);
  assert.match(changed.get(graph.root + 'home/index.ts')!, /leaf=''/);
  assert.match(changed.get(graph.root + 'home/index.ts')!, /'\?kept=1'/);
});

test('在片段边界插入目录时采用右侧片段，共享斜线常量不被修改', async () => {
  const graph = fixture({ 'app.json': '{"pages":["home/index","detail/index","other/index"]}', 'home/index.ts': `const slash='/'; const leaf='detail/index';Page({open(){wx.navigateTo({url:slash+leaf})},other(){wx.navigateTo({url:slash+'other/index'})}});`, 'detail/index.ts': 'Page({});', 'other/index.ts': 'Page({});' });
  const changed = apply(await graph.edits('detail', 'reports/detail'), graph.documents);
  assert.match(changed.get(graph.root + 'home/index.ts')!, /slash='\/'/);
  assert.match(changed.get(graph.root + 'home/index.ts')!, /leaf='reports\/detail\/index'/);
});

test('JSONC 多行页面迁移保留说明、换行及其余注册，多个改动合并为合法数组', async () => {
  const graph = fixture({ 'app.jsonc': '{"pages":[\n  "home/index",\n  /** 详情页面 */ "detail/index",\n],"subPackages":[{"root":"reports","pages":[\n]}]}', 'home/index.ts': 'Page({});', 'detail/index.ts': 'Page({});' });
  const changed = apply(await graph.edits('detail', 'reports/detail'), graph.documents).get(graph.root + 'app.jsonc')!;
  const { jsonRoutes } = await import('../src/resolution/routes-document');
  assert.equal(jsonRoutes(graph.root + 'app.jsonc', changed).complete, true);
  assert.deepEqual(jsonRoutes(graph.root + 'app.jsonc', changed).pages.map((page) => page.path), ['home/index', 'reports/detail/index']);
  assert.equal(changed.split('详情页面').length, 2);
  assert.match(changed, /pages":\[\n/);
});
