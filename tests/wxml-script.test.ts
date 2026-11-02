import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { Definition, LanguageRequest, WorkspaceReader } from '../src/api';
import { createScriptResolver } from '../src/languages/typescript';
import type { ScriptOptions } from '../src/languages/typescript/project';
import { createWxmlPlugin } from '../src/languages/wxml';

/** 模拟文件图及未保存缓冲区，竖线指定模板光标位置。 */
function fixture(template: string, files: Record<string, string>, options: ScriptOptions = {}) {
  const root = 'file:///workspace';
  const documents = new Map(Object.entries({ 'index.wxml': template.replace('|', ''), ...files }).map(([file, text]) => [new URL(file, root + '/').toString(), text]));
  const reads: string[] = [];
  const reader: WorkspaceReader = {
    root: () => root,
    read: async (uri) => {
      reads.push(uri);
      if (uri.startsWith('file:///typescript-lib/')) {
        try { return { text: await readFile(new URL('../node_modules/typescript/lib/' + uri.split('/').pop(), import.meta.url), 'utf8') }; } catch { return undefined; }
      }
      const text = documents.get(uri);
      return text === undefined ? undefined : { text, version: 3 };
    },
  };
  const request: LanguageRequest = { document: { uri: root + '/index.wxml', text: template.replace('|', ''), version: 1, languageId: 'wxml' }, offset: template.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const features = createWxmlPlugin(undefined, createScriptResolver(reader, () => options)).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  /** 走真正的 WXML 提供器，以验证解析范围和依赖注入。 */
  const definitions = (): Promise<readonly Definition[]> => Promise.resolve(features.definition!.provide(request));
  /** 悬浮通过同一公开提供器读取声明注释。 */
  const hover = () => features.hover!.provide(request);
  /** 核对文件和名称，确保结果落到原始声明。 */
  const targets = async () => (await definitions()).map((item) => `${item.uri.slice(root.length + 1)}:${documents.get(item.uri)?.slice(item.range.start, item.range.end)}`);
  return { request, documents, reads, definitions, targets, hover };
}

/** 公用的重导出、重命名及上下文暴露链。 */
const chain = {
  'index.ts': `import { Status as LocalStatus, title as caption, run as handler, Model } from './barrel'; const forwarded = caption; Page({data:{caption:forwarded, Status:LocalStatus, model:new Model()}, methods:{onTap:handler}});`,
  'barrel.ts': `export { State as Status, title, execute as run, Model } from './middle';`,
  'middle.ts': `export * from './original';`,
  'original.ts': `export const title = 'hello'; export enum State { Ready, Done } export function execute() {} export class Model { name='demo'; save() {} }`,
};

test('变量、枚举和函数沿导入别名及重导出链回到原始声明', async () => {
  for (const [template, target] of [['{{cap|tion}}', 'title'], ['{{Sta|tus.Ready}}', 'State'], ['{{Status.Rea|dy}}', 'Ready'], ['<view bindtap="onT|ap"/>', 'execute'], ['{{model.sa|ve()}}', 'save'], ['{{model.na|me}}', 'name']]) {
    assert.deepEqual(await fixture(template!, chain).targets(), [`original.ts:${target}`], template);
  }
});

test('本地字面量、断言对象和方法直接定位，跳转不读取无关导入', async () => {
  const files = { 'index.ts': `import shared from './heavy';Component({behaviors:[shared],data:{count:0,uploadConfig:{} as UploadConfig},methods:{submit(){}}});`, 'heavy.ts': 'export default Behavior({data:{inherited:true}});' };
  for (const [template, name] of [['{{co|unt}}', 'count'], ['{{uploadCon|fig}}', 'uploadConfig'], ['<view bindtap="sub|mit"/>', 'submit']]) {
    const graph = fixture(template!, files);
    assert.deepEqual(await graph.targets(), [`index.ts:${name}`]);
    assert.deepEqual(graph.reads, ['file:///workspace/index.ts']);
    assert.equal((await graph.definitions())[0]!.version, 3);
  }
});

test('跨文件变量按别名及重导出读取目标链，不展开方法体和旁支依赖', async () => {
  const files = {
    ...chain,
    'index.ts': `import unrelated from './heavy';${chain['index.ts']}`,
    'original.ts': `import unused from './heavy';${chain['original.ts']}`,
    'heavy.ts': `import deep from './deep';export default ()=>deep();`,
    'deep.ts': 'export default ()=>1;',
  };
  for (const [template, target] of [['{{cap|tion}}', 'title'], ['{{Sta|tus}}', 'State'], ['<view bindtap="onT|ap"/>', 'execute']]) {
    const graph = fixture(template!, files);
    assert.deepEqual(await graph.targets(), [`original.ts:${target}`]);
    assert.ok(!graph.reads.some((uri) => /\/(?:heavy|deep)\.ts$/.test(uri)));
    assert.equal((await graph.definitions())[0]!.version, 3);
  }
});

test('Behavior 首跳按覆盖顺序读取无参工厂和继承链，略过无关方法依赖', async () => {
  const files = {
    'index.ts': `import unused from './heavy';import earlier from './earlier';import {build as create} from './barrel';Component({behaviors:[earlier,create()]});`,
    'barrel.ts': `export {default as build} from './factory';`,
    'factory.ts': `import nested from './nested';export default ()=>{const config={};return Behavior({behaviors:[nested],methods:{own(){}}});};`,
    'nested.ts': `import helper from './heavy';export default Behavior({methods:{/** 提交 */ submit(){helper();}}});`,
    'earlier.ts': `import heavy from './heavy';export default Behavior({methods:{submit(){heavy();}}});`,
    'heavy.ts': `export default ()=>{};`,
  };
  const graph = fixture('<view bindtap="sub|mit"/>', files);
  assert.deepEqual(await graph.targets(), ['nested.ts:submit']);
  assert.ok(!graph.reads.some((uri) => /\/(?:earlier|heavy)\.ts$/.test(uri)));
  assert.equal((await graph.hover())?.description, '提交');
  const shadowed = fixture('<view bindtap="sub|mit"/>', { ...files, 'index.ts': `import nested from './nested';Component({behaviors:[nested],data:{submit:'本页字段'}});` });
  assert.deepEqual(await shadowed.targets(), ['index.ts:submit']);
});

test('动态继承分支、工厂局部绑定和显式配置类型不被按需路径误判', async () => {
  const dynamic = fixture('<view bindtap="ru|n"/>', {
    'index.ts': `import a from './a';import b from './b';import c from './c';Component({behaviors:[a,flag?b:c]});`,
    'a.ts': `export default Behavior({methods:{run(){}}});`,
    'b.ts': `export default Behavior({methods:{run(){}}});`,
    'c.ts': `export default Behavior({methods:{run(){}}});`,
  });
  assert.deepEqual(await dynamic.targets(), ['b.ts:run', 'c.ts:run']);
  const local = fixture('<view bindtap="ru|n"/>', {
    'index.ts': `import build from './factory';Component({behaviors:[build()]});`,
    'factory.ts': `import {run} from './other';export default ()=>{const run=()=>{};return Behavior({methods:{run}});};`,
    'other.ts': `export function run(){}`,
  });
  assert.deepEqual(await local.targets(), ['factory.ts:run']);
  for (const script of [
    `const config:{data:{visible:boolean}}={data:{visible:true,hidden:true}};Page(config);`,
    `Page(({data:{visible:true,hidden:true}} as {data:{visible:boolean}}));`,
  ]) assert.deepEqual(await fixture('{{hid|den}}', { 'index.ts': script }).targets(), []);
  assert.deepEqual(await fixture('{{tar|get}}', { 'index.ts': `const config={hidden:true,visible:true} as {visible:boolean};Page({data:{target:config.hidden}});` }).targets(), []);
});

test('跨文件声明草稿变化、缺失模块创建和目标版本在每次首跳重新核对', async () => {
  const graph = fixture('{{cap|tion}}', { 'index.ts': `import {label} from './source';Page({data:{caption:label}});` });
  assert.deepEqual(await graph.targets(), []);
  graph.documents.set('file:///workspace/source.ts', `export const label='新建';`);
  assert.deepEqual(await graph.targets(), ['source.ts:label']);
  const before = (await graph.definitions())[0]!;
  graph.documents.set('file:///workspace/source.ts', `/** 新增注释改变位置 */\nexport const label='草稿';`);
  const after = (await graph.definitions())[0]!;
  assert.ok(after.range.start > before.range.start);
  assert.equal(after.version, 3);
  assert.deepEqual(await graph.targets(), ['source.ts:label']);
});

test('动态展开、脚本别名和类型限定的数据对象仍沿完整语义确认来源', async () => {
  const files = { 'source.ts': 'export const title="原始标题";' };
  for (const script of [
    `import {title} from './source';Page({data:{title}});`,
    `import {title} from './source';Page({data:{...{title}}});`,
    `import {title} from './source';const data={title};Page({data});`,
  ]) assert.deepEqual(await fixture('{{ti|tle}}', { ...files, 'index.ts': script }).targets(), ['source.ts:title']);
  const hidden = fixture('{{hid|den}}', { 'index.ts': `Page({data:({hidden:true} as unknown as {visible:boolean})});` });
  assert.deepEqual(await hidden.targets(), []);
});

test('括号、可选链、静态字符串下标和中文标识符', async () => {
  assert.deepEqual(await fixture('{{(Status)?.["Rea|dy"]}}', chain).targets(), ['original.ts:Ready']);
  assert.deepEqual(await fixture('{{名|称}}', { 'index.ts': 'const 来源 = "值"; Page({data:{名称:来源}})' }).targets(), ['index.ts:来源']);
});

test('仅暴露页面上下文，忽略普通文本、注释、字符串及对象字面量键名', async () => {
  for (const template of ['{{tit|le}}', '<view title="cap|tion"/>', '<!-- {{cap|tion}} -->', '{{"cap|tion"}}', '{{{cap|tion:1}}}', '<wxs>var x = "{{cap|tion}}"</wxs>']) {
    assert.deepEqual(await fixture(template, chain).targets(), [], template);
  }
  assert.deepEqual(await fixture('{{{value:cap|tion}}}', chain).targets(), ['original.ts:title']);
});

test('对象展开和 Behavior 工厂参数穿透，当前方法优先覆盖继承方法', async () => {
  const files = {
    'index.ts': `import { build } from './behavior'; import { handle } from './source'; const list=[build(handle)]; Component({behaviors:[...list], data:{...{caption:'local'}}, methods:{own(){}}});`,
    'behavior.ts': `export function build(handler){ return Behavior({ data:{ inherited:'yes' }, methods:{ onTap:handler, own(){return 1;} } }); }`,
    'source.ts': 'export function handle() {}',
  };
  assert.deepEqual(await fixture('<view catch:tap="onT|ap"/>', files).targets(), ['source.ts:handle']);
  assert.deepEqual(await fixture('{{inher|ited}}', files).targets(), ['behavior.ts:inherited']);
  assert.deepEqual(await fixture('<view bindtap="ow|n"/>', files).targets(), ['index.ts:own']);
  assert.deepEqual(await fixture('{{cap|tion}}', files).targets(), ['index.ts:caption']);
});

test('完整选中事件方法后仍能定位命名导出的 Behavior 声明及注释', async () => {
  const files = {
    'index.ts': `import { SpeedBehavior } from './SpeedBehavior'; export default Component({behaviors:[SpeedBehavior]});`,
    'SpeedBehavior.ts': `export const SpeedBehavior=Behavior({methods:{/** 选择倍速 */ selectSpeed(e:any){}}});`,
  };
  for (const template of ['<van-action-sheet bindselect="selectSpeed|"/>', '<view bind:tap="selectSpeed| "/>', "<view catchtap='selectSpeed|'/> "]) {
    const graph = fixture(template, files);
    assert.deepEqual(await graph.targets(), ['SpeedBehavior.ts:selectSpeed']);
    const definitions = await graph.definitions();
    assert.equal(graph.request.document.text.slice(definitions[0]!.originRange.start, definitions[0]!.originRange.end), 'selectSpeed');
    assert.equal((await graph.hover())?.description, '选择倍速');
  }
});

test('方法名末尾沿多层 Behavior 工厂、别名及重导出定位，循环继承安全终止', async () => {
  const files = {
    'index.ts': `import { build as local } from '@behaviors'; Component({behaviors:[local()],methods:{own(){}}});`,
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@behaviors":["behaviors"]}}}',
    'behaviors/index.ts': `export { create as build } from './factory';`,
    'behaviors/factory.ts': `import nested from './nested'; export function create(){return Behavior({behaviors:[nested],methods:{own(){}}});}`,
    'behaviors/nested.ts': `import { SpeedBehavior } from './speed'; export default Behavior({behaviors:[SpeedBehavior]});`,
    'behaviors/speed.ts': `import nested from './nested'; export const SpeedBehavior=Behavior({behaviors:[nested],methods:{selectSpeed(){}}});`,
    'unused.ts': `export const unrelated=Behavior({methods:{selectSpeed(){}}});`,
  };
  assert.deepEqual(await fixture('<view bindselect="selectSpeed|"/>', files).targets(), ['behaviors/speed.ts:selectSpeed']);
  assert.deepEqual(await fixture('<view bindtap="own|"/>', files).targets(), ['index.ts:own']);
  assert.deepEqual(await fixture('<view bindtap="missing|"/>', files).targets(), []);
});

test('名称末尾的插值和成员继续定位原声明，属性键及普通文本仍被忽略', async () => {
  assert.deepEqual(await fixture('{{caption|}}', chain).targets(), ['original.ts:title']);
  assert.deepEqual(await fixture('{{Status.Ready|}}', chain).targets(), ['original.ts:Ready']);
  for (const template of ['<view title="caption|"/>', '<view bindtap="selectSpeed"|/>', '<!-- <view bindtap="selectSpeed|"/> -->', '{{{caption|:1}}}']) {
    assert.deepEqual(await fixture(template, chain).targets(), [], template);
  }
});

test('路径映射、tsconfig 继承与目录入口可跨文件解析', async () => {
  const files = { 'index.ts': `import { label } from '@shared'; Page({data:{title:label}})`, 'tsconfig.json': '{"extends":"./base.json"}', 'base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@shared":["shared"]}}}', 'shared/index.ts': 'export { label } from "./data"', 'shared/data.ts': 'export const label="ok"' };
  assert.deepEqual(await fixture('{{ti|tle}}', files).targets(), ['shared/data.ts:label']);
});

test('template 与 setup 返回值及 Component 属性支持定位', async () => {
  const files = { 'index.ts': `const color='red'; export default { properties:{enabled:{type:Boolean,value:true}}, template:{color}, setup(){return {answer:42}}, methods:{tap(){}} }` };
  for (const [key, target] of [['co|lor', 'color'], ['ans|wer', 'answer'], ['ena|bled', 'enabled'], ['ta|p', 'tap']]) {
    assert.deepEqual(await fixture(`{{${key}}}`, files).targets(), [`index.ts:${target}`]);
  }
});

test('wx:for 别名与默认变量定位局部声明，成员沿集合查找', async () => {
  const files = { 'index.ts': `Page({data:{rows:[{name:'one', children:[{label:'two'}]}], item:{wrong:1}}})` };
  const template = '<view wx:for="{{rows}}" wx:for-item="row"><text>{{row.na|me}}</text></view>';
  assert.deepEqual(await fixture(template, files).targets(), ['index.ts:name']);
  assert.deepEqual(await fixture('<view wx:for="{{rows}}" wx:for-item="row">{{ro|w}}</view>', files).targets(), ['index.wxml:row']);
  assert.deepEqual(await fixture('<view wx:for="{{rows}}">{{it|em}}</view>', files).targets(), ['index.wxml:wx:for']);
  assert.deepEqual(await fixture('<view wx:for="{{rows}}"><view wx:for="{{item.children}}">{{item.la|bel}}</view></view>', files).targets(), ['index.ts:label']);
  assert.deepEqual(await fixture('<view wx:for="{{rows}}">{{item.wr|ong}}</view>', files).targets(), []);
  assert.deepEqual(await fixture('<view wx:for="{{rows}}"/>{{item.wr|ong}}', files).targets(), ['index.ts:wrong']);
});

test('循环引用、取消、缺失文件和读取预算安全终止', async () => {
  assert.deepEqual(await fixture('{{x|x}}', { 'index.ts': `import {xx} from './b'; Page({data:{xx}})`, 'b.ts': `export {xx} from './index'` }).targets(), []);
  assert.deepEqual(await fixture('{{cap|tion}}', chain, { maxFiles: 1 }).targets(), []);
  assert.deepEqual(await fixture('{{cap|tion}}', {}).targets(), []);
  const graph = fixture('{{cap|tion}}', chain);
  Object.assign(graph.request.cancellation, { isCancellationRequested: true });
  assert.deepEqual(await graph.targets(), []);
  assert.deepEqual(graph.reads, []);
});

test('未保存脚本内容每次请求刷新，定义版本与目标文本保持一致', async () => {
  const graph = fixture('{{cap|tion}}', chain);
  const first = (await graph.definitions())[0]!;
  assert.equal(first.version, 3);
  graph.documents.set('file:///workspace/original.ts', '\n\n' + chain['original.ts']);
  const second = (await graph.definitions())[0]!;
  assert.equal(second.range.start, first.range.start + 2);
});

test('JavaScript CommonJS 的 require、解构和 Behavior 导出链可穿透', async () => {
  const files = {
    'index.js': `const { build } = require('./behavior'); const { tap } = require('./handlers'); Component({behaviors:[build(tap)]});`,
    'behavior.js': `exports.build = function(handler) { return Behavior({data:{label:'ok'}, methods:{onTap:handler}}); };`,
    'handlers.js': `const action = () => {}; module.exports = {tap:action};`,
  };
  assert.deepEqual(await fixture('{{la|bel}}', files).targets(), ['behavior.js:label']);
  assert.deepEqual(await fixture('<view bindtap="onT|ap"/>', files).targets(), ['handlers.js:action']);
});

test('命名空间、默认导入和字面量对象解构沿原始声明解析', async () => {
  const files = {
    'index.ts': `import * as module from './source'; import alias from './source'; const {value: caption}=module.model; Page({data:{State:module.State, caption}, methods:{tap:alias}});`,
    'source.ts': `export enum State { Ready } export const model={value:'ok'}; export default function action(){}`,
  };
  assert.deepEqual(await fixture('{{State.Rea|dy}}', files).targets(), ['source.ts:Ready']);
  assert.deepEqual(await fixture('{{cap|tion}}', files).targets(), ['source.ts:value']);
  assert.deepEqual(await fixture('<view bindtap="ta|p"/>', files).targets(), ['source.ts:action']);
});

test('同名成员按对象展开顺序覆盖，条件分支保留候选', async () => {
  const files = { 'index.ts': `import { left, right } from './source'; const model=flag?left:right; Page({data:{model, ...{title:'first'}, title:'last'}})`, 'source.ts': `export const left={label:'one'}; export const right={label:'two'}` };
  const graph = fixture('{{ti|tle}}', files);
  assert.equal((await graph.definitions())[0]?.range.start, files['index.ts'].lastIndexOf('title'));
  const branches = fixture('{{model.la|bel}}', files);
  assert.equal((await branches.definitions()).length, 2);
});

test('已知数字下标只定位对应成员，不混入其它数组元素', async () => {
  const graph = fixture('{{rows[1].na|me}}', { 'index.ts': `Page({data:{rows:[{name:'first'},{name:'second'}]}})` });
  const definitions = await graph.definitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.range.start, graph.documents.get('file:///workspace/index.ts')!.lastIndexOf('name'));
});

