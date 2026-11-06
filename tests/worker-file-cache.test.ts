import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerFileCache } from '../src/adapters/worker/file-cache';
import type { WorkspaceDirectoryEntry } from '../src/api';
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

test('完整目录清单合并候选探测，新增文件后刷新阴性结论并保留依赖', async () => {
  const root = 'memfs:///cache/', revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision);
  const calls: string[] = [];
  let listing: WorkspaceDirectoryEntry[] = [{ name: 'model.ts', kind: 'file' }, { name: 'types', kind: 'directory' }];
  const cache = createWorkerFileCache({ entries: true, revision: revisions.revision, observe: tracking.observe,
    load: async (method, args) => {
      const uri = String(args[0]); calls.push(method + ':' + uri);
      return { value: method === 'entries' ? listing : { text: 'export {}' }, dependencies: [{ uri, revision: revisions.revision(uri) }], stale: false };
    },
  });
  const result = await tracking.capture(() => Promise.all([cache.read('directory', [root + 'types']), cache.read('read', [root + 'missing.ts']), cache.read('read', [root + 'missing.js'])]));
  assert.deepEqual(result.value, [true, undefined, undefined]); assert.equal(calls.length, 1);
  assert.ok(result.dependencies.some((item) => item.uri === root.replace(/\/$/, '')));
  assert.deepEqual(await cache.read('read', [root + 'model.ts']), { text: 'export {}' }); assert.equal(calls.length, 2);
  listing = [...listing, { name: 'missing.ts', kind: 'file' }]; revisions.changed(root + 'missing.ts', root, true);
  assert.deepEqual(await cache.read('read', [root + 'missing.ts']), { text: 'export {}' }); assert.equal(calls.length, 4);
});

test('目录清单对大小写、Unicode、未知类型及不可枚举目录保持原读取语义', async () => {
  const root = 'memfs:///cache/', revisions = createWorkspaceRevisions(), direct: string[] = [];
  const cache = createWorkerFileCache({ entries: true, revision: revisions.revision, observe: revisions.revision,
    load: async (method, args) => {
      const uri = String(args[0]);
      if (method !== 'entries') direct.push(method + ':' + uri);
      return { value: method === 'entries' ? uri === root ? [{ name: 'Model.ts', kind: 'file' }, { name: 'cafe\u0301.ts', kind: 'file' }, { name: '\u03c2.ts', kind: 'file' }, { name: 'linked', kind: 'unknown' }, { name: 'restricted', kind: 'directory' }] : undefined : method === 'directory' ? true : { text: uri },
        dependencies: [{ uri, revision: revisions.revision(uri) }], stale: false };
    },
  });
  for (const uri of [root + 'model.ts', root + 'caf%C3%A9.ts', root + '%CE%A3.ts', root + 'restricted/model.ts', root + 'model.ts?virtual=1']) assert.deepEqual(await cache.read('read', [uri]), { text: uri });
  assert.equal(await cache.read('directory', [root + 'linked']), true);
  assert.equal(direct.length, 6);
});

test('同步路径快照复核目录修订，不能把读取失败或非目录误判为缺失文件', async () => {
  const root = 'memfs:///cache/', revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision);
  let listing = [{ name: 'model.ts', kind: 'file' as const }];
  const cache = createWorkerFileCache({ entries: true, revision: revisions.revision, observe: tracking.observe,
    load: async (method, args) => ({ value: method === 'entries' ? listing : undefined, dependencies: [{ uri: String(args[0]), revision: revisions.revision(String(args[0])) }], stale: false }),
  });
  await cache.read('entries', [root]);
  assert.equal(cache.lookup(root + 'model.ts')?.kind, 'file'); assert.equal(cache.lookup(root + 'missing.ts')?.kind, 'missing');
  const captured = await tracking.capture(() => cache.lookup(root + 'missing.ts'));
  assert.ok(captured.dependencies.some((item) => item.uri === root.replace(/\/$/, '')));
  listing = [...listing, { name: 'missing.ts', kind: 'file' }]; revisions.changed(root + 'missing.ts', root, true);
  assert.equal(cache.lookup(root + 'missing.ts'), undefined);
  await cache.read('entries', [root]); assert.equal(cache.lookup(root + 'missing.ts')?.kind, 'file');
  const fallback = createWorkerFileCache({ revision: revisions.revision, observe: revisions.revision,
    load: async (method, args) => ({ value: method === 'directory' ? false : undefined, dependencies: [{ uri: String(args[0]), revision: revisions.revision(String(args[0])) }], stale: false }),
  });
  await fallback.read('directory', [root + 'file']); assert.equal(fallback.lookup(root + 'file'), undefined);
  await fallback.read('read', [root + 'directory']); assert.equal(fallback.lookup(root + 'directory'), undefined);
});
