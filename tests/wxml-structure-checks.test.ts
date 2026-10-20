import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodeAction, LanguageRequest } from '../src/api';
import { structureChecks } from '../src/languages/wxml/structure-checks';
import { structure } from '../src/languages/wxml/structure';
import { createWxmlPlugin, createTemplateResolver, createComponentResolver } from '../src/languages/wxml';
import { checkWorkspace } from '../src/core/workspace-check';
import { createScriptResolver, createComponentScriptResolver } from '../src/languages/typescript';

/** 结构检查直接使用当前草稿，不需要脚本、配置或文件读取。 */
function request(text: string): LanguageRequest {
  return { document: { uri: 'file:///workspace/page.wxml', languageId: 'wxml', text, version: 3 }, offset: 0, cancellation: { isCancellationRequested: false } };
}

/** 在副本上应用真实编辑，同时核对原文和版本保护。 */
function apply(source: LanguageRequest, action: CodeAction): string {
  let text = source.document.text;
  for (const edit of [...action.edits].sort((left, right) => right.range.start - left.range.start)) {
    assert.equal(edit.uri, source.document.uri); assert.equal(edit.version, 3);
    assert.equal(edit.expectedText, source.document.text);
    assert.equal(text.slice(edit.range.start, edit.range.end), edit.oldText);
    text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
  }
  return text;
}

test('结构诊断定位错配、缺失和多余结束标签，修复保留正文与换行', () => {
  for (const [text, expected] of [
    ['<view>中文</text>', '<view>中文</view>'],
    ['<view>\r\n  <text>内容\r\n</view>', '<view>\r\n  <text>内容\r\n  </text>\r\n</view>'],
    ['</text><view/>', '<view/>'],
    ['<view><text>内容', '<view><text>内容</text></view>'],
    ['<view></view/>', '<view></view>'],
  ]) {
    const source = request(text!);
    const result = structureChecks(source, { start: 0, end: text!.length });
    assert.ok(result.diagnostics.some((item) => item.code?.startsWith('wxml-')));
    const fixed = result.actions.map((action) => apply(source, action));
    assert.ok(fixed.includes(expected!), JSON.stringify(fixed));
    assert.deepEqual(structureChecks(request(expected!)).diagnostics, []);
  }
});

test('重复属性仅定位后续声明，删除修复保留首个属性、引号及其他内容', () => {
  const source = request('<view\r\n  class="first"\r\n  class=\'second\' title="中文 > 标题"/>');
  const result = structureChecks(source);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0]!.code, 'wxml-duplicate-attribute');
  const range = result.diagnostics[0]!.range;
  assert.equal(source.document.text.slice(range.start, range.end), 'class');
  const actions = structureChecks(source, range).actions;
  assert.equal(actions.length, 1); assert.match(actions[0]!.title, /保留首个/);
  const fixed = apply(source, actions[0]!);
  assert.match(fixed, /class="first"/); assert.match(fixed, /title="中文 > 标题"/);
  assert.ok(!fixed.includes('second')); assert.deepEqual(structureChecks(request(fixed)).diagnostics, []);
});

test('条件分支检查同级相邻关系，注释与WXS透明，正文和其他节点会打断', () => {
  for (const middle of ['\n <!-- 注释 -->\n', '<wxs module="util">var fake="<view/>";module.exports={};</wxs>']) {
    assert.deepEqual(structureChecks(request('<view wx:if="{{a}}"/>' + middle + '<view wx:elif="{{b}}"/><view wx:else/>')).diagnostics, []);
  }
  for (const text of ['<view wx:else/>', '<view wx:if="{{a}}"/>文字<view wx:else/>', '<view wx:if="{{a}}"/><text/><view wx:elif="{{b}}"/>', '<view wx:if="{{a}}"><text wx:else/></view>', '<view wx:if="{{a}}"/><view wx:else/><view wx:else/>']) {
    assert.ok(structureChecks(request(text)).diagnostics.some((item) => item.code === 'wxml-orphan-conditional'), text);
  }
  const source = request('<view wx:elif="{{ready}}"/>');
  const problem = structureChecks(source).diagnostics[0]!;
  assert.equal(apply(source, structureChecks(source, problem.range).actions[0]!), '<view wx:if="{{ready}}"/>');
  const otherwise = request('<view wx:else/>');
  assert.deepEqual(structureChecks(otherwise, { start: 0, end: 100 }).actions, [], '不能凭空生成 else 所需的条件');
  assert.deepEqual(structureChecks(request('<view><text></view><view wx:else/>')).diagnostics.map((item) => item.code), ['wxml-mismatched-tag'], '错配恢复后的条件链保持未知，避免追加不可靠的级联错误');
});

test('同一节点互斥条件指令单独提示，修复明确保留首个条件', () => {
  const source = request('<view wx:if="{{ready}}" wx:else/>');
  const result = structureChecks(source, { start: 0, end: source.document.text.length });
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0]!.code, 'wxml-conditional-conflict');
  assert.equal(apply(source, result.actions[0]!), '<view wx:if="{{ready}}"/>');
});

