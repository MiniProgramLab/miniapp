import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import type { LanguageRequest, TextEdit, WorkspaceReader } from '../src/api';
import type { ScriptOptions } from '../src/languages/typescript/project';
import { createComponentScriptResolver, createScriptResolver, createWxsPlugin } from '../src/languages/typescript';
import { createComponentResolver, createDatasetFeatures, createInstanceFeatures, createRenameFeatures, createTemplateResolver, createWxmlPlugin } from '../src/languages/wxml';

/** 内存草稿通过真实组合边界验证三项语义功能，竖线只标记当前查询位置。 */
function fixture(files: Record<string, string>, entry = 'page.wxml', root = 'file:///workspace/', options: ScriptOptions = {}) {
  const text = files[entry]!;
  const documents = new Map(Object.entries(files).map(([file, content]) => [new URL(file, root).href, file === entry ? content.replace('|', '') : content]));
  const reader: WorkspaceReader = {
    root: () => root,
    read: async (uri) => { const text = documents.get(uri); return text === undefined ? undefined : { text, version: 5 }; },
    findFiles: async (_uri, pattern, limit) => [...documents.keys()].filter((uri) => pattern === '**/*.wxml' ? uri.endsWith('.wxml') : pattern === '**/*.json' ? uri.endsWith('.json') : pattern === '**/*.d.ts' ? uri.endsWith('.d.ts') : /\.(?:[cm]?[jt]sx?|wxs|wxml)$/.test(uri)).slice(0, limit),
  };
  const request: LanguageRequest = { document: { uri: new URL(entry, root).href, text: text.replace('|', ''), version: 1, languageId: entry.endsWith('.wxml') ? 'wxml' : entry.endsWith('.wxs') ? 'wxs' : entry.endsWith('.js') ? 'javascript' : 'typescript' }, offset: text.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader, () => options));
  const components = createComponentResolver(reader, (snapshot) => createComponentScriptResolver(snapshot, () => options));
  const instances = createInstanceFeatures(reader, scripts, createComponentScriptResolver(reader, () => options), components);
  const rename = createRenameFeatures(reader, scripts, components, () => ({ maxFiles: options.maxRenameFiles ?? 5000 }), instances);
  const dataset = createDatasetFeatures(reader, scripts, rename.references);
  const context = { logger: { info() {}, error() {} }, subscriptions: { add: <T>(item: T): T => item } };
  const features = entry.endsWith('.wxs') ? createWxsPlugin(reader, () => options, rename, rename.references).setup(context) : createWxmlPlugin(undefined, scripts, undefined, components, reader, rename, rename.references, rename.highlights).setup(context);
  /** 目标名称与坐标必须对应最新源码。 */
  const targets = async () => (await features.definition!.provide(request)).map((item) => `${item.uri.slice(root.length)}:${documents.get(item.uri)!.slice(item.range.start, item.range.end)}`);
  /** 将编辑应用到副本，验证完整结果而不写入磁盘。 */
  const renamed = async (name: string): Promise<Map<string, string>> => {
    const edits = await rename.provide(request, name);
    const result = new Map(documents);
    for (const uri of new Set(edits.map((edit) => edit.uri))) {
      let text = result.get(uri)!;
      for (const edit of edits.filter((item) => item.uri === uri).sort((left, right) => right.range.start - left.range.start)) {
        assert.equal(text.slice(edit.range.start, edit.range.end), edit.oldText);
        text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
      }
      result.set(uri, text);
    }
    return result;
  };
  /** 同时核对每个返回编辑的作用域及原始文本。 */
  const changes = async (name: string): Promise<readonly TextEdit[]> => rename.provide(request, name);
  return { request, documents, features, targets, renamed, changes, rename, dataset, instances, reader };
}

test('模板补全处理空表达式、成员和事件，继承方法覆盖与定义解析保持一致', async () => {
  const files = {
    'page.ts': `import shared from './shared';Component({behaviors:[shared],data:{user:{name:'甲',age:1},count:0},methods:{/** 页面提交 */ submit(value:number){}}});`,
    'shared.ts': `export default Behavior({data:{inherited:true},methods:{submit(value:string){},reset(){}}});`,
  };
  const names = async (template: string) => {
    const graph = fixture({ ...files, 'page.wxml': template });
    return (await graph.features.completion!.provide(graph.request)).map((item) => item.label);
  };
  assert.deepEqual(new Set(await names('<view>{{ | }}</view>')), new Set(['user', 'count', 'inherited', 'submit', 'reset']));
  assert.deepEqual(await names('<view>{{user.na|me}}</view>'), ['name']);
  assert.deepEqual(await names('<view bindtap="|"/>'), ['submit', 'reset']);
  const graph = fixture({ ...files, 'page.wxml': '<view bindtap="sub|"/>' });
  const item = (await graph.features.completion!.provide(graph.request))[0]!;
  assert.match(item.detail, /number/);
  assert.match(item.documentation, /页面提交/);
  assert.equal(graph.request.document.text.slice(item.range.start, item.range.end), 'sub');
});

test('动态组件注册、未知展开和循环包装器保持开放，模块适配识别 require', async () => {
  for (const source of [
    'declare const dynamic:any;Page({usingComponents:dynamic});',
    'declare const dynamic:any;Page({...dynamic});',
    'declare const dynamic:any;definePageConfig({usingComponents:{...dynamic}});',
    'function wrapper(options:any){const {...rest}=options;Component(rest)};declare const dynamic:any;wrapper({...dynamic});',
    'function wrapper(options:any){return wrapper(options)};wrapper({});',
  ]) {
    const graph = fixture({ 'page.ts': source, 'page.wxml': '<custom-card|/>' });
    assert.ok(!(await graph.features.diagnostics!.provide(graph.request)).some((item) => item.code === 'unregistered-component'), source);
  }
  const options: ScriptOptions = { adapters: [{ module: 'portable', name: 'screen', kind: 'page', data: 'state' }] };
  const graph = fixture({ 'page.js': 'const runtime=require("portable");runtime.screen({state:{caption:"甲"}});', 'page.wxml': '{{cap|}}' }, 'page.wxml', 'file:///workspace/', options);
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['caption']);
  const unrelated = fixture({ 'page.js': 'const runtime=require("unrelated");runtime.screen({state:{caption:"甲"}});', 'page.wxml': '{{cap|}}' }, 'page.wxml', 'file:///workspace/', options);
  assert.deepEqual(await unrelated.features.completion!.provide(unrelated.request), []);
  const global = fixture({ 'app.config.ts': 'declare const dynamic:any;defineAppConfig({usingComponents:dynamic});', 'page.ts': 'Page({});', 'page.wxml': '<custom-card|/>' });
  assert.ok(!(await global.features.diagnostics!.provide(global.request)).some((item) => item.code === 'unregistered-component'));
});

test('dataset 补全、类型与双向跳转只接受实际处理函数和对应事件节点', async () => {
  const files = {
    'page.ts': `Component({data:{records:[{id:1,meta:{title:'甲'}}]},methods:{submit(event:any){return event.currentTarget.dataset.|},other(event:any){return event.currentTarget.dataset.unrelated}}});`,
    'page.wxml': '<view wx:for="{{records}}" data-entry="{{item}}" data-user-id="{{item.id}}" data-elementType="text" bind:tap="submit"/><view data-unrelated="true" bindtap="other"/>',
    'independent.ts': 'Page({submit(event:any){return event.currentTarget.dataset.unrelated}});',
    'independent.wxml': '<view data-unrelated="true" bindtap="submit"/>',
  };
  const graph = fixture(files, 'page.ts');
  const completions = await graph.dataset.completion!.provide(graph.request);
  assert.deepEqual(new Set(completions.map((item) => item.label)), new Set(['entry', 'userId', 'elementtype']));
  assert.match(completions.find((item) => item.label === 'userId')!.detail, /^(?:number|1)$/);
  const nested = fixture({ ...files, 'page.ts': files['page.ts'].replace('dataset.|', 'dataset.entry.meta.|') }, 'page.ts');
  assert.deepEqual((await nested.dataset.completion!.provide(nested.request)).map((item) => item.label), ['title']);
  const selected = fixture({ ...files, 'page.ts': files['page.ts'].replace('dataset.|', 'dataset.userI|d') }, 'page.ts');
  const definitions = await selected.dataset.definition!.provide(selected.request);
  assert.deepEqual(definitions.map((item) => [item.uri.split('/').at(-1), selected.documents.get(item.uri)!.slice(item.range.start, item.range.end)]), [['page.wxml', 'user-id']]);
  const template = fixture({ ...files, 'page.ts': files['page.ts'].replace('dataset.|', 'dataset.userId'), 'page.wxml': files['page.wxml'].replace('data-user-id', 'data-user-i|d') }, 'page.wxml');
  const reverse = await template.dataset.definition!.provide(template.request);
  assert.equal(reverse.length, 1);
  assert.equal(template.documents.get(reverse[0]!.uri)!.slice(reverse[0]!.range.start, reverse[0]!.range.end), 'userId');
});

test('dataset 识别参数解构、const 别名和字符串下标，target 补全保留冒泡候选', async () => {
  const files = { 'page.wxml': '<view data-user-id="{{3}}" bindtap="submit"><view data-child-id="child"/></view>',
    'page.ts': `Page({submit({currentTarget:{dataset}}:any){const data=dataset;return data['userI|d']}});` };
  const graph = fixture(files, 'page.ts');
  assert.equal((await graph.dataset.definition!.provide(graph.request)).length, 1);
  const target = fixture({ ...files, 'page.ts': 'Page({submit(event:any){return event.target.dataset.|}});' }, 'page.ts');
  assert.deepEqual(new Set((await target.dataset.completion!.provide(target.request)).map((item) => item.label)), new Set(['userId', 'childId']));
  assert.equal(await target.dataset.rename!.prepare(target.request), undefined);
  const mutable = fixture({ ...files, 'page.ts': `Page({submit(event:any){let data=event.currentTarget.dataset;return data.userI|d}});` }, 'page.ts');
  assert.deepEqual(await mutable.dataset.definition!.provide(mutable.request), []);
});

