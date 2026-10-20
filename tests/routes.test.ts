import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createComponentScriptResolver, createScriptResolver } from '../src/languages/typescript';
import type { ScriptOptions } from '../src/languages/typescript/project';
import { createComponentResolver, createNavigatorPlugin, createRouteContextResolver } from '../src/languages/wxml';
import { createProjectFileResolver, createRoutePlugin, createRouteResolver } from '../src/resolution';

/** 真实语言组合使用内存草稿，所有更新均不写入用户项目。 */
function fixture(files: Record<string, string>, entry = 'src/pages/home/index.ts', options: ScriptOptions = {}) {
  const root = 'file:///workspace/';
  const input = files[entry]!;
  const documents = new Map(Object.entries({ 'package.json': '{}', ...files }).map(([name, text]) => [new URL(name, root).href, name === entry ? text.replace('|', '') : text]));
  let reads = 0;
  const reader: WorkspaceReader = {
    root: () => root,
    revision: (uri) => documents.get(uri) ?? '不存在',
    read: async (uri) => { reads++; const text = documents.get(uri); return text === undefined ? undefined : { text, version: 3 }; },
    findFiles: async (_uri, _pattern, limit) => [...documents.keys()].filter((uri) => /\.(?:[cm]?[jt]sx?|wxml)$/.test(uri)).slice(0, limit),
    fileResolver: (uri, cancellation) => createProjectFileResolver(reader, uri, cancellation),
  };
  const request: LanguageRequest = { document: { uri: new URL(entry, root).href, text: input.replace('|', ''), version: 1, languageId: entry.endsWith('.wxml') ? 'wxml' : entry.endsWith('.json') ? 'json' : entry.endsWith('.js') ? 'javascript' : 'typescript' }, offset: input.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const scripts = createScriptResolver(reader, () => options);
  const inspector = (snapshot: WorkspaceReader) => createComponentScriptResolver(snapshot, () => options);
  const components = (snapshot: WorkspaceReader) => createComponentResolver(snapshot, inspector);
  const routes = createRouteResolver(reader, scripts, createRouteContextResolver(reader, components, inspector, scripts));
  const plugin = entry.endsWith('.wxml') ? createNavigatorPlugin(routes) : createRoutePlugin(scripts, routes);
  const features = plugin.setup({ logger: { info() {}, error() {} }, subscriptions: { add: (value) => value } });
  /** 查询结果同时检查页面源码路径和实际消费位置。 */
  const definitions = async (query = request) => (await features.definition!.provide(query)).map((item) => ({ path: item.uri.slice(root.length), origin: query.document.text.slice(item.originRange.start, item.originRange.end) }));
  return { documents, request, scripts, features, definitions, reads: () => reads };
}

test('通用注册包装器读取 query schema，参数提示保留类型、默认值、注释及声明跳转', async () => {
  const graph = fixture({ ...app,
    'src/reports/detail/index.ts': `import {screen} from '../../runtime';screen({query:{/** 记录编号 */ recordId:{type:String,required:true},limit:{type:Number,value:5},enabled:Boolean,list:Array},onLoad(raw:any){}});`,
    'src/runtime.ts': `export function screen(options:any){const {query,...native}=options;Page(native)}`,
    'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/index?rec|ordId=demo'});`,
  });
  const items = await graph.features.completion!.provide(graph.request);
  assert.equal(items[0]?.detail, 'string');
  assert.match(items[0]!.documentation, /记录编号[\s\S]*必填/);
  const definition = (await graph.features.definition!.provide(graph.request))[0]!;
  assert.equal(graph.documents.get(definition.uri)!.slice(definition.range.start, definition.range.end), 'recordId');
  const query = await graph.scripts.pageQuery!(graph.request, 'file:///workspace/src/reports/detail/index.ts');
  assert.equal(query?.type.properties?.limit?.display, 'number');
  assert.equal(query?.type.properties?.list?.kind, 'array');
  assert.equal(query?.fields?.find((item) => item.name === 'limit')?.defaultValue, '5');
});

test('声明宏按模块与 query 路径适配，导入别名不会变成项目特例', async () => {
  const options: ScriptOptions = { adapters: [{ name: 'screen', module: 'portable', kind: 'page', query: 'route.params' }] };
  const graph = fixture({ ...app, 'src/reports/detail/index.ts': `import {screen as mount} from 'portable';mount({route:{params:{recordId:String,limit:{type:Number,default:3}}}});`, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/index?lim|'});` }, 'src/pages/home/index.ts', options);
  const item = (await graph.features.completion!.provide(graph.request))[0]!;
  assert.equal(item.label, 'limit');
  assert.equal(item.detail, 'number');
  assert.match(item.documentation, /默认值：3/);
  const unrelated = fixture({ ...app, 'src/reports/detail/index.ts': `import {screen as mount} from 'other';mount({route:{params:{recordId:String}}});`, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/index?rec|'});` }, 'src/pages/home/index.ts', options);
  assert.deepEqual(await unrelated.features.completion!.provide(unrelated.request), []);
});

/** 分包与 TabBar 页面用于验证注册和导航规则，名字不关联业务框架。 */
const app = {
  'src/app.json': JSON.stringify({ pages: ['pages/home/index', 'pages/tab/index'], subPackages: [{ root: 'reports', independent: true, pages: ['detail/index'] }], tabBar: { list: [{ pagePath: 'pages/tab/index', text: '标签' }] } }),
  'src/pages/home/index.ts': 'Page({});',
  'src/pages/tab/index.ts': 'Page({});',
  'src/reports/detail/index.ts': 'Page({onLoad(options:{recordId:string;limit?:number}){}});',
};

test('原生页面 URL 定义、分包说明和路径补全共享注册目录', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.ts': `Page({open(){wx.navigateTo({url:'/reports/det|ail/index?recordId=a'})}});` });
  assert.deepEqual(await graph.definitions(), [{ path: 'src/reports/detail/index.ts', origin: '/reports/detail/index?recordId=a' }]);
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /分包：reports（独立分包）/);
  const items = await graph.features.completion!.provide(graph.request);
  assert.deepEqual(items.map((item) => item.label), ['/reports/detail/index']);
  assert.equal(graph.request.document.text.slice(items[0]!.range.start, items[0]!.range.end), '/reports/detail/index');
  assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), []);
});

