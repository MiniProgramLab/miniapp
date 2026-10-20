import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { LanguageRequest, TextEdit, TextRange, WorkspaceReader } from '../src/api';
import { createComponentScriptResolver, createScriptResolver, createWxsPlugin } from '../src/languages/typescript';
import { createComponentResolver, createTemplateResolver, createWxmlPlugin } from '../src/languages/wxml';
import { extractComponent, extractTemplate, prepareComponent, templateRefactors } from '../src/languages/wxml/refactor';
import { createCssModule } from '../src/languages/css';
import { scriptModules } from '../src/languages/wxml/wxs';
import { materializeComponent } from '../src/languages/wxml/component-templates';

/** 双方括号只标记待提取选区，项目快照由只读端口提供。 */
function fixture(source: string, files: Record<string, string> = {}) {
  const start = source.indexOf('[[['), end = source.indexOf(']]]') - 3;
  assert.ok(start >= 0 && end >= start);
  const text = source.replace('[[[', '').replace(']]]', '');
  const document = { uri: 'file:///extract/page.wxml', languageId: 'wxml', version: 3, text };
  const documents = new Map(Object.entries({ 'page.wxml': text, ...files }).map(([name, text]) => ['file:///extract/' + name, text]));
  const reader: WorkspaceReader = { root: () => 'file:///extract/', read: async (uri) => { const text = documents.get(uri); return text === undefined ? undefined : { text }; }, findFiles: async (_uri, pattern, limit) => [...documents.keys()].filter((uri) => pattern === '**/*.wxml' ? uri.endsWith('.wxml') : /\.(?:ts|js|wxs)$/.test(uri)).slice(0, limit) };
  const request: LanguageRequest = { document, offset: start, cancellation: { isCancellationRequested: false } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const range: TextRange = { start, end };
  /** 编辑只应用到副本，保留版本及原文校验。 */
  const applied = (edits: readonly TextEdit[]): string => {
    let result = text;
    for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) { assert.equal(edit.expectedText, text); assert.equal(edit.oldText, text.slice(edit.range.start, edit.range.end)); result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end); }
    return result;
  };
  return { request, range, reader, scripts, applied, documents };
}

/** 在独立文件副本中模拟原子编辑，并核对创建约束和原始快照。 */
function applyFiles(documents: ReadonlyMap<string, string>, edits: readonly TextEdit[]): Map<string, string> {
  const result = new Map(documents);
  for (const uri of new Set(edits.map((edit) => edit.uri))) {
    const changes = edits.filter((edit) => edit.uri === uri);
    const original = documents.get(uri);
    let text = original ?? '';
    for (const edit of [...changes].sort((left, right) => right.range.start - left.range.start)) {
      if (edit.create) assert.equal(original, undefined, '创建文件不能覆盖源码');
      else {
        assert.notEqual(original, undefined);
        if (edit.expectedText !== undefined) assert.equal(edit.expectedText, original);
        if (edit.oldText !== undefined) assert.equal(edit.oldText, original!.slice(edit.range.start, edit.range.end));
      }
      text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
    }
    result.set(uri, text);
  }
  return result;
}

test('提取模板传递真正的外部数据，保留局部循环、事件和同文件模块', async () => {
  const graph = fixture('<wxs module="utils" src="./utils.wxs"/><view>[[[<block wx:for="{{rows}}" wx:for-item="row"><view bindtap="onTap">{{row.name}} {{title}} {{utils.format(row.value)}}</view></block>]]]</view>');
  const edits = await extractTemplate(graph.request, graph.range, 'row-list', graph.scripts, graph.reader);
  const result = graph.applied(edits);
  assert.match(result, /<template is="row-list" data="\{\{rows: rows, title: title\}\}"\/>/);
  assert.match(result, /<template name="row-list">[\s\S]*wx:for-item="row"/);
  assert.match(result, /bindtap="onTap"/);
  assert.ok(!edits[0]!.newText.includes('utils:') && !edits[0]!.newText.includes('row:'));
});