test('dataset 改名保留解构局部变量，节点冲突及动态下标拒绝部分编辑', async () => {
  const files = { 'page.wxml': '<view data-user-id="{{3}}" bindtap="submit"/>',
    'page.ts': `Page({submit(event:any){const {userId}=event.currentTarget.dataset;return event.currentTarget.dataset.userI|d+userId}});` };
  const graph = fixture(files, 'page.ts');
  const edits = await graph.dataset.rename!.provide(graph.request, 'accountId');
  assert.equal(edits.filter((item) => item.uri.endsWith('.ts')).length, 2);
  assert.ok(edits.some((item) => item.newText === 'accountId: userId'));
  assert.ok(edits.some((item) => item.newText === 'account-id'));
  for (const source of ['event.currentTarget.dataset[key];', 'event.target.dataset.userId;', 'consume(event);', 'consume(event.currentTarget.dataset);', 'const {...rest}=event.currentTarget.dataset;rest.userId;']) {
    const unsafe = fixture({ ...files, 'page.ts': files['page.ts'].replace('const {userId}', source + 'const {userId}') }, 'page.ts');
    await assert.rejects(async () => unsafe.dataset.rename!.provide(unsafe.request, 'accountId'), /动态|冒泡/);
  }
  const conflict = fixture({ ...files, 'page.wxml': '<view data-user-id="{{3}}" data-account-id="{{4}}" bindtap="submit"/>' }, 'page.ts');
  await assert.rejects(async () => conflict.dataset.rename!.provide(conflict.request, 'accountId'), /已经声明/);
});

test('dataset 沿 Behavior 实现和不同暴露别名追踪，引用排除未消费的同名函数', async () => {
  const files = {
    'shared.ts': 'export function submit(event:any){return event.currentTarget.dataset.userI|d};export default Behavior({methods:{submit}});',
    'page.ts': `import shared from './shared';Component({behaviors:[shared]});`,
    'page.wxml': '<view data-user-id="{{1}}" bindtap="submit"/>',
    'second.ts': `import {submit} from './shared';Component({methods:{confirm:submit}});`,
    'second.wxml': '<view data-user-id="{{2}}" bindtap="confirm"/>',
    'independent.ts': 'Page({submit(event:any){return event.currentTarget.dataset.userId}});',
    'independent.wxml': '<view data-user-id="{{3}}" bindtap="submit"/>',
  };
  const graph = fixture(files, 'shared.ts');
  const references = await graph.dataset.references!.provide(graph.request, true);
  assert.deepEqual(new Set(references.map((item) => item.uri.split('/').at(-1))), new Set(['shared.ts', 'page.wxml', 'second.wxml']));
  const edits = await graph.dataset.rename!.provide(graph.request, 'accountId');
  assert.equal(edits.length, 3);
});

test('TS require 静态读取的源码属于同一 Program，类型查询不会访问未绑定对象', async () => {
  const graph = fixture({
    'page.ts': `const bridge=require('./bridge');Page({data:bridge.model,submit(event:any){return event.currentTarget.dataset.entry}});`,
    'bridge.ts': 'module.exports={model:{entry:{count:1}}};',
    'page.wxml': '<view data-entry="{{entry}}" bindtap="submit">{{entry.count|}}</view>',
  });
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['count']);
  assert.equal((await graph.features.diagnostics!.provide(graph.request)).length, 0);
});

