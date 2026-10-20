import type { ComponentResolver, ComponentScriptResolver, ComponentUsages, Definition, LanguageRequest, RouteContextResolver, ScriptDefinitionResolver, WorkspaceDependency, WorkspaceReader, WorkspaceText } from '../../api';

/** 同一组件方法的消费关系保留已验证依赖，结果与输入总量有界。 */
interface ContextCache {
  readonly key: string;
  readonly input: string;
  readonly result: Awaited<ReturnType<RouteContextResolver['resolve']>>;
  readonly weight: number;
}

/** 去除源码或模板扩展名，组件入口仍保留完整 URI 主机与目录。 */
function stem(uri: string): string { return uri.replace(/\.(?:[cm]?[jt]sx?|wxml)$/i, ''); }

/** 实际注册原文决定组件运行路径，npm 包未映射时不猜测输出目录。 */
function runtimePath(reference: string, from: string, target: string, parent: string): string | undefined {
  if (reference.includes('{{') || /^[a-z][\w+.-]*:|^\/\//i.test(reference)) return undefined;
  const base = /\/app(?:\.config\.[cm]?[jt]s|\.jsonc?)$/i.test(from) ? '' : parent;
  if (!reference.startsWith('.') && !reference.startsWith('/') && stem(new URL(reference, from).href) !== stem(target)) return undefined;
  const directory = reference.startsWith('/') ? '/' : '/' + base;
  const pathname = decodeURIComponent(new URL(reference, 'https://miniapp.invalid/' + directory.replace(/^\//, '')).pathname).slice(1);
  return pathname.replace(/\.(?:[cm]?[jt]sx?|wxml)$/i, '');
}

/** 相对路由沿实际节点反查页面，使用通用注册解析和函数身份确认组件来源。 */
export function createRouteContextResolver(reader: WorkspaceReader, components: (reader: WorkspaceReader) => ComponentResolver, inspector: (reader: WorkspaceReader) => ComponentScriptResolver, scripts: ScriptDefinitionResolver, options: (uri: string) => { maxFiles?: number } = () => ({})): RouteContextResolver {
  const cache: ContextCache[] = [];
  return {
    /** 多个消费页面保留全部基准，预算不足或动态模板不能作为完整缺失诊断依据。 */
    async resolve(request, access, application) {
      const empty = { bases: [], complete: false, dependencies: [] };
      if (!access.owner || request.cancellation.isCancellationRequested) return empty;
      const maximum = Math.max(1, Math.min(2000, options(request.document.uri).maxFiles ?? 500));
      const key = JSON.stringify([application, access.owner, access.relativeTo, maximum]);
      const input = request.document.uri + ':' + request.document.text;
      const previous = reader.revision && cache.find((item) => item.key === key && item.input === input && item.result.dependencies.every((dependency) => reader.revision!(dependency.uri) === dependency.revision));
      if (previous) return previous.result;
      const dependencies = new Map<string, string>();
      const root = reader.root(request.document.uri);
      if (root && reader.revision) dependencies.set(root, reader.revision(root));
      const documents = new Map<string, Promise<WorkspaceText | undefined>>();
      let bytes = 0, complete = application.pages.length <= maximum, exhausted = false;
      /** 读取前记录修订，源脚本草稿不被磁盘内容覆盖；缺失文件也参与失效判断。 */
      async function read(uri: string): Promise<WorkspaceText | undefined> {
        if (request.cancellation.isCancellationRequested) return undefined;
        if (!documents.has(uri)) {
          if (documents.size >= maximum * 24 + 128) { exhausted = true; return undefined; }
          if (reader.revision) dependencies.set(uri, reader.revision(uri));
          documents.set(uri, (uri === request.document.uri ? Promise.resolve(request.document) : reader.read(uri)).then((snapshot) => {
            if (snapshot && (snapshot.text.length > 2_000_000 || bytes + snapshot.text.length > 16_000_000)) { exhausted = true; return undefined; }
            bytes += snapshot?.text.length ?? 0;
            return request.cancellation.isCancellationRequested ? undefined : snapshot;
          }));
        }
        return documents.get(uri);
      }
      const files = reader.fileResolver?.(request.document.uri, request.cancellation);
      const snapshot: WorkspaceReader = { ...reader, read, ...(files ? { fileResolver: () => files } : {}) };
      const registrations = components(snapshot);
      const metadata = inspector(snapshot);
      const usages = new Map<string, Promise<ComponentUsages | undefined>>();
      const owners = new Map<string, Promise<boolean>>();
      const bases = new Map<string, { path: string; uri: string }>();
      let shared: Promise<ReadonlySet<string>> | undefined;
      /** 依赖冲突表示读取过程中发生变化，不允许进入连续查询缓存。 */
      function retain(items: readonly WorkspaceDependency[]): void {
        for (const item of items) {
          const old = dependencies.get(item.uri);
          if (old !== undefined && old !== item.revision) complete = false;
          dependencies.set(item.uri, item.revision);
        }
      }
      /** 只有可能消费该函数的组件才加载公开实例元数据。 */
      async function owns(uri: string): Promise<boolean> {
        let pending = owners.get(uri);
        if (!pending) {
          pending = (async () => {
            const direct = stem(uri) === stem(access.owner!.uri);
            if (!direct) {
              shared ??= (async () => {
                const discovered = await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,wxs,wxml}', 10001) ?? [];
                if (discovered.length > 10000) { complete = false; return new Set<string>(); }
                if (reader.revision) for (const uri of discovered) dependencies.set(uri, reader.revision(uri));
                try { return new Set(await scripts.instanceTemplates?.(request, { owner: access.owner!, selectors: [], path: [], range: access.range, intent: 'selector', shared: true }) ?? []); }
                catch (error) {
                  if (!(error instanceof Error) || !/扫描上限|解析预算/.test(error.message)) throw error;
                  complete = false; return new Set<string>();
                }
              })();
              if (!(await shared).has(stem(uri) + '.wxml')) return false;
            }
            const info = await metadata.inspect(request, uri, true);
            retain(info?.dependencies ?? []);
            complete &&= !!info && info.complete !== false;
            return info?.instanceOwners?.some((owner: Omit<Definition, 'originRange'>) => owner.uri === access.owner!.uri && owner.range.start === access.owner!.range.start && owner.range.end === access.owner!.range.end) ?? false;
          })();
          owners.set(uri, pending);
        }
        return pending;
      }
      /** 相同模板的节点和注册只解析一次，消费者页面与运行路径分别保留。 */
      async function children(uri: string): Promise<ComponentUsages | undefined> {
        let pending = usages.get(uri);
        if (!pending) {
          if (usages.size >= maximum) { exhausted = true; return undefined; }
          pending = (async () => {
            const content = await read(uri);
            if (!content) { complete = false; return undefined; }
            const context: LanguageRequest = { document: { uri, text: content.text, version: content.version ?? 0, languageId: 'wxml' }, offset: 0, cancellation: request.cancellation };
            const result = await registrations.usages?.(context);
            retain(result?.dependencies ?? []);
            complete &&= !!result && result.complete;
            return result;
          })();
          usages.set(uri, pending);
        }
        return pending;
      }
      for (const page of application.pages.slice(0, maximum)) {
        if (request.cancellation.isCancellationRequested || exhausted) break;
        const locations = [...new Set([...(await files?.candidates('/' + page.path, request.document.uri, 'component') ?? []), new URL(page.path, application.root).href])];
        let template: string | undefined;
        for (const base of locations) if (await read(stem(base) + '.wxml')) { template = stem(base) + '.wxml'; break; }
        if (!template) { complete = false; continue; }
        const queue: { template: string; runtime?: string; script?: string }[] = [{ template, runtime: page.path }];
        const visited = new Set<string>();
        for (let index = 0; index < queue.length && !exhausted; index++) {
          const current = queue[index]!;
          const identity = current.template + ':' + (current.runtime ?? '');
          if (visited.has(identity)) continue;
          if (visited.size >= maximum) { exhausted = true; break; }
          visited.add(identity);
          if (current.script) {
            if (await owns(current.script)) {
              if (access.relativeTo === 'component') {
                if (current.runtime === undefined) complete = false;
                else bases.set(current.runtime + ':' + current.script, { path: current.runtime, uri: current.script });
              } else bases.set(page.path, { path: page.path, uri: template });
            }
          }
          for (const target of (await children(current.template))?.targets ?? []) {
            const runtime = current.runtime === undefined ? undefined : runtimePath(target.reference, target.from, target.uri, current.runtime);
            queue.push({ template: stem(target.uri) + '.wxml', ...target.uri.endsWith('.wxml') ? {} : { script: target.uri }, ...(runtime === undefined ? {} : { runtime }) });
          }
        }
      }
      retain(files?.dependencies ?? []);
      if (request.cancellation.isCancellationRequested) return empty;
      const result = { bases: [...bases.values()], complete: complete && !exhausted, dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })) };
      if (reader.revision && result.complete && result.dependencies.every((item) => reader.revision!(item.uri) === item.revision)) {
        const weight = input.length + JSON.stringify(result).length + bytes;
        cache.push({ key, input, result, weight });
        while (cache.length > 8 || cache.reduce((total, item) => total + item.weight, 0) > 8_000_000) cache.shift();
      }
      return result;
    },
  };
}
