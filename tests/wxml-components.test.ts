import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createComponentScriptResolver, createScriptResolver } from '../src/languages/typescript';
import { createComponentResolver, createWxmlPlugin } from '../src/languages/wxml';
import type { ComponentOptions } from '../src/languages/wxml/components';

/** 使用内存文件和草稿模拟完整组件注册、脚本依赖和插槽调用。 */
function fixture(template: string, files: Record<string, string>, entry = 'src/pages/index.wxml', options: ComponentOptions = {}) {
  const root = 'file:///workspace/';
  const documents = new Map(Object.entries({ 'package.json': '{}', 'src/app.json': '{}', [entry]: template.replace('|', ''), ...files }).map(([path, text]) => [new URL(path, root).toString(), text]));
  const reads: string[] = [];
  const reader: WorkspaceReader = {
    root: () => root,
    /** 草稿版本供跳转适配层排除过期结果。 */
    read: async (uri) => { reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text, version: 7 }; },
    findFiles: async () => [...documents.keys()].filter((uri) => uri.endsWith('.wxml')),
  };
  const request: LanguageRequest = { document: { uri: new URL(entry, root).toString(), text: template.replace('|', ''), version: 1, languageId: 'wxml' }, offset: template.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const resolver = createComponentResolver(reader, (snapshot) => createComponentScriptResolver(snapshot), () => options);
  const features = createWxmlPlugin(undefined, createScriptResolver(reader), undefined, resolver).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  /** 同时验证使用处和目标源码范围。 */
  const definitions = async () => (await features.definition!.provide(request)).map((item) => ({ path: item.uri.slice(root.length), text: documents.get(item.uri)?.slice(item.range.start, item.range.end), origin: request.document.text.slice(item.originRange.start, item.originRange.end), version: item.version }));
  const hover = () => features.hover!.provide(request);
  /** 通过组合入口验证源码参数与内置补全的合并。 */
  const completions = () => features.completion!.provide(request);
  return { definitions, hover, completions, request, documents, reads };
}

/** 包含组件注释、参数默认值和具名插槽的共享实现。 */
const component = {
  'src/pages/index.json': '{"usingComponents":{"my-card":"/components/card/index"}}',
  'src/components/card/index.ts': `/** 展示用户信息的卡片。 */\nComponent({properties:{\n/** 卡片标题。 */\ntitleText:{type:String,value:'默认标题'},\n/** 是否高亮。 */\nactive:Boolean, count:Number, items:Array, profile:Object, anything:null},methods:{}});`,
  'src/components/card/index.wxml': `<!-- 卡片主体 -->\n<view><slot/><!-- 卡片头部内容。 -->\n<slot name="header"/><!-- 操作区说明。 -->\n<view><slot name="actions"/></view></view>`,
};

test('组件值枚举读取 PropType 实际声明，不枚举未声明的宽泛 String 值', async () => {
  const files = { ...component, 'src/components/card/index.ts': `type PropType<T>=()=>T;Component({properties:{size:String as PropType<'small'|'large'>,count:Number}});` };
  assert.deepEqual((await fixture('<my-card size="la|"/>', files).completions()).map((item) => item.label), ['large']);
  assert.deepEqual((await fixture('<my-card size="xx|"/>', files).completions()).map((item) => item.label), []);
  assert.ok(!(await fixture('<my-card count="|"/>', files).completions()).some((item) => item.kind === 'value'));
});

test('组件标签和结束标签跳到注册实现，并显示组件注释', async () => {
  for (const template of ['<my-ca|rd/>', '<my-card></my-ca|rd>']) {
    const context = fixture(template, component);
    assert.deepEqual(await context.definitions(), [{ path: 'src/components/card/index.ts', text: 'Component', origin: 'my-card', version: 7 }]);
    const hover = await context.hover();
    assert.match(hover!.description, /展示用户信息的卡片/);
    assert.match(hover!.description, /默认、header、actions/);
  }
});