test('dataset 缓存响应模板草稿及暴露别名变化，连续查询无需重复读取绑定图', async () => {
  const graph = fixture({ 'page.ts': 'Page({submit(event:any){return event.currentTarget.dataset.userI|d}});', 'page.wxml': '<view data-user-id="{{1}}" bindtap="submit"/>' }, 'page.ts');
  const stamps = new Map<string, number>();
  let reads = 0;
  const reader: WorkspaceReader = { ...graph.reader, revision: (uri) => String(stamps.get(uri) ?? 0), read: async (uri) => { reads++; return graph.reader.read(uri); } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const dataset = createDatasetFeatures(reader, scripts, createRenameFeatures(reader, scripts).references);
  assert.equal((await dataset.definition!.provide(graph.request)).length, 1);
  reads = 0;
  assert.equal((await dataset.definition!.provide(graph.request)).length, 1);
  assert.equal(reads, 0);
  const template = 'file:///workspace/page.wxml';
  graph.documents.set(template, '<view data-account-id="{{1}}" bindtap="submit"/>');
  stamps.set(template, 1);
  assert.deepEqual(await dataset.definition!.provide(graph.request), []);
  graph.documents.set(template, '<view data-user-id="{{1}}" bindtap="submit"/>');
  stamps.set(template, 2);
  assert.equal((await dataset.definition!.provide(graph.request)).length, 1);
  graph.documents.set('file:///workspace/page.ts', 'Page({other(event:any){return event.currentTarget.dataset.userId}});');
  stamps.set('file:///workspace/page.ts', 1);
  const text = graph.documents.get('file:///workspace/page.ts')!;
  const changed = { ...graph.request, document: { ...graph.request.document, text, version: 2 }, offset: text.indexOf('userId') + 2 };
  assert.deepEqual(await dataset.definition!.provide(changed), []);
});

test('组件实例关联实际节点、公开方法及参数返回值，const 别名和继承方法保留实现位置', async () => {
  const files = {
    'page.ts': `Page({open(){const dialog=this.selectComponent('#panel');return dialog.sho|w(2)}});`,
    'page.json': '{"usingComponents":{"custom-panel":"./panel"}}',
    'page.wxml': '<custom-panel id="panel" class="popup primary"/>',
    'panel.ts': `import shared from './shared';Component({behaviors:[shared],data:{account:{name:'甲'}},properties:{title:String},methods:{/** 打开面板 */ show(count:number):string{return String(count)}}});`,
    'shared.ts': 'export default Behavior({methods:{/** 关闭面板 */ hide(force:boolean):void{}}});',
  };
  const graph = fixture(files, 'page.ts');
  const completions = await graph.instances.completion!.provide(graph.request);
  assert.equal(completions.find((item) => item.label === 'show')!.detail, '(count: number) => string');
  const definitions = await graph.instances.definition!.provide(graph.request);
  assert.ok(definitions.some((item) => item.uri.endsWith('panel.ts') && graph.documents.get(item.uri)!.slice(item.range.start, item.range.end) === 'show'));
  const optional = fixture({ ...files, 'page.ts': files['page.ts'].replace('sho|w(2)', 'show|?.(2)') }, 'page.ts');
  assert.ok((await optional.instances.definition!.provide(optional.request)).some((item) => item.uri.endsWith('panel.ts')));
  const inherited = fixture({ ...files, 'page.ts': files['page.ts'].replace('sho|w(2)', 'hi|de(true)') }, 'page.ts');
  assert.ok((await inherited.instances.definition!.provide(inherited.request)).some((item) => item.uri.endsWith('shared.ts')));
  const signature = fixture({ ...files, 'page.ts': files['page.ts'].replace('sho|w(2)', 'show(|)') }, 'page.ts');
  assert.match((await signature.instances.signatureHelp!.provide(signature.request))!.signatures[0]!.label, /show\(count: number\): string/);
  const selector = fixture({ ...files, 'page.ts': files['page.ts'].replace("'#panel'", "'#pa|nel'").replace('sho|w', 'show') }, 'page.ts');
  const targets = await selector.instances.definition!.provide(selector.request);
  assert.ok(targets.some((item) => item.uri.endsWith('page.wxml')));
  assert.ok(targets.some((item) => item.uri.endsWith('panel.ts')));
  const nested = fixture({ ...files, 'page.ts': files['page.ts'].replace('sho|w(2)', 'data.account.|') }, 'page.ts');
  assert.deepEqual((await nested.instances.completion!.provide(nested.request)).map((item) => item.label), ['name']);
});

test('组件集合的元素和循环回调可补全方法，普通数组本身不冒充组件实例', async () => {
  const files = { 'page.ts': `Page({run(){const items=this.selectAllComponents('.panel');items[0]?.sh|ow()}});`,
    'page.json': '{"usingComponents":{"custom-panel":"./panel"}}', 'page.wxml': '<custom-panel class="panel"/>', 'panel.ts': 'Component({methods:{show(){}}});' };
  for (const expression of ['items[0]?.sh|ow()', 'items.forEach(item=>item.sh|ow())', "this.selectAllComponents('.panel').find(item=>true)?.sh|ow()"]){
    const graph = fixture({ ...files, 'page.ts': files['page.ts'].replace('items[0]?.sh|ow()', expression) }, 'page.ts');
    assert.ok((await graph.instances.completion!.provide(graph.request)).some((item) => item.label === 'show'), expression);
  }
  const array = fixture({ ...files, 'page.ts': files['page.ts'].replace('items[0]?.sh|ow()', 'items.sh|ow()') }, 'page.ts');
  assert.deepEqual(await array.instances.completion!.provide(array.request), []);
  const property = fixture({ ...files, 'page.ts': files['page.ts'].replace('items[0]?.sh|ow()', "items['extra'].sh|ow()") }, 'page.ts');
  assert.deepEqual(await property.instances.completion!.provide(property.request), []);
});

test('组件自定义导出使用实际公开接口，不把内部方法误暴露给实例调用', async () => {
  const graph = fixture({ 'page.ts': `Page({run(){this.selectComponent('#panel').|}});`, 'page.json': '{"usingComponents":{"custom-panel":"./panel"}}', 'page.wxml': '<custom-panel id="panel"/>',
    'panel.ts': `Component({behaviors:['wx://component-export'],methods:{internal(){}},export(){return{/** 公开打开 */ open(value:number):string{return String(value)}}}});` }, 'page.ts');
  const methods = await graph.instances.completion!.provide(graph.request);
  assert.deepEqual(methods.map((item) => item.label), ['open']);
  assert.match(methods[0]!.detail, /number.*string/);
});

test('实例选择器覆盖 include、复合 class 和实际调用的命名模板，忽略未使用模板', async () => {
  const files = { 'page.ts': `Page({run(){this.selectComponent('.outer > .panel.primary').sh|ow()}});`,
    'page.json': '{"usingComponents":{"custom-panel":"./panel"}}', 'page.wxml': '<import src="./templates.wxml"/><view class="outer"><include src="./part.wxml"/></view><template is="used"/>',
    'part.wxml': '<block><custom-panel class="panel primary"/></block>',
    'templates.wxml': '<template name="unused"><custom-panel id="unused"/></template><template name="used"><custom-panel id="used"/></template>',
    'panel.ts': 'Component({methods:{show(){}}});' };
  const graph = fixture(files, 'page.ts');
  assert.equal((await graph.instances.definition!.provide(graph.request)).length, 1);
  const selector = fixture({ ...files, 'page.ts': files['page.ts'].replace("'.outer > .panel.primary'", "'#|'").replace('sh|ow', 'show') }, 'page.ts');
  const choices = (await selector.instances.completion!.provide(selector.request)).map((item) => item.label);
  assert.deepEqual(choices, ['#used']);
});

test('Behavior 中的实例查询沿导入和重导出筛选消费模板，不混入无关页面', async () => {
  const files = { 'shared.ts': `export default Behavior({methods:{run(){this.selectComponent('#panel').sh|ow()}}});`,
    'entry.ts': "export {default} from './shared';", 'page.ts': "import shared from './entry';Component({behaviors:[shared]});", 'page.wxml': '<custom-panel id="panel"/>',
    'page.json': '{"usingComponents":{"custom-panel":"./panel"}}', 'panel.ts': 'Component({methods:{show(){}}});',
    'other.ts': 'Page({run(){}});', 'other.wxml': '<other-panel id="panel"/>', 'other.json': '{"usingComponents":{"other-panel":"./other-panel"}}', 'other-panel.ts': 'Component({methods:{show(){}}});' };
  const graph = fixture(files, 'shared.ts');
  const definitions = await graph.instances.definition!.provide(graph.request);
  assert.equal(definitions.length, 1);
  assert.ok(definitions[0]!.uri.endsWith('/panel.ts'));
});

test('具有同名模板的公开配置仍反查其他消费页面，不能将共享函数限定在本地', async () => {
  const files = { 'shared.ts': `export const options={methods:{run(){this.selectComponent('#panel').sh|ow()}}};Component(options);`, 'shared.wxml': '<first-panel id="panel"/>',
    'shared.json': '{"usingComponents":{"first-panel":"./first"}}', 'first.ts': 'Component({methods:{show(){}}});',
    'page.ts': "import {options} from './shared';Component(options);", 'page.wxml': '<second-panel id="panel"/>', 'page.json': '{"usingComponents":{"second-panel":"./second"}}', 'second.ts': 'Component({methods:{show(){}}});' };
  const graph = fixture(files, 'shared.ts');
  const targets = await graph.instances.definition!.provide(graph.request);
  assert.deepEqual(new Set(targets.map((target) => target.uri.split('/').at(-1))), new Set(['first.ts', 'second.ts']));
});

test('直接导出的原生注册只拥有本地模板，不把注册标识当作可复用配置', async () => {
  const graph = fixture({ 'page.ts': `export default Component({methods:{run(){this.selectComponent('#panel').sh|ow()}}});`, 'page.wxml': '<custom-panel id="panel"/>',
    'page.json': '{"usingComponents":{"custom-panel":"./panel"}}', 'panel.ts': 'Component({methods:{show(){}}});' }, 'page.ts');
  const access = await createScriptResolver(graph.reader).instanceAccess!(graph.request);
  assert.equal(access!.shared, false);
  assert.equal((await graph.instances.definition!.provide(graph.request)).length, 1);
});

test('实例选择器只诊断完整静态模板，动态节点、slot、无关 this 与未闭合输入不误报', async () => {
  const files = { 'page.ts': `Page({run(){this.selectComponent('#mis|sing')}});`, 'page.wxml': '<view id="plain"/>', 'page.json': '{}'};
  const missing = fixture(files, 'page.ts');
  assert.ok((await missing.instances.diagnostics!.provide(missing.request)).some((item) => item.code === 'unknown-selector'));
  const native = fixture({ ...files, 'page.ts': files['page.ts'].replace('#mis|sing', '#pla|in') }, 'page.ts');
  assert.ok((await native.instances.diagnostics!.provide(native.request)).some((item) => item.code === 'native-selector'));
  for (const template of ['<custom-panel id="{{name}}"/>', '<slot/>', '<template is="{{name}}"/>']) {
    const graph = fixture({ ...files, 'page.wxml': template }, 'page.ts');
    assert.deepEqual(await graph.instances.diagnostics!.provide(graph.request), [], template);
  }
  const unrelated = fixture({ ...files, 'page.ts': `function fake(){this.selectComponent('#mis|sing')};Page({});` }, 'page.ts');
  assert.deepEqual(await unrelated.instances.diagnostics!.provide(unrelated.request), []);
  const arrow = fixture({ ...files, 'page.ts': `Page({run:()=>this.selectComponent('#mis|sing')});` }, 'page.ts');
  assert.deepEqual(await arrow.instances.diagnostics!.provide(arrow.request), []);
  const partial = fixture({ ...files, 'page.ts': `Page({run(){this.selectComponent('#mis|sing)}});` }, 'page.ts');
  assert.deepEqual(await partial.instances.diagnostics!.provide(partial.request), []);
});

test('实例模型复用完整依赖快照，组件、配置、模板及负向依赖变化后重新解析', async () => {
  const graph = fixture({ 'page.ts': `Page({run(){this.selectComponent('#panel').sh|ow()}});`, 'page.json': '{"usingComponents":{"custom-panel":"./panel"}}',
    'page.wxml': '<custom-panel id="panel"/>', 'panel.ts': 'Component({methods:{show(){}}});' }, 'page.ts');
  const stamps = new Map<string, number>();
  let reads = 0;
  const reader: WorkspaceReader = { ...graph.reader, revision: (uri) => String(stamps.get(uri) ?? 0), read: async (uri) => { reads++; return graph.reader.read(uri); } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const inspector = createComponentScriptResolver(reader);
  const components = createComponentResolver(reader, (snapshot) => createComponentScriptResolver(snapshot));
  const instances = createInstanceFeatures(reader, scripts, inspector, components);
  assert.equal((await instances.definition!.provide(graph.request)).length, 1);
  reads = 0;
  assert.equal((await instances.definition!.provide(graph.request)).length, 1);
  assert.equal(reads, 0);
  graph.documents.set('file:///workspace/panel.ts', 'Component({methods:{hide(){}}});');
  stamps.set('file:///workspace/panel.ts', 1);
  assert.deepEqual(await instances.definition!.provide(graph.request), []);
  graph.documents.set('file:///workspace/new-panel.ts', 'Component({methods:{show(){}}});');
  graph.documents.set('file:///workspace/page.json', '{"usingComponents":{"custom-panel":"./new-panel"}}');
  stamps.set('file:///workspace/page.json', 1);
  assert.ok((await instances.definition!.provide(graph.request)).some((item) => item.uri.endsWith('/new-panel.ts')));
  graph.documents.set('file:///workspace/page.wxml', '<custom-panel id="other"/>');
  stamps.set('file:///workspace/page.wxml', 1);
  assert.deepEqual(await instances.definition!.provide(graph.request), []);
});

test('循环及模板传参补全保留类型、嵌套成员和同名局部遮蔽', async () => {
  const files = {
    'page.ts': `interface Array<T>{[n:number]:T;length:number};interface Entry {id:number;meta:{title:string}};Page({data:{records:[] as Entry[],item:{unrelated:true}}});`,
    'page.wxml': '<import src="./shared.wxml"/><template is="row" data="{{entries:records}}"/>',
    'shared.wxml': '<template name="row"><view wx:for="{{entries}}" wx:for-item="record">{{record.meta.|}}</view></template>',
  };
  const graph = fixture(files, 'shared.wxml');
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['title']);
  const loop = fixture({ ...files, 'page.wxml': '<view wx:for="{{records}}">{{item.|}}</view>' });
  assert.deepEqual(new Set((await loop.features.completion!.provide(loop.request)).map((item) => item.label)), new Set(['id', 'meta']));
  const collection = fixture({ ...files, 'page.wxml': '<view wx:for="{{rec|}}"/>' });
  assert.deepEqual((await collection.features.completion!.provide(collection.request)).map((item) => item.label), ['records']);
});

test('原生 properties 补全展示运行时类型，显式对象类型不会暴露配置字段', async () => {
  const files = { 'page.ts': `interface Entry {id:number;meta:{title:string}};Component({properties:{count:Number,title:{type:String,value:''},entry:{type:Object as PropType<Entry>}}});` };
  const root = fixture({ ...files, 'page.wxml': '{{co|}}' });
  assert.equal((await root.features.completion!.provide(root.request))[0]!.detail, 'number');
  const title = fixture({ ...files, 'page.wxml': '{{ti|}}' });
  assert.equal((await title.features.completion!.provide(title.request))[0]!.detail, 'string');
  const entry = fixture({ ...files, 'page.wxml': '{{entry.|}}' });
  assert.deepEqual(new Set((await entry.features.completion!.provide(entry.request)).map((item) => item.label)), new Set(['id', 'meta']));
  assert.equal((await entry.features.diagnostics!.provide(entry.request)).length, 0);
});

test('模板补全跳过注释和字符串，并公开当前 WXS 模块名称', async () => {
  const files = { 'page.ts': 'Page({data:{title:"甲"}});' };
  for (const template of ['<!-- {{ti|}} -->', '<view title="ti|"/>', `<view>{{'ti|'}}</view>`]) {
    const graph = fixture({ ...files, 'page.wxml': template });
    assert.deepEqual(await graph.features.completion!.provide(graph.request), [], template);
  }
  const graph = fixture({ 'page.wxml': '<wxs module="formatters">module.exports={};</wxs>{{for|}}' });
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['formatters']);
});

test('跨语言引用包含 Behavior 方法和模板，排除独立同名方法及覆盖方法', async () => {
  const files = {
    'page.wxml': '<view bindtap="sub|mit"/>',
    'page.ts': `import shared from './shared';Component({behaviors:[shared]});`,
    'shared.ts': `export default Behavior({methods:{submit(){},again(){this.submit()}}});`,
    'other.ts': 'Page({submit(){}});', 'other.wxml': '<view bindtap="submit"/>',
    'overridden.ts': `import shared from './shared';Component({behaviors:[shared],methods:{submit(){}}});`,
    'overridden.wxml': '<view bindtap="submit"/>',
  };
  const graph = fixture(files);
  const references = await graph.features.references!.provide(graph.request, false);
  assert.deepEqual(new Set(references.map((item) => item.uri.replace('file:///workspace/', ''))), new Set(['page.wxml', 'shared.ts']));
  assert.equal(references.filter((item) => item.uri.endsWith('shared.ts')).length, 1, '排除方法声明，保留 this 调用');
  const included = await graph.features.references!.provide(graph.request, true);
  assert.equal(included.filter((item) => item.uri.endsWith('shared.ts')).length, 2);
});