test('wx:key只纠正确定的结构用法，列表属性名称与未知数据保持开放', () => {
  for (const key of ['id', '*this', 'foo.bar', '0', '字段']) {
    assert.deepEqual(structureChecks(request(`<view wx:for="{{items}}" wx:key="${key}"/>`)).diagnostics, []);
  }
  for (const [text, fixed] of [
    ['<view wx:for="{{items}}" wx:key="{{item.id}}"/>', '<view wx:for="{{items}}" wx:key="id"/>'],
    ['<view wx:for="{{items}}" wx:for-item="row" wx:key="{{ row.uid }}"/>', '<view wx:for="{{items}}" wx:for-item="row" wx:key="uid"/>'],
    ['<view wx:key="id"/>', '<view/>'],
  ]) {
    const source = request(text!); const result = structureChecks(source, { start: 0, end: text!.length });
    assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0]!.code, 'wxml-invalid-key');
    assert.equal(result.diagnostics[0]!.severity, 'warning');
    assert.equal(apply(source, result.actions[0]!), fixed);
  }
  for (const key of ['', '{{index}}', '{{item.id + suffix}}']) {
    const source = request(`<view wx:for="{{items}}" wx:key="${key}"/>`);
    const result = structureChecks(source, { start: 0, end: source.document.text.length });
    assert.equal(result.diagnostics.length, 1); assert.deepEqual(result.actions, [], '未知键不能猜测为 id 或索引');
  }
});

test('注释、CDATA、插值和WXS中的伪标签不进入结构诊断', () => {
  const text = '<!-- <view wx:else/> --><![CDATA[</wrong>]]>{{"<bad>"}}<wxs module="util">var value="<view wx:key=\'x\'/>";</wxs><view title="{{\'<fake/>\'}}"/>';
  assert.deepEqual(structureChecks(request(text)).diagnostics, []);
});

test('未完成输入不产生尾部级联错误，已有完整属性错误仍可定位', () => {
  for (const text of ['<view><text', '<view title="未完成', '<view>{{ value', '<view><!-- 注释', '<view><![CDATA[内容']) {
    assert.deepEqual(structureChecks(request(text)).diagnostics, [], text);
  }
  const source = request('<view class="a" class="b"/><text');
  assert.deepEqual(structureChecks(source).diagnostics.map((item) => item.code), ['wxml-duplicate-attribute']);
  assert.deepEqual(structureChecks(request('<wxs module="util">var value=1;')).diagnostics.map((item) => item.code), ['wxml-unclosed-tag']);
});

test('结构灯泡遵守选区、取消和解析预算，连续查询复用已有索引', () => {
  const source = request('<view id="a" id="b"/><text wx:else/>'); const cached = structure(source.document.text);
  assert.deepEqual(structureChecks(source, { start: 1, end: 2 }).actions, []);
  assert.equal(structure(source.document.text), cached);
  assert.deepEqual(structureChecks({ ...source, cancellation: { isCancellationRequested: true } }), { diagnostics: [], actions: [] });
  assert.deepEqual(structureChecks(request('x'.repeat(2_000_001))).diagnostics, []);
  assert.deepEqual(structureChecks(request('<view>'.repeat(300))).diagnostics, []);
  const budget: string[] = [];
  assert.deepEqual(structureChecks(request('<view></wrong>'.repeat(300)), undefined, { record: (step) => { budget.push(step.code); } }), { diagnostics: [], actions: [] });
  assert.deepEqual(budget, ['budget'], '错误恢复不能绕过深度预算或返回部分修复');
});

test('没有脚本和文件读取端口时仍注册结构诊断，未打开模板复用同一规则', async () => {
  const features = createWxmlPlugin().setup({ logger: { info() {}, error() {} }, subscriptions: { add: <T>(item: T): T => item } });
  const source = request('<view wx:else/>');
  assert.ok(features.diagnostics);
  assert.equal((await features.diagnostics.provide(source))[0]!.code, 'wxml-orphan-conditional');
  const result = await checkWorkspace({ root: () => 'file:///workspace/', read: async () => source.document }, [{ uri: source.document.uri, languageId: 'wxml' }], [{ id: 'structure', name: '结构', languages: ['wxml'], active: () => true, provide: features.diagnostics.provide }], { cancellation: source.cancellation });
  assert.equal(result.report.status, 'complete'); assert.equal(result.report.findings[0]!.code, 'wxml-orphan-conditional');
});

test('组合提供器对无目录草稿保留结构诊断和修复，层级虚拟URI继续正常分析', async () => {
  const reader = { root: () => undefined, read: async () => undefined, findFiles: async () => [] };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const components = createComponentResolver(reader, (snapshot) => createComponentScriptResolver(snapshot));
  const features = createWxmlPlugin(undefined, scripts, undefined, components, reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: <T>(item: T): T => item } });
  for (const uri of ['untitled:Untitled-1', 'memfs:/workspace/page.wxml']) {
    const original = request('<view wx:else/><view wx:for="{{items}}" wx:key="{{item.id}}"/>');
    const source = { ...original, document: { ...original.document, uri } };
    const diagnostics = await features.diagnostics!.provide(source);
    assert.deepEqual(diagnostics.map((item) => item.code), ['wxml-invalid-key', 'wxml-orphan-conditional']);
    const actions = await features.codeActions!.provide(source, diagnostics[0]!.range, 'quickfix');
    assert.ok(actions.some((action) => action.title === '将 wx:key 改为静态属性 id'));
  }
});
