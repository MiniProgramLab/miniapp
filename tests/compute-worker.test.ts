import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createDependencyTracking } from '../src/adapters/vscode/dependency-tracking';
import { createComputeServices } from '../src/compute-services';
import { createScriptResolver, createComponentScriptResolver, createDataPathPlugin, createWxsPlugin } from '../src/languages/typescript';
import { createProjectFileResolver } from '../src/resolution';

/** 使用真实构建线程和虚拟文件系统，核对线程边界与原始语义。 */
function fixture(input: Record<string, string>, events = false) {
  const root = 'memfs:///worker/';
  const documents = new Map(Object.entries(input).map(([uri, text]) => [root + uri, text]));
  const revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision), errors: unknown[] = [];
  let version = 1;
  const listeners = new Set<Parameters<NonNullable<WorkspaceReader['onDidChange']>>[0]>();
  const source: WorkspaceReader = { root: () => root, revision: tracking.observe, capture: tracking.capture,
    ...(events ? { onDidChange: (listener: Parameters<NonNullable<WorkspaceReader['onDidChange']>>[0]) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } } : {}),
    read: async (uri) => { tracking.observe(uri); const text = documents.get(uri); return text === undefined ? undefined : { text, version }; },
    directory: async (uri) => [...documents.keys()].some((name) => name.startsWith(uri.replace(/\/?$/, '/'))),
    findFiles: async (_uri, pattern, limit, scope) => [...documents.keys()].filter((uri) => uri.startsWith(scope?.root ?? root) && (pattern.includes('d.ts') ? uri.endsWith('.d.ts') : uri.endsWith('.wxml'))).slice(0, limit),
  };
  const reader: WorkspaceReader = { ...source, fileResolver: (uri, cancellation) => createProjectFileResolver(source, uri, cancellation) };
  const compute = createComputeServices({ reader, filename: fileURLToPath(new URL('../dist/compute-worker.cjs', import.meta.url)), roots: () => [root], settings: () => ({ script: {}, component: {}, dataPath: {}, wxs: {}, navigation: {} }), logger: { info() {}, error: (...args) => errors.push(args) } });
  /** 光标使用真实 UTF-16 偏移，覆盖中文、换行和模板括号。 */
  const request = (name: string, offset: number, deferred = false): LanguageRequest => ({ document: { uri: root + name, languageId: name.endsWith('.wxml') ? 'wxml' : name.endsWith('.wxs') ? 'wxs' : 'typescript', text: documents.get(root + name)!, version }, offset, deferCompletionDetails: deferred, cancellation: { isCancellationRequested: false } });
  /** 内容事件通过修订端口通知线程，版本更新必须刷新返回坐标。 */
  const change = (name: string, text: string) => { documents.set(root + name, text); version++; revisions.changed(root + name, root); for (const listener of listeners) listener(root + name, 'content'); };
  /** 新建未保存文件的打开和关闭同时改变目录可见性。 */
  const draft = (name: string, text?: string) => {
    if (text === undefined) documents.delete(root + name); else documents.set(root + name, text);
    version++; revisions.changed(root + name, root, true);
    for (const listener of listeners) listener(root + name, text === undefined ? 'close' : 'open');
  };
  return { root, reader, documents, compute, request, change, draft, errors };
}

