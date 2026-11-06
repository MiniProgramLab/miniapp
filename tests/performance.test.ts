import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { ScriptProject } from '../src/languages/typescript/project';
import { createScriptResolver } from '../src/languages/typescript';
import { provideScriptDefinition } from '../src/languages/typescript/navigation';
import { createProjectFileResolver } from '../src/resolution';
import { createNavigationTracking } from '../src/adapters/vscode/navigation-tracking';
import { createTemplateResolver } from '../src/languages/wxml';
import { semanticType, accepts } from '../src/languages/typescript/semantic-types';
import { directTemplateHover } from '../src/languages/typescript/direct-definition';

test('首次悬浮沿 Behavior 的对象展开定位说明，不读取无关依赖并核对草稿变化', async () => {
  const root = 'file:///spread-hover/';
  const documents = new Map([
    [root + 'page.ts', `import base from './base';import environment from './environment';import './heavy';Component({behaviors:[base,environment]});`],
    [root + 'base.ts', `import {colors} from './colors';import './unrelated';export default Behavior({data:{...colors}});`],
    [root + 'environment.ts', `const MATRIX={dev:true,prod:true};type Keys=keyof typeof MATRIX;const flags:Record<Keys,boolean>={} as any;export default Behavior({data:{...flags}});`],
    [root + 'colors.ts', `export const colors={/** 占位文字颜色 */ placeholderColor:'#ccc'};`],
  ]);
  const reads: string[] = [], versions = new Map<string, number>();
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0),
    fileResolver: (uri, cancellation) => createProjectFileResolver(reader, uri, cancellation),
    read: async (uri) => { reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text }; } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{placeholderColor}}', version: 1, languageId: 'wxml' }, offset: 8, cancellation: { isCancellationRequested: false } };
  const expression = { text: 'placeholderColor', range: { start: 2, end: 18 }, bindings: [] };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const hover = await scripts.hover!(request, expression);
  assert.equal(hover?.description, '占位文字颜色');
  assert.deepEqual(hover?.range, expression.range);
  const targets = await scripts.resolve(request, expression);
  assert.equal(targets[0]?.uri, root + 'colors.ts');
  assert.equal(documents.get(targets[0]!.uri)!.slice(targets[0]!.range.start, targets[0]!.range.end), 'placeholderColor');
  assert.ok(!reads.some((uri) => /\/(heavy|unrelated)\./.test(uri)), '首次查询不建立无关脚本图');
  documents.set(root + 'colors.ts', `export const colors={/** 更新后的颜色说明 */ placeholderColor:'#eee'};`);
  versions.set(root + 'colors.ts', 1);
  assert.equal((await scripts.hover!(request, expression))?.description, '更新后的颜色说明');
});

test('对象展开遵守后项覆盖，动态展开和被遮蔽的 Record 保留完整语义回退', async () => {
  const cases = [
    { declaration: `const colors={/** 展开说明 */ label:'甲'};`, data: `/** 本地说明 */ label:'乙',...colors`, expected: '展开说明' },
    { declaration: `const colors={/** 展开说明 */ label:'甲'};`, data: `...colors,/** 本地说明 */ label:'乙'`, expected: '本地说明' },
    { declaration: `const colors={/** 展开说明 */ label:'甲'};const other={dev:true};`, data: `...colors,...other`, expected: '展开说明' },
    { declaration: `const colors:Record<'dev'|'prod',boolean>={} as any;`, data: `/** 本地说明 */ label:'乙',...colors`, expected: '本地说明' },
    { declaration: `const colors:Record<string,string>={} as any;`, data: `/** 本地说明 */ label:'乙',...colors` },
    { declaration: `const colors:Record<'label'|'prod',string>={} as any;`, data: `/** 本地说明 */ label:'乙',...colors` },
    { declaration: `type Record<K,V>={label:V};const colors:Record<'dev',string>={} as any;`, data: `/** 本地说明 */ label:'乙',...colors` },
    { declaration: `import {Record} from './types';const colors:Record<'dev',string>={} as any;`, data: `/** 本地说明 */ label:'乙',...colors` },
    { declaration: `const colors=getColors();`, data: `/** 本地说明 */ label:'乙',...colors` },
    { declaration: `const colors=getColors();`, data: `...colors,/** 本地说明 */ label:'乙'`, expected: '本地说明' },
  ];
  for (const [index, item] of cases.entries()) {
    const root = `file:///spread-order-${index}/`;
    const reader: WorkspaceReader = { root: () => root, read: async (uri) => uri === root + 'page.ts' ? { text: `${item.declaration}Page({data:{${item.data}}});` } : undefined };
    const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{label}}', version: 1, languageId: 'wxml' }, offset: 4, cancellation: { isCancellationRequested: false } };
    const hover = await directTemplateHover(reader, request, { text: 'label', range: { start: 2, end: 7 }, bindings: [] }, {});
    assert.equal(hover?.description, item.expected, `展开场景 ${index} 应遵守静态结论和回退边界`);
  }
});

