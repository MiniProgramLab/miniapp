import assert from 'node:assert/strict';
import test from 'node:test';
import type { Definition, LanguageRequest, WorkspaceReader } from '../src/api';
import { createScriptResolver } from '../src/languages/typescript';
import { createTemplateResolver, createWxmlPlugin } from '../src/languages/wxml';
import type { TemplateOptions } from '../src/languages/wxml/template-project';

/** 通过真实组合边界测试独立模板，文件名任意且无需同名脚本。 */
function fixture(files: Record<string, string>, entry = 'shared/card.wxml', options: TemplateOptions = {}) {
  const root = 'file:///workspace';
  const documents = new Map(Object.entries(files).map(([file, text]) => [new URL(file, root + '/').toString(), text.replace('|', '')]));
  const template = files[entry]!;
  const reads: string[] = [];
  const request: LanguageRequest = { document: { uri: root + '/' + entry, text: template.replace('|', ''), version: 1, languageId: 'wxml' }, offset: template.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const reader: WorkspaceReader = {
    root: () => root,
    read: async (uri) => { reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text, version: 3 }; },
    findFiles: async (_uri, _pattern, limit) => [...documents.keys()].filter((uri) => uri.endsWith('.wxml')).slice(0, limit),
  };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader), () => options);
  const features = createWxmlPlugin(undefined, scripts).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  /** 从公开定义能力触发模板图与脚本链的完整解析。 */
  const definitions = (): Promise<readonly Definition[]> => Promise.resolve(features.definition!.provide(request));
  /** 模板悬浮使用相同调用图，但直接呈现原始脚本注释。 */
  const hover = () => features.hover!.provide(request);
  /** 同时核对目标文件及选择的原始声明名称。 */
  const targets = async () => (await definitions()).map((definition) => `${definition.uri.slice(root.length + 1)}:${documents.get(definition.uri)?.slice(definition.range.start, definition.range.end)}`);
  /** 按编辑器可执行的逐次 F12 继续跳转，核对整条链最终的原始声明。 */
  const origins = async (): Promise<string[]> => {
    const result = new Map<string, Definition>();
    const visit = async (definition: Definition, seen: ReadonlySet<string>): Promise<void> => {
      const key = `${definition.uri}:${definition.range.start}:${definition.range.end}`;
      if (seen.has(key) || seen.size >= 32) return;
      const target = documents.get(definition.uri);
      if (definition.uri.endsWith('.wxml') && target !== undefined) {
        const next = await features.definition!.provide({ document: { uri: definition.uri, languageId: 'wxml', text: target, version: definition.uri === request.document.uri ? 1 : 3 }, offset: definition.range.start, cancellation: request.cancellation });
        if (next.length) {
          for (const item of next) await visit(item, new Set(seen).add(key));
          return;
        }
      }
      result.set(key, definition);
    };
    for (const definition of await definitions()) await visit(definition, new Set());
    return [...result.values()].map((definition) => `${definition.uri.slice(root.length + 1)}:${documents.get(definition.uri)?.slice(definition.range.start, definition.range.end)}`);
  };
  return { documents, request, reads, definitions, targets, origins, hover };
}

/** 页面公开成员先经过 TypeScript 重导出，再由模板 data 映射。 */
const page = {
  'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:caption, Status, format, model}}"/>',
  'pages/home.ts': `import { caption, Status, format, Model, handle } from '../scripts'; Page({data:{caption,Status,format,model:new Model()}, methods:{onTap:handle}});`,
  'scripts.ts': `export { label as caption, State as Status, render as format, Model, handle } from './source';`,
  'source.ts': `export const label='hello'; export enum State { Ready } export function render(){} export function handle(){} export class Model { save(){} }`,
};

test('独立模板变量和成员首次跳到传入的 data 根字段', async () => {
  for (const [expression, name] of [['ti|tle', 'title'], ['Sta|tus', 'Status'], ['Status.Rea|dy', 'Status'], ['for|mat', 'format'], ['model.sa|ve', 'model']]) {
    assert.deepEqual(await fixture({ ...page, 'shared/card.wxml': `<template name="card"><view>{{${expression}}}</view></template>` }).targets(), [`pages/home.wxml:${name}`]);
  }
});

