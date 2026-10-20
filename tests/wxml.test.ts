import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest } from '../src/api';
import { provideCompletions, provideHover } from '../src/languages/wxml/service';

/** 使用光标标记构造包含未保存文本的语言请求。 */
function request(source: string): LanguageRequest {
  const offset = source.indexOf('|');
  assert.notEqual(offset, -1);
  return { document: { uri: 'untitled:示例.wxml', languageId: 'wxml', version: 1, text: source.replace('|', '') }, offset, cancellation: { isCancellationRequested: false } };
}

test('输入标签或结束标签时提供名称补全', () => {
  assert.ok(provideCompletions(request('<|')).some((item) => item.label === 'view'));
  assert.deepEqual(provideCompletions(request('</vi|')).map((item) => item.label), ['view', 'video']);
});

test('在名称中间补全时替换完整名称，保留后面的属性', () => {
  const source = request('<vi|ew class="page">');
  const item = provideCompletions(source).find((entry) => entry.label === 'view')!;
  assert.equal(source.document.text.slice(item.range.start, item.range.end), 'view');
  assert.equal(source.document.text.slice(item.range.end), ' class="page">');
});

test('属性补全过滤已存在属性，且保留当前正在编辑的属性', () => {
  assert.ok(!provideCompletions(request('<view class="page" |')).some((item) => item.label === 'class'));
  const item = provideCompletions(request('<view cl|ass="page">')).find((entry) => entry.label === 'class')!;
  assert.equal(item.insertText, 'class');
  assert.equal(item.insertTextFormat, 'plain');
  assert.equal(item.range.end - item.range.start, 5);
});

test('新增属性使用可填写片段，无值指令不添加赋值符', () => {
  assert.equal(provideCompletions(request('<view cl|')).find((item) => item.label === 'class')?.insertText, 'class="${1}"');
  assert.equal(provideCompletions(request('<view wx:e|')).find((item) => item.label === 'wx:else')?.insertText, 'wx:else');
});

test('属性值按前缀补全，并完整替换光标两侧的值', () => {
  const source = request('<image mode="as|pectFill" />');
  const items = provideCompletions(source);
  assert.deepEqual(items.map((item) => item.label), ['aspectFit', 'aspectFill']);
  assert.equal(source.document.text.slice(items[0]!.range.start, items[0]!.range.end), 'aspectFill');
});

test('带大于号和双花括号字符串的插值不打断标签扫描', () => {
  assert.ok(provideCompletions(request('<view wx:if="{{a > b}}" cl|')).some((item) => item.label === 'class'));
  assert.ok(provideCompletions(request('<view wx:if="{{a === \'}}\'}}" cl|')).some((item) => item.label === 'class'));
});

test('注释和文本插值中的伪标签不参与补全或悬浮', () => {
  for (const source of ['<!-- <vi| -->', '<!-- <vi|', '{{ "<vi|" }}', '正文 <view></view> |', '<view mode="{{va|lue}}">']) {
    assert.deepEqual(provideCompletions(request(source)), []);
    assert.equal(provideHover(request(source)), undefined);
  }
});

test('未闭合标签和多行属性仍然提供补全', () => {
  assert.ok(provideCompletions(request('<view\n  cl|')).some((item) => item.label === 'class'));
  assert.ok(provideCompletions(request('<view class="a">\n<te|')).some((item) => item.label === 'text'));
});

test('标签和属性悬浮保留精确范围，属性值不冒充属性名', () => {
  assert.equal(provideHover(request('<vi|ew>'))?.title, '<view>');
  assert.equal(provideHover(request('<view wx:i|f="{{visible}}">'))?.title, 'wx:if: expression');
  assert.equal(provideHover(request('<view class="cl|ass">')), undefined);
});

test('取消的请求不产生语言结果', () => {
  const source = { ...request('<vi|ew>'), cancellation: { isCancellationRequested: true } };
  assert.deepEqual(provideCompletions(source), []);
  assert.equal(provideHover(source), undefined);
});

test('逻辑节点不建议样式属性，未知组件仍可使用通用指令', () => {
  assert.ok(!provideCompletions(request('<block |')).some((item) => item.label === 'class'));
  assert.ok(provideCompletions(request('<custom-card wx:|')).some((item) => item.label === 'wx:if'));
});
