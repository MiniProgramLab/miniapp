import type { Cancellation, LanguageFeatures, LanguagePlugin, LanguageRequest, ProjectFileResolver, WorkspaceDependency, WorkspaceReader } from './api';
import { ComputeTransport } from './adapters/worker/transport';
import type { ComputeHost } from './adapters/worker/transport';
import { createComponentScriptResolver, createScriptResolver } from './languages/typescript';
import { createProjectFileResolver, createRouteDocumentResolver } from './resolution';

/** 组合公开语言端口和线程传输，语言模块继续保持编辑器中立。 */
export function createComputeServices(host: ComputeHost) {
  const transport = new ComputeTransport(host);
  const syntax = createRouteDocumentResolver();
  let pathSerial = 0;
  /** 请求对象留在宿主，线程只接收其文本、位置和独立取消位。 */
  const proxy = <T extends object>(source: T, service: string): T => new Proxy(source, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (request: LanguageRequest, ...args: unknown[]) => transport.run(`${service}.${String(key)}`, request, args, (current) => value(current, ...args));
    },
  });
  return {
    transport,
    /** 可见模板提前准备运行时，补全、悬浮与跳转仍使用实际查询快照。 */
    prepare: () => transport.prepare(),
    /** 页面配置的 JSON 语法与脚本共用线程，原生 JSON 编辑仍由编辑器提供。 */
    routeDocuments: {
      accesses: (request: LanguageRequest) => transport.run('document.accesses', request, [], (current) => syntax.accesses(current)),
      manifest: (uri: string, text: string) => transport.run('document.manifest', { document: { uri, text, version: 0, languageId: 'json' }, offset: 0, cancellation: { isCancellationRequested: false } }, [uri, text], () => syntax.manifest(uri, text)),
    },
    /** 脚本补全、悬浮、跳转与诊断共用线程中的语义实例。 */
    scripts: proxy(createScriptResolver(host.reader, (uri) => host.settings(uri).script ?? {}), 'script'),
    /** 组件元数据保持主线程工厂的原有快照校验，语义使用宿主最新文本。 */
    components: (snapshot: WorkspaceReader) => proxy(createComponentScriptResolver(snapshot, (uri) => host.settings(uri).component ?? {}), 'component'),
    /** 构建配置的 TypeScript 解析同样移入线程，路径预算仍按实例隔离。 */
    fileResolver(uri: string, cancellation?: Cancellation): ProjectFileResolver {
      const id = ++pathSerial, dependencies = new Map<string, string>();
      const fallback = createProjectFileResolver(host.reader, uri, cancellation);
      const query = async (reference: string, from: string, kind: import('./api').FileReferenceKind) => {
        if (cancellation?.isCancellationRequested) return { candidates: [], dependencies: [] };
        const request: LanguageRequest = { document: { uri, text: '', version: 0, languageId: 'plaintext' }, offset: 0, cancellation: cancellation ?? { isCancellationRequested: false } };
        try {
          const result = await transport.query<{ candidates: readonly string[] }>('path', request, [id, reference, from, kind]);
          for (const item of result.dependencies) if (!dependencies.has(item.uri)) dependencies.set(item.uri, item.revision);
          return { candidates: result.value?.candidates ?? [], dependencies: result.dependencies };
        } catch (error) {
          transport.report('路径线程查询失败，使用原有解析器重新核对。', error);
          const result = await fallback.resolve!(reference, from, kind);
          for (const item of result.dependencies) if (!dependencies.has(item.uri)) dependencies.set(item.uri, item.revision);
          return result;
        }
      };
      return {
        get dependencies(): readonly WorkspaceDependency[] { return [...dependencies].map(([uri, revision]) => ({ uri, revision })); },
        candidates: async (reference, from, kind) => (await query(reference, from, kind)).candidates,
        resolve: query,
      };
    },
    /** 原生 TS/WXS 提供器仅替换计算位置，重命名等组合端口原样保留。 */
    plugin(plugin: LanguagePlugin, service: string, names: readonly (keyof LanguageFeatures)[]): LanguagePlugin {
      return { ...plugin, setup(context) {
        const features = plugin.setup(context);
        const converted = { ...features } as Record<string, unknown>;
        for (const name of names) {
          const feature = features[name];
          if (feature && 'provide' in feature) converted[name] = { ...feature,
            provide: (request: LanguageRequest, ...args: unknown[]) => transport.run(`${service}.${name}.provide`, request, args, (current) => (feature.provide as (...args: unknown[]) => unknown)(current, ...args)),
          };
        }
        return converted as LanguageFeatures;
      } };
    },
    /** 扩展卸载时统一释放线程。 */
    dispose: () => transport.dispose(),
  };
}
