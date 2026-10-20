import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createDataPathPlugin } from '../src/languages/typescript';
import type { ScriptOptions } from '../src/languages/typescript/project';

/** 真实脚本提供器使用内存草稿，当前位置用竖线标记，不修改业务工程。 */
function fixture(source: string, others: Record<string, string> = {}, options: ScriptOptions = {}) {
  const root = 'file:///workspace/';
  const documents = new Map(Object.entries({ 'page.ts': source.replace('|', ''), ...others }).map(([name, text]) => [root + name, text]));
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => documents.get(uri) ?? '', read: async (uri) => { reads++; const text = documents.get(uri); return text === undefined ? undefined : { text, version: 2 }; } };
  const request: LanguageRequest = { document: { uri: root + 'page.ts', text: source.replace('|', ''), languageId: 'typescript', version: 1 }, offset: source.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const features = createDataPathPlugin(reader, () => options).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (value) => value } });
  return { request, features, documents, reads: () => reads };
}

test('setData 对象嵌套路径补全、类型悬浮及声明跳转保留字段范围', async () => {
  const graph = fixture(`Page({data:{user:{/** 用户名称 */ name:'甲',age:1}},open(){this.setData({'user.na|me':'乙'})}});`);
  const item = (await graph.features.completion!.provide(graph.request))[0]!;
  assert.equal(item.label, 'name');
  assert.equal(graph.request.document.text.slice(item.range.start, item.range.end), 'name');
  assert.match(item.documentation, /用户名称/);
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /string/);
  const definition = (await graph.features.definition!.provide(graph.request))[0]!;
  assert.equal(graph.documents.get(definition.uri)!.slice(definition.range.start, definition.range.end), 'name');
});

test('数组下标投影元素字段，越界新增元素不丢失已有元素类型', async () => {
  for (const index of [0, 3, 100]) {
    const graph = fixture(`Page({data:{items:[{title:'甲',done:false}]},open(){this.setData({'items[${index}].ti|tle':'乙'})}});`);
    assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['title']);
    assert.match((await graph.features.hover!.provide(graph.request))!.description, /string/);
  }
});

test('已声明路径赋值类型不兼容时诊断，新字段、动态键与未知值保持开放', async () => {
  const graph = fixture(`Page({data:{user:{name:'甲'},items:[{count:1}]},open(value:any){this.setData({'user.name':1,'items[0].count':'错',newField:true,['items['+value+'].count']:value,'user.later':true})}});|`);
  const diagnostics = await graph.features.diagnostics!.provide(graph.request);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((item) => item.code === 'data-path-type'));
  assert.ok(diagnostics.some((item) => item.message.includes('user.name')));
});

test('观察器多字段、数组成员及通配符使用同一数据声明', async () => {
  const graph = fixture(`Component({data:{user:{name:'甲'},items:[{title:'乙'}]},observers:{'user.name, items[0].ti|tle'(name,title){}}});`);
  const item = (await graph.features.completion!.provide(graph.request))[0]!;
  assert.equal(item.label, 'title');
  assert.equal(graph.request.document.text.slice(item.range.start, item.range.end), 'title');
  const wildcard = fixture(`Component({data:{user:{name:'甲'}},observers:{'user.|'(value){}}});`);
  assert.ok((await wildcard.features.completion!.provide(wildcard.request)).some((item) => item.label === '**'));
});

test('Behavior 状态、属性和内部 data 不受公开组件导出或同名方法影响', async () => {
  const graph = fixture(`import shared from './shared';Component({behaviors:[shared,'wx://component-export'],properties:{enabled:Boolean},data:{title:'甲'},methods:{title(){},open(){this.setData({'settings.na|me':'乙'})}},export(){return{close(){}}}});`, { 'shared.ts': `export default Behavior({data:{settings:{name:'默认'}}});` });
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['name']);
  const root = fixture(`Component({properties:{enabled:Boolean},methods:{open(){this.setData({'en|abled':1})}});`);
  assert.equal((await root.features.completion!.provide(root.request))[0]?.detail, 'boolean');
  assert.equal((await root.features.diagnostics!.provide(root.request))[0]?.code, 'data-path-type');
});