test('带空格的导入 URI、库包声明与类静态成员保持原始定位', async () => {
  const files = {
    'index.ts': `import { Model, label } from './shared source'; Page({data:{Model,label}})`,
    'shared source.ts': `export class Model { static version=1; static save(){} } export const label='ok'`,
  };
  assert.deepEqual(await fixture('{{la|bel}}', files).targets(), ['shared%20source.ts:label']);
  assert.deepEqual(await fixture('{{Model.sa|ve}}', files).targets(), ['shared%20source.ts:save']);
  const packages = { 'index.ts': `import { State } from 'example'; Page({data:{State}})`, 'node_modules/example/package.json': '{"name":"example","types":"index.d.ts"}', 'node_modules/example/index.d.ts': 'export declare enum State { Ready }' };
  assert.deepEqual(await fixture('{{State.Rea|dy}}', packages).targets(), ['node_modules/example/index.d.ts:Ready']);
});

test('循环集合使用显式数组类型或断言时可定位接口成员', async () => {
  for (const declaration of ['const rows: Row[] = [];', 'const rows = [] as Row[];']) {
    const graph = fixture('<view wx:for="{{rows}}">{{item.na|me}}</view>', {
      'index.ts': `import type { Row } from './model'; ${declaration} Page({data:{rows}})`,
      'model.ts': 'export interface Row { name: string; }',
    }, { libraryUri: 'file:///typescript-lib/lib.es5.d.ts' });
    assert.deepEqual(await graph.targets(), ['model.ts:name']);
  }
});