test('参数显示注释、类型和显式默认值，跳到实现的字段而非类型', async () => {
  const context = fixture('<my-card title-te|xt="标题"/>', component);
  assert.deepEqual(await context.definitions(), [{ path: 'src/components/card/index.ts', text: 'titleText', origin: 'title-text', version: 7 }]);
  const hover = await context.hover();
  assert.equal(hover!.title, '');
  assert.match(hover!.description, /卡片标题/);
  assert.match(hover!.description, /类型：string/);
  assert.match(hover!.description, /默认值：'默认标题'/);
});

test('原生参数未写 value 时显示平台的隐式默认值', async () => {
  for (const [name, type, value] of [['active', 'boolean', 'false'], ['count', 'number', '0'], ['items', 'unknown[]', '[]'], ['profile', 'object', 'null'], ['anything', 'any', '未设置']]) {
    const hover = await fixture(`<my-card ${name!.slice(0, 2)}|${name!.slice(2)}=""/>`, component).hover();
    assert.ok(hover!.description.includes(`类型：${type}`));
    assert.ok(hover!.description.includes(`默认值：${value}`));
  }
});

test('具名和默认插槽跳到 WXML 声明，注释可来自直接包装节点', async () => {
  for (const [template, name, description] of [['<my-card><view slot="hea|der"/></my-card>', 'header', '卡片头部内容'], ['<my-card><block><view sl|ot="actions"/></block></my-card>', 'actions', '操作区说明'], ['<my-card><view sl|ot=""/></my-card>', 'slot', '卡片主体']]) {
    const context = fixture(template!, component);
    const definitions = await context.definitions();
    assert.equal(definitions[0]?.path, 'src/components/card/index.wxml');
    assert.equal(definitions[0]?.text, name);
    assert.match((await context.hover())!.description, new RegExp(description!));
  }
});

test('Behavior 继承、重导出和静态工厂保留字段原始声明，当前参数覆盖继承', async () => {
  const files = { ...component,
    'src/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["*"]}}}',
    'src/components/card/index.ts': `import { build } from '@/behaviors/barrel'; Component({behaviors:[build(12)],properties:{count:{type:Number,value:5}}})`,
    'src/behaviors/barrel.ts': `export { build } from './shared';`,
    'src/behaviors/shared.ts': `export function build(amount){return Behavior({properties:{/** 继承的尺寸。 */\nsize:{type:Number,value:amount},count:{type:Number,value:amount}}})}`,
  };
  const inherited = fixture('<my-card si|ze=""/>', files);
  assert.equal((await inherited.definitions())[0]?.path, 'src/behaviors/shared.ts');
  assert.match((await inherited.hover())!.description, /继承的尺寸[\s\S]*默认值：12/);
  const own = fixture('<my-card co|unt=""/>', files);
  assert.equal((await own.definitions())[0]?.path, 'src/components/card/index.ts');
  assert.match((await own.hover())!.description, /默认值：5/);
});

test('Vant 转译调用和项目 libs 源码映射支持 props 与注释', async () => {
  const files = { ...component,
    'src/pages/index.json': '{"usingComponents":{"van-cell":"/libs/vant-ui/cell/index"}}',
    'libs/vant-ui/cell/index.js': `var component_1=require('../common/component');\n/** 单元格组件。 */\n(0, component_1.VantComponent)({props:{/** 是否使用额外插槽。 */\nuseExtra:Boolean,border:{type:Boolean,value:true}}});`,
    'libs/vant-ui/cell/index.wxml': '<!-- 额外内容区域 -->\n<view><slot name="extra"/></view>',
  };
  const context = fixture('<van-cell use-ex|tra="true"/>', files);
  assert.equal((await context.definitions())[0]?.path, 'libs/vant-ui/cell/index.js');
  assert.match((await context.hover())!.description, /是否使用额外插槽[\s\S]*类型：boolean[\s\S]*默认值：false/);
  assert.equal((await fixture('<van-ce|ll/>', files).definitions())[0]?.path, 'libs/vant-ui/cell/index.js');
  assert.match((await fixture('<van-cell><view slot="ex|tra"/></van-cell>', files).hover())!.description, /额外内容区域/);
});

