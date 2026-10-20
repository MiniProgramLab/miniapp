import { AsyncLocalStorage } from 'node:async_hooks';
import type { LanguageResult, WorkspaceDependency } from '../../api';
import { workspaceRevisionKey } from '../../core/workspace-revisions';

/** 异步依赖作用域相互隔离，缓存命中时的修订读取也计入消费关系。 */
export function createDependencyTracking(revision: (uri: string) => string) {
  const scopes = new AsyncLocalStorage<Map<string, string>>();
  return {
    /** 卸载时关闭异步作用域钩子，不保留旧语言请求。 */
    dispose(): void { scopes.disable(); },
    /** 读取和探测保留规范 URI 与当时修订，不能用检查结束时的新版本替代。 */
    observe(uri: string): string {
      const value = revision(uri);
      const dependencies = scopes.getStore();
      const key = workspaceRevisionKey(uri);
      if (dependencies && !dependencies.has(key)) dependencies.set(key, value);
      return value;
    },
    /** 并发请求独立收集，嵌套作用域的依赖仍归入实际调用者。 */
    async capture<T>(provide: () => LanguageResult<T>): Promise<{ value: T; dependencies: readonly WorkspaceDependency[] }> {
      const parent = scopes.getStore();
      const dependencies = new Map<string, string>();
      try {
        const value = await scopes.run(dependencies, provide);
        return { value, dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })) };
      } finally { if (parent) for (const [uri, revision] of dependencies) if (!parent.has(uri)) parent.set(uri, revision); }
    },
  };
}