test('脚本函数引用反查不同名模板方法别名，查找不生成改动', async () => {
  const graph = fixture({
    'handler.ts': 'export function exe|cute(){}',
    'page.ts': `import {execute} from './handler';Component({methods:{onTap:execute}});`,
    'page.wxml': '<view bindtap="onTap"/>',
    'other.ts': 'Page({onTap(){}});', 'other.wxml': '<view bindtap="onTap"/>',
  }, 'handler.ts');
  const references = await graph.rename.references.provide(graph.request, false);
  assert.ok(references.some((item) => item.uri.endsWith('page.wxml')));
  assert.ok(!references.some((item) => item.uri.endsWith('other.wxml')));
  assert.equal(graph.documents.get('file:///workspace/page.wxml'), '<view bindtap="onTap"/>');
});

test('模板方法引用穿过同一实现的多个暴露别名，this 调用也保留真实字段范围', async () => {
  const files = {
    'handler.ts': 'export function execute(){}',
    'page.ts': `import {execute} from './handler';Component({methods:{onTap:execute,again(){this.onTap()}}});`,
    'page.wxml': '<view bindtap="onTa|p"/>',
    'second.ts': `import {execute} from './handler';Component({methods:{confirm:execute,again(){this.confirm()}}});`,
    'second.wxml': '<view bindtap="confirm"/>',
  };
  const graph = fixture(files);
  const references = await graph.features.references!.provide(graph.request, false);
  assert.ok(references.some((item) => item.uri.endsWith('second.wxml')));
  const second = references.filter((item) => item.uri.endsWith('second.ts'));
  assert.ok(second.some((item) => graph.documents.get(item.uri)!.slice(item.range.start, item.range.end) === 'confirm'));
  const edits = await graph.changes('renamed');
  assert.ok(!edits.some((edit) => edit.uri.endsWith('second.wxml')), '方法字段改名仍限定原字段，不能把实现引用规则用于修改别名');
});

test('文档引用高亮区分循环遮蔽和独立文件，不运行工作区引用扫描', async () => {
  const graph = fixture({
    'page.ts': `Page({data:{title:'甲',items:[{title:'乙'}]}});`,
    'page.wxml': '{{tit|le}}<view wx:for="{{items}}" wx:for-item="title">{{title}}</view>{{title}}',
    'other.wxml': '{{title}}', 'other.ts': 'Page({data:{title:"丙"}});',
  });
  const ranges = await graph.features.highlights!.provide(graph.request);
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges.map((range) => graph.request.document.text.slice(range.start, range.end)), ['title', 'title']);
  const wxs = fixture({ 'entry.wxs': 'var cou|nt=1;function read(){return count};read();' }, 'entry.wxs');
  const script = await wxs.features.highlights!.provide(wxs.request);
  assert.equal(script.length, 2);
});

test('模板诊断定位名称和成员拼写，原生快速修复只修改对应引用', async () => {
  const graph = fixture({ 'page.ts': `Page({data:{user:{name:'甲'},title:'标题'}});`, 'page.wxml': '<view>{{user.nma|e}}</view><text>{{titel}}</text>' });
  const diagnostics = await graph.features.diagnostics!.provide(graph.request);
  assert.deepEqual(diagnostics.map((item) => item.code), ['unknown-member', 'unknown-variable']);
  const actions = await graph.features.codeActions!.provide(graph.request, { start: graph.request.offset, end: graph.request.offset });
  assert.equal(actions[0]!.title, '改为 name');
  const edit = actions[0]!.edits[0]!;
  assert.equal(graph.request.document.text.slice(edit.range.start, edit.range.end), 'nmae');
  assert.equal(edit.newText, 'name');
});

test('创建处理方法保留已有字段与注释，Page、Component、JS 和换行格式均可解析', async () => {
  for (const [entry, code] of [
    ['page.ts', 'Page({data:{title:"甲"}});'],
    ['page.ts', 'Component({data:{title:"甲"}});'],
    ['page.ts', 'Component({\r\n  methods: {\r\n    /** 原方法 */ submit() {}\r\n  }\r\n});'],
    ['page.js', 'Component({methods:{submit(){}}});'],
  ]) {
    const graph = fixture({ [entry!]: code!, 'page.wxml': '<view bindtap="handleTa|p"/>' });
    const diagnostics = await graph.features.diagnostics!.provide(graph.request);
    assert.equal(diagnostics[0]!.code, 'unknown-handler');
    const actions = await graph.features.codeActions!.provide(graph.request, { start: graph.request.offset, end: graph.request.offset });
    const action = actions.find((item) => item.title.includes('创建事件处理方法'))!;
    assert.ok(action);
    let result = code!;
    for (const edit of [...action.edits].sort((left, right) => right.range.start - left.range.start)) {
      assert.equal(edit.expectedText, code);
      result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end);
    }
    assert.match(result, /handleTap\(_event/);
    if (code!.includes('原方法')) assert.match(result, /原方法/);
    const source = ts.createSourceFile(entry!, result, ts.ScriptTarget.Latest, true, entry!.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    assert.equal((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0, result);
    if (entry!.endsWith('.js')) assert.ok(!result.includes('_event: unknown'));
  }
});

test('未知框架、开放类型、WXS 模块和未完成输入不产生猜测性模板错误', async () => {
  for (const [code, template] of [
    ['customFactory({data:{title:"甲"}});', '{{unk|nown}}'],
    ['Page({data:{value:{} as any}});', '{{value.unk|nown}}'],
    ['Page({data:{value:{} as Record<string,number>}});', '{{value.unk|nown}}'],
    ['Page({data:{}});', '<wxs module="utils">module.exports={};</wxs>{{utils.unk|nown}}'],
    ['Page({data:{}});', '{{user.|}}'],
  ]) {
    const graph = fixture({ 'page.ts': code!, 'page.wxml': template! });
    assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), [], template);
  }
});

test('动态数据及未知 Behavior 不被误报为缺失，静态 setData 字段保留其他拼写检查', async () => {
  for (const code of [
    `Page({data:{},onLoad(){this.setData({later:1})}});`,
    `Page({data:{},onLoad(){this.setData(response)}});`,
    `Component({behaviors:[unknown],data:{}});`,
  ]) {
    const graph = fixture({ 'page.ts': code, 'page.wxml': '{{lat|er}}' });
    assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), []);
  }
  const graph = fixture({ 'page.ts': `Page({data:{title:'甲'},onLoad(){this.setData({later:1})}});`, 'page.wxml': '{{tit|el}}' });
  assert.equal((await graph.features.diagnostics!.provide(graph.request))[0]!.code, 'unknown-variable');
});

test('处理方法可调用性检查拒绝已知标量，函数和 any 不误报', async () => {
  for (const [value, expected] of [['1', true], ['{}', true], ['() => {}', false], ['{} as any', false]] as const) {
    const graph = fixture({ 'page.ts': `Page({data:{handler:${value}}});`, 'page.wxml': '<view bindtap="han|dler"/>' });
    assert.equal((await graph.features.diagnostics!.provide(graph.request)).some((item) => item.code === 'invalid-handler'), expected);
  }
});

test('未注册组件修复保留 JSON 注释和旧配置，泛型占位与平台标签不误报', async () => {
  const files = {
    'app.json': '{}', 'page.json': '{\n  // 原配置\n  "navigationStyle":"custom",\n  "usingComponents": {}\n}',
    'page.ts': 'Page({});', 'page.wxml': '<my-ca|rd/>',
    'components/my-card/index.json': '{"component":true}', 'components/my-card/index.ts': 'Component({});',
  };
  const graph = fixture(files);
  assert.equal((await graph.features.diagnostics!.provide(graph.request))[0]!.code, 'unregistered-component');
  const actions = await graph.features.codeActions!.provide(graph.request, { start: graph.request.offset, end: graph.request.offset });
  const action = actions.find((item) => item.title.startsWith('注册 my-card'))!;
  assert.ok(action);
  let text = files['page.json'];
  for (const edit of [...action.edits].sort((left, right) => right.range.start - left.range.start)) text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
  assert.match(text, /原配置/);
  const parsed = ts.parseConfigFileTextToJson('page.json', text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.config.navigationStyle, 'custom');
  assert.equal(parsed.config.usingComponents['my-card'], './components/my-card/index');
  const placeholders = fixture({ ...files, 'page.json': '{"componentGenerics":{"item":true}}', 'page.wxml': '<item/><scroll-view/><grid-view/>|' });
  assert.ok(!(await placeholders.features.diagnostics!.provide(placeholders.request)).some((item) => item.code === 'unregistered-component'));
});

test('任意组件别名由原生选择列表确定，缺少 JSON 时生成创建编辑', async () => {
  const graph = fixture({
    'app.json': '{}', 'page.ts': 'Component({});', 'page.wxml': '<arbitrary-wid|get/>',
    'widgets/notice/index.json': '{"component":true}', 'widgets/notice/index.ts': 'Component({});',
  });
  const actions = await graph.features.codeActions!.provide(graph.request, { start: graph.request.offset, end: graph.request.offset });
  const action = actions.find((item) => item.choice)!;
  assert.ok(action);
  const choice = action.choice!;
  assert.equal(choice.items[0]!.label, 'widgets/notice/index.json');
  const edits = await choice.select(choice.items[0]!.value);
  assert.equal(edits[0]!.create, true);
  assert.equal(JSON.parse(edits[0]!.newText).usingComponents['arbitrary-widget'], './widgets/notice/index');
  assert.equal(graph.documents.has('file:///workspace/page.json'), false, '提供器只能生成编辑，不能创建用户文件');
});

test('必填参数修复插入属性，原数据表达式和已有值保持不变', async () => {
  const graph = fixture({
    'app.json': '{}', 'page.json': '{"usingComponents":{"my-card":"./card"}}',
    'page.ts': 'Page({});', 'page.wxml': '<my-ca|rd title="已有标题"/>',
    'card.ts': 'Component({properties:{count:{type:Number,required:true},title:String}});',
  });
  const actions = await graph.features.codeActions!.provide(graph.request, { start: graph.request.offset, end: graph.request.offset });
  const action = actions.find((item) => item.title === '补充组件必填参数')!;
  assert.ok(action);
  const edit = action.edits[0]!;
  const result = graph.request.document.text.slice(0, edit.range.start) + edit.newText + graph.request.document.text.slice(edit.range.end);
  assert.match(result, /count="\{\{0\}\}"/);
  assert.match(result, /title="已有标题"/);
});

