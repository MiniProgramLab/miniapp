import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createWxmlPlugin } from '../src/languages/wxml';
import { createMetadataResolver, metadataDiagnostics, parseMetadata } from '../src/languages/wxml/metadata';
import { provideCompletions, provideHover } from '../src/languages/wxml/service';

/** 各测试使用真实未保存快照和依赖修订，不读取或修改业务工程。 */
function fixture(source: string, files: Record<string, string> = {}, settings = { customData: ['components.html-data.json'], sdkVersion: '' }) {
  const root = 'file:///metadata/';
  const documents = new Map(Object.entries(files).map(([file, text]) => [new URL(file, root).href, text]));
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => documents.get(uri) ?? 'missing', read: async (uri) => { reads++; const text = documents.get(uri); return text === undefined ? undefined : { text }; } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: source.replace('|', ''), languageId: 'wxml', version: 1 }, offset: source.indexOf('|'), cancellation: { isCancellationRequested: false } };
  const features = createWxmlPlugin(undefined, undefined, () => settings, undefined, reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  return { documents, request, features, reader, settings, reads: () => reads };
}

/** 标准值集合、文档对象与事件扩展可以放在同一份声明数据中。 */
const metadata = JSON.stringify({ version: 1.1, valueSets: [{ name: 'sizes', values: [{ name: 'large', description: '大号' }, { name: 'small', description: '小号' }] }],
  definitions: { payload: { type: 'object', properties: { value: { type: 'string' }, count: { type: 'integer' } }, required: ['value'] } },
  tags: [{ name: 'any-card', description: { kind: 'markdown', value: '卡片说明' }, attributes: [{ name: 'size', valueSet: 'sizes', defaultValue: 'small', since: '2.10.0' }, { name: 'old', deprecated: '改用 size。' }], events: [{ name: 'change', detail: { $ref: '#/definitions/payload' } }] }], globalAttributes: [{ name: 'data-theme', values: [{ name: 'dark' }] }] });

test('Custom Data 补全标签、属性、枚举及值说明，事件前缀保持当前绑定方式', async () => {
  for (const [source, name] of [['<any-|', 'any-card'], ['<any-card si|>', 'size'], ['<any-card size="la|"/>', 'large'], ['<any-card catch:ch|/>', 'catch:change'], ['<any-card capture-bind:ch|/>', 'capture-bind:change'], ['<any-card data-th|/>', 'data-theme']]) {
    const graph = fixture(source!, { 'components.html-data.json': metadata });
    const items = await graph.features.completion!.provide(graph.request);
    assert.ok(items.some((item) => item.label === name), `${source}: ${JSON.stringify(items)}`);
    if (name === 'large') assert.match(items.find((item) => item.label === name)!.documentation, /大号/);
  }
});

test('悬浮展示默认值、版本、弃用和 detail 原声明结构，实际所属包版本可见', async () => {
  const files = { 'node_modules/any-lib/components.html-data.json': metadata, 'node_modules/any-lib/package.json': '{"name":"any-lib","version":"3.2.1"}' };
  const graph = fixture('<any-card si|ze="large"/>', files, { customData: ['node_modules/any-lib/components.html-data.json'], sdkVersion: '' });
  const hover = await graph.features.hover!.provide(graph.request);
  assert.match(hover!.description, /默认值：small/); assert.match(hover!.description, /最低基础库：2.10.0/); assert.match(hover!.description, /any-lib@3.2.1/);
  const event = parseMetadata(metadata).tags[0]!.attributes.find((item) => item.name === 'bind:change')!;
  assert.equal(event.detail!.properties!.value!.kind, 'string'); assert.equal(event.detail!.properties!.count!.optional, true);
});

