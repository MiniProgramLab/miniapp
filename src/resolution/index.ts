import type { Cancellation, ProjectFileResolver, WorkspaceReader } from '../api';

/** 工厂不加载 TypeScript，首次路径查询才创建原有请求级配置快照。 */
export function createProjectFileResolver(reader: WorkspaceReader, uri: string, cancellation?: Cancellation): ProjectFileResolver {
  /** 配置和文件预算仍按请求隔离，不跨工程缓存解析结果。 */
  let resolver: ProjectFileResolver | undefined;
  return {
    /** 延迟解析后仍将配置依赖返回公共消费者。 */
    get dependencies() { return resolver?.dependencies ?? []; },
    /** 动态加载期间取消的请求不会继续读取工作区。 */
    async candidates(reference, from, kind) {
      if (cancellation?.isCancellationRequested) return [];
      if (!resolver) {
        const module = await import('./project');
        if (cancellation?.isCancellationRequested) return [];
        resolver ??= module.createProjectFileResolver(reader, uri, cancellation);
      }
      return resolver.candidates(reference, from, kind);
    },
  };
}

/** 配置导航同步注册，语法分析在实际跳转时按需加载。 */
export { createFileNavigationPlugin } from './navigation';
/** 页面目录独立于模板语法，通过公共端口复用 URL 语义。 */
export { createRouteResolver, createRoutePlugin } from './routes';
/** 文件操作复用项目路径规则，不执行构建或工程代码。 */
export { createFileOperations } from './file-operations';
export type { FileMove, FileReferences, RelatedFile } from './file-operations';