test('const this 别名保留实际绑定，普通同名对象及嵌套函数 this 不被接管', async () => {
  const graph = fixture(`Page({data:{user:{name:'甲'}},open(){const self=this;function callback(){self.setData({'user.na|me':'乙'})};callback()}});`);
  assert.equal((await graph.features.completion!.provide(graph.request))[0]?.label, 'name');
  for (const source of [
    `Page({data:{user:{name:'甲'}},open(){function callback(){this.setData({'user.na|me':1})}}});`,
    `const model={setData(value:any){}};model.setData({'user.na|me':1});`,
  ]) {
    const unrelated = fixture(source);
    assert.deepEqual(await unrelated.features.completion!.provide(unrelated.request), []);
    assert.deepEqual(await unrelated.features.diagnostics!.provide(unrelated.request), []);
  }
});

test('包装器与声明宏状态字段按通用适配规则补全，不按方法名称猜测框架', async () => {
  const graph = fixture(`import {mount} from './runtime';mount({data:{user:{name:'甲'}},methods:{open(){this.setData({'user.na|me':'乙'})}});`, { 'runtime.ts': 'export function mount(options:any){Component(options)}' });
  assert.equal((await graph.features.completion!.provide(graph.request))[0]?.label, 'name');
  const mapped = fixture(`import {screen as mount} from 'portable';mount({state:{user:{name:'甲'}},actions:{open(){this.setData({'user.na|me':'乙'})}});`, {}, { adapters: [{ name: 'screen', module: 'portable', kind: 'page', data: 'state', methods: 'actions' }] });
  assert.equal((await mapped.features.completion!.provide(mapped.request))[0]?.label, 'name');
});

test('连续新请求复用完整脚本图，取消不返回过期路径结果', async () => {
  const graph = fixture(`Page({data:{user:{name:'甲'}},open(){this.setData({'user.na|me':'乙'})}});`);
  await graph.features.completion!.provide(graph.request);
  const before = graph.reads();
  await graph.features.completion!.provide({ ...graph.request });
  assert.equal(graph.reads(), before);
  assert.deepEqual(await graph.features.definition!.provide({ ...graph.request, cancellation: { isCancellationRequested: true } }), []);
});

test('显式对象类型保留可空字段，初始化值不会缩窄后续更新的类型', async () => {
  const graph = fixture(`import type {User} from './model';Page({data:{user:{name:'甲'} as User},open(){this.setData({'user.na|me':null})}});`, { 'model.ts': `export interface User { /** 可空名称 */ name:string|null }`, 'tsconfig.json': '{"compilerOptions":{"strictNullChecks":true}}' });
  const item = (await graph.features.completion!.provide(graph.request))[0]!;
  assert.equal(item.label, 'name');
  assert.match(item.detail, /null/);
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /null/);
  assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), []);
});

test('显式只读数组类型覆盖空数组及非空数组的初始化元素', async () => {
  for (const initial of ['[]', "[{title:'甲',count:1}]"]) {
    const graph = fixture(`import type {Rows} from './model';Page({data:{items:${initial} as Rows},open(){this.setData({'items[100].ti|tle':1})}});`, { 'model.ts': `export interface Rows { readonly [index:number]: { /** 项标题 */ title:string; count:number }; readonly length:number }` });
    const item = (await graph.features.completion!.provide(graph.request))[0]!;
    assert.equal(item.label, 'title');
    assert.equal(item.detail, 'string');
    const definition = (await graph.features.definition!.provide(graph.request))[0]!;
    assert.equal(graph.documents.get(definition.uri)!.slice(definition.range.start, definition.range.end), 'title');
    assert.equal((await graph.features.diagnostics!.provide(graph.request))[0]?.code, 'data-path-type');
  }
});