test('转译后的嵌套参数合并保留导入说明、默认值及覆盖顺序', async () => {
  const files = { ...component,
    'src/components/card/index.js': `var shared=require('./props'); var __assign=Object.assign; (0, component.VantComponent)({props:__assign(__assign({},shared.commonProps),{border:{type:Boolean,value:true}})});`,
    'src/components/card/props.js': `exports.commonProps={/** 输入占位文字。 */\nplaceholderStyle:String,cursorSpacing:{type:Number,value:50},border:{type:Boolean,value:false}};`,
  };
  delete (files as Record<string, string>)['src/components/card/index.ts'];
  const shared = fixture('<my-card placeholder-st|yle=""/>', files);
  assert.equal((await shared.definitions())[0]?.path, 'src/components/card/props.js');
  assert.equal((await shared.definitions())[0]?.text, 'placeholderStyle');
  assert.match((await shared.hover())!.description, /输入占位文字[\s\S]*类型：string/);
  assert.match((await fixture('<my-card cursor-sp|acing=""/>', files).hover())!.description, /默认值：50/);
  const completion = (await fixture('<my-card cursor-sp|', files).completions()).find((item) => item.label === 'cursor-spacing');
  assert.equal(completion?.insertText, 'cursor-spacing="${1}"');
  assert.match(completion!.documentation, /类型：number[\s\S]*默认值：50/);
  const own = fixture('<my-card bor|der=""/>', files);
  assert.equal((await own.definitions())[0]?.path, 'src/components/card/index.js');
  assert.match((await own.hover())!.description, /默认值：true/);
});

test('Object.assign 合并组件配置和参数时保留源码，不误解同名对象方法', async () => {
  const files = { ...component,
    'src/components/card/index.ts': `const common={properties:{count:{type:Number,value:2}}};Component(Object.assign({},common,{properties:Object.assign({},common.properties,{count:{type:Number,value:9},active:Boolean})}));`,
  };
  const count = fixture('<my-card co|unt=""/>', files);
  assert.match((await count.hover())!.description, /类型：number[\s\S]*默认值：9/);
  assert.equal((await count.definitions())[0]?.text, 'count');
  assert.match((await fixture('<my-card act|ive=""/>', files).hover())!.description, /类型：boolean/);
  files['src/components/card/index.ts'] = `const factory={assign(){return {count:{type:Number,value:7}}}};Component({properties:factory.assign({wrong:Boolean})});`;
  assert.match((await fixture('<my-card co|unt=""/>', files).hover())!.description, /默认值：7/);
  assert.equal(await fixture('<my-card wr|ong=""/>', files).hover(), undefined);
});

test('转译后的混入工厂调用保留继承参数和绑定的默认值', async () => {
  const files = { ...component,
    'src/components/card/index.js': `var shared=require('./transition');(0, component.VantComponent)({mixins:[(0,shared.transition)(true)]});`,
    'src/components/card/transition.js': `function transition(initial){return Behavior({properties:{/** 是否显示。 */\nshow:{type:Boolean,value:initial},duration:{type:Number,value:300}}})}exports.transition=transition;`,
  };
  delete (files as Record<string, string>)['src/components/card/index.ts'];
  const inherited = fixture('<my-card sh|ow=""/>', files);
  assert.equal((await inherited.definitions())[0]?.path, 'src/components/card/transition.js');
  assert.equal((await inherited.definitions())[0]?.text, 'show');
  assert.match((await inherited.hover())!.description, /是否显示[\s\S]*默认值：true/);
  assert.match((await fixture('<my-card dur|ation=""/>', files).hover())!.description, /默认值：300/);
});

