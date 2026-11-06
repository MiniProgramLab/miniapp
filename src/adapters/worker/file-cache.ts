import type { WorkspaceDependency, WorkspaceDirectoryEntry, WorkspacePathSnapshot } from '../../api';
import type { ComputeRead } from '../../compute-protocol';

/** 文件快照保留读取前依赖，目录和阴性结果使用相同的版本校验。 */
export interface WorkerFileSnapshot { value: unknown; dependencies: readonly WorkspaceDependency[]; stale: boolean }
/** 读取能力与修订由线程组合入口注入，不直接访问文件系统。 */
interface FileCacheHost {
  readonly entries?: boolean | ((uri: string) => boolean);
  revision(uri: string): string;
  observe(uri: string): string;
  load(method: ComputeRead['method'], args: unknown[]): Promise<WorkerFileSnapshot>;
}

/** 合并重复通信并限制缓存体积，正在变化的快照不会被复用。 */
export function createWorkerFileCache(host: FileCacheHost) {
  const entries = new Map<string, { snapshot: WorkerFileSnapshot; weight: number; directory?: string }>();
  const absent = new Map<string, WorkerFileSnapshot>();
  const pending = new Map<string, Promise<WorkerFileSnapshot>>();
  const catalogs = new WeakMap<readonly WorkspaceDirectoryEntry[], { names: ReadonlyMap<string, WorkspaceDirectoryEntry>; folded: ReadonlySet<string>; unicode: boolean }>();
  const paths = new Map<string, { parent: string; name: string } | undefined>();
  let weight = 0;
  /** 不同参数和发现范围不能共用读取结果。 */
  const keyFor = (method: string, args: unknown[]): string => JSON.stringify([method, ...args]);
  /** 命中时核对所有依赖，不能用当前修订替换旧快照的版本。 */
  const valid = (snapshot: WorkerFileSnapshot): boolean => !snapshot.stale && snapshot.dependencies.every((item) => host.revision(item.uri) === item.revision);
  /** 目录清单只在宿主允许的范围内获取，外部依赖沿用逐路径读取。 */
  const canList = (uri: string): boolean => typeof host.entries === 'function' ? host.entries(uri) : host.entries === true;
  /** 只拆分普通路径，查询参数和编码分隔符继续由宿主解释。 */
  const parentEntry = (value: string): { parent: string; name: string } | undefined => {
    if (paths.has(value)) return paths.get(value);
    let result: { parent: string; name: string } | undefined;
    try {
      const uri = new URL(value);
      if (!uri.search && !uri.hash && uri.pathname && uri.pathname !== '/') {
        uri.pathname = uri.pathname.replace(/\/$/, '');
        const name = decodeURIComponent(uri.pathname.slice(uri.pathname.lastIndexOf('/') + 1));
        if (name && !/[\\/]/.test(name)) result = { parent: new URL('./', uri).href, name };
      }
    } catch { /* 非标准 URI 保留宿主解释。 */ }
    paths.set(value, result);
    if (paths.size > 8192) paths.delete(paths.keys().next().value!);
    return result;
  };
  /** 名称索引只随清单存活，避免反复扫描目录数组。 */
  const catalogFor = (listing: readonly WorkspaceDirectoryEntry[]) => {
    let catalog = catalogs.get(listing);
    if (!catalog) {
      catalog = { names: new Map(listing.map((item) => [item.name, item])), folded: new Set(listing.map((item) => item.name.toLowerCase())), unicode: listing.some((item) => /[^\x00-\x7f]/.test(item.name)) };
      catalogs.set(listing, catalog);
    }
    return catalog;
  };
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
    if (Array.isArray(value)) return value.reduce((total, item) => total + (typeof item === 'string' ? item.length : typeof item?.name === 'string' ? item.name.length + 64 : 64), 64);
    return 64;
  };
  /** 清单推导与实际读取使用相同的体积、依赖及淘汰规则。 */
  const save = (method: ComputeRead['method'], args: unknown[], snapshot: WorkerFileSnapshot): void => {
    const key = keyFor(method, args), size = sizeOf(snapshot.value) + snapshot.dependencies.length * 128;
    if (size > 8_000_000) return;
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
  };
  /** 官方解析器同步核对已有清单，已知阴性候选无需增加异步重试轮次。 */
  function lookup(uri: string): WorkspacePathSnapshot | undefined {
    let snapshot: WorkerFileSnapshot | undefined, kind: WorkspacePathSnapshot['kind'] | undefined;
    const document = entries.get(keyFor('read', [uri]));
    const directory = entries.get(keyFor('directory', [uri]));
    if (document && valid(document.snapshot) && document.snapshot.value !== undefined) { snapshot = document.snapshot; kind = 'file'; }
    else if (directory && valid(directory.snapshot) && directory.snapshot.value === true) { snapshot = directory.snapshot; kind = 'directory'; }
    else {
      snapshot = missingParent(uri);
      if (snapshot) kind = 'missing';
      else {
        const path = parentEntry(uri), child = path && canList(path.parent) ? path : undefined;
        const source = child && entries.get(keyFor('entries', [child.parent]));
        if (child && source && valid(source.snapshot) && Array.isArray(source.snapshot.value)) {
          const catalog = catalogFor(source.snapshot.value), item = catalog.names.get(child.name);
          if (item?.kind === 'file' || item?.kind === 'directory') { snapshot = source.snapshot; kind = item.kind; }
          else if (!item && !catalog.unicode && !/[^\x00-\x7f]/.test(child.name) && !catalog.folded.has(child.name.toLowerCase())) { snapshot = source.snapshot; kind = 'missing'; }
        }
      }
    }
    if (!snapshot || !kind) return undefined;
    for (const item of snapshot.dependencies) host.observe(item.uri);
    return { kind, dependencies: snapshot.dependencies };
  }
  /** 并发读取共用在途任务，期间版本变化时重新取得稳定快照。 */
  async function read(method: ComputeRead['method'], args: unknown[]): Promise<unknown> {
    const key = keyFor(method, args);
    for (let attempt = 0; attempt < 3; attempt++) {
      const cached = entries.get(key);
      if (cached && valid(cached.snapshot)) {
        entries.delete(key); entries.set(key, cached);
        for (const item of cached.snapshot.dependencies) host.observe(item.uri);
        return cached.snapshot.value;
      }
      const missing = method === 'read' || method === 'directory' || method === 'entries' ? missingParent(String(args[0])) : undefined;
      if (missing) {
        for (const item of missing.dependencies) host.observe(item.uri);
        return method === 'directory' ? false : undefined;
      }
      // 完整清单一次确认同目录的候选，未知类型仍交给原路径探测。
      const path = method !== 'findFiles' ? parentEntry(String(args[0])) : undefined;
      const child = path && canList(path.parent) ? path : undefined;
      if (child) {
        const parent = entries.get(keyFor('entries', [child.parent]));
        const listing = (method === 'entries' ? parent && valid(parent.snapshot) ? parent.snapshot.value : undefined : await read('entries', [child.parent])) as readonly WorkspaceDirectoryEntry[] | undefined;
        if (listing) {
          const catalog = catalogFor(listing);
          const item = catalog.names.get(child.name);
          // 大小写相近或涉及 Unicode 名称时交回宿主，避免猜测文件系统的折叠规则。
          const absentChild = !item && !catalog.unicode && !/[^\x00-\x7f]/.test(child.name) && !catalog.folded.has(child.name.toLowerCase());
          const knownDirectory = method === 'directory' && item && item.kind !== 'unknown';
          const fileListing = method === 'entries' && item?.kind === 'file';
          if (absentChild || knownDirectory || fileListing) {
            const value = method === 'directory' ? item?.kind === 'directory' : undefined;
            const source = entries.get(keyFor('entries', [child.parent]));
            if (source?.snapshot.value === listing && valid(source.snapshot)) {
              // 清单结论只依赖目录修订，文件内容仍由实际读取单独追踪。
              const snapshot = { ...source.snapshot, value };
              save(method, args, snapshot);
              if (method === 'entries') save('directory', [String(args[0]).replace(/\/$/, '')], { ...snapshot, value: false });
            }
            return value;
          }
        }
        const missing = method === 'entries' ? undefined : missingParent(String(args[0]));
        if (missing) {
          for (const item of missing.dependencies) host.observe(item.uri);
          return method === 'directory' ? false : undefined;
        }
      }
      let loading = pending.get(key);
      if (!loading) {
        loading = host.load(method, args).finally(() => { if (pending.get(key) === loading) pending.delete(key); });
        pending.set(key, loading);
      }
      const snapshot = await loading;
      if (!valid(snapshot)) continue;
      save(method, args, snapshot);
      for (const item of snapshot.dependencies) host.observe(item.uri);
      return snapshot.value;
    }
    throw new Error('线程文件快照持续变化，未复用过期内容。');
  }
  return { read, lookup };
}