test('导入重导出、枚举、对象路径常量及原生函数别名保持路由身份', async () => {
  const files = { ...app, 'src/routes.ts': `export enum Routes{Detail='/reports/detail/index'};export const paths={detail:Routes.Detail};`, 'src/exports.ts': `export {paths} from './routes';` };
  for (const statement of [
    `import {paths} from '../../exports';wx.navigateTo({url:paths.det|ail});`,
    `import {paths} from '../../exports';const go=wx.navigateTo;go({url:paths.det|ail});`,
    `import {paths} from '../../exports';const {navigateTo:go}=wx;go({url:paths.det|ail});`,
  ]) {
    const graph = fixture({ ...files, 'src/pages/home/index.ts': statement });
    assert.deepEqual(await graph.definitions(), [{ path: 'src/reports/detail/index.ts', origin: 'detail' }], statement);
  }
});

test('无返回值包装器和 URL 工厂沿真实参数绑定追踪，未执行回调不产生路由', async () => {
  const files = { ...app, 'src/navigation.ts': `export function go(path:string){wx.navigateTo({url:path})};export function withQuery(path:string,query:string){return query ? path+'?recordId='+query : path}` };
  for (const statement of [
    `import {go} from '../../navigation';go('/reports/det|ail/index');`,
    `import {withQuery} from '../../navigation';const id=String(Date.now());wx.navigateTo({url:withQuery('/reports/det|ail/index',id)});`,
  ]) {
    const graph = fixture({ ...files, 'src/pages/home/index.ts': statement });
    assert.ok((await graph.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'), statement);
  }
  const unused = fixture({ ...app, 'src/pages/home/index.ts': `function wrapper(callback:()=>void){};wrapper(()=>wx.navigateTo({url:'/missing|'}));` });
  // 回调本身可包含运行时导航；包装器不会虚构其参数绑定或调用时序。
  assert.equal((await unused.scripts.routeQueries!(unused.request)).length, 1);
});

test('动态查询值保留静态路径，动态路径、外部协议和普通同名方法不误报', async () => {
  const known = fixture({ ...app, 'src/pages/home/index.ts': 'declare const id:string;wx.navigateTo({url:`/reports/det|ail/index?recordId=${id}`});' });
  assert.ok((await known.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  const unknown = fixture({ ...app, 'src/pages/home/index.ts': `declare const part:string;wx.navigateTo({url:'/reports/'+part+'/in|dex'});wx.navigateTo({url:'plugin-private://demo/page'});const other={navigateTo(value:any){}};other.navigateTo({url:'/missing'});` });
  assert.deepEqual(await unknown.features.diagnostics!.provide(unknown.request), []);
  const shadow = fixture({ ...app, 'src/pages/home/index.ts': `const wx={navigateTo(value:any){}};wx.navigateTo({url:'/miss|ing'});` });
  assert.deepEqual(await shadow.scripts.routeQueries!(shadow.request), []);
});

test('TabBar 导航方式与查询参数分别诊断，补全遵循当前导航方式', async () => {
  const wrong = fixture({ ...app, 'src/pages/home/index.ts': `wx.navigateTo({url:'/pages/ta|b/index'});wx.switchTab({url:'/reports/detail/index'});wx.switchTab({url:'/pages/tab/index?id=1'});` });
  const codes = (await wrong.features.diagnostics!.provide(wrong.request)).map((item) => item.code);
  assert.equal(codes.filter((code) => code === 'route-navigation-method').length, 2);
  assert.equal(codes.filter((code) => code === 'route-tab-query').length, 1);
  const correct = fixture({ ...app, 'src/pages/home/index.ts': `wx.switchTab({url:'/pages/|'});` });
  assert.deepEqual((await correct.features.completion!.provide(correct.request)).map((item) => item.label), ['/pages/tab/index']);
});

test('相对 URL 以当前页面为基准，共享工具不猜测运行时页面', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.ts': `wx.redirectTo({url:'../../reports/detail/in|dex'});` });
  assert.ok((await graph.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  const utility = fixture({ ...app, 'src/utils.ts': `wx.navigateTo({url:'./miss|ing'});` }, 'src/utils.ts');
  assert.deepEqual(await utility.features.diagnostics!.provide(utility.request), []);
});

test('已声明页面查询参数补全保留已有等号与值，不在值中插入字段', async () => {
  for (const [suffix, expected] of [['rec|ordId=value', 'recordId'], ['lim|', 'limit=']] as const) {
    const graph = fixture({ ...app, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/index?${suffix}'});` });
    const items = await graph.features.completion!.provide(graph.request);
    assert.equal(items[0]?.insertText, expected);
    assert.match(items[0]!.detail, /string|number/);
  }
  const value = fixture({ ...app, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/index?recordId=v|alue'});` });
  assert.deepEqual(await value.features.completion!.provide(value.request), []);
});

test('模板 navigator 共享路由能力，动态 URL 与跨小程序目标保持开放', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.wxml': '<navigator url="/reports/detail/in|dex" open-type="navigate"/>' }, 'src/pages/home/index.wxml');
  assert.ok((await graph.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  const external = fixture({ ...app, 'src/pages/home/index.wxml': '<navigator target="miniProgram" url="/miss|ing"/><navigator url="{{path}}"/><navigator open-type="navigateBack" url="/missing"/>' }, 'src/pages/home/index.wxml');
  assert.deepEqual(await external.features.diagnostics!.provide(external.request), []);
  const query = fixture({ ...app, 'src/pages/home/index.wxml': '<navigator url="/reports/detail/in|dex?recordId={{id}}"/>' }, 'src/pages/home/index.wxml');
  assert.ok((await query.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
});

test('JSONC、配置宏及多应用目录保留最近应用边界', async () => {
  const jsonc = fixture({ ...app, 'src/app.json': '{// 注释\n"pages":["pages/home/index","reports/detail/index"],}', 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/in|dex'});` });
  assert.ok((await jsonc.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  const macro = fixture({ 'src/app.config.ts': `import common from './common';export default defineAppConfig({...common,subPackages:[{root:'reports',pages:['detail/index']}]})`, 'src/common.ts': `export default {pages:['pages/home/index']}`, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/in|dex'});`, 'src/reports/detail/index.ts': 'Page({});' });
  assert.ok((await macro.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  const nested = fixture({ ...app, 'src/other/app.json': '{"pages":["pages/home/index"]}', 'src/other/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/in|dex'});` }, 'src/other/pages/home/index.ts');
  assert.equal((await nested.features.diagnostics!.provide(nested.request))[0]?.code, 'unregistered-route');
});

test('缓存与配置草稿更新一致，损坏或动态配置不产生缺失页面结论', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/in|dex'});` });
  assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), []);
  graph.documents.set('file:///workspace/src/app.json', '{"pages":["pages/home/index"]}');
  assert.equal((await graph.features.diagnostics!.provide(graph.request))[0]?.code, 'unregistered-route');
  const invalid = fixture({ ...app, 'src/app.json': '{"pages": [', 'src/pages/home/index.ts': `wx.navigateTo({url:'/miss|ing'});` });
  assert.deepEqual(await invalid.features.diagnostics!.provide(invalid.request), []);
  const dynamic = fixture({ 'src/app.config.ts': 'declare const pages:string[];export default defineAppConfig({pages})', 'src/pages/home/index.ts': `wx.navigateTo({url:'/miss|ing'});` });
  assert.deepEqual(await dynamic.features.diagnostics!.provide(dynamic.request), []);
});

test('应用注册字符串可直接跳到源码，分包字符串补全保留相对包根', async () => {
  const graph = fixture({ ...app, 'src/app.json': '{"pages":["pages/home/index"],"subPackages":[{"root":"reports","pages":["detail/in|dex"]}]}' }, 'src/app.json');
  assert.ok((await graph.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.insertText), ['detail/index']);
});

test('this.router 只接受真实实例方法，pageRouter 的相对页面不靠组件目录猜测', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.wxml': '<card/>', 'src/pages/home/index.json': '{"usingComponents":{"card":"/components/card"}}', 'src/components/card.wxml': '<view/>', 'src/components/card.ts': `Component({methods:{open(){const a=this.router;const b=a;b.navigateTo({url:'../reports/detail/in|dex'})}}});` }, 'src/components/card.ts');
  assert.ok((await graph.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'));
  const unknownPage = fixture({ ...app, 'src/components/card.ts': `Component({methods:{open(){this.pageRouter.navigateTo({url:'../miss|ing'})}}});` }, 'src/components/card.ts');
  assert.deepEqual(await unknownPage.features.diagnostics!.provide(unknownPage.request), []);
  const unrelated = fixture({ ...app, 'src/pages/home/index.ts': `const value={open(){this.router.navigateTo({url:'/miss|ing'})}};` });
  assert.deepEqual(await unrelated.scripts.routeQueries!(unrelated.request), []);
  const shared = fixture({ ...app, 'src/behaviors/shared.ts': `export default Behavior({methods:{open(){this.router.navigateTo({url:'../miss|ing'})}}});` }, 'src/behaviors/shared.ts');
  assert.deepEqual(await shared.features.diagnostics!.provide(shared.request), []);
});

test('显式 JSON 路由常量支持 import 和 require，不要求生成脚本字典', async () => {
  for (const statement of [`import pages from '../../pages.json';wx.navigateTo({url:pages.Det|ail});`, `const pages=require('../../pages.json');wx.navigateTo({url:pages.Det|ail});`, `const pages=require('../../pages.json');wx.navigateTo({url:pages.def|ault});`]) {
    const graph = fixture({ ...app, 'src/pages.json': '{"Detail":"/reports/detail/index","default":"/reports/detail/index"}', 'src/pages/home/index.ts': statement });
    assert.ok((await graph.definitions()).some((item) => item.path === 'src/reports/detail/index.ts'), statement);
  }
});

test('连续请求缓存读取为零，构建映射和缺失页面源码变化会使结果失效', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.ts': `wx.navigateTo({url:'/reports/detail/in|dex'});`, 'webpack.config.js': `module.exports={output:{path:'dist'}}` });
  await graph.definitions();
  const before = graph.reads();
  await graph.definitions({ ...graph.request });
  assert.equal(graph.reads(), before);
  graph.documents.delete('file:///workspace/src/reports/detail/index.ts');
  const missing = await graph.definitions({ ...graph.request });
  assert.equal(missing[0]?.path, 'src/app.json');
  graph.documents.set('file:///workspace/src/reports/detail/index.js', 'Page({});');
  assert.equal((await graph.definitions({ ...graph.request }))[0]?.path, 'src/reports/detail/index.js');
  const cancelled = { ...graph.request, cancellation: { isCancellationRequested: true } };
  assert.deepEqual(await graph.definitions(cancelled), []);
});

test('构建别名变更同时使脚本图和页面导航失效，不能保留旧字典', async () => {
  const graph = fixture({ ...app, 'src/pages/home/index.ts': `import {Detail} from '@routes';wx.navigateTo({url:Det|ail});`, 'first.ts': `export const Detail='/reports/detail/index'`, 'second.ts': `export const Detail='/pages/tab/index'`, 'webpack.config.js': `module.exports={resolve:{alias:{'@routes$':'./first.ts'}}}` });
  assert.equal((await graph.definitions())[0]?.path, 'src/reports/detail/index.ts');
  graph.documents.set('file:///workspace/webpack.config.js', `module.exports={resolve:{alias:{'@routes$':'./second.ts'}}}`);
  assert.equal((await graph.definitions({ ...graph.request }))[0]?.path, 'src/pages/tab/index.ts');
});

/** 两个真实页面使用同一组件，但相对 URL 的目标目录不同。 */
const consumers = {
  'src/app.json': '{"pages":["pages/home/index","archive/index","pages/home/detail/index","archive/detail/index"]}',
  'src/pages/home/index.ts': 'Page({});', 'src/archive/index.ts': 'Page({});',
  'src/pages/home/index.json': '{"usingComponents":{"card":"/components/card"}}',
  'src/archive/index.json': '{"usingComponents":{"card":"/components/card"}}',
  'src/pages/home/index.wxml': '<card/>', 'src/archive/index.wxml': '<card/>',
  'src/pages/home/detail/index.ts': 'Page({});', 'src/pages/home/detail/index.wxml': '<view/>',
  'src/archive/detail/index.ts': 'Page({});', 'src/archive/detail/index.wxml': '<view/>',
  'src/components/card.wxml': '<view/>',
  'src/components/card.ts': `Component({methods:{open(){this.pageRouter.navigateTo({url:'./detail/in|dex'})}}});`,
};

test('共享组件 pageRouter 保留全部实际页面基准，消费节点变更使缓存失效', async () => {
  const graph = fixture(consumers, 'src/components/card.ts');
  assert.deepEqual(new Set((await graph.definitions()).map((item) => item.path)), new Set(['src/pages/home/detail/index.ts', 'src/archive/detail/index.ts']));
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /相对基准：\/pages\/home\/index[\s\S]*相对基准：\/archive\/index/);
  const before = graph.reads();
  await graph.definitions({ ...graph.request });
  assert.equal(graph.reads(), before);
  graph.documents.set('file:///workspace/src/archive/index.wxml', '<template name="unused"><card/></template><view/>');
  assert.deepEqual((await graph.definitions({ ...graph.request })).map((item) => item.path), ['src/pages/home/detail/index.ts']);
});

test('include 与具名模板使用消费页面的注册，未使用注册不参与相对路由', async () => {
  const graph = fixture({ ...consumers,
    'src/archive/index.wxml': '<view/>',
    'src/pages/home/index.wxml': '<import src="../../common.wxml"/><template is="active"/>',
    'src/common.wxml': '<template name="unused"><other-card/></template><template name="active"><include src="./part.wxml"/></template>',
    'src/part.wxml': '<card/>',
  }, 'src/components/card.ts');
  assert.deepEqual((await graph.definitions()).map((item) => item.path), ['src/pages/home/detail/index.ts']);
});

test('不同页面的相对 URL 查询字段合并类型和声明，不冒选最后一个页面', async () => {
  const graph = fixture({ ...consumers,
    'src/pages/home/detail/index.ts': 'Page({onLoad(query:{recordId:string}){}});',
    'src/archive/detail/index.ts': 'Page({onLoad(query:{recordId:number;limit?:number}){}});',
    'src/components/card.ts': `Component({methods:{open(){this.pageRouter.navigateTo({url:'./detail/index?rec|ordId=a'})}}});`,
  }, 'src/components/card.ts');
  const item = (await graph.features.completion!.provide(graph.request))[0]!;
  assert.match(item.detail, /string/); assert.match(item.detail, /number/);
  const targets = await graph.features.definition!.provide(graph.request);
  assert.deepEqual(new Set(targets.map((target) => target.uri)), new Set(['file:///workspace/src/pages/home/detail/index.ts', 'file:///workspace/src/archive/detail/index.ts']));
  assert.ok(targets.every((target) => graph.documents.get(target.uri)!.slice(target.range.start, target.range.end) === 'recordId'));
});

test('Behavior 相对路由按真实函数身份反查组件，显式覆盖的方法不构成消费', async () => {
  const graph = fixture({ ...consumers,
    'src/components/card.ts': `import shared from '../shared';Component({behaviors:[shared]});`,
    'src/shared.ts': `export default Behavior({methods:{open(){this.pageRouter.navigateTo({url:'./detail/in|dex'})}}});`,
  }, 'src/shared.ts');
  assert.equal((await graph.definitions()).length, 2);
  graph.documents.set('file:///workspace/src/components/card.ts', `import shared from '../shared';Component({behaviors:[shared],methods:{open(){}}});`);
  assert.deepEqual(await graph.definitions({ ...graph.request }), []);
});

test('复制目录中的 this.router 使用注册运行路径，源码目录不替代组件目录', async () => {
  const graph = fixture({
    'src/app.json': '{"pages":["pages/home/index","copied/detail/index"]}',
    'project.config.json': '{"srcMiniprogramRoot":"src","miniprogramRoot":"dist"}',
    'webpack.config.js': `const Copy=require('copy-webpack-plugin');module.exports={output:{path:'dist'},plugins:[new Copy([{from:'widgets/card',to:'copied/card'}])]};`,
    'src/pages/home/index.ts': 'Page({});', 'src/pages/home/index.wxml': '<card/>',
    'src/pages/home/index.json': '{"usingComponents":{"card":"/copied/card/index"}}',
    'widgets/card/index.ts': `Component({methods:{open(){this.router.navigateTo({url:'../detail/in|dex'})}}});`,
    'widgets/card/index.wxml': '<view/>',
    'src/copied/detail/index.ts': 'Page({});', 'src/copied/detail/index.wxml': '<view/>',
  }, 'widgets/card/index.ts');
  assert.deepEqual((await graph.definitions()).map((item) => item.path), ['src/copied/detail/index.ts']);
});
