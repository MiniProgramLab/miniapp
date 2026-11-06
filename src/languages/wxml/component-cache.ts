import type { Cancellation, ComponentScriptInfo, WorkspaceDependency, WorkspaceReader } from '../../api';

/** 缓存仅保存已核验的普通语义数据，不持有编辑器或编译器对象。 */
export interface ComponentSnapshot {
  readonly info: ComponentScriptInfo | undefined;
  readonly dependencies: readonly WorkspaceDependency[];
}

/** 同一解析器内按项目上下文合并查询，各调用者独立取消。 */
export function createComponentCache(reader: WorkspaceReader) {
  const completed = new Map<string, ComponentSnapshot & { weight: number }>();
  const pending = new Map<string, { callers: Set<Cancellation>; promise: Promise<ComponentSnapshot> }>();
  let weight = 0;
  return {
    /** 完整且修订未变的结果可跨交互复用，受限结果只在并发批次共享。 */
    async provide(key: string, cancellation: Cancellation, build: (cancellation: Cancellation) => Promise<ComponentSnapshot>): Promise<ComponentScriptInfo | undefined> {
      if (cancellation.isCancellationRequested) return undefined;
      const revision = reader.revision;
      const valid = (snapshot: ComponentSnapshot): boolean => !revision || snapshot.dependencies.every((item) => revision(item.uri) === item.revision);
      const cached = completed.get(key);
      if (cached && valid(cached)) { completed.delete(key); completed.set(key, cached); return cached.info; }
      if (cached) { completed.delete(key); weight -= cached.weight; }
      let running = pending.get(key);
      if (!running || [...running.callers].every((caller) => caller.isCancellationRequested)) {
        const callers = new Set<Cancellation>();
        const shared = { get isCancellationRequested() { return [...callers].every((caller) => caller.isCancellationRequested); } };
        const promise = Promise.resolve().then(async () => {
          const snapshot = await build(shared);
          if (revision && !shared.isCancellationRequested && snapshot.info?.complete === true && valid(snapshot)) {
            let size: number;
            try { size = key.length + JSON.stringify(snapshot).length; } catch { return snapshot; }
            if (size <= 2_000_000) {
              weight += size - (completed.get(key)?.weight ?? 0);
              completed.delete(key); completed.set(key, { ...snapshot, weight: size });
              while (completed.size > 32 || weight > 2_000_000) {
                const oldest = completed.keys().next().value!;
                weight -= completed.get(oldest)!.weight; completed.delete(oldest);
              }
            }
          }
          return snapshot;
        }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
        running = { callers, promise }; pending.set(key, running);
      }
      running.callers.add(cancellation);
      try {
        const snapshot = await running.promise;
        return cancellation.isCancellationRequested || !valid(snapshot) ? undefined : snapshot.info;
      } finally { running.callers.delete(cancellation); }
    },
  };
}