test('不同名原生包装器静态追踪解构、重导出和无返回值注册', async () => {
  for (const wrapper of [
    `export function mount(options){const {meta,...native}=options;return Component({...native});}`,
    `export function mount(options){Component(options)}`,
  ]) {
    const graph = fixture({
      'page.wxml': '<view bindtap="sub|mit">{{title}}</view>',
      'page.ts': `import {mount as create} from './entry';create({meta:'信息',data:{title:'甲'},methods:{/** 提交 */ submit(){},again(){this.submit()}}});`,
      'entry.ts': `export {mount} from './runtime';`, 'runtime.ts': wrapper,
    });
    assert.deepEqual(await graph.targets(), ['page.ts:submit']);
    assert.ok((await graph.features.completion!.provide(graph.request)).some((item) => item.label === 'submit'));
    assert.ok(!(await graph.features.diagnostics!.provide(graph.request)).some((item) => item.code === 'unknown-handler'));
    const renamed = await graph.renamed('confirm');
    assert.match(renamed.get('file:///workspace/page.ts')!, /confirm\(\).*this.confirm/s);
    assert.match(renamed.get('file:///workspace/page.wxml')!, /bindtap="confirm"/);
  }
});

test('声明宏适配按模块和参数位置映射字段，类型声明提供组件路径字面量', async () => {
  const options: ScriptOptions = { adapters: [{ module: '@screen/runtime', name: 'mount', kind: 'page', argument: 1, data: 'state', methods: 'actions', config: 'nativeConfig' }] };
  const graph = fixture({
    'page.wxml': '<view bindtap="sub|mit">{{title}}</view>',
    'page.ts': `import {mount as create} from '@screen/runtime';create('页面',{state:{title:'甲'},actions:{submit(){}}});`,
    'virtual.d.ts': `declare module '@screen/runtime' {export function mount(name:string,options:any):void}declare module 'virtual-widgets' {export const Card: {brand:true} & '/widgets/card/index'}`,
  }, 'page.wxml', 'vscode-remote://ssh-remote+demo/arbitrary/', options);
  assert.deepEqual(await graph.targets(), ['page.ts:submit']);
  assert.ok((await graph.features.completion!.provide(graph.request)).some((item) => item.label === 'submit'));
  const component = fixture({
    'app.json': '{}', 'page.wxml': '<my-ca|rd/>',
    'page.ts': `import {mount} from '@screen/runtime';import {Card} from 'virtual-widgets';mount('页面',{components:[['my-card',Card]],actions:{}});`,
    'virtual.d.ts': `declare module '@screen/runtime' {export function mount(name:string,options:any):void}declare module 'virtual-widgets' {export const Card: {brand:true} & '/widgets/card/index'}`,
    'widgets/card/index.ts': 'Component({properties:{title:String}});',
  }, 'page.wxml', 'file:///unrelated/', { adapters: options.adapters! });
  assert.deepEqual(await component.targets(), ['widgets/card/index.ts:Component']);
  assert.ok(!(await component.features.diagnostics!.provide(component.request)).some((item) => item.code === 'unregistered-component'));
});

test('组件参数检查识别显式表达式类型和必填属性，未知值保持兼容', async () => {
  const files = {
    'app.json': '{}', 'page.json': '{"usingComponents":{"my-card":"./card"}}',
    'page.ts': `Page({data:{title:'甲',count:1,unknown:{} as any}});`,
    'card.ts': `Component({properties:{count:{type:Number,required:true},title:String}});`,
  };
  for (const [template, code] of [
    ['<my-card count="{{title}}"/>|', 'property-type'],
    ['<my-card/>|', 'missing-property'],
    ['<my-card count="{{count}}" title="{{title}}"/>|', undefined],
    ['<my-card count="{{unknown}}"/>|', undefined],
  ] as const) {
    const graph = fixture({ ...files, 'page.wxml': template });
    const diagnostics = await graph.features.diagnostics!.provide(graph.request);
    assert.deepEqual(diagnostics.map((item) => item.code), code ? [code] : []);
  }
});

/** 外部 WXS 导出通过两层 require 转发，不依赖页面脚本。 */
const wxs = {
  'page.wxml': '<wxs module="utils" src="./utils.wxs"/><view>{{utils.for|mat}}</view>',
  'utils.wxs': `var shared=require('./middle.wxs');module.exports={format:shared.format};`,
  'middle.wxs': `module.exports=require('./source.wxs');`,
  'source.wxs': `/** 转为标题 */ var format=function(value){return value;};exports.format=format;`,
};

test('WXS 成员穿过 require 和导出链，悬浮显示真实声明说明', async () => {
  const graph = fixture(wxs);
  assert.deepEqual(await graph.targets(), ['source.wxs:format']);
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /转为标题/);
  const completions = fixture({ ...wxs, 'page.wxml': '<wxs module="utils" src="./utils.wxs"/><view>{{utils.fo|}}</view>' });
  assert.deepEqual((await completions.features.completion!.provide(completions.request)).map((item) => item.label), ['format']);
});

test('内联 WXS 保留真实文档坐标及名称末尾，内部函数也可查询', async () => {
  const graph = fixture({ 'page.wxml': '<wxs module="utils">/** 格式化 */ function format(value){return value}module.exports={format:format};</wxs><view>{{utils.format|}}</view>' });
  assert.deepEqual(await graph.targets(), ['page.wxml:format']);
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /格式化/);
  const internal = fixture({ 'page.wxml': '<wxs module="utils">function format(value){return value}module.exports={format:for|mat};</wxs>' });
  assert.deepEqual(await internal.targets(), ['page.wxml:format']);
});

test('WXS 文件中的成员导航及补全共用模块链，循环依赖安全终止', async () => {
  const files = { ...wxs, 'entry.wxs': `var utils=require('./utils.wxs');utils.for|mat('值');`, 'source.wxs': `var cycle=require('./utils.wxs');/** 标题 */ function format(value){return value}exports.format=format;` };
  assert.deepEqual(await fixture(files, 'entry.wxs').targets(), ['source.wxs:format']);
  const graph = fixture({ ...files, 'entry.wxs': `var utils=require('./utils.wxs');utils.fo|` }, 'entry.wxs');
  assert.deepEqual((await graph.features.completion!.provide(graph.request)).map((item) => item.label), ['format']);
});

test('WXS 草稿刷新且不识别注释、普通字符串或其他模板的同名模块', async () => {
  const graph = fixture(wxs);
  graph.documents.set('file:///workspace/source.wxs', '\n\n' + wxs['source.wxs']);
  const result = await graph.features.definition!.provide(graph.request);
  assert.equal(result[0]!.range.start, wxs['source.wxs'].indexOf('format') + 2);
  for (const template of ['<!-- <wxs module="utils" src="./utils.wxs"/> -->{{utils.for|mat}}', '<view title="utils.for|mat"/>']) {
    assert.deepEqual(await fixture({ ...wxs, 'page.wxml': template }).targets(), []);
  }
});

test('WXS 参数提示穿透导出链，字符串逗号、嵌套调用和空参数保留正确序号', async () => {
  const source = `/** 格式化金额。\n * @param {number} amount 金额。\n * @param {string} [suffix] 后缀。\n */ function format(amount,suffix){return amount+suffix}module.exports={format:format};`;
  for (const [template, parameter] of [
    ['<wxs module="utils" src="./utils.wxs"/>{{utils.format(|)}}', 0],
    ['<wxs module="utils" src="./utils.wxs"/>{{utils.format("a,b", |"元")}}', 1],
    ['<wxs module="utils" src="./utils.wxs"/>{{utils.format(utils.format(1, |"元"), "元")}}', 1],
  ] as const) {
    const graph = fixture({ 'page.wxml': template, 'utils.wxs': `module.exports=require('./source.wxs');`, 'source.wxs': source });
    const help = await graph.features.signatureHelp!.provide(graph.request);
    assert.equal(help?.activeParameter, parameter, template);
    assert.match(help!.signatures[0]!.label, /amount: number.*suffix\?: string/);
    assert.match(help!.signatures[0]!.documentation, /格式化金额/);
    assert.match(help!.signatures[0]!.parameters[0]!.documentation, /金额/);
  }
  const file = fixture({ 'entry.wxs': `var tools=require('./source.wxs');tools.format(1, |"元");`, 'source.wxs': source }, 'entry.wxs');
  assert.equal((await file.features.signatureHelp!.provide(file.request))?.activeParameter, 1);
  const inline = fixture({ 'page.wxml': '<wxs module="utils">/** 内联格式。 */function format(value){return value}format(|1);module.exports={format:format};</wxs>' });
  assert.match((await inline.features.signatureHelp!.provide(inline.request))!.signatures[0]!.documentation, /内联格式/);
});

test('WXS 调用检查覆盖文件、模板字面量、页面数据和具名模板传参', async () => {
  const source = `/** @param {number} amount */ function format(amount){return amount}module.exports={format:format};`;
  const file = fixture({ 'entry.wxs': `var tools=require('./source.wxs');tools.format('错');tools.format();|`, 'source.wxs': source }, 'entry.wxs');
  const diagnostics = await file.features.diagnostics!.provide(file.request);
  assert.ok(diagnostics.some((item) => item.code === 'wxs-call-count'));
  assert.ok(diagnostics.some((item) => item.code === 'wxs-call-type' && file.request.document.text.slice(item.range.start, item.range.end) === "'错'"));
  for (const files of [
    { 'page.wxml': '<wxs module="utils" src="./source.wxs"/>{{utils.format(|"错")}}' },
    { 'page.wxml': '<wxs module="utils" src="./source.wxs"/>{{utils.format(amou|nt)}}', 'page.ts': `Page({data:{amount:'错'}});` },
    { 'page.wxml': '<template name="card"><wxs module="utils" src="./source.wxs"/>{{utils.format(amou|nt)}}</template><template is="card" data="{{amount: value}}"/>', 'page.ts': `Page({data:{value:'错'}});` },
  ]) {
    const graph = fixture({ ...files, 'source.wxs': source });
    const result = await graph.features.diagnostics!.provide(graph.request);
    assert.ok(result.some((item) => item.code === 'wxs-call-type'), JSON.stringify(result));
    assert.ok(!result.some((item) => item.code === 'unknown-variable' && item.message.includes('utils')));
  }
});

