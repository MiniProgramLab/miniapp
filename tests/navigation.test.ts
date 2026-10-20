import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, NavigationStep, WorkspaceReader } from '../src/api';
import { createNavigationTracking } from '../src/adapters/vscode/navigation-tracking';
import { createProjectFileResolver, createRouteResolver } from '../src/resolution';
import { createScriptResolver } from '../src/languages/typescript';
import { createNavigatorPlugin, createTemplateResolver, createWxmlPlugin } from '../src/languages/wxml';

/** 通过真实 WXML 与脚本提供器验证说明，不在测试中猜测失败原因。 */
function fixture(files: Record<string, string>, options = {}) {
  const root = 'file:///navigation/';
  const documents = new Map(Object.entries(files).map(([file, text]) => [new URL(file, root).href, text.replace('|', '')]));
  const navigation = createNavigationTracking();
  const raw: WorkspaceReader = {
    navigation, root: () => root, revision: (uri) => documents.get(uri) ?? 'missing',
    read: async (uri) => { const text = documents.get(uri); return text === undefined ? undefined : { text }; },
    findFiles: async (_uri, _pattern, limit) => [...documents.keys()].filter((uri) => uri.endsWith('.wxml')).slice(0, limit),
  };
  const reader: WorkspaceReader = { ...raw, fileResolver: (uri, cancellation) => createProjectFileResolver(raw, uri, cancellation) };
  const source = files['page.wxml']!;
  const request: LanguageRequest = { document: { uri: new URL('page.wxml', root).href, text: source.replace('|', ''), languageId: 'wxml', version: 1 }, offset: source.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader, () => options));
  const features = createWxmlPlugin(undefined, scripts, undefined, undefined, reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  const routes = createNavigatorPlugin(createRouteResolver(reader, scripts)).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  return { navigation, request, run: () => navigation.capture(() => features.definition!.provide(request)), route: () => navigation.capture(() => routes.definition!.provide(request)) };
}

test('导航追踪隔离并发与嵌套请求，普通查询不保留步骤且记录有界', async () => {
  const navigation = createNavigationTracking();
  const note = (message: string) => navigation.record({ code: 'context', message });
  note('作用域之外');
  const results = await Promise.all(['甲', '乙'].map((name) => navigation.capture(async () => {
    note(name); await Promise.resolve();
    const inner = await navigation.capture(() => { note('内层'); return 2; });
    assert.deepEqual(inner.steps.map((step) => step.message), ['内层']);
    note(name); return name;
  })));
  assert.deepEqual(results.map((result) => result.steps.map((step) => step.message)), [['甲'], ['乙']]);
  const bounded = await navigation.capture(() => { for (let index = 0; index < 1000; index++) note(String(index)); });
  assert.equal(bounded.steps.length, 201);
  assert.match(bounded.steps.at(-1)!.message, /显示上限/);
  navigation.dispose();
});

test('Behavior 导航追踪真实导入链，缓存命中仍能说明符号来源', async () => {
  const graph = fixture({ 'page.wxml': '<view bindtap="ru|n"/>', 'page.ts': "import {shared} from './shared';Component({behaviors:[shared]});", 'shared.ts': 'export const shared=Behavior({methods:{run(){}}});' });
  try {
    const cold = await graph.run();
    assert.equal(cold.value[0]!.uri, 'file:///navigation/shared.ts');
    assert.ok(cold.steps.some((step) => step.code === 'path' && step.uri === 'file:///navigation/shared.ts'));
    const warm = await graph.run();
    assert.deepEqual(warm.value, cold.value);
    assert.ok(warm.steps.some((step) => step.code === 'cached'));
    assert.ok(warm.steps.some((step) => step.code === 'path' && step.uri === 'file:///navigation/shared.ts'));
  } finally { graph.navigation.dispose(); }
});

test('未声明成员和缺失同名脚本使用真实解析结论说明', async () => {
  for (const [script, code] of [["Page({data:{known:1}})", 'symbol'], [undefined, 'missing']] as const) {
    const graph = fixture({ 'page.wxml': '<view>{{unkno|wn}}</view>', ...(script ? { 'page.ts': script } : {}) });
    try {
      const result = await graph.run();
      assert.equal(result.value.length, 0);
      assert.ok(result.steps.some((step) => step.code === code));
    } finally { graph.navigation.dispose(); }
  }
});

test('动态模板路径、缺失别名和错误配置分别报告，不执行工程配置', async () => {
  const cases: { files: Record<string, string>; codes: NavigationStep['code'][] }[] = [
    { files: { 'page.wxml': '<include src="{{pa|th}}"/>' }, codes: ['dynamic'] },
    { files: { 'page.wxml': '<include src="@/mis|sing.wxml"/>' }, codes: ['alias', 'missing'] },
    { files: { 'page.wxml': '<include src="@/ca|rd.wxml"/>', 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./*"]}},"extends":"./missing.json"}', 'card.wxml': '<view/>' }, codes: ['config', 'alias'] },
  ];
  for (const sample of cases) {
    const graph = fixture(sample.files);
    try {
      const result = await graph.run();
      for (const code of sample.codes) assert.ok(result.steps.some((step) => step.code === code), `${code}: ${JSON.stringify(result.steps)}`);
      if (sample.codes.includes('config')) assert.ok(result.steps.some((step) => /missing/.test(step.message)));
    } finally { graph.navigation.dispose(); }
  }
});

test('脚本预算耗尽在仍有部分定义时也明确记录，取消后不生成候选', async () => {
  const graph = fixture({ 'page.wxml': '<view bindtap="ru|n"/>', 'page.ts': "import {shared} from './shared';Component({behaviors:[shared],methods:{run(){}}});", 'shared.ts': 'export const shared=Behavior({methods:{other(){}}});' }, { maxFiles: 1 });
  try {
    const result = await graph.run();
    assert.equal(result.value.length, 1);
    assert.ok(result.steps.some((step) => step.code === 'budget'));
    const cancelled = await graph.navigation.capture(() => createScriptResolver({ ...({} as WorkspaceReader) }).resolve({ ...graph.request, cancellation: { isCancellationRequested: true } }, { text: 'run', range: { start: 0, end: 3 }, bindings: [] }));
    assert.deepEqual(cancelled.value, []);
  } finally { graph.navigation.dispose(); }
});

test('页面路由说明配置来源与缓存，缺失目录和未注册页面保留实际原因', async () => {
  const graph = fixture({ 'page.wxml': '<navigator url="/det|ail"/>', 'app.json': '{"pages":["detail"]}', 'detail.ts': 'Page({});' });
  try {
    const first = await graph.route();
    assert.equal(first.value[0]!.uri, 'file:///navigation/detail.ts');
    assert.ok(first.steps.some((step) => step.code === 'config' && step.uri === 'file:///navigation/app.json'));
    assert.ok((await graph.route()).steps.some((step) => step.code === 'cached'));
  } finally { graph.navigation.dispose(); }
  for (const config of [undefined, '{"pages":[]}']) {
    const missing = fixture({ 'page.wxml': '<navigator url="/det|ail"/>', ...(config ? { 'app.json': config } : {}) });
    try {
      const result = await missing.route();
      assert.equal(result.value.length, 0);
      assert.ok(result.steps.some((step) => step.code === 'missing'));
      if (config) assert.ok(result.steps.some((step) => /未在应用配置中注册/.test(step.message)));
    } finally { missing.navigation.dispose(); }
  }
});
