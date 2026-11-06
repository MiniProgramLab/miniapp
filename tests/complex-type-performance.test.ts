import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createScriptResolver } from '../src/languages/typescript';
import { ScriptProject } from '../src/languages/typescript/project';
import { Values } from '../src/languages/typescript/values';

/** 每个场景独立保存声明、草稿修订和真实模板坐标。 */
function fixture(input: Record<string, string>) {
  const root = 'file:///complex-types/';
  const documents = new Map(Object.entries(input).map(([name, text]) => [root + name, text]));
  const revisions = createWorkspaceRevisions();
  const reader: WorkspaceReader = { root: () => root, revision: revisions.revision,
    read: async (uri) => { const text = documents.get(uri); return text === undefined ? undefined : { text, version: 1 }; } };
  /** 光标放在被查询成员末尾，原始范围可直接核对。 */
  const query = (text: string): LanguageRequest => ({ document: { uri: root + 'page.wxml', text: '{{' + text + '}}', version: 1, languageId: 'wxml' }, offset: 2 + text.length, cancellation: { isCancellationRequested: false }, deferCompletionDetails: true });
  return { root, documents, revisions, reader, query };
}

test('复杂类型的独立导入并行等待，共享文件和目录只探测一次', { timeout: 5000 }, async () => {
  const graph = fixture({
    'page.ts': `import type {Left} from './types/left';import type {Right} from './types/right';Page({data:{model:{} as Left & Right}});`,
    'types/left.ts': 'export interface Left {left:string}', 'types/right.ts': 'export interface Right {right:number}',
  });
  const reads = new Map<string, number>(), directories = new Map<string, number>();
  let entered = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reader: WorkspaceReader = { ...graph.reader,
    read: async (uri) => {
      reads.set(uri, (reads.get(uri) ?? 0) + 1);
      if (/\/types\/(?:left|right)\.ts$/.test(uri)) { if (++entered === 2) release(); await gate; }
      return graph.reader.read(uri);
    },
    directory: async (uri) => {
      directories.set(uri, (directories.get(uri) ?? 0) + 1);
      await Promise.resolve();
      return [...graph.documents.keys()].some((file) => file.startsWith(uri.replace(/\/?$/, '/')));
    },
  };
  const request = graph.query('model.');
  const items = await createScriptResolver(reader).complete!(request, { text: 'model.', range: { start: 2, end: 8 }, bindings: [] });
  assert.deepEqual(items.map((item) => item.label).sort(), ['left', 'right']);
  for (const [uri, count] of reads) if (!uri.endsWith('/page.ts')) assert.equal(count, 1, uri);
  for (const [uri, count] of directories) assert.equal(count, 1, uri);
});

test('首次映射、条件和交叉类型查询保留完整候选、说明及原声明，草稿变更及时生效', async () => {
  const graph = fixture({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'page.ts': `import type {Payload} from './types';Page({data:{formData:{} as Payload}});`,
    'types/index.ts': `export type {Payload} from './schema';`,
    'types/base.ts': 'export interface Base {/** 标识说明 */ id:number;/** 名称说明 */ title:string;nested:{flag:boolean}};export type Remap<T>={[K in keyof T as `field_${K & string}`]?:T[K]};',
    'types/schema.ts': `import type {Base,Remap} from './base';type Unbox<T>=T extends {value:infer U}?U:never;export type Payload=Unbox<{value:Remap<Base>&{/** 状态说明 */status:'ready'|'done'}}>;`,
  });
  const scripts = createScriptResolver(graph.reader);
  const request = graph.query('formData.');
  const expression = { text: 'formData.', range: { start: 2, end: 11 }, bindings: [] };
  const items = await scripts.complete!(request, expression);
  assert.deepEqual(items.map((item) => item.label).sort(), ['field_id', 'field_nested', 'field_title', 'status']);
  const details = await items.find((item) => item.label === 'field_title')!.resolve!({ isCancellationRequested: false });
  assert.equal(details?.detail, 'string | undefined'); assert.match(details!.documentation, /名称说明/);
  const text = 'formData.field_title', selected = { text, range: { start: 2, end: 2 + text.length }, bindings: [] };
  const [hover, definitions] = await Promise.all([scripts.hover!(graph.query(text), selected), scripts.resolve(graph.query(text), selected)]);
  assert.equal(hover?.type, 'string | undefined'); assert.match(hover!.description, /名称说明/);
  assert.equal(definitions[0]!.uri, graph.root + 'types/base.ts');
  assert.equal(graph.documents.get(definitions[0]!.uri)!.slice(definitions[0]!.range.start, definitions[0]!.range.end), 'title');
  graph.documents.set(graph.root + 'types/base.ts', '\nexport interface Base {/** 新字段说明 */ title:number;added:boolean}export type Remap<T>={[K in keyof T as `field_${K & string}`]?:T[K]};');
  graph.revisions.changed(graph.root + 'types/base.ts', graph.root);
  const updated = await scripts.complete!(request, expression);
  assert.deepEqual(updated.map((item) => item.label).sort(), ['field_added', 'field_title', 'status']);
  assert.equal((await updated.find((item) => item.label === 'field_title')!.resolve!({ isCancellationRequested: false }))?.detail, 'number | undefined');
  assert.match((await scripts.hover!(graph.query(text), selected))!.description, /新字段说明/);
});

