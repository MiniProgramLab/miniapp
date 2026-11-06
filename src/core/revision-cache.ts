/** 缓存项同时保存修订和占用量，缺失结果也参与失效校验。 */
interface CacheEntry<T> { readonly revision: string; readonly value: T; readonly weight: number }

/** 有界复用文件快照，并按修订合并并发读取。 */
export function createRevisionCache<T>(revision: (uri: string) => string, load: (uri: string) => Promise<T>, weight: (value: T) => number, maxWeight = 8_000_000) {
  const entries = new Map<string, CacheEntry<T>>();
  const pending = new Map<string, { revision: string; promise: Promise<T> }>();
  let total = 0;
  let active = true;
  return {
    /** 每次命中仍观察依赖，读取期间变化的结果不进入缓存。 */
    async read(uri: string): Promise<T> {
      const own = revision(uri);
      const cached = entries.get(uri);
      if (cached?.revision === own) {
        entries.delete(uri); entries.set(uri, cached);
        return cached.value;
      }
      const running = pending.get(uri);
      if (running?.revision === own) return running.promise;
      const promise = Promise.resolve().then(() => load(uri)).then((value) => {
        const size = weight(value);
        if (active && revision(uri) === own && size <= maxWeight) {
          total += size - (entries.get(uri)?.weight ?? 0);
          entries.delete(uri); entries.set(uri, { revision: own, value, weight: size });
          while (entries.size > 4096 || total > maxWeight) {
            const oldest = entries.keys().next().value!;
            total -= entries.get(oldest)!.weight; entries.delete(oldest);
          }
        }
        return value;
      }).finally(() => { if (pending.get(uri)?.promise === promise) pending.delete(uri); });
      pending.set(uri, { revision: own, promise });
      return promise;
    },
    /** 工作区卸载时释放文本；在途读取不得重新填充缓存。 */
    dispose(): void { active = false; entries.clear(); pending.clear(); total = 0; },
  };
}