test('脚本图复用减少读取，依赖草稿和缺失文件创建会使缓存失效', async () => {
  const root = 'file:///performance/';
  const documents = new Map([
    [root + 'page.ts', `import {shared} from './shared';Page({data:{shared}});`],
    [root + 'shared.ts', `export const shared={title:'甲'};`],
  ]);
  const versions = new Map<string, number>();
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0), read: async (uri) => {
    reads++; const text = documents.get(uri); return text === undefined ? undefined : { text };
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{shared.title}}', version: 1, languageId: 'wxml' }, offset: 5, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  assert.ok(first);
  const firstReads = reads;
  const warm = await new ScriptProject(reader, { ...request, document: { ...request.document, text: '{{shared.}}', version: 2 } }, {}).create();
  assert.equal(warm!.program, first.program, '模板编辑不重建未变化的脚本图');
  assert.equal(reads, firstReads, '缓存命中不重复读取依赖及路径探测');
  documents.set(root + 'shared.ts', `export const shared={updated:true};`);
  versions.set(root + 'shared.ts', 1);
  const changed = await new ScriptProject(reader, request, {}).create();
  assert.notEqual(changed!.program, first.program);
  assert.match(changed!.program.getSourceFile(root + 'shared.ts')!.text, /updated/);
  documents.set(root + 'tsconfig.json', '{"compilerOptions":{"strict":true}}');
  versions.set(root + 'tsconfig.json', 1);
  const configured = await new ScriptProject(reader, request, {}).create();
  assert.notEqual(configured!.program, changed!.program, '之前不存在的配置也是缓存依赖');
  assert.equal(configured!.program.getCompilerOptions().strict, true);
});