test('默认导出的 CommonJS 页面及条件页面保留正确上下文', async () => {
  assert.deepEqual(await fixture('{{ti|tle}}', { 'index.js': `const title='ok'; module.exports={data:{title}};` }).targets(), ['index.js:title']);
  const graph = fixture('{{ti|tle}}', { 'index.ts': `const left={data:{title:'one'}}; const right={data:{title:'two'}}; Page(flag?left:right);` });
  assert.equal((await graph.definitions()).length, 2);
});

test('包的深层依赖不会抢占多层 Behavior 方法的解析预算', async () => {
  const files: Record<string, string> = {
    'index.ts': `import { noise } from 'noise'; import navbar from './navbar'; Component({behaviors:[navbar], data:{noise}});`,
    'navbar.ts': `import camera from './camera'; export default Behavior({behaviors:[camera()]});`,
    'camera.ts': `import { permission } from './permission'; export default () => Behavior({behaviors:[permission]});`,
    'permission.ts': `const createPermission = () => Behavior({methods:{ /** 授权设置 */ authScopeSetting(){}}}); export const permission=createPermission();`,
    'node_modules/noise/package.json': '{"name":"noise","types":"index.d.ts"}',
    'node_modules/noise/index.d.ts': `export declare const noise: string; ${Array.from({length: 20}, (_, index) => `export * from './part${index}';`).join(' ')}`,
  };
  for (let index = 0; index < 20; index++) files[`node_modules/noise/part${index}.d.ts`] = `export declare const noise${index}: string;`;
  const graph = fixture('<button bind:tap="authScopeSet|ting"/>', files, {maxFiles: 8});
  assert.deepEqual(await graph.targets(), ['permission.ts:authScopeSetting']);
  assert.equal((await graph.hover())?.description, '授权设置');
});