test('源码参数补全保留已填写的值，并过滤驼峰和连字符形式的已有参数', async () => {
  const context = fixture('<my-card title-te|xt="已有标题" active="true"/>', component);
  const title = (await context.completions()).find((item) => item.label === 'title-text');
  assert.equal(title?.insertText, 'title-text');
  assert.equal(title?.insertTextFormat, 'plain');
  assert.equal(context.request.document.text.slice(title!.range.start, title!.range.end), 'title-text');
  assert.match(title!.documentation, /卡片标题[\s\S]*默认值：'默认标题'/);
  const camel = (await fixture('<my-card titleT|ext="已有标题"/>', component).completions()).find((item) => item.label === 'titleText');
  assert.equal(camel?.insertText, 'titleText');
  const labels = (await fixture('<my-card active titleText="已有标题" |', component).completions()).map((item) => item.label);
  assert.ok(labels.includes('count'));
  assert.ok(labels.includes('wx:if'));
  assert.ok(!labels.includes('active'));
  assert.ok(!labels.includes('title-text'));
});

test('参数补全及时读取草稿，插值、注释和取消请求不读取组件源码', async () => {
  const context = fixture('<my-card new-|', component);
  assert.deepEqual(await context.completions(), []);
  context.documents.set('file:///workspace/src/components/card/index.ts', `Component({properties:{/** 新增草稿参数。 */\nnewCount:{type:Number,value:8}}})`);
  const draft = (await context.completions()).find((item) => item.label === 'new-count');
  assert.match(draft!.documentation, /新增草稿参数[\s\S]*默认值：8/);
  for (const template of ['<my-card title-text="{{cap|tion}}"/>', '<!-- <my-card title-| -->']) {
    const ignored = fixture(template, component);
    assert.deepEqual(await ignored.completions(), []);
    assert.ok(ignored.reads.every((uri) => /\/pages\/index\.[cm]?[jt]sx?$/.test(uri)), '表达式补全可以探测页面脚本，但不能读取无关组件实现');
  }
  const cancelled = fixture('<my-card title-|', component);
  (cancelled.request.cancellation as { isCancellationRequested: boolean }).isCancellationRequested = true;
  assert.deepEqual(await cancelled.completions(), []);
  assert.deepEqual(cancelled.reads, []);
});

test('默认导出与对象展开跳到实际实现，声明文件不会成为候选', async () => {
  const files = { ...component,
    'src/components/card/index.ts': `export { default } from './actual';`,
    'src/components/card/actual.ts': `const common={/** 外部标题。 */\n titleText:{type:String,value:'展开'}};\n/** 原始实现。 */\nconst options={properties:{...common}};export default options;`,
    'src/components/card/actual.d.ts': 'declare const options:{properties:{titleText:string}};export default options;',
  };
  const property = fixture('<my-card title-te|xt=""/>', files);
  assert.equal((await property.definitions())[0]?.path, 'src/components/card/actual.ts');
  assert.match((await property.hover())!.description, /外部标题/);
  assert.equal((await fixture('<my-ca|rd/>', files).definitions())[0]?.path, 'src/components/card/actual.ts');
});

test('局部注册覆盖全局，配置宏与泛型默认组件可静态解析', async () => {
  const files = { ...component, 'src/app.json': '{"usingComponents":{"my-card":"/components/global/index"}}', 'src/components/global/index.ts': 'Component({properties:{}})' };
  assert.equal((await fixture('<my-ca|rd/>', files).definitions())[0]?.path, 'src/components/card/index.ts');
  delete (files as Record<string, string>)['src/pages/index.json'];
  files['src/pages/index.ts' as keyof typeof files] = `const path='/components/card/index'; definePageConfig({usingComponents:{'my-card':path}});`;
  assert.equal((await fixture('<my-ca|rd/>', files).definitions())[0]?.path, 'src/components/card/index.ts');
  assert.equal((await fixture('<generic-ca|rd/>', { ...component, 'src/pages/index.json': '{"componentGenerics":{"generic-card":{"default":"/components/card/index"}}}' }).definitions())[0]?.path, 'src/components/card/index.ts');
});

