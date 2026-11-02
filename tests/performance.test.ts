import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { ScriptProject } from '../src/languages/typescript/project';
import { createScriptResolver } from '../src/languages/typescript';

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

test('目录探测发现循环模块并排除缺失目录，超出文件预算的图不进入缓存', async () => {
  const root = 'file:///directory/';
  const files = new Map([[root + 'page.ts', `import {shared} from './lib/shared';import absent from './missing/entry';Page({data:{shared}});`], [root + 'lib/shared.ts', `export const shared={title:'甲'};`]]);
  let probes = 0;
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', directory: async (uri) => {
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
  const repeated = await new ScriptProject(reader, request, { maxFiles: 1 }).create();
  assert.notEqual(first!.program, repeated!.program, '超预算查询不能伪装为完整缓存命中');
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