test('变量、枚举成员、接口成员和事件悬浮显示原声明的各类注释', async () => {
  const files = {
    'index.ts': `import { title as caption, Status, handle } from './source'; import type { Row } from './source'; const rows:Row[]=[]; Page({data:{caption,Status,rows, /** 相机是否显示 */ showCamera:false}, methods:{onTap:handle, // 授权设置\n authScopeSetting(){}}});`,
    'source.ts': `/** 页面标题\n * 第二行说明\n */\nexport const title='hello'; export enum Status { /** 已就绪 */ Ready } // 处理点击\n export function handle(){} export interface Row { /** 姓名 */ name:string; }`,
  };
  for (const [template, description] of [
    ['{{cap|tion}}', '页面标题\n第二行说明'],
    ['{{Status.Rea|dy}}', '已就绪'],
    ['{{showCa|mera}}', '相机是否显示'],
    ['<button bind:tap="onT|ap"/>', '处理点击'],
    ['<button catch:tap="authScopeSet|ting"/>', '授权设置'],
    ['<view wx:for="{{rows}}">{{item.na|me}}</view>', '姓名'],
  ]) {
    const graph = fixture(template!, files, {libraryUri:'file:///typescript-lib/lib.es5.d.ts'});
    const result = await graph.hover();
    assert.equal(result?.description, description, template);
    assert.equal(graph.request.document.text.slice(result!.range.start, result!.range.end), result?.title);
  }
});

test('悬浮不借用相邻或外层注释，未保存的声明注释及时刷新', async () => {
  const graph = fixture('{{ti|tle}}', { 'index.ts': 'Page({data:{ /** 标题说明 */ title:"ok", other:"" }});' });
  assert.equal((await graph.hover())?.description, '标题说明');
  graph.documents.set('file:///workspace/index.ts', 'Page({data:{ // 新的标题说明\n title:"ok" }});');
  assert.equal((await graph.hover())?.description, '新的标题说明');
  assert.equal(await fixture('{{ot|her}}', { 'index.ts': '/** 页面说明 */ Page({data:{ /** 标题说明 */ title:"ok", other:"" }});' }).hover(), undefined);
  const cancelled = fixture('{{ti|tle}}', { 'index.ts': '/** 标题说明 */ const title="ok"; Page({data:{title}});' });
  Object.assign(cancelled.request.cancellation, {isCancellationRequested:true});
  assert.equal(await cancelled.hover(), undefined);
  assert.deepEqual(cancelled.reads, []);
});
