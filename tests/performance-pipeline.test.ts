import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createDependencyTracking } from '../src/adapters/vscode/dependency-tracking';
import { createProjectFileResolver } from '../src/resolution';
import { createComponentScriptResolver, createScriptResolver } from '../src/languages/typescript';
import { ScriptProject } from '../src/languages/typescript/project';
import { createTemplateResolver } from '../src/languages/wxml';

/** 读取、修订及依赖追踪与宿主一致，保留可核对的源码版本。 */
function fixture(input: Record<string, string>) {
  const root = 'file:///pipeline/';
  const documents = new Map(Object.entries(input).map(([name, text]) => [root + name, text]));
  const revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision), reads: string[] = [];
  let enumerations = 0, version = 1;
  const reader: WorkspaceReader = { root: () => root, revision: tracking.observe, capture: tracking.capture,
    read: async (uri) => { tracking.observe(uri); reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text, version }; },
    findFiles: async (_uri, pattern, limit, scope) => {
      enumerations++; const source = scope?.root ?? root; tracking.observe(source);
      return [...documents.keys()].filter((uri) => uri.startsWith(source) && (pattern.includes('wxml') ? uri.endsWith('.wxml') : pattern.includes('d.ts') ? uri.endsWith('.d.ts') : uri.endsWith('package.json'))).slice(0, limit);
    } };
  /** 草稿始终使用实际文本、版本和 UTF-16 偏移。 */
  const request = (name: string, offset = 0): LanguageRequest => ({ document: { uri: root + name, text: documents.get(root + name)!, version, languageId: name.endsWith('.wxml') ? 'wxml' : 'typescript' }, offset, cancellation: { isCancellationRequested: false } });
  /** 内容和结构变化分别触发现有修订机制。 */
  const change = (name: string, text: string, structural = false) => { documents.set(root + name, text); version++; revisions.changed(root + name, root, structural); };
  return { root, reader, documents, request, reads, change, tracking, enumerations: () => enumerations };
}

test('声明按配置归属读取，隔离嵌套工作树并保留显式共享声明', async () => {
  const graph = fixture({
    'apps/a/tsconfig.json': '{"include":["src/**/*","../../shared-types/**/*"]}',
    'apps/a/src/page.ts': `import type {Model} from 'contract';Page({data:{model:{} as Model}});`,
    'apps/a/src/page.wxml': '{{model.}}',
    'apps/a/local.d.ts': `declare module 'contract' {export interface Model {title:string}}`,
    'shared-types/shared.d.ts': `declare module 'contract' {export interface Model {shared:boolean}}`,
    'apps/a/.claude/worktrees/old/local.d.ts': `declare module 'contract' {export interface Model {wrong:number}}`,
    'apps/b/local.d.ts': `declare module 'contract' {export interface Model {other:number}}`,
  });
  const request = { ...graph.request('apps/a/src/page.wxml', 8), deferCompletionDetails: true };
  const items = await createScriptResolver(graph.reader).complete!(request, { text: 'model.', range: { start: 2, end: 8 }, bindings: [] });
  assert.deepEqual(items.map((item) => item.label).sort(), ['shared', 'title']);
  assert.ok(!graph.reads.some((uri) => uri.includes('/worktrees/') || uri.includes('/apps/b/')));
});

test('并发候选各自保留包依赖，共用配置而不混入另一个包', async () => {
  const graph = fixture({ 'package.json': '{}', 'page.ts': '',
    'node_modules/one/package.json': '{"source":"./src/index.ts"}',
    'node_modules/two/package.json': '{"source":"./src/index.ts"}',
  });
  const files = createProjectFileResolver(graph.reader, graph.root + 'page.ts');
  const [one, two] = await Promise.all([files.resolve!('one', graph.root + 'page.ts', 'script'), files.resolve!('two', graph.root + 'page.ts', 'script')]);
  assert.ok(one.dependencies.some((item) => item.uri.includes('/one/package.json')));
  assert.ok(two.dependencies.some((item) => item.uri.includes('/two/package.json')));
  assert.ok(!one.dependencies.some((item) => item.uri.includes('/two/')));
  assert.ok(!two.dependencies.some((item) => item.uri.includes('/one/')));
});

