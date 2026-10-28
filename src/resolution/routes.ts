import { posix as path } from 'node:path';
import type { Completion, Definition, LanguageFeatures, LanguagePlugin, LanguageRequest, RouteContextResolver, RouteManifest, RouteResolver, RouteResult, ScriptDefinitionResolver, WorkspaceReader, WorkspaceText } from '../api';

/** 路由目录记录应用根与实际读取依赖，跨工作区不共享内容。 */
interface Catalog {
  readonly uri: string;
  readonly root: string;
  readonly manifest: RouteManifest;
  /** 构建配置只补充注册依据，不参与源码注册编辑。 */
  readonly generated?: readonly string[];
}

/** 缓存只保留有界、已校验的结果和修订，不能保留过期取消令牌。 */
interface Cached {
  readonly key: string;
  readonly catalog: Catalog;
  readonly dependencies: ReadonlyMap<string, string>;
  readonly weight: number;
}

/** 宿主修订函数同时隔离不同读取器与工作区。 */
const caches = new WeakMap<NonNullable<WorkspaceReader['revision']>, Cached[]>();

/** 连续查询缓存保留完整依赖，限制结果与输入快照总量。 */
const resultCaches = new WeakMap<NonNullable<WorkspaceReader['revision']>, { key: string; result: RouteResult; dependencies: ReadonlyMap<string, string>; weight: number }[]>();

/** 页面文件扩展名保持源码优先，声明文件不作为运行页面。 */
const extensions = ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.wxml'];

