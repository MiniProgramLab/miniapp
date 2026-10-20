import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { ScriptProject } from '../src/languages/typescript/project';
import type { LanguageRequest, WorkspaceReader } from '../src/api';

test('普通内容变化只更新自身，结构变化更新相关目录及发现根', () => {
  const revisions = createWorkspaceRevisions();
  const root = 'file:///workspace/';
  const original = revisions.revision(root);
  const parent = revisions.revision(root + 'a/');
  const file = revisions.revision(root + 'a/page.ts');
  const other = revisions.revision(root + 'b/page.ts');
  revisions.changed(root + 'a/page.ts', root);
  assert.notEqual(revisions.revision(root + 'a/page.ts'), file);
  assert.equal(revisions.revision(root), original);
  assert.equal(revisions.revision(root + 'a'), parent);
  assert.equal(revisions.revision(root + 'b/page.ts'), other);
  revisions.changed(root + 'a/created.ts', root, true);
  assert.notEqual(revisions.revision(root + 'a/'), parent);
  assert.notEqual(revisions.revision(root), original);
  assert.equal(revisions.revision(root + 'b/page.ts'), other);
});

test('大量构建输出事件不回收已有修订，已观察的输出及包依赖仍刷新', () => {
  const revisions = createWorkspaceRevisions();
  const root = 'vscode-remote://ssh-remote+dev/project/';
  const original = revisions.revision(root);
  const source = revisions.revision(root + 'src/page.ts');
  const map = revisions.revision(root + 'dist/page.js.map');
  const dependency = revisions.revision(root + 'node_modules/library/');
  for (let index = 0; index < 10000; index++) revisions.changed(root + 'dist/generated-' + index + '.js', root, true);
  assert.equal(revisions.revision(root), original);
  assert.equal(revisions.revision(root + 'src/page.ts'), source);
  revisions.changed(root + 'dist/page.js.map', root);
  assert.notEqual(revisions.revision(root + 'dist/page.js.map'), map);
  revisions.changed(root + 'node_modules/library/index.d.ts', root, true);
  assert.notEqual(revisions.revision(root + 'node_modules/library'), dependency);
  assert.equal(revisions.revision(root), original);
});

test('实际脚本图在无关文件修改后复用，缺失目录创建后重新解析', async () => {
  const root = 'file:///workspace/';
  const files = new Map([[root + 'page.ts', `import {value} from './missing/value';Page({data:{value}});`]]);
  const revisions = createWorkspaceRevisions();
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: revisions.revision, read: async (uri) => { reads++; const text = files.get(uri); return text === undefined ? undefined : { text }; }, directory: async (uri) => [...files.keys()].some((file) => file.startsWith(uri.replace(/\/?$/, '/'))) };
  const request: LanguageRequest = { document: { uri: root + 'page.wxml', text: '{{value}}', version: 1, languageId: 'wxml' }, offset: 3, cancellation: { isCancellationRequested: false } };
  const first = await new ScriptProject(reader, request, {}).create();
  const before = reads;
  revisions.changed(root + 'unrelated.ts', root);
  const warm = await new ScriptProject(reader, { ...request }, {}).create();
  assert.equal(warm!.program, first!.program);
  assert.equal(reads, before);
  files.set(root + 'missing/value.ts', 'export const value=1;');
  revisions.changed(root + 'missing/value.ts', root, true);
  const created = await new ScriptProject(reader, { ...request }, {}).create();
  assert.notEqual(created!.program, first!.program);
  assert.ok(created!.program.getSourceFile(root + 'missing/value.ts'));
});

test('大型工程的一万多个探测保持修订稳定，超过有界容量才整体回收', () => {
  const revisions = createWorkspaceRevisions();
  const root = 'file:///large-workspace/';
  const first = revisions.revision(root);
  for (let index = 0; index < 15000; index++) revisions.revision(root + 'probe-' + index + '.ts');
  assert.equal(revisions.revision(root), first);
  for (let index = 15000; index < 66000; index++) revisions.revision(root + 'probe-' + index + '.ts');
  assert.notEqual(revisions.revision(root), first);
});