test('npm 组件优先使用 miniprogram 实现入口，不跳 types 声明', async () => {
  const files = { ...component, 'src/pages/index.json': '{"usingComponents":{"pkg-card":"@vendor/ui/card"}}',
    'node_modules/@vendor/ui/package.json': '{"miniprogram":"wechat","types":"types/index.d.ts"}',
    'node_modules/@vendor/ui/types/index.d.ts': 'export interface Props {count:number}',
    'node_modules/@vendor/ui/wechat/card/index.js': 'Component({properties:{count:{type:Number,value:8}}});',
    'node_modules/@vendor/ui/wechat/card/index.wxml': '<slot name="header"/>',
  };
  assert.equal((await fixture('<pkg-card co|unt="8"/>', files).definitions())[0]?.path, 'node_modules/@vendor/ui/wechat/card/index.js');
});

test('slot 所属组件取最近的自定义父节点，不能跨过另一个组件', async () => {
  const files = { ...component, 'src/pages/index.json': '{"usingComponents":{"my-card":"/components/card/index","inner-card":"/components/inner/index"}}', 'src/components/inner/index.ts': 'Component({})', 'src/components/inner/index.wxml': '<slot name="header"/>' };
  assert.equal((await fixture('<my-card><inner-card><view slot="hea|der"/></inner-card></my-card>', files).definitions())[0]?.path, 'src/components/inner/index.wxml');
  assert.deepEqual(await fixture('<my-card><inner-card><view slot="act|ions"/></inner-card></my-card>', files).definitions(), []);
});

test('静态 include 中的插槽定位实际被包含的文件，循环包含会终止', async () => {
  const files = { ...component, 'src/components/card/index.wxml': '<include src="./slots.wxml"/>', 'src/components/card/slots.wxml': '<!-- 共享头部。 --><slot name="header"/><include src="./index.wxml"/>' };
  const context = fixture('<my-card><view slot="hea|der"/></my-card>', files);
  assert.equal((await context.definitions())[0]?.path, 'src/components/card/slots.wxml');
  assert.match((await context.hover())!.description, /共享头部/);
});

test('参数和插槽修改未保存时立即重新解析，保留草稿版本', async () => {
  const context = fixture('<my-card title-te|xt=""/>', component);
  assert.match((await context.hover())!.description, /默认标题/);
  context.documents.set('file:///workspace/src/components/card/index.ts', `Component({properties:{/** 新标题。 */\ntitleText:{type:String,value:'新默认值'}}})`);
  assert.match((await context.hover())!.description, /新标题[\s\S]*新默认值/);
  assert.equal((await context.definitions())[0]?.version, 7);
});

test('参数表达式仍按原脚本引用链导航，内置组件仍提供原说明', async () => {
  const expression = fixture('<my-card title-text="{{cap|tion}}"/>', { ...component, 'src/pages/index.ts': `const original='值';Page({data:{caption:original}});` });
  assert.equal((await expression.definitions())[0]?.text, 'original');
  assert.match((await fixture('<vi|ew/>', component).hover())!.description, /视图容器/);
  assert.deepEqual(await fixture('<!-- <my-ca|rd/> -->', component).definitions(), []);
});

test('取消请求不读工程，不解析动态插槽和不可用的外部插件实现', async () => {
  const context = fixture('<my-ca|rd/>', component);
  (context.request.cancellation as { isCancellationRequested: boolean }).isCancellationRequested = true;
  assert.deepEqual(await context.definitions(), []);
  assert.deepEqual(context.reads, []);
  assert.deepEqual(await fixture('<my-card><view slot="{{na|me}}"/></my-card>', component).definitions(), []);
  assert.deepEqual(await fixture('<remote-ca|rd/>', { 'src/pages/index.json': '{"usingComponents":{"remote-card":"plugin://remote/card"}}' }).definitions(), []);
});