/** 已有路径规则负责别名与构建映射，路由目录只解释页面注册。 */
export function createRouteResolver(reader: WorkspaceReader, scripts: ScriptDefinitionResolver, contexts?: RouteContextResolver): RouteResolver {
  /** 请求内合并配置探测和源码读取，重复路由不重复建立目录。 */
  const models = new WeakMap<LanguageRequest, Promise<{ catalog?: Catalog; read: (uri: string) => Promise<WorkspaceText | undefined>; valid: () => boolean; exhausted: () => boolean; dependencies: Map<string, string>; files?: ReturnType<NonNullable<WorkspaceReader['fileResolver']>> }>>();
  /** 配置与负向探测均参与修订验证，未保存配置由请求快照覆盖。 */
  async function model(request: LanguageRequest) {
    const documents = new Map<string, Promise<WorkspaceText | undefined>>();
    const dependencies = new Map<string, string>();
    const revision = reader.revision;
    const workspace = reader.root(request.document.uri) ?? new URL('./', request.document.uri).href;
    const input = /\/app(?:\.config\.[cm]?[jt]s|\.jsonc?)$/i.test(request.document.uri) ? request.document.text : '';
    const key = JSON.stringify([new URL('./', request.document.uri).href, workspace, input]);
    const cached = revision && caches.get(revision)?.find((item) => item.key === key && [...item.dependencies].every(([uri, value]) => revision(uri) === value));
    if (revision) dependencies.set(workspace, revision(workspace));
    /** 同一请求对象也可能被外部宿主重复调用，依赖变化后必须重建目录。 */
    const valid = () => !!revision && [...dependencies].every(([uri, value]) => revision(uri) === value);
    let exhausted = false, characters = 0;
    /** 超出预算或取消后不读取文件，不缓存不完整结果。 */
    async function read(uri: string): Promise<WorkspaceText | undefined> {
      if (request.cancellation.isCancellationRequested) return undefined;
      if (!documents.has(uri)) {
        if (documents.size >= 200) { exhausted = true; reader.navigation?.record({ code: 'budget', message: '页面路由配置与源码探测达到二百份文件上限，候选可能不完整。', uri }); return undefined; }
        if (revision) dependencies.set(uri, revision(uri));
        documents.set(uri, (uri === request.document.uri ? Promise.resolve({ text: request.document.text, version: request.document.version }) : reader.read(uri)).then((document) => {
          if (document && (document.text.length > 1_000_000 || characters + document.text.length > 4_000_000)) { exhausted = true; reader.navigation?.record({ code: 'budget', message: '页面路由文本超过单文件或总量上限，后续来源未读取。', uri }); return undefined; }
          characters += document?.text.length ?? 0;
          return request.cancellation.isCancellationRequested ? undefined : document;
        }));
      }
      return documents.get(uri);
    }
    const files = reader.fileResolver?.(request.document.uri, request.cancellation);
    if (cached) { for (const [uri, value] of cached.dependencies) dependencies.set(uri, value); return { catalog: cached.catalog, read, valid, exhausted: () => exhausted, dependencies, ...(files ? { files } : {}) }; }
    const candidates: string[] = [];
    let directory = new URL('./', request.document.uri).href;
    const boundary = workspace.replace(/\/?$/, '/');
    for (let depth = 0; depth < 32 && (directory === boundary || directory.startsWith(boundary)); depth++) {
      for (const name of ['app.json', 'app.config.ts', 'app.config.js', 'app.jsonc']) candidates.push(new URL(name, directory).href);
      if (directory === boundary) break;
      const parent = new URL('../', directory).href;
      if (parent === directory) break;
      directory = parent;
    }
    let catalog: Catalog | undefined;
    /** 最近应用入口优先，配置没有完整目录时不借用其他工程的页面。 */
    async function inspect(uri: string): Promise<boolean> {
      const document = await read(uri);
      if (!document) return false;
      const manifest = /\.jsonc?$/i.test(uri) ? (await import('./routes-document')).jsonRoutes(uri, document.text) : await scripts.routeManifest?.(request, uri);
      if (!manifest) { reader.navigation?.record({ code: 'config', message: '应用入口未解析出页面目录，请检查配置语法、静态声明及框架适配。', uri }); return true; }
      reader.navigation?.record({ code: 'config', message: `应用配置包含 ${manifest.pages.length} 个静态页面；${manifest.complete ? '页面目录已完整解析' : '仍有动态或未确定的页面声明'}。`, uri });
      for (const dependency of manifest.dependencies) dependencies.set(dependency.uri, dependency.revision);
      catalog = { uri, root: new URL('./', uri).href, manifest };
      return true;
    }
    for (const uri of candidates) if (await inspect(uri)) break;
    if (!catalog && files) for (const uri of await files.candidates('/app.json', request.document.uri, 'component')) if (await inspect(uri)) break;
    if (catalog && files) {
      const source = catalog;
      const pages = new Map(source.manifest.pages.map((page) => [page.path, page]));
      const tabs = new Set(source.manifest.tabs);
      const generated: string[] = [];
      let tabComplete = source.manifest.tabComplete;
      let enclosing = false;
      // 嵌套应用没有独立工程边界时，不借用外层工程的构建产物。
      for (let directory = source.root, depth = 0; depth < 32 && directory.startsWith(boundary); depth++) {
        if (directory !== source.root) for (const name of ['app.json', 'app.config.ts', 'app.config.js', 'app.jsonc']) if (await read(new URL(name, directory).href)) { enclosing = true; break; }
        if (enclosing || await read(new URL('package.json', directory).href) || directory === boundary) break;
        const parent = new URL('../', directory).href;
        if (parent === directory) break;
        directory = parent;
      }
      // 只接纳能映射回当前应用的产物，避免混入相邻应用或任意 app.json。
      const application = new URL('app.json', source.root).href;
      for (const uri of enclosing ? [] : await files.candidates('/app.json', request.document.uri, 'component')) {
        if (uri === application || !(await files.candidates(uri, request.document.uri, 'file')).includes(application)) continue;
        const document = await read(uri);
        if (!document) continue;
        const manifest = (await import('./routes-document')).jsonRoutes(uri, document.text);
        if (!manifest.complete) continue;
        let added = 0;
        for (const page of manifest.pages) if (!pages.has(page.path)) {
          pages.set(page.path, page);
          if (manifest.tabs.includes(page.path)) tabs.add(page.path);
          added++;
        }
        if (!added) continue;
        generated.push(uri);
        tabComplete &&= manifest.tabComplete;
        reader.navigation?.record({ code: 'config', message: `构建产物为当前应用补充 ${added} 个页面注册，导航仍优先使用源码。`, uri });
      }
      if (generated.length) catalog = { ...source, generated, manifest: { ...source.manifest, pages: [...pages.values()], tabs: [...tabs], tabComplete } };
    }
    for (const item of files?.dependencies ?? []) dependencies.set(item.uri, item.revision);
    if (catalog && revision && !exhausted && catalog.manifest.complete && !request.cancellation.isCancellationRequested && [...dependencies].every(([uri, value]) => revision(uri) === value)) {
      const rows = caches.get(revision) ?? [];
      const weight = characters + catalog.manifest.pages.length * 256;
      const next = [...rows.filter((item) => item.key !== key), { key, catalog, dependencies, weight }];
      let total = next.reduce((size, item) => size + item.weight, 0);
      while (next.length > 8 || total > 4_000_000) total -= next.shift()!.weight;
      caches.set(revision, next);
    }
    return { ...(catalog ? { catalog } : {}), read, valid, exhausted: () => exhausted, dependencies, ...(files ? { files } : {}) };
  }
  /** 一次诊断或查询复用同一份目录；取消不会污染下一次请求。 */
  async function get(request: LanguageRequest) {
    let pending = models.get(request);
    if (pending && !(await pending).valid()) pending = undefined;
    if (!pending) { pending = model(request); models.set(request, pending); }
    return pending;
  }
  return {
    catalog: async (request) => (await get(request)).catalog,
    /** 静态 URL 关联注册、分包、导航规则及原始页面文件。 */
    async query(request, access): Promise<RouteResult> {
      const empty: RouteResult = { definitions: [], completions: [], diagnostics: [] };
      if (request.cancellation.isCancellationRequested) return empty;
      if (!access.urls.length) { reader.navigation?.record({ code: 'dynamic', message: '路由 URL 没有可确定的静态字符串，无法据此定位页面。', uri: request.document.uri }); return empty; }
      const revision = reader.revision;
      const cacheKey = JSON.stringify([request.document.uri, request.document.text, request.offset, access]);
      const cached = revision && resultCaches.get(revision)?.find((item) => item.key === cacheKey && [...item.dependencies].every(([uri, value]) => revision(uri) === value));
      if (cached) { reader.navigation?.record({ code: 'cached', message: '复用已核验依赖的路由结果，静态来源与候选保持一致。', uri: request.document.uri }); return cached.result; }
      const state = await get(request);
      const catalog = state.catalog;
      if (request.cancellation.isCancellationRequested) return empty;
      if (!catalog) { reader.navigation?.record({ code: 'missing', message: '没有找到可解析的所属应用页面目录，请检查 app.json / app.config 与源码根。', uri: request.document.uri }); return empty; }
      const { manifest } = catalog;
      const contextUri = access.base === 'component' ? access.baseUri ?? request.document.uri : request.document.uri;
      const currentPath = contextUri.startsWith(catalog.root) ? decodeURIComponent(contextUri.slice(catalog.root.length)).replace(/\.(?:[cm]?[jt]sx?|wxml)$/i, '') : undefined;
      const current = access.base !== 'unknown' && currentPath && (access.base === 'component' || manifest.pages.some((page) => page.path === currentPath)) ? currentPath : undefined;
      let bases: readonly { path: string; uri: string }[] = current ? [{ path: current, uri: contextUri }] : [];
      let contextComplete = true;
      const relative = access.urls.some((url) => !url.text.startsWith('/') && !/^[a-z][\w+.-]*:/i.test(url.text));
      if (relative && contexts && access.owner && (access.base === 'component' || !current)) {
        const consumers = await contexts.resolve(request, access, { root: catalog.root, pages: manifest.pages });
        bases = consumers.bases;
        contextComplete = consumers.complete;
        for (const item of consumers.dependencies) state.dependencies.set(item.uri, item.revision);
      }
      if (relative && !bases.length) reader.navigation?.record({ code: 'context', message: '相对路由没有确定的消费页面基准，共享组件或工具函数不能按所在目录猜测运行页面。', uri: request.document.uri });
      /** 相对 wx URL 只有所属页面明确时才解析，共享工具中的运行页面不能靠目录猜测。 */
      const normalize = (url: string, base?: string): string | undefined => {
        const pathname = url.split(/[?#]/, 1)[0]!;
        if (!pathname || /^[a-z][\w+.-]*:|^\/\//i.test(pathname) || pathname.includes('{动态}')) return undefined;
        if (!pathname.startsWith('/') && base === undefined) return undefined;
        const target = path.normalize(pathname.startsWith('/') ? pathname.slice(1) : path.join(path.dirname(base!), pathname));
        return target.startsWith('../') || target === '..' ? undefined : target;
      };
      const urls = [...new Map(access.urls.map((url) => [url.text, url])).values()];
      const targets = urls.flatMap((url) => url.text.startsWith('/') ? [{ url, path: normalize(url.text), from: '' }] : bases.map((base) => ({ url, path: normalize(url.text, base.path), from: base.path })));
      const definitions: Definition[] = [];
      const links: NonNullable<RouteResult['targets']>[number][] = [];
      const diagnostics: RouteResult['diagnostics'][number][] = [];
      const descriptions: string[] = [];
      const selected = request.offset >= access.range.start && request.offset <= access.range.end;
      const content = request.document.text.slice(access.range.start, access.range.end);
      const cursor = Math.max(0, Math.min(content.length, request.offset - access.range.start));
      const pathEnd = content.search(/[?#]/);
      const queryEditing = access.editable && selected && pathEnd >= 0 && cursor > pathEnd && content[pathEnd] === '?';
      const completions: Completion[] = [];
      let query: import('../api').SemanticType | undefined;
      let queryFields: NonNullable<import('../api').PageQuery['fields']> = [];
      const queries: import('../api').PageQuery[] = [];
      let queryComplete = true;
      /** 产物补充的注册不可编辑，重构时保留不完整标记。 */
      let generatedTarget = false;
      /** 只有完整源码目录才能确认页面缺失。 */
      const missing = (target: typeof targets[number]): void => {
        if (contextComplete && manifest.complete && !state.exhausted() && (target.url.complete || !target.url.text.split(/[?#]/, 1)[0]!.includes('{动态}'))) diagnostics.push({ range: access.range, severity: 'warning', code: 'unregistered-route', message: `${bases.length > 1 && target.from ? `从 /${target.from} 导航时，` : ''}页面 /${target.path} 未在应用配置中注册。` });
      };
      for (const target of targets) {
        if (!target.path) continue;
        const page = manifest.pages.find((page) => page.path === target.path);
        if (!page) { missing(target); continue; }
        const generated = catalog.generated?.includes(page.definition.uri);
        let original: string | undefined;
        const sources = [...new Set([...(await state.files?.candidates('/' + page.path, request.document.uri, 'component') ?? []), new URL(page.path, catalog.root).href])].filter((uri) => !generated || !uri.startsWith(new URL('./', page.definition.uri).href));
        for (const item of state.files?.dependencies ?? []) state.dependencies.set(item.uri, item.revision);
        for (const base of sources) {
          for (const uri of extensions.map((extension) => base + extension)) {
            if (request.cancellation.isCancellationRequested) return empty;
            const document = await state.read(uri);
            if (document) {
              original = uri;
              definitions.push({ uri, range: { start: 0, end: 0 }, originRange: access.range, ...(document.version === undefined ? {} : { version: document.version }) });
              break;
            }
          }
          if (original) break;
        }
        // 已删除源码不能被残留产物中的注册和脚本掩盖。
        if (generated && !original) { missing(target); continue; }
        generatedTarget ||= !!generated;
        const tab = manifest.tabs.includes(page.path);
        if (manifest.tabComplete && (access.method === 'switchTab' ? !tab : ['navigateTo', 'redirectTo'].includes(access.method) && tab)) diagnostics.push({ range: access.range, severity: 'warning', code: 'route-navigation-method', message: tab ? `TabBar 页面 /${page.path} 应使用 switchTab 或 reLaunch。` : `switchTab 只能打开 TabBar 页面，/${page.path} 不是 TabBar 页面。` });
        if (access.method === 'switchTab' && target.url.text.includes('?')) diagnostics.push({ range: access.range, severity: 'warning', code: 'route-tab-query', message: 'switchTab 的页面 URL 不能携带查询参数。' });
        if (!original) definitions.push({ ...page.definition, originRange: access.range });
        else {
          const from = bases.find((base) => base.path === target.from);
          links.push({ uri: original, path: page.path, url: target.url.text, root: catalog.root, ...(from ? { from } : {}) });
        }
        descriptions.push(`/${page.path}\n${tab ? 'TabBar 页面' : page.package ? `分包：${page.package}${page.independent ? '（独立分包）' : ''}` : '主包页面'}\n注册配置：${page.definition.uri}${bases.length > 1 && target.from ? `\n相对基准：/${target.from}` : ''}`);
        if (queryEditing && original && !original.endsWith('.wxml')) {
          const info = await scripts.pageQuery?.(request, original);
          query = info?.type;
          queryFields = info?.fields ?? [];
          if (info) queries.push(info);
          queryComplete &&= !!info && info.complete !== false;
          for (const item of info?.dependencies ?? []) state.dependencies.set(item.uri, item.revision);
        }
      }
      if (queries.length > 1) {
        const properties: Record<string, import('../api').SemanticType> = {};
        const fields: NonNullable<import('../api').PageQuery['fields']>[number][] = [];
        for (const name of new Set(queries.flatMap((info) => Object.keys(info.type.properties ?? {})))) {
          const candidates = queries.flatMap((info) => info.type.properties?.[name] ? [info.type.properties[name]!] : []);
          const types = [...new Map(candidates.map((type) => [type.display, type])).values()];
          const type = types.length === 1 ? types[0]! : { kind: 'unknown' as const, display: types.map((type) => type.display).join(' | '), alternatives: types };
          properties[name] = { ...type, optional: candidates.length < queries.length || candidates.some((item) => item.optional) };
          const declarations = queries.flatMap((info) => info.fields?.filter((field) => field.name === name) ?? []);
          if (!declarations.length) continue;
          const defaults = new Set(declarations.map((field) => field.defaultValue));
          const defaultValue = defaults.size === 1 ? declarations[0]!.defaultValue : undefined;
          fields.push({ name, type: properties[name]!, required: candidates.length === queries.length && declarations.every((field) => field.required), description: [...new Set(declarations.map((field) => field.description).filter(Boolean))].join('\n'), definitions: declarations.flatMap((field) => field.definitions), ...(defaultValue === undefined ? {} : { defaultValue }) });
        }
        query = { kind: 'object', display: '页面查询参数', properties };
        queryFields = fields;
      }
      if (access.editable && selected && !queryEditing && !/^[a-z][\w+.-]*:|^\/\//i.test(content)) {
        const prefix = content.slice(0, cursor);
        const absolute = content.startsWith('/');
        const origins = absolute || access.registration !== undefined ? [{ path: '' }] : bases;
        for (const base of origins) for (const page of manifest.pages) {
          if (manifest.tabComplete && (access.method === 'switchTab' ? !manifest.tabs.includes(page.path) : ['navigateTo', 'redirectTo'].includes(access.method) && manifest.tabs.includes(page.path))) continue;
          if (access.registration && !page.path.startsWith(access.registration.replace(/\/$/, '') + '/')) continue;
          let value = access.registration !== undefined ? access.registration ? page.path.slice(access.registration.replace(/\/$/, '').length + 1) : page.path : absolute ? '/' + page.path : path.relative(path.dirname(base.path), page.path);
          if (!absolute && content.startsWith('./') && !value.startsWith('.')) value = './' + value;
          if (!value.startsWith(prefix)) continue;
          completions.push({ label: value, kind: 'value', detail: manifest.tabs.includes(page.path) ? 'TabBar 页面' : page.package ? `分包：${page.package}` : '主包页面', documentation: page.definition.uri, insertText: value, range: { start: access.range.start, end: access.range.start + (pathEnd < 0 ? content.length : pathEnd) } });
        }
      }
      if (queryEditing && query?.properties && access.method !== 'switchTab') {
        const start = Math.max(content.lastIndexOf('&', cursor - 1), pathEnd) + 1;
        const tail = content.indexOf('&', cursor);
        const end = tail < 0 ? content.length : tail;
        const equals = content.indexOf('=', start);
        if (equals < 0 || equals >= end || cursor <= equals) for (const [name, type] of Object.entries(query.properties)) {
          if (!name.startsWith(content.slice(start, cursor))) continue;
          const field = queryFields.find((item) => item.name === name);
          completions.push({ label: name, kind: 'value', detail: type.display, documentation: [field?.description, `${field?.required ? '必填' : '可选'}页面查询参数`, field?.defaultValue === undefined ? '' : `默认值：${field.defaultValue}`].filter(Boolean).join('\n'), insertText: name + (equals >= start && equals < end ? '' : '='), range: { start: access.range.start + start, end: access.range.start + (equals >= start && equals < end ? equals : end) } });
        }
        if (equals < 0 || equals >= end || cursor <= equals) {
          const keyEnd = equals >= start && equals < end ? equals : end;
          const name = content.slice(start, keyEnd);
          const field = queryFields.find((item) => item.name === name);
          if (field?.definitions.length) {
            const originRange = { start: access.range.start + start, end: access.range.start + keyEnd };
            definitions.splice(0, definitions.length, ...field.definitions.map((definition) => ({ ...definition, originRange })));
            descriptions.splice(0, descriptions.length, [name, `类型：${field.type.display}`, field.description, field.required ? '必填参数' : '可选参数', field.defaultValue === undefined ? '' : `默认值：${field.defaultValue}`].filter(Boolean).join('\n'));
          }
        }
      }
      if (request.cancellation.isCancellationRequested) return empty;
      const result: RouteResult = { definitions: [...new Map(definitions.map((item) => [item.uri + ':' + item.range.start + ':' + item.range.end, item])).values()], completions: [...new Map(completions.map((item) => [item.label + ':' + item.insertText, item])).values()], diagnostics: [...new Map(diagnostics.map((item) => [item.code + ':' + item.message, item])).values()], targets: links, complete: manifest.complete && contextComplete && !state.exhausted() && !generatedTarget, ...(query ? { query } : {}), ...(descriptions.length ? { hover: { title: access.method, description: descriptions.join('\n\n'), range: access.range } } : {}) };
      for (const item of result.diagnostics) reader.navigation?.record({ code: 'context', message: item.message, uri: request.document.uri });
      if (!definitions.length) reader.navigation?.record({ code: 'missing', message: '当前 URL 或查询字段未得到可确定的源码定义；请核对页面注册、路径及已声明的查询字段。', uri: request.document.uri });
      if (revision && manifest.complete && manifest.tabComplete && queryComplete && contextComplete && state.valid()) {
        const next = [...(resultCaches.get(revision) ?? []).filter((item) => item.key !== cacheKey), { key: cacheKey, result, dependencies: new Map(state.dependencies), weight: cacheKey.length + JSON.stringify(result).length }];
        let weight = next.reduce((size, item) => size + item.weight, 0);
        while (next.length > 16 || weight > 4_000_000) weight -= next.shift()!.weight;
        resultCaches.set(revision, next);
      }
      return result;
    },
  };
}

/** 通用脚本提供器只在真实路由 URL 上补充编辑器能力。 */
export function createRoutePlugin(scripts: ScriptDefinitionResolver, routes: RouteResolver): LanguagePlugin {
  /** 配置页面字符串与脚本平台调用使用相同的路由结果。 */
  async function accesses(request: LanguageRequest, all = false) {
    return ['json', 'jsonc'].includes(request.document.languageId) ? (await import('./routes-document')).jsonRouteAccesses(request) : await scripts.routeQueries?.(request, all) ?? [];
  }
  /** 光标查询只选取包含当前位置的 URL，不替代常量的普通 TypeScript 语义。 */
  async function result(request: LanguageRequest): Promise<RouteResult | undefined> {
    const candidates = await accesses(request);
    const access = candidates.find((item) => request.offset >= item.range.start && request.offset <= item.range.end);
    return access ? routes.query(request, access) : undefined;
  }
  const features: LanguageFeatures = {
    definition: { provide: async (request) => (await result(request))?.definitions ?? [] },
    completion: { triggerCharacters: ['/', '?', '&'], provide: async (request) => (await result(request))?.completions ?? [] },
    hover: { provide: async (request) => (await result(request))?.hover },
    diagnostics: { dependencyLanguages: ['json', 'jsonc', 'typescript', 'javascript'],
      /** 全文件复用目录和源码探测，未知 URL 不产生缺失页面诊断。 */
      async provide(request) {
        const result: RouteResult['diagnostics'][number][] = [];
        for (const access of await accesses(request, true)) result.push(...(await routes.query(request, access)).diagnostics);
        return result;
      },
    },
  };
  return { id: 'miniprogramlab.page-routes', displayName: '页面路由语义', languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'json', 'jsonc'], setup: () => features };
}
