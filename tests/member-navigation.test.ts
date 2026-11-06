import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createScriptResolver } from '../src/languages/typescript';
import { directTemplateDefinition, directTemplateNames } from '../src/languages/typescript/direct-definition';

/** 根字段和成员拥有不同说明，用于发现错误借用页面同名字段的结果。 */
function fixture(text: string) {
  const root = 'file:///members/';
  const files = new Map([[root + 'page.ts', text], [root + 'heavy.ts', 'export const unrelated=true;']]);
  const reads: string[] = [];
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', read: async (uri) => { reads.push(uri); const text = files.get(uri); return text === undefined ? undefined : { text }; } };
  /** 文本与光标均使用真实表达式范围。 */
  const query = (expression: string): LanguageRequest => ({ document: { uri: root + 'page.wxml', text: '{{' + expression + '}}', version: 1, languageId: 'wxml' }, offset: 2 + expression.length, cancellation: { isCancellationRequested: false }, deferCompletionDetails: true });
  return { root, files, reads, reader, query, scripts: createScriptResolver(reader) };
}

test('嵌套静态对象补全、详情、悬浮和下标导航不读取无关导入', async () => {
  const { root, files, reads, reader, query, scripts } = fixture(`import './heavy';Page({data:{name:'页面',user:{/** 用户姓名 */name:'用户',age:18}},methods:{save(){}}});`);
  const request = query('user.');
  const expression = { text: 'user.', range: { start: 2, end: 7 }, bindings: [] };
  const candidates = await scripts.complete!(request, expression);
  assert.deepEqual(candidates.map((item) => item.label).sort(), ['age', 'name']);
  const selected = candidates.find((item) => item.label === 'name')!;
  assert.deepEqual(await selected.resolve!({ isCancellationRequested: false }), { detail: '"用户"', documentation: '用户姓名' });
  const hoverExpression = { text: 'user.name', range: { start: 2, end: 11 }, bindings: [] };
  assert.equal((await scripts.hover!(query('user.name'), hoverExpression))?.description, '用户姓名');
  const bracket = `user['name']`;
  const target = (await directTemplateDefinition(reader, { ...query(bracket), offset: 11 }, { text: bracket, range: { start: 2, end: 14 }, bindings: [] }))![0]!;
  assert.equal(target.uri, root + 'page.ts');
  assert.equal(files.get(target.uri)!.slice(target.range.start, target.range.end), 'name');
  assert.equal(query(bracket).document.text.slice(target.originRange.start, target.originRange.end), 'name');
  assert.ok(!reads.some((uri) => uri.endsWith('/heavy.ts')));
  const full = await scripts.complete!({ ...request, deferCompletionDetails: false }, expression);
  assert.deepEqual(candidates.map((item) => item.label).sort(), full.map((item) => item.label).sort());
});

test('带点的下标名称与多层成员链不混用缓存', async () => {
  const { reader, query } = fixture(`Page({data:{a:{'b.c':{name:'甲'},b:{c:{name:'乙'}}}}});`);
  const targets = [];
  for (const text of [`a['b.c'].name`, 'a.b.c.name']) {
    const request = query(text);
    targets.push((await directTemplateDefinition(reader, request, { text, range: { start: 2, end: 2 + text.length }, bindings: [] }))![0]!.range.start);
  }
  assert.notEqual(targets[0], targets[1]);
});

test('显式类型、动态成员及循环变量不使用猜测的轻量结果', async () => {
  for (const source of [`interface User {name:string};const user={} as User;Page({data:{user}});`, `const user=loadUser();Page({data:{user}});`]) {
    const { reader, query } = fixture(source);
    assert.equal(await directTemplateNames(reader, query('user.'), { text: 'user.', range: { start: 2, end: 7 }, bindings: [] }, {}), undefined);
  }
  const { reader, query } = fixture(`Page({data:{user:{name:'页面'}}});`);
  assert.equal(await directTemplateDefinition(reader, query('user.name'), { text: 'user.name', range: { start: 2, end: 11 }, bindings: [{ name: 'user', kind: 'item', range: { start: 0, end: 1 }, collection: 'rows' }] }), undefined);
});

test('事件名称轻量筛选只返回可确认的函数，保留函数字段和继承方法', async () => {
  const { reads, query, scripts } = fixture(`import './heavy';Page({data:{saveLabel:'文字',saveAction:()=>true},save(){}});`);
  const request = query('sav');
  const expression = { text: 'sav', range: { start: 2, end: 5 }, bindings: [], event: true };
  const candidates = await scripts.complete!(request, expression);
  assert.deepEqual(candidates.map((item) => item.label).sort(), ['save', 'saveAction']);
  assert.ok(!reads.some((uri) => uri.endsWith('/heavy.ts')));
  const full = await scripts.complete!({ ...request, deferCompletionDetails: false }, expression);
  assert.deepEqual(candidates.map((item) => item.label).sort(), full.map((item) => item.label).sort());
});
