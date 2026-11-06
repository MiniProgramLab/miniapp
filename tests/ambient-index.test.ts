import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { ambientIndex } from '../src/languages/typescript/ambient-index';
import { ScriptProject } from '../src/languages/typescript/project';

/** 声明内容、结构事件和读取计数由各场景控制。 */
function fixture(input: Record<string, string>) {
  const root = 'file:///ambient/';
  const documents = new Map(Object.entries(input).map(([name, text]) => [root + name, text]));
  const revisions = createWorkspaceRevisions(), reads: string[] = [];
  let enumerations = 0;
  const reader: WorkspaceReader = { root: () => root, revision: revisions.revision,
    findFiles: async (_uri, _pattern, limit) => { enumerations++; return [...documents.keys()].filter((uri) => uri.endsWith('.d.ts')).slice(0, limit); },
    read: async (uri) => { reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text }; } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{shared.}}', version: 1, languageId: 'wxml' }, offset: 9, cancellation: { isCancellationRequested: false } };
  return { root, documents, revisions, reader, request, reads, enumerations: () => enumerations };
}

test('工作区声明索引跨页面共享，只重读修改的声明，结构变化及时失效', async () => {
  const { root, documents, revisions, reader, request, reads, enumerations } = fixture({ 'ordinary.d.ts': 'export interface Item {title:string}', 'one.d.ts': `declare module 'virtual' {export interface Shared {left:string}}` });
  const first = await ambientIndex(reader, request, 20);
  reads.length = 0;
  assert.equal(await ambientIndex(reader, { ...request, document: { ...request.document, uri: root + 'other.wxml' } }, 20), first);
  assert.deepEqual(reads, []); assert.equal(enumerations(), 1);
  documents.set(root + 'ordinary.d.ts', `declare module 'created' {export const value:number}`); revisions.changed(root + 'ordinary.d.ts', root);
  const changed = await ambientIndex(reader, request, 20);
  assert.ok(changed.modules.has('created')); assert.deepEqual(reads, [root + 'ordinary.d.ts']); assert.equal(enumerations(), 1);
  documents.set(root + 'two.d.ts', `declare module 'virtual' {export interface Shared {right:number}}`); revisions.changed(root + 'two.d.ts', root, true);
  assert.deepEqual((await ambientIndex(reader, request, 20)).modules.get('virtual'), [root + 'one.d.ts', root + 'two.d.ts']);
  documents.delete(root + 'one.d.ts'); revisions.changed(root + 'one.d.ts', root, true);
  assert.deepEqual((await ambientIndex(reader, request, 20)).modules.get('virtual'), [root + 'two.d.ts']);
});

test('同名环境模块的合并声明全部进入类型图，目录预算不能冒充完整结果', async () => {
  const { root, reader, request } = fixture({
    'page.ts': `import type {Shared} from 'virtual';Page({data:{shared:{} as Shared}});`,
    'one.d.ts': `declare module 'virtual' {export interface Shared {left:string}}`,
    'two.d.ts': `declare module 'virtual' {export interface Shared {right:number}}`,
  });
  assert.equal((await ambientIndex(reader, request, 1)).complete, false);
  const project = await new ScriptProject(reader, request, { maxFiles: 20 }).create();
  assert.ok(project!.program.getSourceFile(root + 'one.d.ts')); assert.ok(project!.program.getSourceFile(root + 'two.d.ts'));
  const checker = project!.program.getTypeChecker();
  const imported = project!.entry.statements.find(ts.isImportDeclaration)!;
  const bindings = imported.importClause!.namedBindings!;
  assert.ok(ts.isNamedImports(bindings));
  const symbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(bindings.elements[0]!.name)!);
  assert.deepEqual(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol)).map((item) => item.name).sort(), ['left', 'right']);
});

test('取消的声明扫描不污染其他请求，转义名称仍由 TypeScript 解析', async () => {
  const { root, reader, request, reads } = fixture({ 'one.d.ts': `declare module '\\u0064emo' {export const value:number}` });
  const cancelled = await ambientIndex(reader, { ...request, cancellation: { isCancellationRequested: true } }, 20);
  assert.equal(cancelled.complete, false); assert.deepEqual(reads, []);
  assert.deepEqual((await ambientIndex(reader, request, 20)).modules.get('demo'), [root + 'one.d.ts']);
});

test('无修订读取器仍读取声明，暂时缺失的文件恢复后可以重新索引', async () => {
  const { root, reader, request } = fixture({ 'one.d.ts': `declare module 'demo' {export const value:number}` });
  const unversioned: WorkspaceReader = { root: reader.root, read: reader.read, findFiles: reader.findFiles! };
  assert.deepEqual((await ambientIndex(unversioned, request, 20)).modules.get('demo'), [root + 'one.d.ts']);
  let available = false;
  const recovering: WorkspaceReader = { ...reader, read: async (uri) => available ? reader.read(uri) : undefined };
  assert.equal((await ambientIndex(recovering, request, 20)).complete, false);
  available = true;
  assert.deepEqual((await ambientIndex(recovering, request, 20)).modules.get('demo'), [root + 'one.d.ts']);
});

test('声明词法筛选保留注释间隔、转义与模块增补，不把说明文字当模块', async () => {
  const { root, reader, request } = fixture({
    'ordinary.d.ts': `/** declare module 'fake' {} */declare namespace Mini {interface Data {title:string}}`,
    'commented.d.ts': `declare/*间隔*/module/*间隔*/'commented' {export const value:number}`,
    'escaped.d.ts': `declare module '\\u0065scaped' {export const value:number}`,
    'augment.d.ts': `export {};declare module 'augment' {export interface Extra {value:string}}`,
    'template.d.ts': 'type Note<T extends string>=`module ${T}`;declare module "template" {export const value:number}',
  });
  const index = await ambientIndex(reader, request, 20);
  assert.equal(index.complete, true); assert.equal(index.modules.has('fake'), false);
  for (const name of ['commented', 'escaped', 'augment', 'template']) assert.deepEqual(index.modules.get(name), [root + name + '.d.ts']);
  const invalid = fixture({ 'broken.d.ts': `declare module//换行\n 'broken' {export const value:number}` });
  assert.equal((await ambientIndex(invalid.reader, invalid.request, 20)).complete, false);
});

test('模块名称索引精简文档解析后，语法完整性与完整解析器保持一致', async () => {
  for (const text of [
    '/** 模块说明。{@link Item} */declare module "large" {/** 方法说明。 @param value 参数说明。 */export function save(value:string):void;export interface Item {value:number}}',
    'declare module "broken" {export interface Item {value:}}',
    'declare module "comment" {export const value:string}/* 未闭合',
  ]) {
    const graph = fixture({ 'source.d.ts': text });
    const source = ts.createSourceFile(graph.root + 'source.d.ts', text, ts.ScriptTarget.Latest, true);
    const names = source.statements.flatMap((item) => ts.isModuleDeclaration(item) && ts.isStringLiteralLike(item.name) ? [item.name.text] : []);
    const errors = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    const index = await ambientIndex(graph.reader, graph.request, 20);
    assert.deepEqual([...index.modules.keys()], names); assert.equal(index.complete, errors.length === 0);
  }
});
