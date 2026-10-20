import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, TemplateExpression } from '../src/api';
import { expressionNames } from '../src/languages/typescript/expression-names';
import { componentData } from '../src/languages/wxml/component-data';

/** 数据别名验证使用真实语法引用，键名及局部作用域不按字符串替换。 */
function fixture(value: string) {
  const text = '<view>{{' + value + '}}</view>';
  const request: LanguageRequest = { document: { uri: 'file:///data/page.wxml', languageId: 'wxml', version: 3, text }, offset: 8, cancellation: { isCancellationRequested: false } };
  const expression: TemplateExpression = { text: value, range: { start: 8, end: 8 + value.length }, bindings: [] };
  const parsed = expressionNames(request, expression);
  assert.equal(parsed.complete, true);
  const uses = parsed.names.map((use) => ({ ...use, uri: request.document.uri }));
  return { request, uses, range: { start: 0, end: text.length } };
}

test('数据别名保留常用名称并避开大小写冲突，对象简写的键契约保持原名', () => {
  const graph = fixture('{Title, title, URL, userName, detail: Title.name}');
  const result = componentData(graph.request, graph.range, ['Title', 'title', 'URL', 'userName'], graph.uses);
  assert.deepEqual(result.bindings, [{ name: 'Title', property: 'title2', attribute: 'title2' }, { name: 'title', property: 'title', attribute: 'title' }, { name: 'URL', property: 'url', attribute: 'url' }, { name: 'userName', property: 'userName', attribute: 'user-name' }]);
  let text = graph.request.document.text;
  for (const edit of [...result.edits].sort((left, right) => right.range.start - left.range.start)) text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
  assert.equal(text, '<view>{{{Title: title2, title, URL: url, userName, detail: title2.name}}}</view>');
  assert.equal(result.edits.length, 3);
});

test('组件数据改写只接受当前选区的真实引用，过期坐标拒绝部分迁移', () => {
  const graph = fixture('Title + outside');
  const references = [...graph.uses, { name: 'Title', uri: 'file:///data/shared.wxml', range: { start: 0, end: 5 } }];
  const result = componentData(graph.request, { start: 8, end: 13 }, ['Title'], references);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0]!.expectedText, graph.request.document.text);
  assert.throws(() => componentData(graph.request, graph.range, ['Title'], [{ name: 'Title', uri: graph.request.document.uri, range: { start: 9, end: 14 } }]), /快照/);
});