test('首次查询仍加载副作用导入中的接口增补，补全不遗漏合并字段', async () => {
  const graph = fixture({
    'page.ts': `import './augment';import type {Model} from './model';Page({data:{model:{} as Model}});`,
    'model.ts': `export interface Model {title:string}`,
    'augment.ts': `import './model';declare module './model' {interface Model {/** 增补说明 */extra:number}}`,
  });
  const scripts = createScriptResolver(graph.reader), request = graph.query('model.');
  const expression = { text: 'model.', range: { start: 2, end: 8 }, bindings: [] };
  const items = await scripts.complete!(request, expression);
  assert.deepEqual(items.map((item) => item.label).sort(), ['extra', 'title']);
  const text = 'model.extra', selected = { text, range: { start: 2, end: 2 + text.length }, bindings: [] };
  assert.match((await scripts.hover!(graph.query(text), selected))!.description, /增补说明/);
  assert.equal((await scripts.resolve(graph.query(text), selected))[0]!.uri, graph.root + 'augment.ts');
});

test('并发建图途中声明变更时重新取快照，不发布新旧混合候选', { timeout: 5000 }, async () => {
  const graph = fixture({
    'page.ts': `import type {Left} from './left';import type {Right} from './right';Page({data:{model:{} as Left & Right}});`,
    'left.ts': 'export interface Left {oldField:string}', 'right.ts': 'export interface Right {right:number}',
  });
  let edited = false, entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reader: WorkspaceReader = { ...graph.reader, read: async (uri) => {
    const snapshot = await graph.reader.read(uri);
    if (uri === graph.root + 'left.ts' && !edited) { entered(); await gate; }
    if (uri === graph.root + 'right.ts' && !edited) {
      await ready; edited = true;
      graph.documents.set(graph.root + 'left.ts', 'export interface Left {newField:boolean}');
      graph.revisions.changed(graph.root + 'left.ts', graph.root); release();
    }
    return snapshot;
  } };
  const items = await createScriptResolver(reader).complete!(graph.query('model.'), { text: 'model.', range: { start: 2, end: 8 }, bindings: [] });
  assert.deepEqual(items.map((item) => item.label).sort(), ['newField', 'right']);
});

test('复杂成员只枚举名称时不展开类型，单字段查询保留完整投影类型', async () => {
  const graph = fixture({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'page.ts': 'interface Base {title:string;count:number}type Model={[K in keyof Base as `field_${K & string}`]?:Base[K] extends string?{raw:Base[K]}:Base[K]} & {save(value:number):void};const model={} as Model;Page({data:{model}});',
  });
  const project = new ScriptProject(graph.reader, graph.query('model.'), {}), created = await project.create();
  const actual = created!.program.getTypeChecker();
  let expanded = 0;
  const checker = new Proxy(actual, { get(target, key) {
    if (key === 'getTypeOfSymbolAtLocation') return (...args: Parameters<ts.TypeChecker['getTypeOfSymbolAtLocation']>) => { expanded++; return target.getTypeOfSymbolAtLocation(...args); };
    return Reflect.get(target, key);
  } });
  const values = new Values(checker, () => false, () => undefined);
  const statement = created!.entry.statements.find(ts.isVariableStatement)!;
  const model = values.value(statement.declarationList.declarations[0]!);
  const names = values.fields(model, new Set(), undefined, false);
  assert.deepEqual([...names.keys()].sort(), ['field_count', 'field_title', 'save']); assert.equal(expanded, 0);
  const selected = values.access(model, ['field_title']); assert.equal(expanded, 1);
  const complete = values.fields(model);
  assert.equal(actual.typeToString(selected[0]!.runtimeType!), actual.typeToString(complete.get('field_title')![0]!.runtimeType!));
  assert.match(actual.typeToString(selected[0]!.runtimeType!), /raw: string/);
});