test('条件节点的循环和分支留在调用处，循环项作为真实传参进入新模板', async () => {
  const graph = fixture('<view wx:if="{{ready}}"/><block>[[[<view wx:for="{{rows}}" wx:for-item="row" wx:if="{{row.visible}}" class="row">{{row.name}}</view>]]]</block>');
  const edits = await extractTemplate(graph.request, graph.range, 'row-card', graph.scripts, graph.reader);
  assert.match(edits[0]!.newText, /wx:for="\{\{rows\}\}" wx:for-item="row" wx:if="\{\{row.visible\}\}"/);
  assert.match(edits[0]!.newText, /data="\{\{row: row\}\}"/);
  assert.ok(!edits[1]!.newText.includes('wx:for') && !edits[1]!.newText.includes('wx:if'));
  const branch = fixture('<view wx:if="{{ready}}"/>[[[<view wx:else>完成</view>]]]<text/>');
  assert.match((await extractTemplate(branch.request, branch.range, 'finish', branch.scripts))[0]!.newText, /wx:else/);
});

test('独立包含文件的自由数据进入契约，内部循环及声明正文不混入', async () => {
  const graph = fixture('<view>[[[<block wx:for="{{rows}}"><include src="./body.wxml"/></block>]]]</view>', { 'body.wxml': '<text>{{item.name}} {{caption}}</text><template name="unused">{{notUsed}}</template>' });
  const edits = await extractTemplate(graph.request, graph.range, 'list', graph.scripts, graph.reader);
  assert.match(edits[0]!.newText, /rows: rows, caption: caption/);
  assert.ok(!edits[0]!.newText.includes('item:') && !edits[0]!.newText.includes('notUsed'));
  const nested = fixture('<template name="outer">[[[<view>{{caption}}</view>]]]</template>');
  assert.match((await extractTemplate(nested.request, nested.range, 'inner', nested.scripts))[0]!.newText, /caption: caption/);
});

test('本地与导入命名冲突、循环包含、部分节点和双向绑定拒绝部分编辑', async () => {
  const duplicate = fixture('[[[<view/>]]]<template name="taken"><text/></template>');
  await assert.rejects(() => extractTemplate(duplicate.request, duplicate.range, 'taken', duplicate.scripts), /已经声明/);
  const imported = fixture('<import src="./shared.wxml"/>[[[<view/>]]]', { 'shared.wxml': '<template name="taken"><text/></template>' });
  await assert.rejects(() => extractTemplate(imported.request, imported.range, 'taken', imported.scripts, imported.reader), /导入模板/);
  const cycle = fixture('[[[<include src="./body.wxml"/>]]]', { 'body.wxml': '<include src="./page.wxml"/>' });
  await assert.rejects(() => extractTemplate(cycle.request, cycle.range, 'list', cycle.scripts, cycle.reader), /循环/);
  const partial = fixture('<view>[[[内容</view>]]]');
  assert.deepEqual(templateRefactors(partial.request, partial.range, partial.scripts), []);
  const model = fixture('[[[<input model:value="{{value}}"/>]]]');
  await assert.rejects(() => extractTemplate(model.request, model.range, 'input-view', model.scripts), /写回路径/);
});

