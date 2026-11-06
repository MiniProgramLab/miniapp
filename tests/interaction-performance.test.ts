import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createCheckpoint } from '../src/core/cooperative';
import { templateExpressions, expressionAt, clearExpressionCache } from '../src/languages/wxml/expression';
import { templateNodes } from '../src/languages/wxml/template-document';
import { templateDiagnostics } from '../src/languages/wxml/checks';
import { createScriptResolver } from '../src/languages/typescript';
import { directTemplateNames } from '../src/languages/typescript/direct-definition';
import { ScriptProject } from '../src/languages/typescript/project';
import { createDependencyTracking } from '../src/adapters/vscode/dependency-tracking';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createTemplateResolver } from '../src/languages/wxml/template-project';

/** 固定文档版本由测试显式推进，读取记录用于发现无关依赖展开。 */
function fixture(files: Record<string, string>) {
  const root = 'file:///interaction/';
  const documents = new Map(Object.entries(files).map(([name, text]) => [root + name, text]));
  const versions = new Map<string, number>(), reads: string[] = [];
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0), read: async (uri) => {
    reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text };
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{}}', version: 1, languageId: 'wxml' }, offset: 2, cancellation: { isCancellationRequested: false } };
  return { root, documents, versions, reads, reader, request };
}

test('表达式索引复用完整快照，保留嵌套循环、事件右边界和模板对象语法', () => {
  const text = `<!--{{ignored}}--><view wx:for="{{rows}}" wx:for-item="row"><text>{{row.name}}</text><button bindtap="save"/><template is="item" data="{{label:row.name}}"/></view><wxs module="m">const ignored='{{hidden}}';</wxs>`;
  const expressions = templateExpressions(text);
  assert.equal(templateExpressions(text), expressions);
  assert.equal(templateNodes(text), templateNodes(text));
  assert.deepEqual(expressions.map((item) => item.text), ['rows', 'row.name', 'save', 'label:row.name']);
  assert.deepEqual(expressions[0]!.bindings, []);
  assert.ok(expressions[1]!.bindings.some((binding) => binding.name === 'row' && binding.collection === 'rows'));
  assert.equal(expressions[3]!.objectLiteral, true);
  assert.equal(expressionAt(text, expressions[2]!.range.end)?.event, true);
  assert.equal(expressionAt(text, text.indexOf('ignored')), undefined);
  assert.notEqual(templateExpressions(text + '\n'), expressions);
  clearExpressionCache();
  assert.notEqual(templateExpressions(text), expressions);
});

test('诊断一次枚举真实表达式并保留 WXS 模块，不重复分析事件插值', async () => {
  const { request } = fixture({});
  const text = `<view a="{{title}}" bindtap="{{handler}}" catchtap="save"/><wxs module="m" src="./m.wxs"/><!--{{ignored}}-->`;
  const calls: string[] = [];
  await templateDiagnostics({ ...request, document: { ...request.document, text } }, { resolve: () => [], analyze: (_request, expression) => {
    calls.push(expression.text); assert.equal(expression.modules?.[0]?.name, 'm'); return undefined;
  } });
  assert.deepEqual(calls, ['title', 'handler', 'save']);
});

test('批量诊断让出线程后响应取消，不发布部分结果', async () => {
  const { request } = fixture({});
  const cancellation = { isCancellationRequested: false };
  setImmediate(() => { cancellation.isCancellationRequested = true; });
  let calls = 0;
  const diagnostics = await templateDiagnostics({ ...request, cancellation, checkpoint: createCheckpoint(0), document: { ...request.document, text: '<view>{{title}}</view>'.repeat(100) } }, { resolve: () => [], analyze: () => { calls++; return undefined; } });
  assert.deepEqual(diagnostics, []);
  assert.equal(calls, 0, '取消事件能在首个分析批次前被宿主处理');
});

test('轻量补全覆盖完整静态成员，选中后读取详情且草稿变化立即生效', async () => {
  const { root, documents, versions, reads, reader, request } = fixture({
    'page.ts': `import base from './base';import './heavy';Component({behaviors:[base],data:{local:1},methods:{save(){}}});`,
    'base.ts': `import {colors} from './colors';export default Behavior({data:{...colors},methods:{reset(){}}});`,
    'colors.ts': `export const colors={/** 颜色说明 */ label:'甲'};`,
    'heavy.ts': `export const unused={nested:{value:1}};`,
  });
  const scripts = createScriptResolver(reader);
  const expression = { text: '', range: { start: 2, end: 2 }, bindings: [] };
  const deferred = await scripts.complete!({ ...request, deferCompletionDetails: true }, expression);
  assert.deepEqual(deferred.map((item) => item.label).sort(), ['label', 'local', 'reset', 'save']);
  assert.ok(!reads.some((uri) => /heavy/.test(uri)), '候选列表不加载无关方法依赖');
  const label = deferred.find((item) => item.label === 'label')!;
  const before = reads.length;
  assert.equal(await label.resolve!({ isCancellationRequested: true }), undefined);
  assert.equal(reads.length, before);
  assert.equal((await label.resolve!({ isCancellationRequested: false }))?.documentation, '颜色说明');
  assert.ok(!reads.some((uri) => /heavy/.test(uri)), '字面量详情不触发完整类型图');
  const complete = await scripts.complete!(request, expression);
  assert.deepEqual(deferred.map((item) => item.label).sort(), complete.map((item) => item.label).sort());
  documents.set(root + 'colors.ts', `export const colors={/** 新颜色说明 */ label:'乙', extra:true};`);
  versions.set(root + 'colors.ts', 1);
  assert.equal((await label.resolve!({ isCancellationRequested: false }))?.documentation, '新颜色说明');
  assert.ok((await scripts.complete!({ ...request, deferCompletionDetails: true }, expression)).some((item) => item.label === 'extra'));
});