test('依赖绑定后保留父节点和参数文档，声明来源与草稿坐标保持准确', async () => {
  const graph = fixture({ 'page.ts': `import {save} from './handler';Page({methods:{save}});`, 'handler.ts': '/** 保存说明。\n * @param value 参数说明。\n */export function save(value:string){return value}' });
  const created = await new ScriptProject(graph.reader, graph.query('save'), {}).create();
  const checker = created!.program.getTypeChecker(), source = created!.program.getSourceFile(graph.root + 'handler.ts')!;
  const declaration = source.statements.find(ts.isFunctionDeclaration)!;
  assert.equal(declaration.parameters[0]!.parent, declaration);
  assert.equal(declaration.parameters[0]!.getSourceFile(), source);
  assert.match(ts.displayPartsToString(checker.getSymbolAtLocation(declaration.parameters[0]!.name)!.getDocumentationComment(checker)), /参数说明/);
  const targets = await createScriptResolver(graph.reader).resolve(graph.query('save'), { text: 'save', range: { start: 2, end: 6 }, bindings: [], event: true });
  assert.ok(targets.some((item) => item.uri === source.fileName && graph.documents.get(item.uri)!.slice(item.range.start, item.range.end) === 'save'));
});

test('无类型约束的 TS 数组不推导整组类型，显式元素类型继续限定可见字段', async () => {
  const graph = fixture({ 'page.ts': `const first={title:'首项'};const rest=[{count:1}];const list=[first,...rest];const constrained:[{visible:string}]=[{visible:'值',hidden:true}];Page({data:{list,constrained}});` });
  const created = (await new ScriptProject(graph.reader, graph.query('list.'), {}).create())!;
  const actual = created.program.getTypeChecker();
  let arrays = 0;
  const checker = new Proxy(actual, { get(target, key) {
    if (key === 'getTypeAtLocation') return (node: ts.Node) => { if (ts.isArrayLiteralExpression(node)) arrays++; return target.getTypeAtLocation(node); };
    return Reflect.get(target, key);
  } });
  const values = new Values(checker, () => false, () => undefined);
  const declarations = created.entry.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
  const list = declarations.find((node) => node.name.getText() === 'list')!;
  const items = values.elements(values.value(list));
  assert.deepEqual(items.flatMap((item) => [...values.fields(item).keys()]).sort(), ['count', 'title']); assert.equal(arrays, 0);
  const constrained = declarations.find((node) => node.name.getText() === 'constrained')!;
  const typed = values.elements(values.value(constrained));
  assert.ok(typed.length); assert.deepEqual([...values.fields(typed[0]!).keys()], ['visible']);
});

test('跨页面复用导入扫描后，公共模块改换导出仍刷新类型与声明坐标', async () => {
  const graph = fixture({ 'page.ts': `import {model} from './shared';Page({data:{model}});`, 'other.ts': `import {model} from './shared';Page({data:{model}});`,
    'shared.ts': `export {model} from './left';`, 'left.ts': `export const model={/** 旧字段 */title:'标题'};`, 'right.ts': `\nexport const model={/** 新字段 */title:1,added:true};` });
  const scripts = createScriptResolver(graph.reader), expression = { text: 'model.', range: { start: 2, end: 8 }, bindings: [] };
  const first = graph.query('model.'), second = { ...first, document: { ...first.document, uri: graph.root + 'other.wxml' } };
  assert.deepEqual((await scripts.complete!(first, expression)).map((item) => item.label), ['title']);
  assert.deepEqual((await scripts.complete!(second, expression)).map((item) => item.label), ['title']);
  graph.documents.set(graph.root + 'shared.ts', `export {model} from './right';`); graph.revisions.changed(graph.root + 'shared.ts', graph.root);
  assert.deepEqual((await scripts.complete!(second, expression)).map((item) => item.label).sort(), ['added', 'title']);
  const text = 'model.title', request = { ...graph.query(text), document: { ...graph.query(text).document, uri: second.document.uri } };
  const selected = { text, range: { start: 2, end: 2 + text.length }, bindings: [] };
  assert.match((await scripts.hover!(request, selected))!.description, /新字段/);
  const targets = await scripts.resolve(request, selected);
  assert.equal(targets[0]!.uri, graph.root + 'right.ts'); assert.equal(graph.documents.get(targets[0]!.uri)!.slice(targets[0]!.range.start, targets[0]!.range.end), 'title');
});