test('无修订端口、已取消请求及不同解析设置不复用旧图', async () => {
  const uri = 'vscode-remote://ssh-remote+test/project/page.ts';
  let text = 'Page({data:{old:true}});';
  const reader: WorkspaceReader = { root: () => new URL('./', uri).href, read: async (target) => target === uri ? { text } : undefined };
  const request: LanguageRequest = { document: { uri: uri.replace('.ts', '.wxml'), text: '{{old}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  text = 'Page({data:{newer:true}});';
  const next = await new ScriptProject(reader, request, {}).create();
  assert.match(next!.entry.text, /newer/);
  assert.notEqual(first!.program, next!.program);
  const cachedReader = { ...reader, revision: () => '0' };
  const configured = await new ScriptProject(cachedReader, request, { maxFiles: 2 }).create();
  const other = await new ScriptProject(cachedReader, request, { maxFiles: 20 }).create();
  assert.notEqual(configured!.program, other!.program);
  assert.equal(await new ScriptProject(cachedReader, { ...request, cancellation: { isCancellationRequested: true } }, {}).create(), undefined);
});

test('跳转打开或关闭同内容的目标时复用类型图，只刷新目标文档版本', async () => {
  const root = 'file:///buffer-cache/';
  const shared = root + 'shared.ts';
  const documents = new Map([[root + 'page.ts', `import {title} from './shared';Page({data:{title}});`], [shared, `export const title='甲';`]]);
  const versions = new Map<string, number>();
  const reads: string[] = [];
  let opened = false;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0), read: async (uri) => {
    reads.push(uri);
    const text = documents.get(uri);
    return text === undefined ? undefined : { text, ...(uri === shared && opened ? { version: 1 } : {}) };
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{title}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  for (const state of [true, false, true]) {
    opened = state;
    versions.set(shared, (versions.get(shared) ?? 0) + 1);
    reads.length = 0;
    const project = new ScriptProject(reader, request, {});
    assert.equal((await project.create())!.program, first!.program);
    assert.deepEqual(reads, [shared]);
    assert.equal(project.documents.get(shared)?.version, state ? 1 : undefined);
  }
  documents.set(shared, `export const title='已修改';`);
  versions.set(shared, versions.get(shared)! + 1);
  const edited = await new ScriptProject(reader, request, {}).create();
  assert.notEqual(edited!.program, first!.program);
  assert.match(edited!.program.getSourceFile(shared)!.text, /已修改/);
});

test('缓存复核期间目标再次变化时放弃旧图，重新读取最新源码', async () => {
  const root = 'file:///cache-race/';
  const shared = root + 'shared.ts';
  let text = 'export const count=1;';
  let revision = 0;
  let changing = false;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => uri === shared ? String(revision) : '0', read: async (uri) => {
    if (uri === root + 'page.ts') return { text: `import {count} from './shared';Page({data:{count}});` };
    if (uri !== shared) return undefined;
    const snapshot = { text };
    if (changing) { changing = false; text = 'export const count=2;'; revision++; }
    return snapshot;
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{count}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  revision++; changing = true;
  const next = await new ScriptProject(reader, request, {}).create();
  assert.notEqual(next!.program, first!.program);
  assert.match(next!.program.getSourceFile(shared)!.text, /count=2/);
});

test('目录探测排除缺失目录，受限图复用时仍保留不完整标记', async () => {
  const root = 'file:///directory/';
  const files = new Map([[root + 'page.ts', `import {shared} from './lib/shared';import absent from './missing/entry';Page({data:{shared}});`], [root + 'lib/shared.ts', `export const shared={title:'甲'};`]]);
  let probes = 0;
  let structure = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => uri === root ? String(structure) : '0', directory: async (uri) => {
    probes++; return [...files.keys()].some((file) => file.startsWith(uri.replace(/\/?$/, '/')));
  }, read: async (uri) => { const text = files.get(uri); return text === undefined ? undefined : { text }; } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{shared.title}}', languageId: 'wxml', version: 1 }, offset: 3, cancellation: { isCancellationRequested: false } };
  const project = new ScriptProject(reader, request, { maxFiles: 20 });
  const complete = await project.create();
  assert.ok(complete!.program.getSourceFile(root + 'lib/shared.ts'));
  assert.equal(project.exhausted, false);
  assert.ok(probes > 0);
  const bounded = new ScriptProject(reader, request, { maxFiles: 1 });
  const first = await bounded.create();
  assert.equal(bounded.exhausted, true);
  const reused = new ScriptProject(reader, request, { maxFiles: 1 });
  const repeated = await reused.create();
  assert.equal(first!.program, repeated!.program, '受限图也避免重复建图');
  assert.equal(reused.exhausted, true, '复用不能把受限图当成完整上下文');
  structure++;
  const refreshed = await new ScriptProject(reader, request, { maxFiles: 1 }).create();
  assert.notEqual(refreshed!.program, repeated!.program, '目录结构变化后重新尝试补全受限图');
});

test('按需引用链缓存核对草稿、目标打开版本及路径配置，连续查询不重复探测', async () => {
  const root = 'file:///direct-cache/';
  const shared = root + 'shared.ts';
  const documents = new Map([
    [root + 'page.ts', `import {title} from '@shared';Page({data:{title}});`],
    [root + 'tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@shared":["shared"]}}}'],
    [shared, `export const title='甲';`],
    [root + 'other.ts', `export const title='乙';`],
  ]);
  const versions = new Map<string, number>();
  const reads: string[] = [];
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0), read: async (uri) => {
    reads.push(uri);
    const text = documents.get(uri);
    return text === undefined ? undefined : { text, version: versions.get(uri) ?? 0 };
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{title}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const expression = { text: 'title', range: { start: 2, end: 7 }, bindings: [] };
  const scripts = createScriptResolver(reader);
  const first = await scripts.resolve(request, expression);
  assert.equal(first[0]!.uri, shared);
  reads.length = 0;
  assert.deepEqual(await scripts.resolve(request, expression), first);
  assert.deepEqual(reads, []);
  versions.set(shared, 1);
  const opened = await scripts.resolve(request, expression);
  assert.equal(opened[0]!.version, 1);
  assert.deepEqual(reads, [shared]);
  documents.set(shared, `/** 草稿移动声明 */\nexport const title='更新';`);
  versions.set(shared, 2);
  assert.ok((await scripts.resolve(request, expression))[0]!.range.start > first[0]!.range.start);
  documents.set(root + 'tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@shared":["other"]}}}');
  versions.set(root + 'tsconfig.json', 1);
  assert.equal((await scripts.resolve(request, expression))[0]!.uri, root + 'other.ts');
});

test('按需路径缓存保留缺失文件依赖，复核期间内容再次变化时重新解析', async () => {
  const root = 'file:///direct-missing/';
  const shared = root + 'shared.ts';
  let text: string | undefined;
  let version = 0;
  let changing = false;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => uri === shared ? String(version) : '0', read: async (uri) => {
    if (uri === root + 'page.ts') return { text: `import {title} from './shared';Page({data:{title}});` };
    if (uri !== shared || text === undefined) return undefined;
    const snapshot = { text, version };
    if (changing) { changing = false; text = `/** 新位置 */\nexport const title='最新';`; version++; }
    return snapshot;
  } };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{title}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const expression = { text: 'title', range: { start: 2, end: 7 }, bindings: [] };
  const scripts = createScriptResolver(reader);
  assert.equal((await scripts.resolve(request, expression)).length, 0);
  text = `export const title='新建';`; version++;
  const first = await scripts.resolve(request, expression);
  assert.equal(first[0]!.uri, shared);
  version++; changing = true;
  const next = await scripts.resolve(request, expression);
  assert.ok(next[0]!.range.start > first[0]!.range.start);
  assert.equal(next[0]!.version, version);
});

test('编辑脚本后重建语义关系，同时复用未变化依赖的语法树', async () => {
  const root = 'file:///incremental/';
  let text = `import {state} from './shared';Page({data:{state}});`;
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', read: async (uri) => uri === root + 'shared.ts' ? { text: 'export const state={count:1};' } : undefined };
  const request: LanguageRequest = { document: { uri: root + 'page.ts', text, languageId: 'typescript', version: 1 }, offset: 0, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create(request.document.uri);
  text = text.replace('data:{state}', 'data:{state,title:"新增"}');
  const next = await new ScriptProject(reader, { ...request, document: { ...request.document, text, version: 2 } }, {}).create(request.document.uri);
  assert.notEqual(next!.program, first!.program);
  assert.equal(next!.program.getSourceFile(root + 'shared.ts'), first!.program.getSourceFile(root + 'shared.ts'));
  assert.match(next!.entry.text, /新增/);
  assert.equal(next!.program.getSemanticDiagnostics().length, first!.program.getSemanticDiagnostics().length);
});

test('脚本深度预算阻止读取深层模块，关闭限制后可完整解析且循环正常终止', async () => {
  const root = 'file:///depth/';
  const files = new Map(Array.from({ length: 20 }, (_, index) => [root + `part${index}.ts`, index < 19 ? `export * from './part${index + 1}';` : `export const end=1;`]));
  const reads: string[] = [];
  const steps: string[] = [];
  const navigation = createNavigationTracking();
  const reader: WorkspaceReader = { root: () => root, read: async (uri) => { reads.push(uri); const text = files.get(uri); return text === undefined ? undefined : { text }; }, navigation };
  const request: LanguageRequest = { document: { uri: root + 'page.ts', text: `import {end} from './part0';`, languageId: 'typescript', version: 1 }, offset: 0, cancellation: { isCancellationRequested: false } };
  const bounded = new ScriptProject(reader, request, { maxDepth: 3 });
  const report = await navigation.capture(() => bounded.create(request.document.uri));
  steps.push(...report.steps.map((step) => step.message));
  assert.equal(bounded.exhausted, true);
  assert.equal(bounded.sources.size, 4);
  assert.ok(!reads.includes(root + 'part3.ts'));
  assert.ok(steps.some((message) => message.includes('3 层')));
  const complete = new ScriptProject(reader, request, { maxDepth: 0 });
  await complete.create(request.document.uri);
  assert.equal(complete.exhausted, false);
  assert.equal(complete.sources.size, 21);
  navigation.dispose();
});

test('脚本导入导航忽略无关分支，字符串内的普通文字不触发项目读取', async () => {
  const root = 'file:///selective/';
  const text = `import {run} from '@logic/model';import './noise';run();`;
  const files = new Map([[root + 'webpack.config.js', `module.exports={resolve:{alias:{'@logic':'domain'}}}`], [root + 'domain/model.ts', 'export function run(){return 1;}'], [root + 'other/model.ts', 'export function run(){return 2;}'], [root + 'noise.ts', `export * from './deep';`], [root + 'deep.ts', 'export const other=1;']]);
  const reads: string[] = [];
  const revisions = new Map<string, number>();
  const raw: WorkspaceReader = { root: () => root, revision: (uri) => String(revisions.get(uri) ?? 0), read: async (uri) => { reads.push(uri); const text = files.get(uri); return text === undefined ? undefined : { text }; } };
  const reader: WorkspaceReader = { ...raw, fileResolver: (uri, cancellation) => createProjectFileResolver(raw, uri, cancellation) };
  const request: LanguageRequest = { document: { uri: root + 'page.ts', text, languageId: 'typescript', version: 1 }, offset: text.lastIndexOf('run') + 1, cancellation: { isCancellationRequested: false } };
  assert.equal((await provideScriptDefinition(reader, request))[0]!.uri, root + 'domain/model.ts');
  assert.ok(!reads.includes(root + 'noise.ts') && !reads.includes(root + 'deep.ts'));
  reads.length = 0;
  assert.equal((await provideScriptDefinition(reader, request))[0]!.uri, root + 'domain/model.ts');
  assert.deepEqual(reads, [], '连续查询不重复配置探测');
  files.set(root + 'webpack.config.js', `module.exports={resolve:{alias:{'@logic':'other'}}}`); revisions.set(root + 'webpack.config.js', 1);
  assert.equal((await provideScriptDefinition(reader, request))[0]!.uri, root + 'other/model.ts', '复用语法树后仍重新核验变更的源码映射');
  reads.length = 0;
  const literal = 'const title="普通文字";';
  assert.deepEqual(await provideScriptDefinition(reader, { ...request, document: { ...request.document, text: literal }, offset: literal.indexOf('普通') + 1 }), []);
  assert.deepEqual(reads, []);
});

test('并发建图合并读取，取消一个调用者不会取消其他调用者', async () => {
  const root = 'file:///concurrent/';
  let reads = 0, release: () => void = () => {}, started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', read: async (uri) => {
    if (uri !== root + 'page.ts') return undefined;
    reads++; started(); await blocked; return { text: 'Page({data:{title:"标题"}});' };
  } };
  const cancelled = { isCancellationRequested: false };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{title}}', languageId: 'wxml', version: 1 }, offset: 4, cancellation: cancelled };
  const first = new ScriptProject(reader, request, {}).create();
  const secondRequest = { ...request, cancellation: { isCancellationRequested: false } };
  const second = new ScriptProject(reader, secondRequest, {}).create();
  await ready; cancelled.isCancellationRequested = true; release();
  assert.equal(await first, undefined);
  const result = await second;
  assert.ok(result); assert.equal(reads, 1);
  assert.equal((await new ScriptProject(reader, secondRequest, {}).create())!.program, result.program);
});

