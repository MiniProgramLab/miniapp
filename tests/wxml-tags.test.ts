import assert from 'node:assert/strict';
import test from 'node:test';
import type { Disposable, LanguageRequest } from '../src/api';
import { provideCompletions } from '../src/languages/wxml/service';
import { provideAutoClosingTag, provideLinkedTags } from '../src/languages/wxml/tag-editing';
import { scanTags } from '../src/languages/wxml/parser';
import { createWxmlPlugin } from '../src/languages/wxml';

/** 光标标记对应编辑后的文档，自动闭合在刚输入的大于号后请求。 */
function request(source: string): LanguageRequest {
  const offset = source.indexOf('|');
  assert.ok(offset >= 0);
  return { document: { uri: 'untitled:tags.wxml', languageId: 'wxml', text: source.replace('|', ''), version: 1 }, offset, cancellation: { isCancellationRequested: false } };
}

test('接受新标签补全时生成完整标签对，已有属性或闭合符只补名称', () => {
  assert.equal(provideCompletions(request('<vi|')).find((item) => item.label === 'view')?.insertText, 'view>$0</view>');
  for (const source of ['<vi|>', '<vi| class="page">', '<vi| />']) {
    assert.equal(provideCompletions(request(source)).find((item) => item.label === 'view')?.insertText, 'view');
  }
  assert.equal(provideCompletions(request('<vi|'), false).find((item) => item.label === 'view')?.insertText, 'view');
});

test('结束标签优先补全当前未闭合的自定义或同名嵌套标签', () => {
  for (const source of ['<custom-card><view></view></|', '<view><view></view></|']) {
    const item = provideCompletions(request(source))[0]!;
    assert.equal(item.label, source.includes('custom') ? 'custom-card' : 'view');
    assert.equal(item.insertText, `${item.label}>`);
  }
  assert.equal(provideCompletions(request('<custom-card></cu|>'))[0]?.insertText, 'custom-card');
});

test('输入大于号自动闭合普通、自定义及多行标签，并识别属性表达式', () => {
  for (const [source, closing] of [['<view>|', '</view>'], ['<custom-card\n wx:if="{{a > b}}">|', '</custom-card>'], ['<view><view>|</view>', '</view>'], ['<wxs>|', '</wxs>']]) {
    assert.equal(provideAutoClosingTag(request(source!)), closing);
  }
});

test('已有配对标签、自闭合、结束标签或非结构文本不触发自动闭合', () => {
  for (const source of ['<view>|</view>', '<view>|\n<text></text>\n</view>', '<image />|', '<view></view>|', '<view title="a >| b">', '<!-- <view>| -->', '<![CDATA[<view>|]]>', '{{ "<view>|" }}', '<wxs>const a="<view>|";</wxs>']) {
    assert.equal(provideAutoClosingTag(request(source)), undefined, source);
  }
});

test('同步改名仅关联当前标签对，区分同名嵌套和兄弟节点', () => {
  const source = request('<view><vi|ew>内容</view></view><view></view>');
  const result = provideLinkedTags(source)!;
  assert.deepEqual(result.ranges, [{ start: 7, end: 11 }, { start: 16, end: 20 }]);
  assert.deepEqual(result.ranges.map((range) => source.document.text.slice(range.start, range.end)), ['view', 'view']);
  const closing = request('<custom-card>内容</custom-ca|rd>');
  assert.deepEqual(provideLinkedTags(closing)?.ranges.map((range) => closing.document.text.slice(range.start, range.end)), ['custom-card', 'custom-card']);
  assert.ok(new RegExp(result.wordPattern!).test('custom-card'));
});

test('标签名末尾和 WXS 外层标签可以联动，属性、脚本和错误配对不可联动', () => {
  assert.equal(provideLinkedTags(request('<view|></view>'))?.ranges.length, 2);
  assert.equal(provideLinkedTags(request('<wx|s>const fake="<view></view>";</wxs>'))?.ranges.length, 2);
  for (const source of ['<view cla|ss="view"></view>', '<vie|w />', '<vi|ew>', '<vi|ew><text></view></text>', '<!-- <vi|ew></view> -->', '<![CDATA[<vi|ew></view>]]>', '{{ "<vi|ew></view>" }}', '<wxs>const a="<vi|ew></view>";</wxs>']) {
    assert.equal(provideLinkedTags(request(source)), undefined, source);
  }
});

test('取消请求不插入文本或返回联动范围', () => {
  for (const source of ['<view>|', '<vi|ew></view>']) {
    const cancelled = { ...request(source), cancellation: { isCancellationRequested: true } };
    assert.equal(provideAutoClosingTag(cancelled), undefined);
    assert.equal(provideLinkedTags(cancelled), undefined);
  }
});

test('提前结束与交错扫描不会缓存不完整标签，文本修改后重新解析', () => {
  const text = '<cache-view><cache-text/></cache-view>';
  const first = scanTags(text);
  const second = scanTags(text);
  assert.equal(first.next().value?.name, 'cache-view');
  assert.equal(second.next().value?.name, 'cache-view');
  assert.deepEqual([...scanTags(text)].map((tag) => tag.name), ['cache-view', 'cache-text', 'cache-view']);
  assert.equal([...first].length, 2);
  assert.equal([...second].length, 2);
  assert.deepEqual([...scanTags(text)].map((tag) => tag.name), ['cache-view', 'cache-text', 'cache-view']);
  assert.deepEqual([...scanTags(text.replaceAll('view', 'page'))].map((tag) => tag.name), ['cache-page', 'cache-text', 'cache-page']);
});

test('WXML 插件释放时清空词法快照，重新注册后标签功能保持一致', async () => {
  const subscriptions: Disposable[] = [];
  const context = { logger: { info() {}, error() {} }, subscriptions: { add: <T extends Disposable>(resource: T): T => { subscriptions.push(resource); return resource; } } };
  const plugin = createWxmlPlugin();
  const features = plugin.setup(context);
  const source = request('<cache-pa|nel></cache-panel>');
  const first = [...scanTags(source.document.text)];
  const linked = await features.linkedEditing!.provide(source);
  assert.equal([...scanTags(source.document.text)][0], first[0]);
  for (const resource of subscriptions) resource.dispose();
  const next = [...scanTags(source.document.text)];
  assert.notEqual(next[0], first[0]);
  assert.deepEqual(next, first);
  assert.deepEqual(await plugin.setup(context).linkedEditing!.provide(source), linked);
  for (const resource of subscriptions) resource.dispose();
});