test('独立命名模板沿实际调用页面解析组件，保留多个实现候选', async () => {
  const files = { ...component,
    'src/templates/card.wxml': '<template name="card"><my-card title-text="标题"/></template>',
    'src/pages/index.wxml': '<import src="../templates/card.wxml"/><template is="card"/>',
    'src/other/index.wxml': '<import src="../templates/card.wxml"/><template is="card"/>',
    'src/other/index.json': '{"usingComponents":{"my-card":"/components/other/index"}}',
    'src/components/other/index.ts': 'Component({properties:{titleText:{type:String,value:"其他"}}})',
  };
  const context = fixture('<template name="card"><my-card title-te|xt="标题"/></template>', files, 'src/templates/card.wxml');
  assert.deepEqual((await context.definitions()).map((item) => item.path).sort(), ['src/components/card/index.ts', 'src/components/other/index.ts']);
  assert.match((await context.hover())!.description, /默认标题[\s\S]*其他/);
});

test('组件依赖的 npm Behavior 通过 main 获取运行时字段，不采用同名类型声明', async () => {
  const files = { ...component,
    'src/components/card/index.ts': `import inherited from 'shared-behavior';Component({behaviors:[inherited]});`,
    'node_modules/shared-behavior/package.json': '{"types":"index.d.ts","main":"index.js"}',
    'node_modules/shared-behavior/index.d.ts': 'declare const inherited:{properties:{size:number}};export default inherited;',
    'node_modules/shared-behavior/index.js': 'module.exports=Behavior({properties:{/** 依赖包实现的尺寸。 */\nsize:{type:Number,value:10}}});',
  };
  const context = fixture('<my-card si|ze="10"/>', files);
  assert.equal((await context.definitions())[0]?.path, 'node_modules/shared-behavior/index.js');
  assert.match((await context.hover())!.description, /依赖包实现的尺寸/);
});

test('源码缺失的已注册组件仍隔离插槽，禁止跳到外层同名插槽', async () => {
  const files = { ...component, 'src/pages/index.json': '{"usingComponents":{"my-card":"/components/card/index","missing":"/missing/index"}}' };
  assert.deepEqual(await fixture('<my-card><missing><view slot="hea|der"/></missing></my-card>', files).definitions(), []);
});

test('未命名 WXML 缓冲区保留内置标签悬浮，不尝试解析文件目录', async () => {
  const context = fixture('<vi|ew/>', component);
  (context.request.document as { uri: string }).uri = 'untitled:Untitled-1';
  assert.match((await context.hover())!.description, /视图容器/);
  assert.deepEqual(context.reads, []);
});

test('重导出入口没有 WXML 时，插槽继续跟随真实组件的模板', async () => {
  const files = { ...component, 'src/components/card/index.ts': `export { default } from './actual';`, 'src/components/card/actual.ts': 'export default {properties:{}};', 'src/components/card/actual.wxml': '<!-- 真实组件插槽。 --><slot name="header"/>' };
  delete (files as Record<string, string>)['src/components/card/index.wxml'];
  const context = fixture('<my-card><view slot="hea|der"/></my-card>', files);
  assert.equal((await context.definitions())[0]?.path, 'src/components/card/actual.wxml');
  assert.match((await context.hover())!.description, /真实组件插槽/);
});

test('JSON 注释与联合构造类型均可解析', async () => {
  const files = { ...component, 'src/pages/index.json': '// 组件注册\n{"usingComponents":{"my-card":"/components/card/index"},}', 'src/components/card/index.ts': 'Component({properties:{count:{type:Number,optionalTypes:[String,null],value:0}}});' };
  assert.match((await fixture('<my-card co|unt=""/>', files).hover())!.description, /类型：number \| string \| any/);
});

test('组件 sourceRoot 和额外源码目录按工作区相对路径读取', async () => {
  const files = { 'src/pages/index.json': component['src/pages/index.json'], 'vendor/components/card/index.ts': 'Component({properties:{count:{type:Number,value:9}}});' };
  for (const options of [{ sourceRoot: 'vendor' }, { includePaths: ['vendor'] }]) {
    const context = fixture('<my-card co|unt=""/>', files, 'src/pages/index.wxml', options);
    assert.equal((await context.definitions())[0]?.path, 'vendor/components/card/index.ts');
    assert.match((await context.hover())!.description, /默认值：9/);
  }
});