test('原生提取入口支持命名与预览，表达式中的键名和字符串不成为依赖', async () => {
  const graph = fixture('[[[<view>{{user.name}} {{list[index]}} {{utils.format("literal")}}</view>]]]<wxs module="utils" src="./utils.wxs"/>');
  const actions = templateRefactors(graph.request, graph.range, graph.scripts);
  assert.equal(actions[0]!.preview, true); assert.equal(actions[0]!.kind, 'refactor.extract');
  assert.ok(actions[0]!.input!.validate('"bad"'));
  const edits = await actions[0]!.input!.select('detail', graph.request.cancellation);
  assert.match(edits[0]!.newText, /user: user, list: list, index: index/);
  assert.ok(!edits[0]!.newText.includes('name:') && !edits[0]!.newText.includes('literal:'));
  const plugin = createWxmlPlugin(undefined, graph.scripts, undefined, undefined, graph.reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  assert.ok((await plugin.codeActions!.provide(graph.request, graph.range, 'refactor.extract')).some((action) => action.input && action.preview));
});

test('提取拒绝拆开多节点条件链，输入前展示确定的写回限制', async () => {
  const graph = fixture('[[[<view wx:if="{{ready}}"/><view wx:elif="{{other}}"/>]]]<view wx:else/>');
  await assert.rejects(() => extractTemplate(graph.request, graph.range, 'part', graph.scripts), /完整条件链/);
  assert.match(templateRefactors(graph.request, graph.range, graph.scripts)[0]!.disabled!, /完整条件链/);
  const model = fixture('[[[<input model:value="{{value}}"/>]]]');
  assert.match(templateRefactors(model.request, model.range, model.scripts)[0]!.disabled!, /写回路径/);
});

test('组件提取转发保持原始事件和父级 this，多方法与已有名称不冲突', async () => {
  const source = 'Page({ __extractEvent0(){}, onTap(event){this.received=event;return event.detail.value}, onChange(event){this.changed=event} });';
  const graph = fixture('[[[<view bindtap="onTap"/>]]]', { 'page.js': source });
  const result = await graph.scripts.extractComponentParent!(graph.request, 'row-card', './components/row-card/index', ['onTap', 'onChange', 'onTap']);
  assert.ok(result && result.bindings.length === 2);
  assert.equal(result.bindings[0]!.method, '__extractEvent1');
  let rewritten = source;
  for (const edit of [...result.edits].filter((edit) => edit.uri.endsWith('.js')).sort((left, right) => right.range.start - left.range.start)) {
    assert.equal(edit.uri, 'file:///extract/page.js'); assert.equal(edit.expectedText, source);
    rewritten = rewritten.slice(0, edit.range.start) + edit.newText + rewritten.slice(edit.range.end);
  }
  const parsed = ts.createSourceFile('page.js', rewritten, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  let parent: any;
  runInNewContext(rewritten, { Page(options: unknown) { parent = options; } });
  const event = { detail: { value: 7 }, currentTarget: { dataset: { id: 'original' } }, target: { id: 'inner' } };
  assert.equal(parent[result.bindings[0]!.method]({ detail: { originalEvent: event } }), 7);
  assert.equal(parent.received, event);
  parent[result.bindings[1]!.method]({ detail: { originalEvent: event } });
  assert.equal(parent.changed, event);
});

test('转发插入消费组件而非 Behavior，并遵守声明宏方法路径及动态边界', async () => {
  const graph = fixture('[[[<view bindtap="onTap"/>]]]', { 'page.ts': "import {shared} from './shared'; Component({behaviors:[shared]});", 'shared.ts': 'export const shared=Behavior({methods:{onTap(event:any){}}});' });
  const result = await graph.scripts.extractComponentParent!(graph.request, 'row-card', './components/row-card/index', ['onTap']);
  assert.ok(result?.edits.every((edit) => ['file:///extract/page.ts', 'file:///extract/page.json'].includes(edit.uri)));
  assert.ok(result?.edits.some((edit) => edit.uri.endsWith('.json') && edit.create && edit.newText.includes('row-card')));
  assert.ok(result?.edits.some((edit) => edit.newText.includes('"methods"')));
  const configured = fixture('[[[<view/>]]]', { 'page.ts': "import {screen} from './runtime'; screen({actions:{onTap(event:any){}}});", 'runtime.ts': 'export function screen(options:any){return options}' });
  const scripts = createScriptResolver(configured.reader, () => ({ adapters: [{ name: 'screen', module: './runtime', kind: 'component', methods: 'actions' }] }));
  const adapted = await scripts.extractComponentParent!(configured.request, 'row-card', './components/row-card/index', ['onTap']);
  assert.ok(adapted?.edits.some((edit) => edit.newText.includes('__extractEvent0')));
  const empty = fixture('[[[<view/>]]]', { 'page.ts': "import {screen} from './runtime';import {shared} from './shared';screen({behaviors:[shared]});", 'runtime.ts': 'export function screen(options:any){return options}', 'shared.ts': 'export const shared=Behavior({methods:{onTap(event:any){}}});' });
  const emptyScripts = createScriptResolver(empty.reader, () => ({ adapters: [{ name: 'screen', module: './runtime', kind: 'component', methods: 'actions' }] }));
  const merged = await emptyScripts.extractComponentParent!(empty.request, 'row-card', './components/row-card/index', ['onTap']);
  assert.equal(merged?.edits.length, 1, '同一注册对象中的配置和方法插入应合并');
  assert.match(merged!.edits[0]!.newText, /"usingComponents"/); assert.match(merged!.edits[0]!.newText, /"actions"/);
  const tree = ts.createSourceFile('page.ts', merged!.edits[0]!.newText, ts.ScriptTarget.Latest, true);
  assert.equal((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  const dynamic = fixture('[[[<view/>]]]', { 'page.ts': 'Component({methods:getMethods()});' });
  assert.equal(await dynamic.scripts.extractComponentParent!(dynamic.request, 'row-card', './components/row-card/index', ['onTap']), undefined);
  assert.equal(await graph.scripts.extractComponentParent!({ ...graph.request, cancellation: { isCancellationRequested: true } }, 'row-card', './components/row-card/index', ['onTap']), undefined);
});

test('组件迁移按顺序改写数据与动态 class，对象简写和事件方法保持原契约', async () => {
  const graph = fixture('[[[<view class="card {{Title ? \'active\' : \'\'}}" bindtap="onTap">{{{Title, title}}}</view>]]]', { 'app.json': '{}', 'page.wxss': '.card{} .active{}' });
  const styles = createCssModule(graph.reader).classes;
  const result = await prepareComponent(graph.request, graph.range, graph.scripts, styles, graph.reader);
  assert.match(result.body, /class="\{\{__extractStyles\.map\(false, 'card ', \(title2 \? 'active' : ''\)\)\}\}"/);
  assert.match(result.body, /\{\{\{Title: title2, title\}\}\}/);
  assert.match(result.body, /bindtap="onTap"/);
  assert.equal(result.style.bindings.length, 2);
  assert.equal(result.styleFiles[0]!.uri, 'file:///extract/page.wxss');
  const loop = fixture('[[[<view wx:for="{{rows}}" wx:for-item="Title" wx:if="{{Title.ready}}">{{Title.name}}</view>]]]', { 'app.json': '{}' });
  const migrated = await prepareComponent(loop.request, loop.range, loop.scripts, createCssModule(loop.reader).classes, loop.reader);
  assert.deepEqual(migrated.data.map((binding) => binding.name), ['Title']);
  assert.match(migrated.control, /wx:for="\{\{rows\}\}"/);
  assert.equal(migrated.body, '<view   >{{title.name}}</view>');
});

test('提取组件原子创建关联文件，事件转发保持原始对象和消费方 this', async () => {
  const graph = fixture('[[[<view class="card {{active ? \'active\' : \'\'}}" bindtap="onTap" data-id="{{id}}">{{title}}</view>]]]', {
    'app.json': '{}', 'page.wxss': '.card{} .active{}',
    'page.js': 'Page({data:{title:"标题",active:true,id:7},onTap(event){this.received=event;return this.marker;}});',
  });
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  const files = applyFiles(graph.documents, edits), base = 'file:///extract/components/card-view/index';
  assert.match(files.get(graph.request.document.uri)!, /<card-view .*bind:extract-event-0="__extractEvent0"/);
  assert.equal(JSON.parse(files.get('file:///extract/page.json')!).usingComponents['card-view'], './components/card-view/index');
  assert.equal(JSON.parse(files.get(base + '.json')!).component, true);
  assert.ok(files.has(base + '.js') && files.has(base + '.wxss') && files.has(base + '.styles.wxs'));
  assert.match(files.get(base + '.wxml')!, /src="\.\/index.styles.wxs"/);
  let parent: Record<string, (...args: any[]) => any> = {}, child: { methods: Record<string, (...args: any[]) => any> } | undefined;
  runInNewContext(files.get('file:///extract/page.js')!, { Page: (value: typeof parent) => { parent = value; } });
  runInNewContext(files.get(base + '.js')!, { Component: (value: NonNullable<typeof child>) => { child = value; } });
  const context = { ...parent, marker: Symbol('消费方'), received: undefined as unknown };
  const original = { currentTarget: { dataset: { id: 7 } }, detail: { value: '原始事件' } };
  child!.methods.onTap!.call({ triggerEvent: (name: string, detail: unknown) => {
    assert.equal(name, 'extract-event-0');
    assert.equal(parent.__extractEvent0!.call(context, { detail }), context.marker);
  } }, original);
  assert.equal(context.received, original);
  const generatedReader: WorkspaceReader = { ...graph.reader, read: async (uri) => files.has(uri) ? { text: files.get(uri)! } : undefined };
  const wxs = createWxsPlugin(generatedReader).setup({ subscriptions: { add: (item) => item }, logger: { info() {}, error() {} } });
  const diagnostics = await (await wxs).diagnostics!.provide({ ...graph.request, document: { ...graph.request.document, uri: base + '.styles.wxs', languageId: 'wxs', text: files.get(base + '.styles.wxs')! } });
  assert.deepEqual(diagnostics, [], '生成的辅助模块也必须通过实际 WXS 检查器');
});

test('默认隔离的组件只迁移局部样式，嵌套组件注册按原路径重定位', async () => {
  const graph = fixture('[[[<view class="card"><nested-card title="{{title}}"/></view>]]]', {
    'app.json': '{}', 'app.wxss': '@import "./missing.styl";', 'page.wxss': '.card{}',
    'page.ts': 'Component({data:{title:"标题"}});', 'page.json': '{"component":true,"usingComponents":{"nested-card":"./nested/index"}}',
    'nested/index.ts': 'Component({properties:{title:String}});', 'nested/index.json': '{"component":true}',
  });
  const components = createComponentResolver(graph.reader, createComponentScriptResolver);
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader, components);
  const files = applyFiles(graph.documents, edits), base = 'file:///extract/components/card-view/index';
  assert.equal(JSON.parse(files.get(base + '.json')!).usingComponents['nested-card'], '../../nested/index');
  const tree = ts.createSourceFile(base + '.ts', files.get(base + '.ts')!, ts.ScriptTarget.Latest, true);
  assert.equal((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  const shared = fixture('[[[<view/>]]]', { 'app.json': '{}', 'app.wxss': '@import "./missing.styl";', 'page.ts': 'Component({options:{styleIsolation:"shared"}});' });
  await assert.rejects(extractComponent(shared.request, shared.range, './components/card-view/index', shared.scripts, createCssModule(shared.reader).classes, shared.reader), /样式|导入/);
});

test('组件提取拒绝目标冲突和越界，取消时不生成任何创建编辑', async () => {
  const graph = fixture('[[[<view/>]]]', { 'app.json': '{}', 'page.js': 'Page({});', 'components/card-view/index.scss': '.existing{}' });
  const extract = (path: string, request = graph.request) => extractComponent(request, graph.range, path, graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  await assert.rejects(extract('./components/card-view/index'), /已经存在/);
  await assert.rejects(extract('../outside/index'), /工作区/);
  await assert.rejects(extract('./components/view/index'), /原生标签/);
  await assert.rejects(extract('./components/new-view/index', { ...graph.request, cancellation: { isCancellationRequested: true } }));
  assert.equal(graph.documents.size, 4, '分析与失败路径不能写入项目');
});

test('组件边界分析区分页面和组件，读取 JSON 隔离配置及真实实例查询', async () => {
  const graph = fixture('[[[<view/>]]]', {
    'page.ts': 'Component({externalClasses:["custom-class"],methods:{query(){const self=this;self.selectComponent("#child");}}});',
    'page.json': '{"styleIsolation":"shared"}',
  });
  const scope = await graph.scripts.componentExtractionScope!(graph.request);
  assert.equal(scope?.globalStyles, true);
  assert.deepEqual(scope?.externalClasses, ['custom-class']);
  assert.deepEqual(scope?.nodeQueries, [{ name: 'selectComponent', selectors: ['#child'] }]);
  const ordinary = fixture('[[[<view/>]]]', { 'page.js': 'Component({methods:{run(){const unrelated={select(){},selectComponent(){}};unrelated.select("x");unrelated.selectComponent("x");}}});' });
  assert.deepEqual((await ordinary.scripts.componentExtractionScope!(ordinary.request))?.nodeQueries, [], '普通对象的同名方法不应阻止提取');
});

test('提取复用外部 WXS，并将内联模块原子迁移为共享文件且保留 require 基准', async () => {
  const graph = fixture('<wxs module="outside" src="./outside.wxs"/><wxs module="counter">var offset=require("./offset.wxs");var count=0;module.exports.next=function(){return ++count+offset.value;};</wxs><wxs module="unused">module.exports={};</wxs>[[[<view>{{counter.next()}} {{outside.format(title)}}</view>]]]<text>{{counter.next()}}</text>', {
    'page.js': 'Page({data:{title:"标题"}});', 'app.json': '{}', 'offset.wxs': 'module.exports={value:10};',
    'outside.wxs': 'module.exports.format=function(value){return value;};', 'page.card-view.counter.wxs': 'module.exports={existing:true};',
  });
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  const files = applyFiles(graph.documents, edits), base = 'file:///extract/components/card-view/index';
  /** 从生成模板读取真实模块路径，避免仅核对某段字符串。 */
  const modules = (uri: string) => scriptModules({ ...graph.request, document: { ...graph.request.document, uri, text: files.get(uri)! } });
  const parent = modules(graph.request.document.uri), child = modules(base + '.wxml');
  assert.equal(child.find((module) => module.name === 'outside')!.uri, 'file:///extract/outside.wxs');
  const counter = parent.find((module) => module.name === 'counter')!;
  assert.equal(counter.uri, child.find((module) => module.name === 'counter')!.uri);
  assert.ok(counter.uri.endsWith('/page.card-view.counter-2.wxs'));
  assert.ok(!child.some((module) => module.name === 'unused'));
  assert.equal(files.get('file:///extract/page.card-view.counter.wxs'), 'module.exports={existing:true};');
  const cache = new Map<string, { exports: any }>();
  /** 按文件身份缓存模块，证明父子模板共享状态及嵌套相对引用。 */
  function load(uri: string): any {
    const previous = cache.get(uri); if (previous) return previous.exports;
    const module = { exports: {} }; cache.set(uri, module);
    runInNewContext(files.get(uri)!, { module, require: (reference: string) => load(new URL(reference, uri).href) });
    return module.exports;
  }
  assert.equal(load(counter.uri).next(), 11);
  assert.equal(load(child.find((module) => module.name === 'counter')!.uri).next(), 12);
  assert.ok(!edits.some((edit) => edit.uri.endsWith('/offset.wxs') || edit.uri.endsWith('/outside.wxs')));
});

test('组件提取展开多层 include 并保留循环数据、条件与属性别名', async () => {
  const graph = fixture('<wxs module="check" src="./check.wxs"/>[[[<view wx:if="{{check.ready}}" wx:for="{{rows}}" wx:for-item="row"><include src="./parts/row.wxml" wx:if="{{check.visible(row)}}"/></view>]]]', {
    'app.json': '{}', 'page.js': 'Page({data:{rows:[],Title:"标题"}});', 'page.wxss': '.card{}',
    'check.wxs': 'module.exports={ready:true,visible:function(row){return row.visible;}};',
    'parts/row.wxml': '<include src="./label.wxml"/><template name="unused">{{missing}}</template>',
    'parts/label.wxml': '<text class="card">{{row.name}} {{Title}}</text>',
  });
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  const files = applyFiles(graph.documents, edits), child = files.get('file:///extract/components/card-view/index.wxml')!;
  assert.match(files.get(graph.request.document.uri)!, /wx:for="\{\{rows\}\}" wx:for-item="row"/);
  assert.match(files.get(graph.request.document.uri)!, /title="\{\{Title\}\}"/);
  assert.match(files.get(graph.request.document.uri)!, /wx:if="\{\{check.ready\}\}"/);
  assert.match(child, /<block wx:if="\{\{__extractModule0.visible\(row\)\}\}">/);
  assert.match(child, /\{\{row.name\}\} \{\{title\}\}/);
  assert.match(child, /class="extract-style-0"/);
  assert.ok(!child.includes('<include') && !child.includes('missing'));
  assert.ok(edits.every((edit) => !edit.uri.includes('/parts/')), '透明模板源码保持复用');
});

test('实际调用的本地和导入模板保留传参、各自 WXS 及事件与样式归属', async () => {
  const graph = fixture('<wxs module="fmt" src="./root.wxs"/><import src="./parts/templates.wxml"/><template name="local"><text class="label">{{fmt.format(Title)}}</text></template>[[[<view><template is="local" data="{{Title: title}}"/><template is="remote" data="{{value: title}}"/></view>]]]', {
    'page.js': 'Page({data:{title:"标题"},onTap(event){}});', 'app.json': '{}', 'page.wxss': '.label{}',
    'root.wxs': 'module.exports.format=function(value){return "根"+value;};',
    'parts/templates.wxml': '<wxs module="fmt" src="./remote.wxs"/><import src="./nested.wxml"/><template name="remote"><text class="label" bindtap="onTap">{{fmt.format(value)}}</text><template is="nested" data="{{value}}"/></template><template name="unused"><missing-card/></template>',
    'parts/remote.wxs': 'module.exports.format=function(value){return "远程"+value;};', 'parts/nested.wxml': '<template name="nested"><text>{{value}}</text></template>',
  });
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  const files = applyFiles(graph.documents, edits), uri = 'file:///extract/components/card-view/index.wxml', child = files.get(uri)!;
  const request = { ...graph.request, document: { ...graph.request.document, uri, text: child } };
  const modules = scriptModules(request);
  assert.deepEqual(modules.map((module) => module.uri).sort(), ['file:///extract/parts/remote.wxs', 'file:///extract/root.wxs']);
  assert.equal(new Set(modules.map((module) => module.name)).size, 2, '同名模块按声明文件隔离');
  assert.equal([...child.matchAll(/<template name=/g)].length, 3);
  assert.match(child, /data="\{\{Title: title\}\}"/);
  assert.match(child, /\{\{__extractModule0.format\(Title\)\}\}/);
  assert.match(child, /\{\{__extractModule1.format\(value\)\}\}/);
  assert.match(child, /bindtap="onTap"/);
  assert.equal([...child.matchAll(/class="extract-style-0"/g)].length, 2);
  assert.ok(!child.includes('missing-card') && !child.includes('<import'));
  assert.match(files.get('file:///extract/page.js')!, /__extractEvent0/);
  const generatedReader: WorkspaceReader = { ...graph.reader, read: async (uri) => files.has(uri) ? { text: files.get(uri)! } : undefined };
  const resolver = createTemplateResolver(generatedReader, createScriptResolver(generatedReader));
  const features = createWxmlPlugin(undefined, resolver).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (value) => value } });
  const definitions = await features.definition!.provide({ ...request, offset: child.indexOf('__extractModule1.format') + '__extractModule1.format'.length });
  assert.equal(definitions[0]?.uri, 'file:///extract/parts/remote.wxs', '生成模板的真实导航仍落到原模块');
});

test('跨文件内联模块迁移保护原快照，生成别名避开原有模板参数', async () => {
  const graph = fixture('<import src="./parts/shared.wxml"/>[[[<template is="row" data="{{__extractModule0: title}}"/>]]]', {
    'app.json': '{}', 'page.js': 'Page({data:{title:"标题"}});',
    'parts/shared.wxml': '<wxs module="fmt">module.exports.format=function(value){return value;};</wxs><template name="row"><text>{{fmt.format(__extractModule0)}}</text></template>',
  });
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  const files = applyFiles(graph.documents, edits), child = files.get('file:///extract/components/card-view/index.wxml')!;
  assert.match(child, /module="__extractModule1"/);
  assert.match(child, /__extractModule1.format\(__extractModule0\)/);
  const sourceEdit = edits.find((edit) => edit.uri === 'file:///extract/parts/shared.wxml')!;
  assert.equal(sourceEdit.expectedText, graph.documents.get(sourceEdit.uri));
  assert.equal(sourceEdit.version, undefined, '磁盘依赖不能伪造编辑器版本零');
  assert.match(files.get(sourceEdit.uri)!, /src="\.\/shared.card-view.fmt.wxs"/);
});

test('动态、缺失、循环模板与依赖写回契约拒绝生成部分组件', async () => {
  for (const [source, files, reason] of [
    ['[[[<template is="{{name}}"/>]]]', {}, /静态确定/],
    ['[[[<template is="missing"/>]]]', {}, /不能唯一确定/],
    ['<template name="loop"><template is="loop"/></template>[[[<template is="loop"/>]]]', {}, /循环/],
    ['[[[<include src="./cycle.wxml"/>]]]', { 'cycle.wxml': '<include src="./page.wxml"/>' }, /循环/],
    ['<template name="field"><input model:value="{{value}}"/></template>[[[<template is="field" data="{{value}}"/>]]]', {}, /写回/],
    ['<import src="./node_modules/package/template.wxml"/>[[[<template is="row"/>]]]', { 'node_modules/package/template.wxml': '<wxs module="tools">module.exports={value:1};</wxs><template name="row">{{tools.value}}</template>' }, /依赖目录/],
  ] as const) {
    const graph = fixture(source, { 'app.json': '{}', 'page.js': 'Page({data:{value:""}});', ...files });
    await assert.rejects(extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader), reason);
    assert.ok(![...graph.documents.keys()].some((uri) => uri.includes('/components/')));
  }
});

test('样式映射辅助模块不会遮蔽具名模板的参数', async () => {
  const graph = fixture('<template name="row"><text class="{{__extractStyles}}">内容</text></template>[[[<template is="row" data="{{__extractStyles: classes}}"/>]]]', {
    'app.json': '{}', 'page.js': 'Page({data:{classes:"card"}});', 'page.wxss': '.card{}',
  });
  const edits = await extractComponent(graph.request, graph.range, './components/card-view/index', graph.scripts, createCssModule(graph.reader).classes, graph.reader);
  const child = applyFiles(graph.documents, edits).get('file:///extract/components/card-view/index.wxml')!;
  assert.match(child, /module="__extractStyles1"/);
  assert.match(child, /__extractStyles1.map\(false, \(__extractStyles\)\)/);
  assert.match(child, /data="\{\{__extractStyles: classes\}\}"/);
});

test('重复 include 复用实际依赖读取，展开体积超限在创建组件前停止', async () => {
  const graph = fixture('[[[<view>' + '<include src="./shared.wxml"/>'.repeat(20) + '</view>]]]', {
    'app.json': '{}', 'page.js': 'Page({data:{caption:"标题"}});', 'shared.wxml': '<text>{{caption}}</text>',
  });
  let reads = 0;
  const reader: WorkspaceReader = { ...graph.reader, read: async (uri) => { if (uri.endsWith('/shared.wxml')) reads++; return graph.reader.read(uri); } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  await extractComponent(graph.request, graph.range, './components/card-view/index', scripts, createCssModule(reader).classes, reader);
  assert.equal(reads, 1, '同一 include 的迁移不重复读取');
  const large = fixture('[[[<view>' + '<include src="./large.wxml"/>'.repeat(5) + '</view>]]]', { 'large.wxml': '<text>' + '字'.repeat(800000) + '</text>' });
  await assert.rejects(materializeComponent(large.request, large.range, large.scripts, async (from, reference) => {
    const uri = new URL(reference!, from.document.uri).href;
    return { ...from, document: { ...from.document, uri, text: large.documents.get(uri)! } };
  }), /四百万/);
  assert.equal(large.documents.size, 2);
});