test('多层模板改名先定位对应 data 字段，对象子字段可以单独继续跳转', async () => {
  const files = { ...page,
    'pages/home.wxml': '<import src="../shared/wrapper.wxml"/><template is="wrapper" data="{{payload:{heading:caption, Status, model}}}"/>',
    'shared/wrapper.wxml': '<import src="card.wxml"/><template name="wrapper"><template is="card" data="{{...payload, title:payload.heading}}"/></template>',
    'shared/card.wxml': '<template name="card">{{ti|tle}}</template>',
  };
  assert.deepEqual(await fixture(files).targets(), ['shared/wrapper.wxml:title']);
  assert.deepEqual(await fixture(files).origins(), ['pages/home.wxml:payload']);
  const heading = fixture({ ...files, 'pages/home.wxml': files['pages/home.wxml'].replace('heading:caption', 'hea|ding:caption') }, 'pages/home.wxml');
  assert.deepEqual(await heading.targets(), ['source.ts:label']);
  assert.deepEqual(await fixture({ ...files, 'shared/card.wxml': '<template name="card">{{Status.Rea|dy}}</template>' }).targets(), ['shared/wrapper.wxml:payload']);
});

test('include 继承页面上下文并支持多层包含', async () => {
  const files = { ...page, 'pages/home.wxml': '<include src="../shared/header.wxml"/>', 'shared/header.wxml': '<include src="card.wxml"/>', 'shared/card.wxml': '<view>{{cap|tion}}</view>' };
  assert.deepEqual(await fixture(files).origins(), ['source.ts:label']);
});

test('静态事件名称在独立模板中绑定实际页面方法', async () => {
  assert.deepEqual(await fixture({ ...page, 'shared/card.wxml': '<template name="card"><button bindtap="onT|ap"/></template>' }).origins(), ['source.ts:handle']);
});

test('include 片段与多层改名模板的悬浮直接显示原声明注释', async () => {
  const files = { ...page,
    'source.ts': '/** 标题原始说明 */ export const label="hello"; /** 点击操作 */ export function handle(){}',
    'pages/home.wxml': '<include src="../shared/card.wxml"/>',
    'shared/card.wxml': '<button bind:tap="onT|ap"/>',
  };
  assert.equal((await fixture(files).hover())?.description, '点击操作');
  assert.equal((await fixture({...files, 'shared/card.wxml':'{{cap|tion}}'}).hover())?.description, '标题原始说明');
  const templates = { ...files,
    'pages/home.wxml': '<import src="../shared/wrapper.wxml"/><template is="wrapper" data="{{heading:caption}}"/>',
    'shared/wrapper.wxml': '<import src="card.wxml"/><template name="wrapper"><template is="card" data="{{title:heading}}"/></template>',
    'shared/card.wxml': '<template name="card">{{ti|tle}}</template>',
  };
  const graph = fixture(templates);
  assert.deepEqual(await graph.targets(), ['shared/wrapper.wxml:title']);
  assert.equal((await graph.hover())?.description, '标题原始说明');
});

test('多个页面实际调用同一模板时保留不同原始声明并去重', async () => {
  const files = { ...page, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>', 'pages/other.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:label}}"/><template is="card" data="{{title:label}}"/>', 'pages/other.ts': 'Page({data:{label:"other"}})' };
  assert.deepEqual((await fixture(files).origins()).sort(), ['pages/other.ts:label', 'source.ts:label']);
});

test('命名模板只看到 data 传入的值，不泄漏调用方同名变量或外层循环', async () => {
  const files = { ...page, 'shared/card.wxml': '<template name="card">{{cap|tion}}</template>' };
  assert.deepEqual(await fixture(files).origins(), []);
  assert.deepEqual(await fixture({ ...files, 'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card"/>', 'shared/card.wxml': '<template name="card">{{Sta|tus}}</template>' }).origins(), []);
});

test('单独 import 不会执行模板，且 import 不传递目标文件的导入', async () => {
  assert.deepEqual(await fixture({ ...page, 'pages/home.wxml': '<import src="../shared/card.wxml"/>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' }).origins(), []);
  const files = { ...page, 'pages/home.wxml': '<import src="../shared/wrapper.wxml"/><template is="card" data="{{title:caption}}"/>', 'shared/wrapper.wxml': '<import src="card.wxml"/><template name="wrapper"/>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' };
  assert.deepEqual(await fixture(files).origins(), []);
});

test('include 不会实例化被包含文件中的 template 定义', async () => {
  const files = { ...page, 'pages/home.wxml': '<include src="../shared/card.wxml"/>', 'shared/card.wxml': '<template name="card">{{cap|tion}}</template>' };
  assert.deepEqual(await fixture(files).origins(), []);
});

