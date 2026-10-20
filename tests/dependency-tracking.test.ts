import assert from 'node:assert/strict';
import test from 'node:test';
import { createDependencyTracking } from '../src/adapters/vscode/dependency-tracking';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';

test('并发异步读取隔离依赖，嵌套查询仍记录到调用者', async () => {
  const revisions = createWorkspaceRevisions();
  const tracking = createDependencyTracking(revisions.revision);
  const [first, second] = await Promise.all([
    tracking.capture(async () => {
      tracking.observe('file:///first.ts');
      await Promise.resolve();
      await tracking.capture(async () => { tracking.observe('file:///nested.ts'); });
      return 1;
    }),
    tracking.capture(async () => { await Promise.resolve(); tracking.observe('file:///second.ts'); return 2; }),
  ]);
  assert.equal(first.value, 1);
  assert.deepEqual(first.dependencies.map((item) => item.uri), ['file:///first.ts', 'file:///nested.ts']);
  assert.deepEqual(second.dependencies.map((item) => item.uri), ['file:///second.ts']);
});

test('读取期间依赖变化不能覆盖最初修订，缓存命中的修订检查仍进入依赖', async () => {
  const revisions = createWorkspaceRevisions();
  const tracking = createDependencyTracking(revisions.revision);
  const uri = 'file:///workspace/module.ts';
  const result = await tracking.capture(async () => {
    tracking.observe(uri);
    revisions.changed(uri, 'file:///workspace/');
    await Promise.resolve();
    tracking.observe(uri);
  });
  assert.notEqual(result.dependencies[0]!.revision, revisions.revision(uri));
  const cached = await tracking.capture(async () => tracking.observe('file:///workspace/'));
  assert.equal(cached.dependencies[0]!.uri, 'file:///workspace');
});
