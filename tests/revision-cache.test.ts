import assert from 'node:assert/strict';
import test from 'node:test';
import { createRevisionCache } from '../src/core/revision-cache';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';

test('文件快照合并并发读取，修改、新建缺失文件和全局配置变化及时失效', async () => {
  const revisions = createWorkspaceRevisions();
  const files = new Map([['file:///page.ts', '甲']]);
  let reads = 0;
  const cache = createRevisionCache(revisions.revision, async (uri) => { reads++; return files.get(uri); }, (value) => value?.length ?? 0);
  assert.deepEqual(await Promise.all([cache.read('file:///page.ts'), cache.read('file:///page.ts')]), ['甲', '甲']);
  await cache.read('file:///missing.ts'); await cache.read('file:///missing.ts');
  assert.equal(reads, 2, '正文与阴性探测都可跨请求复用');
  files.set('file:///missing.ts', '新建'); revisions.changed('file:///missing.ts', 'file:///', true);
  assert.equal(await cache.read('file:///missing.ts'), '新建');
  files.set('file:///page.ts', '乙'); revisions.changed('file:///page.ts');
  assert.equal(await cache.read('file:///page.ts'), '乙');
  revisions.invalidate(); await cache.read('file:///page.ts');
  assert.equal(reads, 5);
  cache.dispose();
});

test('在途旧读取不会覆盖新修订，并发失败可重试且文本预算限制缓存驻留', async () => {
  let version = 0, reads = 0;
  let release: (value: string) => void = () => {};
  const cache = createRevisionCache(() => String(version), async () => {
    reads++;
    if (reads === 1) return new Promise<string>((resolve) => { release = resolve; });
    if (reads === 3) throw new Error('读取中断');
    return '新';
  }, (value) => value.length, 1);
  const stale = cache.read('file:///page.ts');
  await Promise.resolve(); version++;
  assert.equal(await cache.read('file:///page.ts'), '新');
  release('旧'); await stale;
  assert.equal(await cache.read('file:///page.ts'), '新');
  assert.equal(reads, 2);
  version++; await assert.rejects(cache.read('file:///page.ts'), /中断/);
  assert.equal(await cache.read('file:///page.ts'), '新');
  await cache.read('file:///other.ts'); await cache.read('file:///page.ts');
  assert.equal(reads, 6, '超出总量后旧文件重新读取');
  cache.dispose();
});