test('源码属性提示与说明优先，元数据只补充额外字段和值集合', async () => {
  const graph = fixture('<any-card si|ze="large"/>', { 'components.html-data.json': metadata });
  const actual = createWxmlPlugin(undefined, undefined, () => graph.settings, { definition: () => [], hover: () => ({ title: '实际源码', description: '实际参数为 number。', range: { start: 10, end: 14 } }), completion: () => [{ label: 'size', kind: 'attribute', detail: 'number', documentation: '源码类型', insertText: 'size', range: { start: 10, end: 14 } }] }, graph.reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  assert.equal((await actual.completion!.provide(graph.request)).find((item) => item.label === 'size')!.detail, 'number');
  const hover = await actual.hover!.provide(graph.request);
  assert.equal(hover!.title, '实际源码'); assert.match(hover!.description, /^实际参数为 number。/); assert.match(hover!.description, /元数据补充/);
});

test('已声明源码枚举覆盖元数据枚举，空前缀结果也不回退到过期文档值', async () => {
  for (const prefix of ['s', 'l']) {
    const graph = fixture(`<any-card size="${prefix}|"/>`, { 'components.html-data.json': metadata });
    const resolver = { definition: () => [], hover: () => undefined, instance: () => ({ description: '', definitions: [], registrations: {}, properties: [{ name: 'size', type: '"source"', defaultValue: 'source', required: false, description: '实际枚举', definitions: [], valueType: { kind: 'string' as const, display: '"source"', literal: 'source' } }] }) };
    const features = createWxmlPlugin(undefined, undefined, () => graph.settings, resolver, graph.reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
    assert.deepEqual((await features.completion!.provide(graph.request)).map((item) => item.label), prefix === 's' ? ['source'] : []);
  }
});

test('元数据与目标基础库按实际修订失效，私有 latest 不回退到较旧项目版本', async () => {
  const graph = fixture('<any-card size="large" ol|d/>', { 'components.html-data.json': metadata, 'project.private.config.json': '{"libVersion":"2.9.0"}', 'project.config.json': '{"libVersion":"2.12.0"}' });
  const resolver = createMetadataResolver(graph.reader, () => graph.settings);
  const first = await resolver.load(graph.request), before = graph.reads();
  assert.equal(first.sdkVersion, '2.9.0'); assert.equal(await resolver.load(graph.request), first); assert.equal(graph.reads(), before);
  assert.deepEqual(metadataDiagnostics(graph.request, first).map((item) => item.code), ['component-sdk-version', 'deprecated-component-api']);
  graph.documents.set('file:///metadata/project.private.config.json', '{"libVersion":"latest"}');
  const latest = await resolver.load(graph.request);
  assert.equal(latest.sdkVersion, undefined); assert.ok(!metadataDiagnostics(graph.request, latest).some((item) => item.code === 'component-sdk-version'));
  graph.documents.set('file:///metadata/components.html-data.json', JSON.stringify({ version: 1.1, tags: [{ name: 'other-card' }] }));
  assert.ok((await resolver.load(graph.request)).tags.some((tag) => tag.name === 'other-card'));
  graph.settings.sdkVersion = '2.10.0'; assert.equal((await resolver.load(graph.request)).sdkVersion, '2.10.0');
});

test('原生目录覆盖完整标签名并展示官方事件 detail 和明确版本', () => {
  const graph = fixture('<scroll-view binddra|gstart="start"/>', {}, { customData: [], sdkVersion: '2.11.0' });
  const completion = provideCompletions(graph.request).find((item) => item.label === 'binddragstart')!;
  assert.match(completion.documentation, /最低基础库：2.12.0/); assert.match(completion.documentation, /scrollTop: number/);
  const input = fixture('<input bindin|put="change"/>', {}, { customData: [], sdkVersion: '' });
  assert.match(provideHover(input.request)!.description, /value: string/);
  assert.ok(provideCompletions(fixture('<video object-fit="co|"/>').request).some((item) => item.label === 'cover'));
});

test('循环 detail 引用保持开放，错误配置不执行，取消和读取期间变更不缓存旧结果', async () => {
  const cyclic = parseMetadata(JSON.stringify({ version: 1.1, definitions: { cycle: { $ref: '#/definitions/cycle' } }, tags: [{ name: 'any-card', events: [{ name: 'change', detail: { $ref: '#/definitions/cycle' } }] }] }));
  assert.equal(cyclic.tags[0]!.attributes[0]!.detail!.kind, 'unknown');
  assert.throws(() => parseMetadata('export default {}')); assert.throws(() => parseMetadata('{"version":2}'));
  const graph = fixture('<any-card |/>', { 'components.html-data.json': metadata });
  let changes = 0;
  const reader: WorkspaceReader = { ...graph.reader, read: async (uri) => { const value = await graph.reader.read(uri); if (!changes++ && uri.endsWith('components.html-data.json')) graph.documents.set(uri, '{"version":1.1,"tags":[]}'); return value; } };
  const resolver = createMetadataResolver(reader, () => graph.settings);
  const first = await resolver.load(graph.request), second = await resolver.load(graph.request);
  assert.ok(first.tags.some((tag) => tag.name === 'any-card')); assert.ok(!second.tags.some((tag) => tag.name === 'any-card'));
  assert.deepEqual((await resolver.load({ ...graph.request, cancellation: { isCancellationRequested: true } })).tags, []);
});

test('缺失或损坏元数据可见且不污染原生提示，修复后诊断立即消失', async () => {
  const graph = fixture('<input |/>', { 'components.html-data.json': '{"version":2}' });
  assert.ok((await graph.features.diagnostics!.provide(graph.request)).some((item) => item.code === 'component-metadata-config'));
  assert.ok((await graph.features.completion!.provide(graph.request)).some((item) => item.label === 'bindinput'));
  graph.documents.set('file:///metadata/components.html-data.json', '{"version":1.1}');
  assert.ok(!(await graph.features.diagnostics!.provide(graph.request)).some((item) => item.code === 'component-metadata-config'));
});
