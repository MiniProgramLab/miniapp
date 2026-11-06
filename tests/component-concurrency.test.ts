import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createComponentScriptResolver } from '../src/languages/typescript';
import { ScriptProject } from '../src/languages/typescript/project';
import { createComponentResolver } from '../src/languages/wxml';

/** 等价 reader 包装共享修订域，独立调用者保留自己的取消状态。 */
test('不同 reader 包装合并同一类型图，取消首个请求不会中断其他请求', async () => {
  const root = 'file:///wrapped/';
  let reads = 0, entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', read: async (uri) => {
    if (uri !== root + 'page.ts') return undefined;
    reads++; entered(); await gate; return { text: `Page({data:{title:'标题'}});` };
  } };
  const cancellation = { isCancellationRequested: false };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{title}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation };
  const first = new ScriptProject({ ...reader, read: (uri) => reader.read(uri) }, request, {}).create();
  const second = new ScriptProject({ ...reader, read: (uri) => reader.read(uri) }, { ...request, cancellation: { isCancellationRequested: false } }, {}).create();
  await ready; cancellation.isCancellationRequested = true; release();
  assert.equal(await first, undefined); assert.ok(await second); assert.equal(reads, 1);
});

test('组件并发悬浮共享元数据，取消与补全详情保持准确', async () => {
  const root = 'file:///component-shared/';
  const documents = new Map([
    [root + 'app.json', '{}'], [root + 'package.json', '{}'],
    [root + 'page.json', '{"usingComponents":{"my-card":"./card/index"}}'],
    [root + 'card/index.ts', `Component({properties:{/** 标题一 */ title:{type:String,value:'默认'}}});`],
    [root + 'card/index.wxml', '<view/>'],
  ]);
  const revisions = createWorkspaceRevisions();
  const reader: WorkspaceReader = { root: () => root, revision: revisions.revision, read: async (uri) => { const text = documents.get(uri); return text === undefined ? undefined : { text, version: 1 }; } };
  let inspected = 0, entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const components = createComponentResolver(reader, (snapshot) => {
    const actual = createComponentScriptResolver(snapshot);
    return { ...actual, inspect: async (request, uri, includeInstance, inspection) => {
      if (uri === root + 'card/index.ts') { inspected++; entered(); if (inspected === 1) await gate; }
      return actual.inspect(request, uri, includeInstance, inspection);
    } };
  });
  const text = '<my-card title/>';
  const cancellation = { isCancellationRequested: false };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text, version: 1, languageId: 'wxml' }, offset: text.indexOf('title') + 2, cancellation };
  const hover = components.hover(request);
  const otherHover = components.hover({ ...request, cancellation: { isCancellationRequested: false } });
  await ready; cancellation.isCancellationRequested = true; release();
  assert.equal(await hover, undefined);
  assert.match((await otherHover)!.description, /标题一/);
  assert.equal(inspected, 1);
  const current = { ...request, cancellation: { isCancellationRequested: false } };
  assert.match((await components.hover(current))!.description, /标题一/); assert.equal(inspected, 1, '完整元数据可跨交互复用');
  assert.ok((await components.completion!(current)).some((item) => item.label === 'title' && item.documentation.includes('标题一')));
  const previous = inspected;
  documents.set(root + 'card/index.ts', `Component({properties:{/** 标题二 */ title:{type:Number,value:2}}});`); revisions.changed(root + 'card/index.ts', root);
  const updated = await components.hover(current);
  assert.match(updated!.description, /标题二/); assert.match(updated!.description, /number/); assert.equal(inspected, previous + 1);
  const definition = (await components.definition(current))[0]!;
  assert.equal(definition.uri, root + 'card/index.ts');
  assert.equal(documents.get(definition.uri)!.slice(definition.range.start, definition.range.end), 'title');
});