test('延迟详情区分成员和页面同名字段，组件参数继续使用运行时类型', async () => {
  const { reader, request } = fixture({ 'page.ts': `const props={label:'默认'};Component({properties:props,data:{name:'页面',user:{name:'用户'}}});` });
  const scripts = createScriptResolver(reader);
  const expression = { text: 'user.n', range: { start: 2, end: 8 }, bindings: [] };
  const current = { ...request, document: { ...request.document, text: '{{user.n}}' }, offset: 8 };
  const member = (await scripts.complete!({ ...current, deferCompletionDetails: true }, expression)).find((item) => item.label === 'name')!;
  const full = (await scripts.complete!(current, expression)).find((item) => item.label === 'name')!;
  assert.deepEqual(await member.resolve!({ isCancellationRequested: false }), { detail: full.detail, documentation: full.documentation });
  const rootExpression = { text: '', range: { start: 2, end: 2 }, bindings: [] };
  const prop = (await scripts.complete!({ ...request, deferCompletionDetails: true }, rootExpression)).find((item) => item.label === 'label')!;
  const original = (await scripts.complete!(request, rootExpression)).find((item) => item.label === 'label')!;
  assert.deepEqual(await prop.resolve!({ isCancellationRequested: false }), { detail: original.detail, documentation: original.documentation });
});

test('动态状态和开放 Record 不使用不完整的静态候选，事件保留函数筛选', async () => {
  for (const text of [
    `function data(){return {label:'甲'}};Page({data});`,
    `const data:Record<string,string>={} as any;Page({data});`,
    `type Record<K,V>={label:V};const data:Record<'other',string>={} as any;Page({data});`,
  ]) {
    const { reader, request } = fixture({ 'page.ts': text });
    assert.equal(await directTemplateNames(reader, request, { text: '', range: { start: 2, end: 2 }, bindings: [] }, {}), undefined);
  }
  const { reader, request } = fixture({ 'page.ts': `Page({data:{label:'甲'},save(){}});` });
  const scripts = createScriptResolver(reader), expression = { text: '', range: { start: 2, end: 2 }, bindings: [], event: true };
  assert.deepEqual((await scripts.complete!({ ...request, deferCompletionDetails: true }, expression)).map((item) => item.label), ['save']);
});

test('脚本空白修改复用导入路径，新增缺失依赖和配置变化仍重新解析', async () => {
  const { root, documents, versions, reads, reader, request } = fixture({
    'page.ts': `import {title} from './model';Page({data:{title}});`,
    'model.ts': `import './later';export const title='甲';`,
  });
  const first = await new ScriptProject(reader, request, {}).create();
  assert.ok(first); const firstReads = reads.length;
  reads.length = 0;
  documents.set(root + 'page.ts', documents.get(root + 'page.ts') + '\n'); versions.set(root + 'page.ts', 1);
  const next = await new ScriptProject(reader, request, {}).create();
  assert.ok(next); assert.notEqual(next!.program, first!.program);
  assert.ok(reads.length < firstReads / 2, '导入不变时不重复扩展名和缺失路径探测');
  documents.set(root + 'later.ts', `export const ready=true;`); versions.set(root + 'later.ts', 1); versions.set(root, 1);
  const added = await new ScriptProject(reader, request, {}).create();
  assert.ok(added!.program.getSourceFile(root + 'later.ts'), '阴性模块缓存跟随文件创建失效');
  documents.set(root + 'tsconfig.json', '{"compilerOptions":{"strict":true}}'); versions.set(root + 'tsconfig.json', 1);
  assert.equal((await new ScriptProject(reader, request, {}).create())!.program.getCompilerOptions().strict, true);
});

test('具名模板连续查询复用调用图，调用者编辑和新增页面使索引失效', async () => {
  const { root, documents, reads, reader } = fixture({
    'page.wxml': `<import src="./shared.wxml"/><template is="item" data="{{label:title}}"/>`,
    'shared.wxml': `<template name="item">{{label}}</template>`,
  });
  const revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision);
  const shared: WorkspaceReader = { ...reader, revision: tracking.observe, capture: tracking.capture,
    read: async (uri) => { tracking.observe(uri); return reader.read(uri); },
    findFiles: async () => [...documents.keys()].filter((uri) => uri.endsWith('.wxml')) };
  const text = documents.get(root + 'shared.wxml')!;
  const request: LanguageRequest = { document: { uri: root + 'shared.wxml', text, languageId: 'wxml', version: 1 }, offset: text.indexOf('label') + 2, cancellation: { isCancellationRequested: false } };
  const expression = expressionAt(text, request.offset)!;
  const templates = createTemplateResolver(shared, { resolve: (_request, current) => (current.contexts ?? []).map((context) => ({ uri: context.uri, range: { start: 0, end: 1 }, originRange: expression.range })) });
  try {
    const first = await templates.resolve(request, expression);
    assert.ok(first.some((item) => item.uri === root + 'page.wxml'));
    reads.length = 0;
    assert.deepEqual(await templates.resolve(request, expression), first);
    assert.deepEqual(reads, [], '相同快照不枚举或重读整份模板图');
    documents.set(root + 'page.wxml', '<view/>'); revisions.changed(root + 'page.wxml', root);
    assert.deepEqual(await templates.resolve(request, expression), []);
    documents.set(root + 'new.wxml', `<import src="./shared.wxml"/><template is="item"/>`); revisions.changed(root + 'new.wxml', root, true);
    assert.ok((await templates.resolve(request, expression)).some((item) => item.uri === root + 'new.wxml'));
  } finally { tracking.dispose(); }
});
