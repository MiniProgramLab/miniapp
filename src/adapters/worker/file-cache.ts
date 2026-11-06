import type { WorkspaceDependency } from '../../api';
import type { ComputeRead } from '../../compute-protocol';

/** 文件快照保留读取前依赖，目录和阴性结果使用相同的版本校验。 */
export interface WorkerFileSnapshot { value: unknown; dependencies: readonly WorkspaceDependency[]; stale: boolean }
/** 读取能力与修订由线程组合入口注入，不直接访问文件系统。 */
interface FileCacheHost {
  revision(uri: string): string;
  observe(uri: string): string;
  load(method: ComputeRead['method'], args: unknown[]): Promise<WorkerFileSnapshot>;
}

/** 合并重复通信并限制缓存体积，正在变化的快照不会被复用。 */
export function createWorkerFileCache(host: FileCacheHost) {
  const entries = new Map<string, { snapshot: WorkerFileSnapshot; weight: number; directory?: string }>();
  const absent = new Map<string, WorkerFileSnapshot>();
  const pending = new Map<string, Promise<WorkerFileSnapshot>>();
  let weight = 0;
  /** 不同参数和发现范围不能共用读取结果。 */
  const keyFor = (method: string, args: unknown[]): string => JSON.stringify([method, ...args]);
  /** 命中时核对所有依赖，不能用当前修订替换旧快照的版本。 */
  const valid = (snapshot: WorkerFileSnapshot): boolean => !snapshot.stale && snapshot.dependencies.every((item) => host.revision(item.uri) === item.revision);
  /** 已确认不存在的目录，其子路径无需再次跨线程探测。 */
  const missingParent = (uri: string): WorkerFileSnapshot | undefined => {
    if (!absent.size) return undefined;
    const scheme = uri.indexOf('://');
    if (scheme < 0) return undefined;
    const boundary = uri.indexOf('/', scheme + 3);
    if (boundary < 0) return undefined;
    const path = uri.replace(/[?#].*$/, '');
    let end = path.endsWith('/') ? path.length - 1 : path.length;
    for (let depth = 0; depth < 40 && end > boundary; depth++) {
      end = path.lastIndexOf('/', end - 1);
      const cached = absent.get(path.slice(0, end === boundary ? end + 1 : end));
      if (cached && valid(cached)) return cached;
    }
    return undefined;
  };
  /** 文本、路径列表与阴性探测均计入缓存预算。 */
  const sizeOf = (value: unknown): number => {
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text.length + 64;
    if (Array.isArray(value)) return value.reduce((total, item) => total + (typeof item === 'string' ? item.length : 64), 64);
    return 64;
  };
  return {
    /** 并发读取共用在途任务，期间版本变化时重新取得稳定快照。 */
    async read(method: ComputeRead['method'], args: unknown[]): Promise<unknown> {
      const key = keyFor(method, args);
      for (let attempt = 0; attempt < 3; attempt++) {
        const cached = entries.get(key);
        if (cached && valid(cached.snapshot)) {
          entries.delete(key); entries.set(key, cached);
          for (const item of cached.snapshot.dependencies) host.observe(item.uri);
          return cached.snapshot.value;
        }
        const missing = method === 'read' || method === 'directory' ? missingParent(String(args[0])) : undefined;
        if (missing) {
          for (const item of missing.dependencies) host.observe(item.uri);
          return method === 'directory' ? false : undefined;
        }
        let loading = pending.get(key);
        if (!loading) {
          loading = host.load(method, args).finally(() => { if (pending.get(key) === loading) pending.delete(key); });
          pending.set(key, loading);
        }
        const snapshot = await loading;
        if (!valid(snapshot)) continue;
        const size = sizeOf(snapshot.value) + snapshot.dependencies.length * 128;
        if (size <= 8_000_000) {
          weight += size - (entries.get(key)?.weight ?? 0);
          const directory = method === 'directory' ? String(args[0]) : undefined;
          entries.delete(key); entries.set(key, { snapshot, weight: size, ...(directory ? { directory } : {}) });
          if (directory) { if (snapshot.value === false) absent.set(directory, snapshot); else absent.delete(directory); }
          while (entries.size > 4096 || weight > 8_000_000) {
            const oldest = entries.keys().next().value!;
            const entry = entries.get(oldest)!;
            if (entry.directory && absent.get(entry.directory) === entry.snapshot) absent.delete(entry.directory);
            weight -= entry.weight; entries.delete(oldest);
          }
        }
        for (const item of snapshot.dependencies) host.observe(item.uri);
        return snapshot.value;
      }
      throw new Error('线程文件快照持续变化，未复用过期内容。');
    },
  };
}