test('同名模板按实际 import 目标区分，未引用页面不会贡献候选', async () => {
  const files = { ...page, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>', 'shared/unrelated.wxml': '<template name="card">{{title}}</template>', 'pages/unrelated.wxml': '<import src="../shared/unrelated.wxml"/><template is="card" data="{{title:caption}}"/>', 'pages/unrelated.ts': 'Page({data:{caption:"wrong"}})' };
  assert.deepEqual(await fixture(files).origins(), ['source.ts:label']);
});

test('在调用者循环中传入 item，先停在 data 字段，再定位循环绑定', async () => {
  const files = { 'pages/home.wxml': '<import src="../shared/card.wxml"/><view wx:for="{{rows}}" wx:for-item="row"><template is="card" data="{{record:row}}"/></view>', 'pages/home.ts': 'Page({data:{rows:[{label:"first"}]}})', 'shared/card.wxml': '<template name="card">{{record.la|bel}}</template>' };
  assert.deepEqual(await fixture(files).targets(), ['pages/home.wxml:record']);
  assert.deepEqual(await fixture(files).origins(), ['pages/home.wxml:row']);
  const member = fixture({ ...files, 'pages/home.wxml': files['pages/home.wxml'].replace('</view>', '{{row.la|bel}}</view>') }, 'pages/home.wxml');
  assert.deepEqual(await member.targets(), ['pages/home.ts:label']);
  const included = { ...files, 'pages/home.wxml': '<view wx:for="{{rows}}" wx:for-item="row"><include src="../shared/card.wxml"/></view>', 'shared/card.wxml': '{{ro|w}}' };
  assert.deepEqual(await fixture(included).origins(), ['pages/home.wxml:row']);
});

test('独立模板中的循环项成员先定位 data 集合字段，再定位原始数组', async () => {
  const files = { 'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{records:rows}}"/>', 'pages/home.ts': 'Page({data:{rows:[{label:"first"}]}})', 'shared/card.wxml': '<template name="card"><view wx:for="{{records}}">{{item.la|bel}}</view></template>' };
  assert.deepEqual(await fixture(files).targets(), ['pages/home.wxml:records']);
  assert.deepEqual(await fixture(files).origins(), ['pages/home.ts:rows']);
});

test('模板内包含片段时保留当前 data 上下文', async () => {
  const files = { ...page, 'shared/card.wxml': '{{ti|tle}}', 'shared/wrapper.wxml': '<template name="wrapper"><include src="card.wxml"/></template>', 'pages/home.wxml': '<import src="../shared/wrapper.wxml"/><template is="wrapper" data="{{title:caption}}"/>' };
  assert.deepEqual(await fixture(files).origins(), ['source.ts:label']);
});

test('data 字面量和对象覆盖定位到调用模板中的声明位置', async () => {
  const files = { ...page, 'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{...{title:caption}, title:42}}"/>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' };
  const graph = fixture(files);
  assert.deepEqual(await graph.origins(), ['pages/home.wxml:title']);
  assert.equal((await graph.definitions())[0]?.range.start, files['pages/home.wxml'].lastIndexOf('title'));
});

test('同文件命名模板同样经过 data 隔离，与独立模板规则一致', async () => {
  const graph = fixture({ 'index.wxml': '<template name="card">{{ti|tle}}</template><template is="card" data="{{title:caption}}"/>', 'index.ts': 'const label="ok"; Page({data:{caption:label}})' }, 'index.wxml');
  assert.deepEqual(await graph.origins(), ['index.ts:label']);
});

test('循环引用仍能找到真实页面入口，不重复或无限递归', async () => {
  const files = { ...page, 'shared/card.wxml': '<import src="wrapper.wxml"/><template name="card">{{ti|tle}}<template is="wrapper" data="{{title}}"/></template>', 'shared/wrapper.wxml': '<import src="card.wxml"/><template name="wrapper"><template is="card" data="{{title}}"/></template>' };
  assert.deepEqual(await fixture(files).origins(), ['source.ts:label']);
});

test('调用文件未保存修改会更新 data 映射，删除实际调用后不留陈旧候选', async () => {
  const graph = fixture({ ...page, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' });
  assert.deepEqual(await graph.origins(), ['source.ts:label']);
  graph.documents.set('file:///workspace/pages/home.wxml', '<import src="../shared/card.wxml"/><template is="card" data="{{title:Status.Ready}}"/>');
  assert.deepEqual(await graph.origins(), ['source.ts:Ready']);
  graph.documents.set('file:///workspace/pages/home.wxml', '<import src="../shared/card.wxml"/>');
  assert.deepEqual(await graph.origins(), []);
});

test('注释、WXS 和动态模板名不构成虚假的调用链', async () => {
  for (const caller of ['<!-- <template is="card" data="{{title:caption}}"/> -->', '<wxs>var text=\'<template is="card" data="{{title:caption}}"/>\'</wxs>', '<template is="{{selected}}" data="{{title:caption}}"/>']) {
    assert.deepEqual(await fixture({ ...page, 'pages/home.wxml': '<import src="../shared/card.wxml"/>' + caller, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' }).origins(), []);
  }
});

test('取消、文件预算和孤立模板安全返回，不猜测符号来源', async () => {
  assert.deepEqual(await fixture({ 'shared/card.wxml': '{{ti|tle}}' }).origins(), []);
  assert.deepEqual(await fixture({ ...page, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' }, 'shared/card.wxml', { maxFiles: 1 }).origins(), []);
  const graph = fixture({ ...page, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' });
  Object.assign(graph.request.cancellation, { isCancellationRequested: true });
  assert.deepEqual(await graph.origins(), []);
  assert.deepEqual(graph.reads, []);
});

test('跨层传递字面量别名仍定位到最初调用处', async () => {
  const graph = fixture({ ...page, 'pages/home.wxml': '<import src="../shared/wrapper.wxml"/><template is="wrapper" data="{{original:42}}"/>', 'shared/wrapper.wxml': '<import src="card.wxml"/><template name="wrapper"><template is="card" data="{{title:original}}"/></template>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' });
  assert.deepEqual(await graph.origins(), ['pages/home.wxml:original']);
});

test('绝对模板路径以最近的小程序根为准，支持省略扩展名', async () => {
  const files = { 'app/app.json': '{}', 'app/pages/index.wxml': '<import src="/shared/card"/><template is="card" data="{{title:caption}}"/>', 'app/pages/index.ts': 'Page({data:{caption:"ok"}})', 'app/shared/card.wxml': '<template name="card">{{ti|tle}}</template>', 'shared/card.wxml': '<template name="card">wrong</template>' };
  assert.deepEqual(await fixture(files, 'app/shared/card.wxml').origins(), ['app/pages/index.ts:caption']);
});

test('模板变量穿过使用处 TS 的嵌套解构、工厂转发和重导出后定位原始字段', async () => {
  const files = {
    'shared/card.wxml': '<template name="card"><view>{{ti|tle}}</view></template>',
    'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:card.heading}}"/>',
    'pages/home.ts': `import { settings, forward } from '../bridge'; const { card: { title: renamed } } = settings; const viewModel = forward({heading:renamed}); Page({data:{card:viewModel}});`,
    'bridge.ts': `export { config as settings } from './data'; export { forward } from './factory';`,
    'data.ts': `export const config={card:{title:'original'}};`,
    'factory.ts': `export function forward(value){ return value; }`,
  };
  const graph = fixture(files);
  assert.deepEqual(await graph.origins(), ['data.ts:title']);
  assert.deepEqual(await graph.targets(), ['pages/home.wxml:title']);
  assert.equal((await graph.definitions())[0]?.range.start, files['pages/home.wxml'].indexOf('title:'));
});

test('模板变量沿使用处工厂的解构参数追踪到调用实参声明', async () => {
  const files = {
    'shared/card.wxml': '<template name="card">{{ti|tle}}</template>',
    'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:card.heading}}"/>',
    'pages/home.ts': `import { config } from '../data'; import { build } from '../factory'; Page({data:{card:build(config)}});`,
    'data.ts': `export const config={card:{title:'original'}};`,
    'factory.ts': `export function build({card:{title}}){return {heading:title};}`,
  };
  assert.deepEqual(await fixture(files).origins(), ['data.ts:title']);
});

test('TS 数据链中的静态计算属性沿键的常量别名定位到原始字段', async () => {
  const files = {
    'shared/card.wxml': '<template name="card">{{ti|tle}}</template>',
    'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:heading}}"/>',
    'pages/home.ts': `import { config, key } from '../data'; const renamedKey=key; const heading=config.card[renamedKey]; Page({data:{heading}});`,
    'data.ts': `export const key='title'; export const config={card:{title:'original'}};`,
  };
  assert.deepEqual(await fixture(files).origins(), ['data.ts:title']);
});

test('首跳准确落在 data 改名字段，再次 F12 沿绑定表达式定位 TS 原始声明', async () => {
  const files = { ...page, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' };
  const graph = fixture(files);
  assert.deepEqual(await graph.targets(), ['pages/home.wxml:title']);
  const first = (await graph.definitions())[0]!;
  assert.equal(first.range.start, files['pages/home.wxml'].indexOf('title:'));
  assert.equal(first.range.end - first.range.start, 'title'.length);
  assert.equal(first.version, 3);
  assert.equal(graph.request.document.text.slice(first.originRange.start, first.originRange.end), 'title');
  assert.deepEqual(await graph.origins(), ['source.ts:label']);
});

test('多层模板先停在最近使用处 data，再逐层向外追踪', async () => {
  const files = { ...page, 'pages/home.wxml': '<import src="../shared/wrapper.wxml"/><template is="wrapper" data="{{heading:caption}}"/>', 'shared/wrapper.wxml': '<import src="card.wxml"/><template name="wrapper"><template is="card" data="{{title:heading}}"/></template>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' };
  assert.deepEqual(await fixture(files).targets(), ['shared/wrapper.wxml:title']);
  const next = fixture({ ...files, 'shared/wrapper.wxml': files['shared/wrapper.wxml'].replace('title:heading', 'ti|tle:heading') }, 'shared/wrapper.wxml');
  assert.deepEqual(await next.targets(), ['pages/home.wxml:heading']);
  assert.deepEqual(await next.origins(), ['source.ts:label']);
});

test('data 简写及展开字段定位到使用处，并保留覆盖顺序', async () => {
  const files = { ...page, 'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{caption, ...{title:caption}, title:Status.Ready}}"/>', 'shared/card.wxml': '<template name="card">{{cap|tion}}</template>' };
  assert.deepEqual(await fixture(files).targets(), ['pages/home.wxml:caption']);
  const override = fixture({ ...files, 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' });
  assert.deepEqual(await override.targets(), ['pages/home.wxml:title']);
  assert.equal((await override.definitions())[0]?.range.start, files['pages/home.wxml'].lastIndexOf('title:'));
  assert.deepEqual(await override.origins(), ['source.ts:Ready']);
});

test('同一模板的不同使用处分别返回对应 data 字段，不按最终来源提前合并', async () => {
  const files = { ...page, 'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:caption}}"/><template is="card" data="{{title:caption}}"/>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' };
  const graph = fixture(files);
  const definitions = await graph.definitions();
  assert.equal(definitions.length, 2);
  assert.deepEqual(definitions.map((item) => item.range.start).sort((a, b) => a - b), [files['pages/home.wxml'].indexOf('title:'), files['pages/home.wxml'].lastIndexOf('title:')]);
  assert.deepEqual(await graph.origins(), ['source.ts:label']);
});

test('显式 data 字段不依赖调用页面脚本存在或绑定值可解析', async () => {
  const files = { 'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:missing}}"/>', 'shared/card.wxml': '<template name="card">{{ti|tle}}</template>' };
  assert.deepEqual(await fixture(files).targets(), ['pages/home.wxml:title']);
  const quoted = { ...files, 'pages/home.wxml': files['pages/home.wxml'].replace('title:missing', "'title':missing") };
  assert.deepEqual(await fixture(quoted).targets(), ['pages/home.wxml:title']);
});

test('多个使用处调用同一解构工厂时，各自的数据实参互不混淆', async () => {
  const files = {
    'shared/card.wxml': '<template name="card">{{ti|tle}}</template>',
    'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:first.heading}}"/><template is="card" data="{{title:second.heading}}"/>',
    'pages/home.ts': `import { one, two } from '../data'; import { build } from '../factory'; Page({data:{first:build(one),second:build(two)}});`,
    'data.ts': `const firstTitle='first'; const secondTitle='second'; export const one={card:{title:firstTitle}}; export const two={card:{title:secondTitle}};`,
    'factory.ts': `export function build({card:{title}}){return {heading:title};}`,
  };
  assert.deepEqual(await fixture(files).targets(), ['pages/home.wxml:title', 'pages/home.wxml:title']);
  assert.deepEqual((await fixture(files).origins()).sort(), ['data.ts:firstTitle', 'data.ts:secondTitle']);
});

test('再次跳转支持嵌套数组解构，未知下标不按变量名猜测字段', async () => {
  const files = {
    'shared/card.wxml': '<template name="card">{{ti|tle}}</template>',
    'pages/home.wxml': '<import src="../shared/card.wxml"/><template is="card" data="{{title:heading}}"/>',
    'pages/home.ts': `import { rows } from '../data'; const [, {title:heading}]=rows; Page({data:{heading}});`,
    'data.ts': `const first='first'; const second='second'; export const rows=[{title:first},{title:second}];`,
  };
  assert.deepEqual(await fixture(files).origins(), ['data.ts:second']);
  const unknown = fixture({ ...files, 'pages/home.wxml': files['pages/home.wxml'].replace('title:heading', 'ti|tle:heading'), 'pages/home.ts': `declare const key:string; const item={key:'wrong'}; const heading=item[key]; Page({data:{heading}});` }, 'pages/home.wxml');
  assert.deepEqual(await unknown.targets(), []);
});