test('WXS 可选参数和 arguments 保持合法，未知类型、展开与普通同名字段不误报', async () => {
  const graph = fixture({ 'entry.wxs': `/** @param {number} value @param {string} [suffix] */function format(value,suffix){return value;}function flexible(){return arguments.length;}function truncate(arr,size){return arr.slice(0,size?size:5);}format(1);truncate([1]);flexible(1,'a',{});var wx={ok:1};var other={wx:1};wx.ok;other.wx;|` }, 'entry.wxs');
  assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), []);
  const template = fixture({ 'page.wxml': '<wxs module="utils" src="./source.wxs"/>{{utils.format(val|ue)}}', 'page.ts': 'declare const value:any;Page({data:{value}});', 'source.wxs': '/** @param {number} value */function format(value){return value;}module.exports={format:format};' });
  assert.ok(!(await template.features.diagnostics!.provide(template.request)).some((item) => item.code === 'wxs-call-type'));
  assert.equal(await template.features.signatureHelp!.provide({ ...template.request, cancellation: { isCancellationRequested: true } }), undefined);
  const handler = fixture({ 'page.wxml': '<wxs module="utils" src="./source.wxs"/><view bindtap="ut|ils"/>', 'page.ts': 'Page({utils(){}});', 'source.wxs': 'module.exports={format:function(){}};' });
  assert.deepEqual(await handler.targets(), ['page.ts:utils'], '静态事件方法不能被同名 WXS 模块遮蔽');
  const shadow = fixture({ 'page.wxml': '<wxs module="utils" src="./first.wxs"/><wxs module="utils" src="./last.wxs"/>{{utils.for|mat}}', 'first.wxs': 'module.exports={format:function(first){}};', 'last.wxs': 'module.exports={format:function(last){}};' });
  assert.ok((await shadow.targets()).every((target) => target.startsWith('last.wxs:')), '同名模块引用只指向后声明的实现');
});

test('WXS 语法及平台诊断映射内联坐标，合法工具和注释不混入', async () => {
  for (const entry of ['page.wxml', 'entry.wxs']) {
    const body = 'var broken=; wx.request({});new Date();new RegExp("x");require("./bad.js");';
    const text = entry.endsWith('.wxml') ? '<!-- 中文😀 -->\r\n<wxs module="utils">' + body + '</wxs><view/>|' : body + '|';
    const graph = fixture({ [entry]: text }, entry);
    const items = await graph.features.diagnostics!.provide(graph.request);
    assert.ok(items.some((item) => item.code === 'wxs-syntax'), JSON.stringify(items));
    assert.ok(items.some((item) => item.code === 'wxs-api' && graph.request.document.text.slice(item.range.start, item.range.end) === 'wx'));
    assert.ok(items.some((item) => item.code === 'wxs-module' && graph.request.document.text.slice(item.range.start, item.range.end) === '"./bad.js"'));
  }
  const legal = fixture({ 'entry.wxs': `getDate();getRegExp('x','g');Date.now();console.log('wx.request');/* wx.request();|` }, 'entry.wxs');
  assert.deepEqual(await legal.features.diagnostics!.provide(legal.request), []);
});

/** 自定义事件来自继承方法，detail 为可确定的对象结构。 */
const events = {
  'app.json': '{}',
  'page.json': '{"usingComponents":{"my-card":"./card"}}',
  'page.wxml': '<my-card bind:cha|nge="onChange"/>',
  'page.ts': `Page({methods:{onChange(e:{detail:{value:number}}){}}});`,
  'card.ts': `import {shared} from './shared';Component({behaviors:[shared]});`,
  'shared.ts': `export const shared=Behavior({methods:{emit(){/** 数值已变化 */ this.triggerEvent('change',{value:1});}}});`,
};

test('自定义事件的补全、悬浮和定义来自 Behavior 中的实际发出位置', async () => {
  const graph = fixture(events);
  assert.deepEqual(await graph.targets(), ['shared.ts:change']);
  assert.match((await graph.features.hover!.provide(graph.request))!.description, /detail.*value: number/s);
  const incomplete = fixture({ ...events, 'page.wxml': '<my-card catch:ch|/>' });
  assert.ok((await incomplete.features.completion!.provide(incomplete.request)).some((item) => item.label === 'catch:change'));
  assert.deepEqual(await graph.features.diagnostics!.provide(graph.request), []);
});

test('事件参数诊断检查 detail 类型及必需参数数量，any 和可选参数不误报', async () => {
  for (const [method, expected] of [
    ['onChange(e:{detail:{value:string}}){}', true],
    ['onChange(e:{detail:{other:number}}){}', true],
    ['onChange(e:{detail:{value:2}}){}', true],
    ['onChange(e:{detail:{value:1}}){}', false],
    ['onChange(e:{detail:{value:1|2}}){}', false],
    ['onChange(e:WeChatMiniprogram.CustomEvent<{value:string}>){}', true],
    ['onChange(e:WeChatMiniprogram.CustomEvent<{value:number}>){}', false],
    ['onChange(e:any, extra:number){}', true],
    ['onChange(e:any, extra?:number){}', false],
    ['onChange(e:any){}', false],
    ['onChange(){}', false],
  ] as const) {
    const graph = fixture({ ...events, 'page.ts': `Page({methods:{${method}}});` });
    assert.equal((await graph.features.diagnostics!.provide(graph.request)).length > 0, expected, method);
  }
});

test('覆盖掉的继承方法不贡献事件，静态常量事件可解析且动态事件不猜测', async () => {
  const graph = fixture({ ...events, 'card.ts': `import {shared} from './shared';Component({behaviors:[shared],methods:{emit(){this.triggerEvent(dynamicName,{value:1})}}});` });
  assert.deepEqual(await graph.targets(), []);
  const constant = fixture({ ...events, 'shared.ts': `const event='change';export const shared=Behavior({methods:{emit(){this.triggerEvent(event,{value:1});}}});` });
  assert.deepEqual(await constant.targets(), ['shared.ts:change']);
  const hooks = fixture({ ...events, 'card.ts': `Component({lifetimes:{ready(){this.triggerEvent('change',{value:1})}},methods:{helper(){const unrelated={emit(){this.triggerEvent('other')}}}}});` });
  assert.deepEqual(await hooks.targets(), ['card.ts:change']);
  const data = fixture({ ...events, 'card.ts': `Component({data:{value:0},methods:{emit(){this.triggerEvent('change',{value:this.data.value})}}});` });
  assert.match((await data.features.hover!.provide(data.request))!.description, /value: number/);
});

test('Behavior 方法重命名联动模板和 this 引用，独立同名方法及覆盖不受影响', async () => {
  const graph = fixture({
    'page.wxml': '<view bindtap="selectSpeed|"/>',
    'page.ts': `import {shared} from './behavior';Component({behaviors:[shared],methods:{tap(){this.selectSpeed()}}});`,
    'other.wxml': '<view bindtap="selectSpeed"/>',
    'other.ts': `Component({methods:{selectSpeed(){}}});`,
    'override.wxml': '<view bindtap="selectSpeed"/>',
    'override.ts': `import {shared} from './behavior';Component({behaviors:[shared],methods:{selectSpeed(){}}});`,
    'behavior.ts': `export const shared=Behavior({methods:{selectSpeed(){},repeat(){this.selectSpeed()}}});`,
  });
  const renamed = await graph.renamed('chooseSpeed');
  assert.match(renamed.get('file:///workspace/page.wxml')!, /chooseSpeed/);
  assert.match(renamed.get('file:///workspace/page.ts')!, /this.chooseSpeed/);
  assert.match(renamed.get('file:///workspace/behavior.ts')!, /chooseSpeed\(\).*this.chooseSpeed/s);
  assert.equal(renamed.get('file:///workspace/other.ts'), graph.documents.get('file:///workspace/other.ts'));
  assert.equal(renamed.get('file:///workspace/override.wxml'), graph.documents.get('file:///workspace/override.wxml'));
});

test('字段重命名更新 setData 与 observers，方法别名保留原函数名称', async () => {
  const graph = fixture({ 'page.wxml': '{{count|}}', 'page.ts': `Component({data:{count:0},observers:{'count,other'(){}},methods:{tap(){this.setData({'count.value':1});return this.data.count}}});` });
  const changed = await graph.renamed('total');
  assert.match(changed.get('file:///workspace/page.ts')!, /data:\{total:0\}/);
  assert.match(changed.get('file:///workspace/page.ts')!, /'total,other'/);
  assert.match(changed.get('file:///workspace/page.ts')!, /'total.value'/);
  assert.match(changed.get('file:///workspace/page.ts')!, /this.data.total/);
  const alias = fixture({ 'page.wxml': '<view bindtap="onTap|"/>', 'page.ts': `import {execute} from './source';Page({methods:{onTap:execute}});`, 'source.ts': 'export function execute(){}' });
  const renamed = await alias.renamed('onOpen');
  assert.match(renamed.get('file:///workspace/page.ts')!, /onOpen:execute/);
  assert.equal(renamed.get('file:///workspace/source.ts'), 'export function execute(){}');
});

test('const this 别名进入统一引用和改名，捕获别名与独立 this 保持各自作用域', async () => {
  const source = `Component({data:{count:0},methods:{run(){const self=this;const owner=self;owner.setData({'count.value':1});const callback=function(){self.setData({count:2});return self.data.count};function unrelated(){return this.data.count}const other={data:{count:9},setData(value){}};other.setData({count:4});return owner.data.count}}});`;
  const graph = fixture({ 'page.wxml': '{{cou|nt}}', 'page.ts': source });
  const references = await graph.rename.references.provide(graph.request, false);
  assert.equal(references.filter((item) => item.uri.endsWith('page.ts')).length, 4);
  const changed = (await graph.renamed('total')).get('file:///workspace/page.ts')!;
  assert.match(changed, /owner.setData\(\{'total.value':1\}\)/);
  assert.match(changed, /self.setData\(\{total:2\}\).*self.data.total/);
  assert.match(changed, /return owner.data.total/);
  assert.match(changed, /function unrelated\(\)\{return this.data.count\}/);
  assert.match(changed, /other.setData\(\{count:4\}\)/);
});