test('线程首次补全、详情、悬浮和跳转与原始解析器完全一致，草稿版本及时刷新', async () => {
  const graph = fixture({ 'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'page.ts': `import type {Model} from './model';Page({data:{record:{} as Model}});`,
    'model.ts': 'interface Base {/** 字段说明 */title:string;count:number};export type Model={[K in keyof Base as `field_${K & string}`]?:Base[K]};',
    'page.wxml': '{{record.field_title}}',
  });
  try {
    const inline = createScriptResolver(graph.reader), request = graph.request('page.wxml', 15, true);
    const expression = { text: 'record.field_title', range: { start: 2, end: 20 }, bindings: [] };
    const items = await graph.compute.scripts.complete!(request, expression), expected = await inline.complete!(request, expression);
    assert.deepEqual(items.map(({ resolve: _resolve, ...item }) => item), expected.map(({ resolve: _resolve, ...item }) => item));
    assert.ok(items.length);
    assert.deepEqual(await items[0]!.resolve!({ isCancellationRequested: false }), await expected[0]!.resolve!({ isCancellationRequested: false }));
    assert.deepEqual(await graph.compute.scripts.hover!(request, expression), await inline.hover!(request, expression));
    assert.deepEqual(await graph.compute.scripts.resolve(request, expression), await inline.resolve(request, expression));
    graph.change('model.ts', '\ninterface Base {/** 草稿说明 */title:number;count:number};export type Model={[K in keyof Base as `field_${K & string}`]?:Base[K]};');
    const updated = await graph.compute.scripts.hover!(graph.request('page.wxml', 15), expression);
    assert.equal(updated?.type, 'number | undefined'); assert.match(updated!.description, /草稿说明/);
    const targets = await graph.compute.scripts.resolve(graph.request('page.wxml', 15), expression);
    assert.equal(targets[0]!.version, 2); assert.equal(graph.documents.get(targets[0]!.uri)!.slice(targets[0]!.range.start, targets[0]!.range.end), 'title');
    assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('提前准备只加载编译器，不读取工程，首次查询继续使用最新草稿', async () => {
  const graph = fixture({ 'page.ts': `Page({data:{title:'旧标题'}});`, 'page.wxml': '{{title}}' });
  const original = graph.reader.read;
  let reads = 0;
  graph.reader.read = (uri) => { reads++; return original(uri); };
  try {
    graph.compute.prepare();
    const worker = (graph.compute.transport as unknown as { worker: import('node:worker_threads').Worker }).worker;
    const ready = await new Promise<{ kind: string; error?: string }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.equal(ready.kind, 'ready'); assert.equal(ready.error, undefined); assert.equal(reads, 0);
    graph.change('page.ts', `Page({data:{/** 新标题说明 */title:1}});`);
    const request = graph.request('page.wxml', 5), expression = { text: 'title', range: { start: 2, end: 7 }, bindings: [] };
    assert.deepEqual(await graph.compute.scripts.hover!(request, expression), await createScriptResolver(graph.reader).hover!(request, expression));
    assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('组件与路径计算保留宿主依赖修订，变化后不复用旧类型或旧位置', async () => {
  const graph = fixture({ 'package.json': '{}', 'page.wxml': '<card title/>', 'card.ts': `Component({properties:{/** 标题 */title:String}});` });
  try {
    const remote = graph.compute.components(graph.reader), inline = createComponentScriptResolver(graph.reader), request = graph.request('page.wxml', 9);
    assert.deepEqual(await remote.inspect(request, graph.root + 'card.ts'), await inline.inspect(request, graph.root + 'card.ts'));
    const paths = graph.compute.fileResolver(request.document.uri), result = await paths.resolve!('./card', request.document.uri, 'script');
    assert.ok(result.candidates.some((uri) => uri.endsWith('/card')));
    assert.ok(result.dependencies.every((item) => item.revision === graph.reader.revision!(item.uri)));
    graph.change('card.ts', '\nComponent({properties:{/** 新说明 */title:Number}});');
    const updated = await remote.inspect(graph.request('page.wxml', 9), graph.root + 'card.ts');
    assert.equal(updated!.properties[0]!.type, 'number'); assert.equal(updated!.properties[0]!.definitions[0]!.version, 2);
    assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('WXS 和数据路径提供器使用同一线程，返回原有补全详情及定义', async () => {
  const graph = fixture({ 'page.wxs': `var tools=require('./tools.wxs');tools.format`, 'tools.wxs': '/** 工具说明 */function format(value){return value}module.exports={format:format};', 'page.ts': `Page({data:{title:'标题'},save(){this.setData({'title':1})}});` });
  const context = { logger: { info() {}, error() {} }, subscriptions: { add: <T>(item: T): T => item } };
  try {
    for (const [plugin, service, name, offset] of [[createWxsPlugin(graph.reader), 'wxs', 'page.wxs', 40], [createDataPathPlugin(graph.reader), 'dataPath', 'page.ts', graph.documents.get(graph.root + 'page.ts')!.lastIndexOf('title') + 2]] as const) {
      const original = plugin.setup(context), remote = graph.compute.plugin(plugin, service, ['completion', 'definition', 'hover']).setup(context);
      const request = graph.request(name, offset);
      assert.deepEqual(await remote.definition!.provide(request), await original.definition!.provide(request));
      assert.deepEqual(await remote.hover!.provide(request), await original.hover!.provide(request));
      assert.deepEqual(await remote.completion!.provide(request), await original.completion!.provide(request));
    }
    assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('线程并发建图中首个调用者取消，不中断仍在等待的补全', async () => {
  const graph = fixture({ 'page.ts': `import type {Model} from './model';Page({data:{record:{} as Model}});`, 'model.ts': `export type {Model} from './details';`, 'details.ts': 'export interface Model {title:string}', 'page.wxml': '{{record.}}' });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const original = graph.reader.read;
  graph.reader.read = async (uri) => { if (uri.endsWith('/model.ts')) { entered(); await gate; } return original(uri); };
  try {
    const cancellation = { isCancellationRequested: false }, expression = { text: 'record.', range: { start: 2, end: 9 }, bindings: [] };
    const first = graph.compute.scripts.complete!({ ...graph.request('page.wxml', 9, true), cancellation }, expression);
    const second = graph.compute.scripts.complete!(graph.request('page.wxml', 9, true), expression);
    await ready; cancellation.isCancellationRequested = true;
    // 等待共享取消位同步后再读取下一级依赖，覆盖合并建图的首调用者取消。
    await new Promise<void>((resolve) => setTimeout(resolve, 25)); release();
    assert.deepEqual(await first, []); assert.deepEqual((await second).map((item) => item.label), ['title']); assert.deepEqual(graph.errors, []);
  } finally { release(); graph.compute.dispose(); }
});

test('文件在线程读取途中变更时重新获取快照，保持新类型与说明一致', async () => {
  const graph = fixture({ 'page.ts': `import type {Model} from './model';Page({data:{record:{} as Model}});`, 'model.ts': 'export interface Model {/** 旧说明 */title:string}', 'page.wxml': '{{record.title}}' });
  const original = graph.reader.read;
  let changed = false;
  graph.reader.read = async (uri) => {
    const snapshot = await original(uri);
    if (uri.endsWith('/model.ts') && !changed) { changed = true; graph.change('model.ts', 'export interface Model {/** 新说明 */title:number}'); }
    return snapshot;
  };
  try {
    const expression = { text: 'record.title', range: { start: 2, end: 14 }, bindings: [] }, request = graph.request('page.wxml', 12);
    const [value, items, targets] = await Promise.all([graph.compute.scripts.hover!(request, expression), graph.compute.scripts.complete!({ ...request, deferCompletionDetails: true }, expression), graph.compute.scripts.resolve(request, expression)]);
    assert.equal(value?.type, 'number'); assert.match(value!.description, /新说明/);
    assert.ok(items.some((item) => item.label === 'title'));
    assert.deepEqual(targets, await createScriptResolver(graph.reader).resolve(graph.request('page.wxml', 12), expression));
    assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('线程重启后补全详情可重新计算，失效句柄不会借用另一个候选', async () => {
  const graph = fixture({ 'page.ts': `Page({data:{/** 标题说明 */title:'标题',count:1}});`, 'page.wxml': '{{title}}' });
  try {
    const items = await graph.compute.scripts.complete!(graph.request('page.wxml', 5, true), { text: 'title', range: { start: 2, end: 7 }, bindings: [] });
    const expected = await items[0]!.resolve!({ isCancellationRequested: false });
    await (graph.compute.transport as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    assert.deepEqual(await items[0]!.resolve!({ isCancellationRequested: false }), expected); assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('未保存模块打开与关闭同步刷新目录缓存，不复用缺失模块的旧结论', async () => {
  const graph = fixture({ 'page.ts': `import type {Model} from './generated/model';Page({data:{record:{} as Model}});`, 'page.wxml': '{{record.}}' }, true);
  const expression = { text: 'record.', range: { start: 2, end: 9 }, bindings: [] };
  try {
    const before = await graph.compute.scripts.complete!(graph.request('page.wxml', 9, true), expression);
    assert.ok(!before.some((item) => item.label === 'title'));
    graph.draft('generated/model.ts', 'export interface Model {/** 草稿字段 */title:string}');
    const items = await graph.compute.scripts.complete!(graph.request('page.wxml', 9, true), expression);
    assert.ok(items.some((item) => item.label === 'title'));
    graph.draft('generated/model.ts');
    const after = await graph.compute.scripts.complete!(graph.request('page.wxml', 9, true), expression);
    assert.ok(!after.some((item) => item.label === 'title')); assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});

test('线程持续不可用时沿用原解析器，已返回的补全详情仍能解析', async () => {
  const graph = fixture({ 'page.ts': `Page({data:{/** 标题说明 */title:'标题',count:1}});`, 'page.wxml': '{{title}}' });
  try {
    const request = graph.request('page.wxml', 5, true), expression = { text: 'title', range: { start: 2, end: 7 }, bindings: [] };
    const items = await graph.compute.scripts.complete!(request, expression);
    const expected = await items[0]!.resolve!({ isCancellationRequested: false });
    const transport = graph.compute.transport as unknown as { host: { filename: string }; worker: { terminate(): Promise<number> } };
    await transport.worker.terminate(); transport.host.filename += '.missing';
    assert.deepEqual(await items[0]!.resolve!({ isCancellationRequested: false }), expected);
    assert.deepEqual(await graph.compute.scripts.hover!(request, expression), await createScriptResolver(graph.reader).hover!(request, expression));
    assert.equal(graph.errors.length, 1);
  } finally { graph.compute.dispose(); }
});

test('JSONC 路由清单在线程解析，保留中文页面路径、注释与原始范围', async () => {
  const text = '{// 页面说明\n"pages":["pages/中文/index"],"tabBar":{"list":[{"pagePath":"pages/中文/index"}]}}';
  const graph = fixture({ 'app.json': text });
  try {
    const { createRouteDocumentResolver } = await import('../src/resolution');
    const syntax = createRouteDocumentResolver();
    assert.deepEqual(await graph.compute.routeDocuments.manifest(graph.root + 'app.json', text), await syntax.manifest(graph.root + 'app.json', text));
    assert.deepEqual(await graph.compute.routeDocuments.accesses(graph.request('app.json', 40)), await syntax.accesses(graph.request('app.json', 40)));
    assert.deepEqual(graph.errors, []);
  } finally { graph.compute.dispose(); }
});