test('优先候选已经命中后不再读取低优先级扩展名，缺失新增仍及时失效', async () => {
  const graph = fixture({ 'page.ts': `import {value} from './found';Page({data:{value}});`, 'page.wxml': '{{value}}', 'found.ts': 'export const value=1;' });
  const project = new ScriptProject(graph.reader, graph.request('page.wxml'), {});
  assert.ok(await project.create());
  assert.ok(graph.reads.includes(graph.root + 'found.ts'));
  assert.ok(!graph.reads.some((uri) => /found\.(?:tsx|js|jsx|d\.ts)$/.test(uri)));
  graph.change('found.ts', 'export const value="新值";');
  const updated = await new ScriptProject(graph.reader, graph.request('page.wxml'), {}).create();
  assert.match(updated!.program.getSourceFile(graph.root + 'found.ts')!.text, /新值/);
});

test('受限组件元数据复用保留不完整标记，版本和源码变更不能借用旧位置', async () => {
  const graph = fixture({ 'page.wxml': '<card/>', 'card.ts': `import './heavy';Component({properties:{/** 标题 */title:String}});`, 'heavy.ts': 'export const value=1;' });
  const scripts = createComponentScriptResolver(graph.reader, () => ({ maxFiles: 1 }));
  const first = await scripts.inspect(graph.request('page.wxml'), graph.root + 'card.ts');
  const second = await scripts.inspect(graph.request('page.wxml'), graph.root + 'card.ts');
  assert.equal(first?.complete, false); assert.equal(second?.complete, false); assert.deepEqual(second?.properties, first?.properties);
  graph.change('card.ts', '\nComponent({properties:{/** 新说明 */title:Number}});');
  const updated = await scripts.inspect(graph.request('page.wxml'), graph.root + 'card.ts');
  assert.match(updated!.properties[0]!.description, /新说明/); assert.equal(updated!.properties[0]!.type, 'number');
  assert.equal(updated!.properties[0]!.definitions[0]!.version, 2);
});

test('模板并发查询共享调用图，跨文件复用与编辑后的 data 坐标保持准确', async () => {
  const graph = fixture({ 'page.wxml': '<import src="./card.wxml"/><import src="./other.wxml"/><template is="card" data="{{title:label}}"/><template is="other" data="{{title:label}}"/>',
    'page.ts': `Page({data:{/** 原说明 */label:'标题'}});`,
    'card.wxml': '<template name="card">{{title}}</template>', 'other.wxml': '<template name="other">{{title}}</template>',
  });
  const scripts = createTemplateResolver(graph.reader, createScriptResolver(graph.reader));
  const query = (name: string) => { const current = graph.request(name, graph.documents.get(graph.root + name)!.indexOf('{{title}}') + 5); return { current, expression: { text: 'title', range: { start: current.document.text.indexOf('{{title}}') + 2, end: current.document.text.indexOf('{{title}}') + 7 }, bindings: [] } }; };
  const first = query('card.wxml');
  const [hover, targets] = await Promise.all([scripts.hover!(first.current, first.expression), scripts.resolve(first.current, first.expression)]);
  assert.match(hover!.description, /原说明/); assert.equal(targets[0]!.uri, graph.root + 'page.wxml'); assert.equal(graph.enumerations(), 1);
  const other = query('other.wxml'); await scripts.hover!(other.current, other.expression); assert.equal(graph.enumerations(), 1);
  graph.reads.length = 0;
  graph.change('page.wxml', '\n' + graph.documents.get(graph.root + 'page.wxml'));
  const updated = await scripts.resolve(first.current, first.expression);
  assert.equal(updated[0]!.range.start, targets[0]!.range.start + 1);
  assert.ok(!graph.reads.includes(graph.root + 'other.wxml'));
});

test('模板调用图的首个请求取消后，其他调用者仍取得正确说明', async () => {
  const graph = fixture({ 'page.wxml': '<include src="./card.wxml"/>', 'page.ts': `Page({data:{/** 共享说明 */title:'值'}});`, 'card.wxml': '{{title}}' });
  let entered!: () => void, release!: () => void, enumerations = 0;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reader: WorkspaceReader = { ...graph.reader, findFiles: async (...args) => { enumerations++; entered(); await gate; return graph.reader.findFiles!(...args); } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const cancellation = { isCancellationRequested: false }, expression = { text: 'title', range: { start: 2, end: 7 }, bindings: [] };
  const first = scripts.hover!({ ...graph.request('card.wxml', 5), cancellation }, expression);
  const second = scripts.hover!(graph.request('card.wxml', 5), expression);
  await ready; await new Promise<void>((resolve) => setImmediate(resolve)); cancellation.isCancellationRequested = true; release();
  assert.equal(await first, undefined); assert.match((await second)!.description, /共享说明/); assert.equal(enumerations, 1);
});