test('观察路径只属于实际注册的观察器，普通同名对象不参与改名', async () => {
  const graph = fixture({
    'page.wxml': '{{cou|nt}}',
    'page.ts': `import {watchers} from './watchers';Component({data:{count:0},observers:watchers,methods:{run(){const other={observers:{'count'(){}}};return other}}});`,
    'watchers.ts': `export const watchers={'count,other'(){}};`,
  });
  const changed = await graph.renamed('total');
  assert.match(changed.get('file:///workspace/watchers.ts')!, /'total,other'/);
  assert.match(changed.get('file:///workspace/page.ts')!, /observers:\{'count'\(\)/);
});

test('组件实例方法调用及集合别名进入统一引用和 F2，其他组件同名方法保持原文', async () => {
  const graph = fixture({
    'card.ts': `Component({methods:{re|set(){},again(){this.reset()}}});`, 'card.wxml': '<view bindtap="reset"/>',
    'page.js': `Component({methods:{run(){const self=this;const card=self.selectComponent('#card');card.reset();const all=this.selectAllComponents('.cards');all.forEach(item=>item.reset());const first=all[0];first['r\\u0065set']?.();this.selectComponent('#other').reset();}}});`,
    'page.wxml': '<my-card id="card" class="cards"/><other-card id="other"/>',
    'page.json': '{"usingComponents":{"my-card":"./card","other-card":"./other"}}',
    'other.ts': 'Component({methods:{reset(){}}});',
  }, 'card.ts');
  const references = await graph.rename.references.provide(graph.request, false);
  assert.equal(references.filter((item) => item.uri.endsWith('page.js')).length, 3);
  const changed = await graph.renamed('clear');
  assert.match(changed.get('file:///workspace/card.ts')!, /clear\(\).*this.clear\(\)/);
  assert.match(changed.get('file:///workspace/card.wxml')!, /bindtap="clear"/);
  assert.match(changed.get('file:///workspace/page.js')!, /card.clear\(\)/);
  assert.match(changed.get('file:///workspace/page.js')!, /item.clear\(\)/);
  assert.match(changed.get('file:///workspace/page.js')!, /first\['clear'\]/);
  assert.match(changed.get('file:///workspace/page.js')!, /selectComponent\('#other'\).reset\(\)/);
  assert.equal(changed.get('file:///workspace/other.ts'), graph.documents.get('file:///workspace/other.ts'));
});

test('从实例使用处启动改名能定位真实字段，数据字符串声明使用相同身份', async () => {
  const graph = fixture({
    'card.ts': `Component({data:{'count':0},methods:{reset(){}}});`,
    'page.ts': `Page({run(){const card=this.selectComponent('#card');return card.data.cou|nt;}});`,
    'page.wxml': '<my-card id="card"/>', 'page.json': '{"usingComponents":{"my-card":"./card"}}',
  }, 'page.ts');
  assert.equal((await graph.rename.prepare(graph.request))?.name, 'count');
  const changed = await graph.renamed('total');
  assert.match(changed.get('file:///workspace/card.ts')!, /'total':0/);
  assert.match(changed.get('file:///workspace/page.ts')!, /card.data.total/);
});

test('实例 setData 的静态路径联动字段改名，简写局部变量和其他组件保持原名', async () => {
  const graph = fixture({
    'card.ts': `Component({data:{count:{value:0}}});`, 'other.ts': 'Component({data:{count:{value:0}}});',
    'page.ts': `Page({run(){const card=this.selectComponent('#card');const count={value:4};card.setData({count});card.setData({'cou\\u006et.value':1});card.setData({['count.value']:2});this.selectComponent('#other').setData({'count.value':9});return card.data.cou|nt;}});`,
    'page.wxml': '<my-card id="card"/><other-card id="other"/>', 'page.json': '{"usingComponents":{"my-card":"./card","other-card":"./other"}}',
  }, 'page.ts');
  const changed = await graph.renamed('total'), parent = changed.get('file:///workspace/page.ts')!;
  assert.match(parent, /const count=\{value:4\}/);
  assert.match(parent, /card.setData\(\{total: count\}\)/);
  assert.match(parent, /card.setData\(\{'total.value':1\}\)/);
  assert.match(parent, /card.setData\(\{\['total.value'\]:2\}\)/);
  assert.match(parent, /\('#other'\).setData\(\{'count.value':9\}\)/);
  assert.match(parent, /card.data.total/);
});

test('转义声明与观察路径按语义名称改名，不使用解码后的长度裁剪原文', async () => {
  const graph = fixture({
    'page.wxml': '{{cou|nt.value}}',
    'page.ts': `Component({data:{'cou\\u006et':{value:0}},observers:{'cou\\u006et.value, other'(){}},methods:{run(){const self=this;self.setData({'cou\\u006et.value':1});self.setData({['count.value']:2});return self.data.count;}}});`,
  });
  const parent = (await graph.renamed('total')).get('file:///workspace/page.ts')!;
  assert.match(parent, /'total':\{value:0\}/);
  assert.match(parent, /'total.value, other'\(\)/);
  assert.match(parent, /self.setData\(\{'total.value':1\}\)/);
  assert.match(parent, /self.setData\(\{\['total.value'\]:2\}\)/);
  const parsed = ts.createSourceFile('page.ts', parent, ts.ScriptTarget.Latest, true);
  assert.equal((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
});

test('实例方法别名的引用继续追踪实现，字段改名保持其他别名和函数名', async () => {
  const graph = fixture({
    'handler.ts': `export function execute(){}`,
    'card.ts': `import {execute} from './handler';import './second';Component({methods:{onTap:execute}});`,
    'bridge.ts': `export {execute as perform} from './handler';`,
    'second.ts': `import {perform as local} from './bridge';Component({methods:{confirm:local,repeat(){this.confirm()}}});`,
    'page.ts': `Page({run(){this.selectComponent('#first').onTa|p();this.selectComponent('#second').confirm();}});`,
    'page.wxml': '<my-card id="first"/><second-card id="second"/>',
    'page.json': '{"usingComponents":{"my-card":"./card","second-card":"./second"}}',
  }, 'page.ts');
  const references = await graph.rename.references.provide(graph.request, false);
  assert.equal(references.filter((item) => item.uri.endsWith('page.ts')).length, 2);
  assert.ok(references.some((item) => item.uri.endsWith('second.ts') && graph.documents.get(item.uri)!.slice(item.range.start, item.range.end) === 'confirm'));
  const changed = await graph.renamed('onOpen');
  assert.match(changed.get('file:///workspace/card.ts')!, /onOpen:execute/);
  assert.match(changed.get('file:///workspace/page.ts')!, /\('#first'\).onOpen\(\).*\('#second'\).confirm\(\)/);
  assert.equal(changed.get('file:///workspace/handler.ts'), graph.documents.get('file:///workspace/handler.ts'));
});

test('从实现函数查引用穿透重导出及不同名组件字段，改实现名保留公开别名', async () => {
  const graph = fixture({
    'handler.ts': `export function exe|cute(){}`,
    'bridge.ts': `export {execute as action} from './handler';`,
    'card.ts': `import {action as local} from './bridge';Component({methods:{accept:local,repeat(){this.accept()}}});`,
    'card.wxml': '<button bindtap="accept"/>',
    'other.ts': 'Component({methods:{accept(){}}});',
    'other.wxml': '<button bindtap="accept"/>',
  }, 'handler.ts');
  const references = await graph.rename.references.provide(graph.request, true);
  assert.ok(references.some((item) => item.uri.endsWith('card.wxml')), '不同名公开字段的模板绑定也属于实现引用');
  assert.ok(references.some((item) => item.uri.endsWith('card.ts') && graph.documents.get(item.uri)!.slice(item.range.start, item.range.end) === 'accept'));
  assert.ok(!references.some((item) => item.uri.endsWith('other.wxml') || item.uri.endsWith('other.ts')));
  const changed = await graph.renamed('perform');
  assert.match(changed.get('file:///workspace/handler.ts')!, /function perform/);
  assert.match(changed.get('file:///workspace/bridge.ts')!, /perform as action/);
  assert.equal(changed.get('file:///workspace/card.wxml'), graph.documents.get('file:///workspace/card.wxml'));
  assert.equal(changed.get('file:///workspace/card.ts'), graph.documents.get('file:///workspace/card.ts'));
});

test('WXS 实现引用沿 require 和不同名导出到达模板，独立模块不混入', async () => {
  const graph = fixture({
    'implementation.wxs': 'function exe|cute(value){return value};module.exports=execute;',
    'bridge.wxs': 'var run=require("./implementation.wxs");module.exports={accept:run};',
    'page.wxml': '<wxs module="tools" src="./bridge.wxs"/>{{tools.accept(1)}}',
    'other.wxs': 'module.exports={accept:function(value){return value}};',
    'other.wxml': '<wxs module="tools" src="./other.wxs"/>{{tools.accept(1)}}',
  }, 'implementation.wxs');
  const references = await graph.rename.references.provide(graph.request, true);
  assert.ok(references.some((item) => item.uri.endsWith('page.wxml')));
  assert.ok(!references.some((item) => item.uri.endsWith('other.wxml') || item.uri.endsWith('other.wxs')));
});

test('对象成员实现通过命名空间别名暴露时，模板引用不依赖组件内存在自调用', async () => {
  const graph = fixture({
    'handler.ts': 'export const handlers={exe|cute(){}};',
    'bridge.ts': 'export {handlers as actions} from "./handler";',
    'card.ts': 'import {actions as local} from "./bridge";Component({methods:{accept:local.execute}});',
    'card.wxml': '<button bindtap="accept"/>',
  }, 'handler.ts');
  const references = await graph.rename.references.provide(graph.request, true);
  assert.ok(references.some((item) => item.uri.endsWith('card.wxml')));
});

test('动态或多组件来源不会生成部分实例改名，取消保持无编辑', async () => {
  const files = {
    'card.ts': `Component({methods:{re|set(){}}});`, 'other.ts': 'Component({methods:{reset(){}}});',
    'page.ts': `Page({run(){this.selectComponent(selector).reset();}});`,
    'page.wxml': '<my-card id="first" class="card"/><other-card id="second" class="card"/>',
    'page.json': '{"usingComponents":{"my-card":"./card","other-card":"./other"}}',
  };
  const graph = fixture(files, 'card.ts');
  await assert.rejects(graph.changes('clear'), /动态来源/);
  const multiple = fixture({ ...files, 'page.ts': `Page({run(){this.selectAllComponents('.card').forEach(item=>item.reset());}});` }, 'card.ts');
  await assert.rejects(multiple.changes('clear'), /多个不同声明/);
  assert.deepEqual(await graph.rename.provide({ ...graph.request, cancellation: { isCancellationRequested: true } }, 'clear'), []);
});

test('继承的数据根字段改名联动嵌套更新与观察路径，普通同名对象保持原文', async () => {
  const graph = fixture({ 'page.wxml': '{{us|er.name}}', 'page.ts': `import shared from './shared';Component({behaviors:[shared],methods:{open(){this.setData({'user.name':'乙'})}}});`, 'shared.ts': `export default Behavior({data:{user:{name:'甲'}},observers:{'user.name'(){}}});`, 'other.ts': `const user={name:'其他'};user.name='其他';` });
  const changed = await graph.renamed('account');
  assert.equal(changed.get('file:///workspace/page.wxml'), '{{account.name}}');
  assert.match(changed.get('file:///workspace/page.ts')!, /'account.name'/);
  assert.match(changed.get('file:///workspace/shared.ts')!, /data:\{account:/);
  assert.match(changed.get('file:///workspace/shared.ts')!, /'account.name'/);
  assert.equal(changed.get('file:///workspace/other.ts'), graph.documents.get('file:///workspace/other.ts'));
});

test('简写数据字段重命名保留原变量，脚本起点也联动模板', async () => {
  const graph = fixture({ 'page.wxml': '{{title|}}', 'page.ts': `const title='标题';Page({data:{title}});` });
  assert.match((await graph.renamed('caption')).get('file:///workspace/page.ts')!, /data:\{caption: title\}/);
  const script = fixture({ 'page.wxml': '<view bindtap="onTap"/>', 'page.ts': `Page({methods:{onT|ap(){}}});` }, 'page.ts');
  assert.match((await script.renamed('onOpen')).get('file:///workspace/page.wxml')!, /onOpen/);
});

test('模板传参字段及循环别名按作用域重命名，不修改外层同名变量', async () => {
  const graph = fixture({
    'page.wxml': '<import src="./card.wxml"/><template is="card" data="{{title:caption}}"/>',
    'page.ts': `Page({data:{caption:'标题'}});`,
    'card.wxml': '<template name="card">{{title|}}</template>',
  }, 'card.wxml');
  const changed = await graph.renamed('heading');
  assert.match(changed.get('file:///workspace/card.wxml')!, /heading/);
  assert.match(changed.get('file:///workspace/page.wxml')!, /heading:caption/);
  assert.equal(changed.get('file:///workspace/page.ts'), graph.documents.get('file:///workspace/page.ts'));
  const loop = fixture({ 'page.wxml': '<view wx:for="{{rows}}" wx:for-item="row">{{row|.name}}</view><view wx:for="{{others}}" wx:for-item="row">{{row.name}}</view>' });
  const result = (await loop.renamed('entry')).get('file:///workspace/page.wxml')!;
  assert.match(result, /wx:for-item="entry">\{\{entry.name/);
  assert.match(result, /wx:for-item="row">\{\{row.name/);
});

test('WXS 模块别名及内联函数重命名只影响所属模板', async () => {
  const alias = fixture({ ...wxs, 'page.wxml': '<wxs module="utils" src="./utils.wxs"/>{{utils|.format}}', 'other.wxml': '<wxs module="utils" src="./utils.wxs"/>{{utils.format}}' });
  const changed = await alias.renamed('tools');
  assert.match(changed.get('file:///workspace/page.wxml')!, /module="tools".*tools.format/);
  assert.equal(changed.get('file:///workspace/other.wxml'), alias.documents.get('file:///workspace/other.wxml'));
  const inline = fixture({ 'page.wxml': '<wxs module="utils">function format(value){return value}module.exports={format:format};</wxs>{{utils.for|mat}}' });
  assert.match((await inline.renamed('pretty')).get('file:///workspace/page.wxml')!, /utils.pretty/);
  const shorthand = fixture({ 'page.wxml': '<wxs module="utils">function format(value){return value}module.exports={format};</wxs>{{utils.for|mat}}' });
  assert.match((await shorthand.renamed('pretty')).get('file:///workspace/page.wxml')!, /exports=\{pretty: format\}/);
});

test('自定义事件重命名联动发出声明和组件绑定，不改普通字符串', async () => {
  const graph = fixture({ ...events, 'page.ts': events['page.ts'] + `const label='change';` });
  const changed = await graph.renamed('value-changed');
  assert.match(changed.get('file:///workspace/shared.ts')!, /triggerEvent\('value-changed'/);
  assert.match(changed.get('file:///workspace/page.wxml')!, /bind:value-changed="onChange"/);
  assert.match(changed.get('file:///workspace/page.ts')!, /label='change'/);
  const source = fixture({ ...events, 'page.wxml': events['page.wxml'].replace('|', ''), 'shared.ts': `export const shared=Behavior({methods:{emit(){this.triggerEvent('cha|nge',{value:1});this.triggerEvent('change',{value:2});}}});` }, 'shared.ts');
  const renamed = await source.renamed('updated');
  assert.equal(renamed.get('file:///workspace/shared.ts')!.match(/triggerEvent\('updated'/g)?.length, 2);
  assert.match(renamed.get('file:///workspace/page.wxml')!, /bind:updated/);
});

test('Behavior 工厂中的 this 方法引用随声明更新', async () => {
  const graph = fixture({ 'page.wxml': '<view bindtap="onTap|"/>', 'page.ts': `import {build} from './behavior';Component({behaviors:[build()]});`,
    'behavior.ts': `export function build(){return Behavior({methods:{onTap(){},repeat(){this.onTap()}}})}` });
  const changed = await graph.renamed('onOpen');
  assert.match(changed.get('file:///workspace/behavior.ts')!, /onOpen\(\).*this.onOpen/s);
  const scopes = fixture({ 'page.wxml': '<view bindtap="onTap|"/>', 'page.ts': `Page({methods:{onTap(){},repeat(){(()=>this.onTap())();const unrelated={tap(){this.onTap()}}}}});` });
  const result = (await scopes.renamed('onOpen')).get('file:///workspace/page.ts')!;
  assert.match(result, /=>this.onOpen/);
  assert.match(result, /unrelated=\{tap\(\)\{this.onTap/);
});

test('重命名冲突、非法名称和取消请求不会返回部分编辑', async () => {
  const graph = fixture({ 'page.wxml': '<view bindtap="onTap|"/>', 'page.ts': `Page({methods:{onTap(){},onOpen(){}}});` });
  await assert.rejects(graph.changes('onOpen'), /已经/);
  await assert.rejects(graph.changes('new-name'), /名称/);
  const loop = fixture({ 'page.wxml': '<view wx:for="{{rows}}" wx:for-item="row">{{row|.name}}</view>' });
  await assert.rejects(loop.changes('index'), /遮蔽/);
  const modules = fixture({ ...wxs, 'page.wxml': '<wxs module="utils" src="./utils.wxs"/><wxs module="tools" src="./utils.wxs"/>{{utils|.format}}' });
  await assert.rejects(modules.changes('tools'), /已经/);
  Object.assign(graph.request.cancellation, { isCancellationRequested: true });
  assert.equal(await graph.rename.prepare(graph.request), undefined);
  const cancelled = fixture(wxs);
  Object.assign(cancelled.request.cancellation, { isCancellationRequested: true });
  assert.deepEqual(await cancelled.targets(), []);
});

test('不同目录、组件别名和 CommonJS 工厂使用相同事件规则，兼容远程 URI', async () => {
  const files = {
    'app.json': '{}',
    'client/pages/order/detail.json': '{"usingComponents":{"x-notice":"../../../widgets/notice/index"}}',
    'client/pages/order/detail.wxml': '<x-notice capture-catch:notice-rea|dy="acceptNotice"/>',
    'client/pages/order/detail.js': `Page({acceptNotice(event){}});`,
    'widgets/notice/index.js': `const create=require('../../logic/emissions');Component({behaviors:[create()]});`,
    'logic/emissions.js': `module.exports=function(){return Behavior({methods:{publish(){this.triggerEvent('notice-ready',{amount:7})}}})};`,
  };
  for (const root of ['file:///another%20workspace/', 'vscode-remote://ssh-remote+demo/arbitrary/']) {
    const graph = fixture(files, 'client/pages/order/detail.wxml', root);
    assert.deepEqual(await graph.targets(), ['logic/emissions.js:notice-ready']);
    assert.match((await graph.features.hover!.provide(graph.request))!.description, /amount: number/);
  }
});

test('WXS 的模块、函数和路径名称来自源码，支持空格路径和成员改名', async () => {
  const graph = fixture({
    'views/receipt.wxml': '<wxs module="mathTools" src="../logic/amount helpers.wxs"/>{{mathTools.calc|Total}}',
    'logic/amount helpers.wxs': `module.exports={calcTotal:function(amount){return amount}};`,
    'views/other.wxml': '<wxs module="mathTools" src="../logic/other.wxs"/>{{mathTools.calcTotal}}',
    'logic/other.wxs': `exports.calcTotal=function(amount){return amount*2};`,
  }, 'views/receipt.wxml');
  assert.deepEqual(await graph.targets(), ['logic/amount%20helpers.wxs:calcTotal']);
  const renamed = await graph.renamed('computeTotal');
  assert.match(renamed.get('file:///workspace/views/receipt.wxml')!, /mathTools.computeTotal/);
  assert.match(renamed.get('file:///workspace/logic/amount%20helpers.wxs')!, /computeTotal:/);
  assert.match(renamed.get('file:///workspace/views/other.wxml')!, /mathTools.calcTotal/);
});

test('事件参数优先读取实际类型声明，不能根据 CustomEvent 名称猜测 detail', async () => {
  const graph = fixture({ ...events, 'page.ts': `interface CustomEvent<T>{detail:string;metadata:T} Page({methods:{onChange(event:CustomEvent<{value:number}>){}}});` });
  assert.equal((await graph.features.diagnostics!.provide(graph.request)).length, 1);
  const alias = fixture({ ...events, 'page.ts': `type Notice<T>={detail:T};type Params=Notice<{value:string}>;Page({methods:{onChange(event:Params){}}});` });
  assert.equal((await alias.features.diagnostics!.provide(alias.request)).length, 1);
});

test('任意方法名通过路径别名和重导出改名，独立同名方法不构成引用', async () => {
  const graph = fixture({
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@logic/*":["logic/*"]}}}',
    'screens/payment/main.wxml': '<view bindtap="submitPay|ment"/>',
    'screens/payment/main.ts': `import {install as shared} from '@logic/public';Component({behaviors:[shared()]});`,
    'logic/public.ts': `export {build as install} from './factory';`,
    'logic/factory.ts': `export function build(){return Behavior({methods:{submitPayment(){},retry(){this.submitPayment()}}})}`,
    'screens/independent.wxml': '<view bindtap="submitPayment"/>',
    'screens/independent.ts': 'Page({submitPayment(){}});',
  }, 'screens/payment/main.wxml');
  const changed = await graph.renamed('confirmPayment');
  assert.match(changed.get('file:///workspace/logic/factory.ts')!, /confirmPayment\(\).*this.confirmPayment/s);
  assert.match(changed.get('file:///workspace/screens/payment/main.wxml')!, /confirmPayment/);
  assert.match(changed.get('file:///workspace/screens/independent.wxml')!, /submitPayment/);
});
