import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerFileCache } from '../src/adapters/worker/file-cache';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createDependencyTracking } from '../src/adapters/vscode/dependency-tracking';

test('线程缓存合并阴性探测并重播依赖，文件新增后重新读取', async () => {
  const uri = 'memfs:///cache/model.ts', revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision);
  let reads = 0, value: unknown;
  const cache = createWorkerFileCache({ revision: revisions.revision, observe: tracking.observe,
    load: async () => { reads++; return { value, dependencies: [{ uri, revision: revisions.revision(uri) }], stale: false }; },
  });
  assert.deepEqual(await Promise.all([cache.read('read', [uri]), cache.read('read', [uri])]), [undefined, undefined]);
  assert.equal(reads, 1);
  const captured = await tracking.capture(() => cache.read('read', [uri]));
  assert.deepEqual(captured.dependencies, [{ uri, revision: revisions.revision(uri) }]); assert.equal(reads, 1);
  value = { text: 'export interface Model {title:string}', version: 1 }; revisions.changed(uri, 'memfs:///cache', true);
  assert.deepEqual(await cache.read('read', [uri]), value); assert.equal(reads, 2);
});

test('并发等待读取期间文件变化时不复用旧版本，两位调用者均取得新快照', async () => {
  const uri = 'memfs:///cache/model.ts', revisions = createWorkspaceRevisions();
  let reads = 0, version = 1, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = createWorkerFileCache({ revision: revisions.revision, observe: revisions.revision,
    load: async () => {
      const snapshot = { value: { text: String(version), version }, dependencies: [{ uri, revision: revisions.revision(uri) }], stale: false };
      if (++reads === 1) await gate;
      return snapshot;
    },
  });
  const first = cache.read('read', [uri]), second = cache.read('read', [uri]);
  version++; revisions.changed(uri); release();
  assert.deepEqual(await Promise.all([first, second]), [{ text: '2', version: 2 }, { text: '2', version: 2 }]); assert.equal(reads, 2);
});

test('文件发现缓存按范围和上限隔离，目录结构变化后不会保留旧列表', async () => {
  const root = 'memfs:///cache', revisions = createWorkspaceRevisions();
  let reads = 0;
  const cache = createWorkerFileCache({ revision: revisions.revision, observe: revisions.revision,
    load: async (_method, args) => ({ value: [++reads], dependencies: [{ uri: (args[3] as { root: string }).root, revision: revisions.revision((args[3] as { root: string }).root) }], stale: false }),
  });
  const args = [root, '**/*.d.ts', 20, { root }];
  assert.deepEqual(await cache.read('findFiles', args), [1]); assert.deepEqual(await cache.read('findFiles', args), [1]);
  assert.deepEqual(await cache.read('findFiles', [root, '**/*.d.ts', 21, { root }]), [2]);
  assert.deepEqual(await cache.read('findFiles', [root, '**/*.d.ts', 20, { root: root + '/shared' }]), [3]);
  revisions.changed(root + '/new.d.ts', root, true);
  assert.deepEqual(await cache.read('findFiles', args), [4]);
});

test('缺失目录的子路径复用阴性结论，新增文件使该结论失效', async () => {
  const root = 'memfs:///cache', parent = root + '/missing', target = parent + '/model.ts', revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision);
  let reads = 0, exists = false;
  const cache = createWorkerFileCache({ revision: revisions.revision, observe: tracking.observe,
    load: async (method, args) => { reads++; const uri = String(args[0]); return { value: method === 'directory' ? exists : { text: 'export {}' }, dependencies: [{ uri, revision: revisions.revision(uri) }], stale: false }; },
  });
  assert.equal(await cache.read('directory', [parent]), false);
  const captured = await tracking.capture(() => cache.read('read', [target]));
  assert.equal(captured.value, undefined); assert.deepEqual(captured.dependencies, [{ uri: parent, revision: revisions.revision(parent) }]);
  assert.equal(await cache.read('directory', [parent + '/nested']), false); assert.equal(reads, 1);
  exists = true; revisions.changed(target, root, true);
  assert.deepEqual(await cache.read('read', [target]), { text: 'export {}' }); assert.equal(reads, 2);
  await cache.read('read', [root + '/missing-other/model.ts']); assert.equal(reads, 3);
});