test('普通页面的空提示不反查整个工作区，独立模板仍由调用图解析', async () => {
  const root = 'file:///empty-page/';
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', read: async (uri) => uri === root + 'page.ts' ? { text: 'Page({data:{title:"标题"}});' } : undefined,
    findFiles: async () => { throw new Error('普通页面不应扫描工作区'); } };
  const scripts = createTemplateResolver(reader, createScriptResolver(reader));
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{missing}}', languageId: 'wxml', version: 1 }, offset: 6, cancellation: { isCancellationRequested: false } };
  const expression = { text: 'missing', range: { start: 2, end: 9 }, bindings: [] };
  assert.equal(await scripts.hover!(request, expression), undefined);
  assert.deepEqual(await scripts.complete!(request, expression), []);
  assert.deepEqual(await scripts.resolve(request, expression), []);
});

test('宽类型和循环类型的投影有界，预算不足保留未知兼容性', async () => {
  const uri = 'file:///projection/page.ts';
  const text = `interface Leaf { ${Array.from({ length: 100 }, (_, index) => `p${index}:string;`).join('')} } interface Wide { ${Array.from({ length: 100 }, (_, index) => `p${index}:Leaf;`).join('')} } declare const wide:Wide; interface Recursive { child:Recursive; name:string; } declare const recursive:Recursive;`;
  const request: LanguageRequest = { document: { uri, text, languageId: 'typescript', version: 1 }, offset: 0, cancellation: { isCancellationRequested: false } };
  const project = await new ScriptProject({ root: () => 'file:///projection/', read: async () => undefined }, request, {}).create(uri);
  const checker = project!.program.getTypeChecker();
  let reads = 0;
  const measured = { ...checker, getTypeOfSymbolAtLocation: (...args: Parameters<typeof checker.getTypeOfSymbolAtLocation>) => { reads++; return checker.getTypeOfSymbolAtLocation(...args); } };
  const declarations = project!.entry.statements.filter(ts.isVariableStatement).flatMap((statement) => statement.declarationList.declarations);
  const wide = declarations.find((declaration) => declaration.name.getText() === 'wide')!;
  const limited = semanticType(measured, checker.getTypeAtLocation(wide.name), wide.name);
  assert.equal(limited.kind, 'unknown'); assert.ok(reads < 600);
  assert.equal(accepts(limited, { kind: 'number', display: 'number' }), true);
  const recursive = declarations.find((declaration) => declaration.name.getText() === 'recursive')!;
  const cycle = semanticType(measured, checker.getTypeAtLocation(recursive.name), recursive.name);
  assert.equal(cycle.properties?.child?.kind, 'unknown');
  assert.equal(cycle.properties?.name?.kind, 'string');
});
