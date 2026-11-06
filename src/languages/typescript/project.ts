import { ambientIndex } from './ambient-index';
import type { AmbientIndex } from './ambient-index';
import ts from 'typescript';
import type { Cancellation, LanguageRequest, ProjectFileResolver, ScriptAdapter, WorkspaceDependency, WorkspaceReader, WorkspaceText } from '../../api';

/** 脚本预算由公共计算契约描述，保留现有模块类型名称。 */
export type ScriptOptions = import('../../api/compute').ScriptSettings;

/** 返回父目录，保留远程文件系统的协议和主机。 */
function directory(uri: string): string {
  return new URL('./', uri).toString();
}

/** 统一编译器路径与编辑器 URI 的空格编码。 */
function canonical(uri: string): string {
  try { return new URL(uri).toString(); } catch { return uri; }
}

/** 将源码 URI 转成相对模块引用，继续交由 TypeScript 处理扩展名与目录入口。 */
function moduleReference(target: string, from: string): string {
  const source = new URL(from);
  const destination = new URL(target);
  if (source.protocol !== destination.protocol || source.host !== destination.host) return target;
  const left = source.pathname.split('/').slice(0, -1);
  const right = destination.pathname.split('/');
  while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
  return '../'.repeat(left.length) + (left.length ? '' : './') + right.join('/');
}

/** 图缓存保留完整性标记，取消或读取期间变化的结果不进入缓存。 */
interface CachedProject {
  readonly key: string;
  readonly input: string | undefined;
  readonly documents: Map<string, WorkspaceText | undefined>;
  readonly sources: Map<string, ts.SourceFile>;
  readonly resolutions: Map<string, ts.ResolvedModuleFull>;
  readonly mapped: Set<string>;
  readonly revisions: Map<string, string>;
  readonly options: ts.CompilerOptions;
  readonly program: { program: ts.Program; entry: ts.SourceFile };
  readonly weight: number;
  readonly exhausted: boolean;
}

/** 最多保留八份图、两千四百万字符，容纳大型页面并限制常驻内存。 */
const projectCaches = new WeakMap<NonNullable<WorkspaceReader['revision']>, CachedProject[]>();

/** 同一修订域的等价快照共享建图，项目、入口、设置和文本仍分别核对。 */
const pendingProjects = new WeakMap<object, Map<string, { readonly input: string | undefined; readonly callers: Set<Cancellation>; readonly promise: Promise<ScriptProject> }>>();

/** 模块边单独按依赖修订复用，页面内容变化不重复探测未变化的导入。 */
interface CachedModule {
  readonly target: string | undefined;
  readonly module: ts.ResolvedModuleFull | undefined;
  readonly mapped: boolean;
  readonly ambient: readonly string[];
  readonly dependencies: ReadonlyMap<string, string>;
}
const moduleCaches = new WeakMap<NonNullable<WorkspaceReader['revision']>, { entries: Map<string, CachedModule>; dependencies: number }>();

/** 只读脚本图将异步文件端口转换为 TypeScript 的同步内存宿主。 */
export class ScriptProject {
  readonly sources = new Map<string, ts.SourceFile>();
  readonly documents = new Map<string, WorkspaceText | undefined>();
  private readonly resolutions = new Map<string, ts.ResolvedModuleFull>();
  private readonly reading = new Map<string, Promise<WorkspaceText | undefined>>();
  private readonly readingDirectories = new Map<string, Promise<boolean>>();
  private readonly directories = new Map<string, boolean>();
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private previousSources: ReadonlyMap<string, ts.SourceFile> | undefined;
  private entryImports: { uri: string; names: ReadonlySet<string> } | undefined;
  /** 入口语法导航保留父节点，依赖节点由 TypeScript 在绑定时统一补齐。 */
  private entryUri: string | undefined;
  private readonly root: string;
  private bytes = 0;
  private options: ts.CompilerOptions = {};
  /** 按需导航只读取模块路径配置，不建立完整脚本图。 */
  private navigationConfigured = false;
  private program: { program: ts.Program; entry: ts.SourceFile } | undefined;
  private built = false;
  private readonly files: ProjectFileResolver | undefined;
  private readonly mapped = new Set<string>();
  private readonly ambientRoots = new Set<string>();
  private ambientModules: ReadonlyMap<string, readonly string[]> | undefined;
  private ambientLoading: Promise<AmbientIndex> | undefined;
  private declarationRoots: readonly string[] | undefined;
  private readonly revisions = new Map<string, string>();
  private readonly observations = new Set<Map<string, string>>();
  private configRevisions = new Map<string, string>();
  /** 重命名必须知道引用图是否完整，不能静默提交部分编辑。 */
  exhausted = false;

  /** 请求级缓存优先使用模板快照，不读取或执行项目代码。 */
  constructor(private readonly reader: WorkspaceReader, readonly request: LanguageRequest, private readonly settings: ScriptOptions, private readonly shared = false) {
    this.files = reader.fileResolver?.(request.document.uri, request.cancellation);
    this.documents.set(request.document.uri, { text: request.document.text, version: request.document.version });
    this.maxFiles = Number.isFinite(settings.maxFiles) ? Math.max(1, Math.min(1000, settings.maxFiles!)) : 400;
    this.maxDepth = Number.isFinite(settings.maxDepth) ? Math.max(0, Math.min(64, Math.floor(settings.maxDepth!))) : 12;
    this.root = reader.root(request.document.uri) ?? directory(request.document.uri);
  }

  /** 已取消请求不再产生新文件访问。 */
  get cancelled(): boolean {
    return this.request.cancellation.isCancellationRequested;
  }

  /** 静态适配规则属于当前请求的设置快照。 */
  get adapters(): readonly ScriptAdapter[] { return this.settings.adapters ?? []; }

  /** 查询阶段沿用读取阶段的追踪作用域，普通请求不保存说明。 */
  explain(step: import('../../api').NavigationStep): void { this.reader.navigation?.record(step); }

  /** 缓存命中后仍从实际模块图整理入口到声明的导入链。 */
  explainDefinition(uri: string): void {
    if (!this.reader.navigation?.active || !this.program) return;
    const entry = this.program.entry.fileName;
    const reached = new Map<string, { from: string; reference: string } | undefined>([[entry, undefined]]);
    const queue = [entry];
    for (let index = 0; index < queue.length && !reached.has(uri); index++) {
      const from = queue[index]!;
      for (const [key, module] of this.resolutions) {
        const separator = key.indexOf('\0');
        if (key.slice(0, separator) !== from || reached.has(module.resolvedFileName)) continue;
        reached.set(module.resolvedFileName, { from, reference: key.slice(separator + 1) }); queue.push(module.resolvedFileName);
      }
    }
    const chain: { from: string; reference: string; target: string }[] = [];
    for (let target = uri, previous = reached.get(target); previous; target = previous.from, previous = reached.get(target)) chain.unshift({ ...previous, target });
    for (const step of chain) this.explain({ code: 'path', message: `沿 ${step.from} 的导入 ${step.reference} 定位模块。`, uri: step.target });
    this.explain({ code: 'symbol', message: '实际注册、模板作用域及引用链解析到此声明。', uri });
  }

  /** 修订来自实际读取前的快照，缓存命中后也保留全部正向和负向依赖。 */
  get dependencies(): readonly WorkspaceDependency[] {
    for (const item of this.files?.dependencies ?? []) if (!this.revisions.has(item.uri)) this.revisions.set(item.uri, item.revision);
    return [...this.revisions].map(([uri, revision]) => ({ uri, revision }));
  }

  /** 返回已经加载的模块，供 CommonJS 静态求值复用官方解析结果。 */
  module(reference: string, from: string): ts.SourceFile | undefined {
    const target = this.resolutions.get(`${from}\0${reference}`)?.resolvedFileName;
    this.reader.navigation?.record({ code: target ? 'path' : 'missing', message: target ? `沿导入 ${reference} 定位模块。` : `导入 ${reference} 未得到已加载模块；检查路径配置、目标文件或扫描预算。`, uri: target ?? from });
    return target ? this.sources.get(target) : undefined;
  }

  /** 只为智能映射接管的文件补充导航，普通文件仍使用编辑器原生提供器。 */
  isMapped(uri: string): boolean {
    // 已加载的公共依赖也属于后续映射入口的引用链，不能因加载顺序丢失导航。
    let changed: boolean;
    do {
      changed = false;
      for (const [key, module] of this.resolutions) if (this.mapped.has(key.slice(0, key.indexOf('\0'))) && !this.mapped.has(module.resolvedFileName)) {
        this.mapped.add(module.resolvedFileName); changed = true;
      }
    } while (changed);
    return this.mapped.has(uri);
  }

  /** 缺失文件也缓存，限制路径探测和解析文本总量。 */
  private async read(uri: string): Promise<WorkspaceText | undefined> {
    uri = canonical(uri);
    if (this.cancelled) return undefined;
    this.observe(uri);
    if (this.documents.has(uri)) return this.documents.get(uri);
    const pending = this.reading.get(uri);
    if (pending) return pending;
    if (this.reader.revision) this.revisions.set(uri, this.reader.revision(uri));
    if (this.documents.size + this.reading.size >= this.maxFiles * 24 + 128) { this.exhausted = true; return undefined; }
    const promise = (async () => {
      const value = await this.reader.read(uri);
      if (this.cancelled) return undefined;
      if (!value || value.text.length > 2_000_000 || this.bytes + value.text.length > 16_000_000) {
        if (value) this.exhausted = true;
        this.documents.set(uri, undefined);
        return undefined;
      }
      this.bytes += value.text.length;
      this.documents.set(uri, value);
      return value;
    })().finally(() => this.reading.delete(uri));
    this.reading.set(uri, promise);
    return promise;
  }

  /** 同步宿主仅访问内存，未知路径交由下一轮异步探测。 */
  private text(uri: string, pending: Set<string>): string | undefined {
    uri = canonical(uri);
    if (!this.documents.has(uri)) {
      if (pending.size + this.documents.size + this.reading.size < this.maxFiles * 24 + 128) pending.add(uri);
      else this.exhausted = true;
    } else this.observe(uri);
    return this.documents.get(uri)?.text;
  }

  /** 未知目录先等待异步探测，重试时才允许官方解析器搜索其中的文件。 */
  private directory(uri: string, pending: Set<string>): boolean {
    if (!this.reader.directory) return true;
    uri = canonical(uri);
    const known = this.directories.get(uri);
    if (known !== undefined) { this.observe(uri); return known; }
    if (this.directories.size + pending.size + this.readingDirectories.size >= this.maxFiles * 8 + 128) { this.exhausted = true; return false; }
    pending.add(uri);
    return false;
  }

  /** 重试标准模块解析直到所需文件已读入，不手写包导出规则。 */
  private async probe<T>(operation: (text: (uri: string) => string | undefined, directory: (uri: string) => boolean) => T): Promise<T> {
    const files = new Set<string>(), pendingDirectories = new Set<string>();
    let fileBatch = 1;
    const text = (uri: string) => this.text(uri, files), directory = (uri: string) => this.directory(uri, pendingDirectories);
    let result = operation(text, directory);
    for (let round = 0; (files.size || pendingDirectories.size) && round < 32 && !this.cancelled; round++) {
      if (this.request.checkpoint && !await this.request.checkpoint(this.request.cancellation)) break;
      const directories = [...pendingDirectories].slice(0, 16);
      pendingDirectories.clear();
      for (let offset = 0; offset < directories.length; offset += 16) await Promise.all(directories.slice(offset, offset + 16).map(async (uri) => {
        if (this.cancelled || this.directories.has(uri)) return;
        this.observe(uri);
        let reading = this.readingDirectories.get(uri);
        if (!reading) {
          if (this.reader.revision) this.revisions.set(uri, this.reader.revision(uri));
          reading = this.reader.directory!(uri).then((exists) => { this.directories.set(uri, exists); return exists; }).finally(() => this.readingDirectories.delete(uri));
          this.readingDirectories.set(uri, reading);
        }
        await reading;
      }));
      // 目录到位后重新探测，只读取本轮仍需要的优先候选。
      files.clear();
      result = operation(text, directory);
      const pending = [...files].slice(0, fileBatch);
      if (pending.length) fileBatch = Math.min(8, fileBatch * 2);
      files.clear();
      await Promise.all(pending.map((uri) => this.read(uri)));
      result = operation(text, directory);
    }
    if (files.size || pendingDirectories.size) this.exhausted = true;
    return result;
  }

  /** 从最近的 tsconfig/jsconfig 读取继承后的编译选项，禁用目录扫描。 */
  private async configure(entry: string): Promise<void> {
    let current = directory(entry);
    let config: string | undefined;
    for (let depth = 0; depth < 40 && !this.cancelled; depth++) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const uri = new URL(name, current).toString();
        if (await this.read(uri)) { config = uri; break; }
      }
      if (config || current.replace(/\/$/, '') === this.root.replace(/\/$/, '')) break;
      const parent = new URL('../', current).toString();
      if (parent === current) break;
      current = parent;
    }
    if (config) {
      const uri = config;
      const result = await this.probe((text) => ts.getParsedCommandLineOfConfigFile(uri, {}, {
        useCaseSensitiveFileNames: true,
        readDirectory: () => [],
        fileExists: (file) => text(file) !== undefined,
        readFile: text,
        getCurrentDirectory: () => this.root,
        onUnRecoverableConfigFileDiagnostic: (error) => this.explain({ code: 'config', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), uri }),
      }));
      this.options = result?.options ?? {};
      // 最近配置划定声明归属，显式共享目录和文件继续参与索引。
      const roots = new Set([directory(uri)]);
      const includes = Array.isArray(result?.raw?.include) ? result.raw.include : [];
      for (const pattern of [...includes, ...result?.options.typeRoots ?? []]) if (typeof pattern === 'string') {
        const prefix = pattern.split(/[*?]/, 1)[0]!;
        const target = new URL(prefix || './', directory(uri)).href;
        const base = /\.[^/]+$/.test(prefix) ? directory(target) : target.replace(/\/?$/, '/');
        if (base.startsWith(this.root.replace(/\/?$/, '/')) && !base.startsWith(directory(uri)) && !base.includes('/node_modules/')) roots.add(base);
      }
      for (const file of result?.fileNames ?? []) if (/\.d\.[cm]?ts$/i.test(file)) roots.add(canonical(file));
      this.declarationRoots = [...roots];
      this.reader.navigation?.record({ code: 'config', message: `读取脚本配置，识别 ${Object.keys(this.options.paths ?? {}).length} 条 paths 映射。`, uri });
      for (const error of result?.errors ?? []) if (error.code !== 18003) this.reader.navigation?.record({ code: 'config', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), uri });
    }
    this.options = { ...this.options, noEmit: true, noLib: true, allowJs: true, checkJs: false, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: this.options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true, skipLibCheck: true,
      ...(this.settings.preferImplementations ? { noDtsResolution: true, maxNodeModuleJsDepth: 100 } : {}),
    };
    this.configRevisions = new Map(this.revisions);
    this.configRevisions.delete(entry); this.configRevisions.delete(this.request.document.uri);
  }

  /** 内存探测也登记原始修订，缓存不能漏掉缺失路径和目录结构。 */
  private observe(uri: string): void {
    if (this.reader.revision) {
      const revision = this.revisions.get(uri) ?? this.reader.revision(uri);
      this.reader.revision(uri);
      for (const dependencies of this.observations) if (!dependencies.has(uri)) dependencies.set(uri, revision);
    }
  }

  /** 模块缓存只复用路径结论，源码内容仍由当前图重新核对。 */
  private async resolve(reference: string, from: string, ambient = true): Promise<string | undefined> {
    const revision = this.reader.revision;
    if (!revision) return this.resolveUncached(reference, from, ambient);
    const key = JSON.stringify([this.root, this.request.document.uri, from, reference, this.options, ambient, this.mapped.has(from)]);
    const state = moduleCaches.get(revision) ?? { entries: new Map<string, CachedModule>(), dependencies: 0 };
    moduleCaches.set(revision, state);
    const cached = state.entries.get(key);
    if (cached && [...cached.dependencies].every(([uri, version]) => revision(uri) === version)) {
      for (const [uri, version] of cached.dependencies) { if (!this.revisions.has(uri)) this.revisions.set(uri, version); this.observe(uri); }
      if (cached.module) this.resolutions.set(`${from}\0${reference}`, cached.module);
      if (cached.target && cached.mapped) this.mapped.add(cached.target);
      for (const uri of cached.ambient) this.ambientRoots.add(uri);
      state.entries.delete(key); state.entries.set(key, cached);
      return cached.target;
    }
    const dependencies = new Map(this.configRevisions);
    if (!this.reader.capture) this.observations.add(dependencies);
    try {
      const result = this.reader.capture ? await this.reader.capture(() => this.resolveUncached(reference, from, ambient)) : { value: await this.resolveUncached(reference, from, ambient), dependencies: [] };
      const target = result.value;
      for (const item of result.dependencies) if (!dependencies.has(item.uri)) dependencies.set(item.uri, this.revisions.get(item.uri) ?? item.revision);
      if (!this.cancelled && !this.exhausted && [...dependencies].every(([uri, version]) => revision(uri) === version)) {
        state.dependencies += dependencies.size - (state.entries.get(key)?.dependencies.size ?? 0);
        state.entries.delete(key); state.entries.set(key, { target, module: this.resolutions.get(`${from}\0${reference}`), mapped: !!target && this.mapped.has(target), ambient: target && this.ambientRoots.has(target) ? this.ambientModules?.get(reference) ?? [target] : [], dependencies });
        while (state.entries.size > 4096 || state.dependencies > 200_000) {
          const oldest = state.entries.keys().next().value!;
          state.dependencies -= state.entries.get(oldest)!.dependencies.size; state.entries.delete(oldest);
        }
      }
      return target;
    } finally { this.observations.delete(dependencies); }
  }

  /** 配置候选重播局部依赖，旧端口仍保留保守的完整追踪。 */
  private async candidates(reference: string, from: string, kind: import('../../api').FileReferenceKind): Promise<readonly string[]> {
    if (!this.files) return [];
    const result = this.files.resolve ? await this.files.resolve(reference, from, kind) : { candidates: await this.files.candidates(reference, from, kind), dependencies: this.files.dependencies ?? [] };
    for (const item of result.dependencies) { if (!this.revisions.has(item.uri)) this.revisions.set(item.uri, item.revision); this.observe(item.uri); }
    return result.candidates;
  }

  /** 使用官方解析器处理相对路径、路径映射、目录入口和包声明。 */
  private async resolveUncached(reference: string, from: string, ambient = true): Promise<string | undefined> {
    // WXS 和显式 JSON 引用只读取静态文件，保留源模块身份及类型检查器。
    if (/\.(?:wxs|json)$/i.test(reference)) {
      const candidates = [...await this.candidates(reference, from, 'file'), new URL(reference, from).href];
      for (const target of candidates) if (await this.read(target)) {
        this.resolutions.set(`${from}\0${reference}`, { resolvedFileName: target, extension: reference.endsWith('.json') ? ts.Extension.Json : ts.Extension.Js });
        return target;
      }
      return undefined;
    }
    /** 官方解析规则负责包导出、声明文件及扩展名探测。 */
    const queries = new Map<string, Promise<ts.ResolvedModuleFull | undefined>>();
    const resolve = (name: string): Promise<ts.ResolvedModuleFull | undefined> => {
      const key = name.startsWith('.') || name.startsWith('/') ? new URL(name, from).href : name;
      let query = queries.get(key);
      if (!query) { query = this.probe((text, directory) => ts.resolveModuleName(name, from, this.options, {
      fileExists: (file) => text(file) !== undefined,
      readFile: text,
      directoryExists: directory,
      getCurrentDirectory: () => this.root,
      realpath: (file) => file,
      }).resolvedModule); queries.set(key, query); }
      return query;
    };
    const original = await resolve(reference);
    let result = original;
    if (!this.cancelled) for (const candidate of await this.candidates(reference, from, 'script')) {
      if (this.cancelled) return undefined;
      // 已映射的具体 JS 文件必须保留原样复制语义，不能被 TS 扩展名替换抢走。
      const extension = candidate.endsWith('.js') ? ts.Extension.Js : candidate.endsWith('.mjs') ? ts.Extension.Mjs : candidate.endsWith('.cjs') ? ts.Extension.Cjs : undefined;
      if (extension && candidate !== new URL(reference, from).href && await this.read(candidate)) {
        result = { resolvedFileName: candidate, extension }; break;
      }
      const resolved = await resolve(moduleReference(candidate, from));
      if (resolved) { result = resolved; break; }
    }
    if (!result) {
      if (ambient && !reference.startsWith('.') && !reference.startsWith('/') && this.reader.findFiles) {
        if (!this.ambientModules) {
          const index = await (this.ambientLoading ??= ambientIndex(this.reader, this.request, this.maxFiles, this.declarationRoots));
          this.ambientModules = index.modules;
          this.exhausted ||= !index.complete;
          for (const item of index.dependencies) { if (!this.revisions.has(item.uri)) this.revisions.set(item.uri, item.revision); this.observe(item.uri); }
        }
        const uris = this.ambientModules.get(reference);
        if (uris?.length) { for (const uri of uris) this.ambientRoots.add(uri); return uris[0]; }
      }
      return undefined;
    }
    const resolvedFileName = canonical(result.resolvedFileName);
    if (this.mapped.has(from) || resolvedFileName !== (original && canonical(original.resolvedFileName))) this.mapped.add(resolvedFileName);
    this.resolutions.set(`${from}\0${reference}`, { ...result, resolvedFileName });
    return resolvedFileName;
  }

  /** 明确引用链复用官方路径解析，缺失模块交回完整语义处理。 */
  async navigationModule(reference: string, from: string): Promise<string | undefined> {
    if (!this.navigationConfigured) {
      await this.configure(from);
      this.navigationConfigured = true;
    }
    const target = await this.resolve(reference, from, false);
    if (target) this.explain({ code: 'path', message: `沿导入 ${reference} 按需定位模块。`, uri: target });
    return this.exhausted || this.cancelled ? undefined : target;
  }

  /** 按需查询与完整图共享请求快照，回退时不重复读取同一文件。 */
  navigationSource(uri: string): Promise<WorkspaceText | undefined> { return this.read(uri); }

  /** 优先按层级加载项目源码，再读取包依赖，避免声明包耗尽页面解析预算。 */
  private async load(uri: string): Promise<void> {
    const pending = new Map([[uri, 0]]);
    const dependencies = new Map<string, number>();
    const deferred: { reference: string; from: string; depth: number }[] = [];
    /** 共享依赖保留最短已知距离，较长分支不能覆盖近处导入。 */
    const enqueue = (target: string, depth: number): void => {
      if (this.sources.has(target)) return;
      const queue = target.includes('/node_modules/') ? dependencies : pending;
      queue.set(target, Math.min(depth, queue.get(target) ?? depth));
    };
    let nextDependency = 0;
    const checkpoint = this.request.checkpoint;
    // 两个队列都保持发现顺序，已加载索引负责终止循环依赖。
    while (pending.size || dependencies.size || nextDependency < deferred.length) {
      if (this.cancelled || checkpoint && !await checkpoint(this.request.cancellation)) return;
      if (!pending.size && nextDependency < deferred.length) {
        const batch = deferred.slice(nextDependency, nextDependency + 8);
        nextDependency += batch.length;
        const targets = await Promise.all(batch.map((imported) => this.resolve(imported.reference, imported.from)));
        for (let index = 0; index < targets.length; index++) if (targets[index]) enqueue(targets[index]!, batch[index]!.depth);
        continue;
      }
      const queue = pending.size ? pending : dependencies;
      const [current, depth] = queue.entries().next().value!;
      queue.delete(current);
      if (this.sources.has(current)) continue;
      if (this.sources.size >= this.maxFiles) { this.exhausted = true; return; }
      const content = await this.read(current);
      if (!content) continue;
      const previous = this.previousSources?.get(current);
      // 无函数语法的 TS 模型只解析类型检查所需注释，参数文档和 JS 注解仍完整保留。
      const leanComments = /\.[cm]?tsx?$/i.test(current) && !content.text.includes('(') && !content.text.includes('=>');
      const source = previous?.text === content.text ? previous : ts.createSourceFile(current, content.text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: leanComments ? ts.JSDocParsingMode.ParseForTypeErrors : ts.JSDocParsingMode.ParseAll }, current === this.entryUri, /\.wxs$/i.test(current) ? ts.ScriptKind.JS : undefined);
      this.sources.set(current, source);
      const info = ts.preProcessFile(content.text, true, true);
      const imports = this.entryImports?.uri === current ? info.importedFiles.filter((item) => this.entryImports!.names.has(item.fileName)) : info.importedFiles;
      if (this.maxDepth && depth >= this.maxDepth && (imports.length || info.referencedFiles.length || info.libReferenceDirectives.length)) {
        this.exhausted = true;
        this.explain({ code: 'budget', message: `脚本引用链达到 ${this.maxDepth} 层上限，可调整 wxml.maxScriptDepth；未继续展开依赖。`, uri: current });
        continue;
      }
      for (let offset = 0; offset < imports.length; offset += 8) {
        if (this.cancelled || checkpoint && !await checkpoint(this.request.cancellation)) return;
        // 独立导入有界并发，入队仍按源码顺序，保留原有优先级。
        const targets = await Promise.all(imports.slice(offset, offset + 8).map(async (imported) => {
          const reference = imported.fileName;
          const mapped = Object.keys(this.options.paths ?? {}).some((pattern) => pattern.includes('*')
            ? reference.startsWith(pattern.slice(0, pattern.indexOf('*'))) && reference.endsWith(pattern.slice(pattern.indexOf('*') + 1)) : reference === pattern);
          // 包入口的路径探测同样会占用预算，先保留本地路径和 tsconfig 别名。
          if (!reference.startsWith('.') && !reference.startsWith('/') && !mapped) {
            deferred.push({ reference, from: current, depth: depth + 1 });
            return undefined;
          }
          return this.resolve(reference, current);
        }));
        for (const target of targets) if (target) enqueue(target, depth + 1);
      }
      for (const reference of info.referencedFiles) enqueue(new URL(reference.fileName, current).toString(), depth + 1);
      if (this.settings.libraryUri && current.startsWith(directory(this.settings.libraryUri))) {
        for (const library of info.libReferenceDirectives) enqueue(new URL(`lib.${library.fileName}.d.ts`, current).toString(), depth + 1);
      }
    }
  }

  /** 打开、关闭或保存同内容文件时只刷新快照版本，保留已建立的类型图。 */
  private async unchanged(cached: CachedProject): Promise<boolean> {
    const revision = this.reader.revision!;
    const changed = [...cached.revisions].filter(([uri, version]) => revision(uri) !== version);
    if (!changed.length) return true;
    if (changed.length > 32 || changed.some(([uri]) => !cached.documents.has(uri))) return false;
    const replacements = new Map<string, WorkspaceText | undefined>();
    const versions = new Map(cached.revisions);
    for (const [uri] of changed) {
      if (this.cancelled) return false;
      const version = revision(uri);
      const document = uri === this.request.document.uri ? this.request.document : await this.reader.read(uri);
      if (document?.text !== cached.documents.get(uri)?.text || revision(uri) !== version) return false;
      replacements.set(uri, document);
      versions.set(uri, version);
    }
    if ([...versions].some(([uri, version]) => revision(uri) !== version)) return false;
    for (const [uri, document] of replacements) cached.documents.set(uri, document);
    for (const [uri, version] of versions) cached.revisions.set(uri, version);
    return true;
  }

  /** 合并建图后复制查询状态，依赖仍登记到当前调用者的追踪作用域。 */
  private adopt(project: ScriptProject): void {
    for (const [uri, document] of project.documents) if (uri !== this.request.document.uri) this.documents.set(uri, document);
    for (const [uri, source] of project.sources) this.sources.set(uri, source);
    for (const [name, target] of project.resolutions) this.resolutions.set(name, target);
    for (const uri of project.mapped) this.mapped.add(uri);
    for (const [uri, version] of project.revisions) { this.revisions.set(uri, version); this.reader.revision?.(uri); }
    this.options = project.options;
    this.program = project.program;
    this.exhausted = project.exhausted;
    if (this.exhausted) this.explain({ code: 'budget', message: '共享脚本图仍受解析预算限制，当前结果不完整。' });
  }

  /** 找到同名源码后建立仅在内存运行的类型检查器。 */
  async create(entryUri?: string, additional: readonly string[] = [], imports?: readonly string[]): Promise<{ program: ts.Program; entry: ts.SourceFile } | undefined> {
    if (this.built) return this.program;
    this.built = true;
    if (this.cancelled || (!entryUri && !/\.wxml$/i.test(this.request.document.uri))) return undefined;
    const revision = this.reader.revision;
    const cache = revision && projectCaches.get(revision);
    const key = JSON.stringify([this.root, this.request.document.uri, entryUri, additional, this.settings, imports]);
    // 普通模板文本不进入脚本 Program，编辑模板仍可复用未变化的页面脚本图。
    const input = /\.wxml$/i.test(this.request.document.uri) ? undefined : this.request.document.text;
    const cached = cache?.find((item) => item.key === key);
    if (cached && cached.input === input && await this.unchanged(cached) && !this.cancelled) {
      this.reader.navigation?.record({ code: 'cached', message: `复用已核验依赖修订的脚本图，包含 ${cached.sources.size} 份源码及 ${Object.keys(cached.options.paths ?? {}).length} 条 paths 映射。`, uri: cached.program.entry.fileName });
      for (const [uri, document] of cached.documents) if (uri !== this.request.document.uri) this.documents.set(uri, document);
      for (const [uri, source] of cached.sources) this.sources.set(uri, source);
      for (const [name, target] of cached.resolutions) this.resolutions.set(name, target);
      for (const uri of cached.mapped) this.mapped.add(uri);
      for (const [uri, revision] of cached.revisions) this.revisions.set(uri, revision);
      this.options = cached.options;
      this.program = cached.program;
      this.exhausted = cached.exhausted;
      if (this.exhausted) this.explain({ code: 'budget', message: '缓存脚本图仍受解析预算限制，未将部分结果视为完整上下文。', uri: cached.program.entry.fileName });
      cache!.splice(cache!.indexOf(cached), 1); cache!.push(cached);
      return this.program;
    }
    if (revision && !this.shared && this.documents.size === 1) {
      const scope = this.reader.revision ?? this.reader;
      const pending = pendingProjects.get(scope) ?? new Map();
      pendingProjects.set(scope, pending);
      let running = pending.get(key);
      if (!running || running.input !== input) {
        const callers = new Set<Cancellation>();
        const cancellation = { get isCancellationRequested() { return [...callers].every((caller) => caller.isCancellationRequested); } };
        const project = new ScriptProject(this.reader, { ...this.request, cancellation }, this.settings, true);
        const promise = Promise.resolve().then(async () => { await project.create(entryUri, additional, imports); return project; }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
        running = { input, callers, promise }; pending.set(key, running);
      }
      running.callers.add(this.request.cancellation);
      try {
        const project = await running.promise;
        if (this.cancelled) return undefined;
        if (project.program && [...project.revisions].every(([uri, version]) => revision(uri) === version)) { this.adopt(project); return this.program; }
        // 共享快照过期时由当前请求重新读取，不沿用其他调用者的旧结果。
      } finally { running.callers.delete(this.request.cancellation); }
    }
    // 同一入口重建时复用未变化的语法树，类型关系仍由新 Program 核验。
    this.previousSources = cached?.sources;
    const base = this.request.document.uri.replace(/\.wxml$/i, '');
    let entry: string | undefined = entryUri;
    for (const extension of entry ? [] : ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
      if (await this.read(base + extension)) { entry = base + extension; break; }
    }
    if (!entry) { this.reader.navigation?.record({ code: 'missing', message: '当前模板没有找到同名 TS/JS 脚本，无法建立页面成员上下文。', uri: this.request.document.uri }); return undefined; }
    this.entryUri = entry;
    if (!this.navigationConfigured) await this.configure(entry);
    if (imports) this.entryImports = { uri: entry, names: new Set(imports) };
    await this.load(entry);
    for (const uri of additional) await this.load(uri);
    for (const uri of this.ambientRoots) await this.load(uri);
    if (this.settings.libraryUri) await this.load(this.settings.libraryUri);
    if (this.cancelled) return undefined;
    if (this.request.checkpoint && !await this.request.checkpoint(this.request.cancellation)) return undefined;
    // 并发读取保留首次修订，依赖在途中变化时不发布混合快照。
    for (const dependency of this.files?.dependencies ?? []) if (!this.revisions.has(dependency.uri)) this.revisions.set(dependency.uri, dependency.revision);
    if (revision && [...this.revisions].some(([uri, version]) => revision(uri) !== version)) return undefined;
    const host: ts.CompilerHost = {
      getSourceFile: (file) => this.sources.get(file),
      getDefaultLibFileName: () => '',
      writeFile: () => {},
      getCurrentDirectory: () => this.root,
      getDirectories: () => [],
      fileExists: (file) => this.sources.has(file),
      readFile: (file) => this.documents.get(file)?.text,
      getCanonicalFileName: (file) => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      resolveModuleNames: (names, from) => names.map((name) => this.resolutions.get(`${from}\0${name}`)),
    };
    this.options.allowNonTsExtensions = true;
    // TS 中的 require 链也由静态语义读取，所有已加载节点必须属于此 Program，避免检查未绑定的语法树。
    const program = ts.createProgram([...new Set([entry, ...additional, ...this.ambientRoots, ...this.sources.keys()])], this.options, host, cached?.program.program);
    const source = program.getSourceFile(entry);
    if (this.exhausted) this.reader.navigation?.record({ code: 'budget', message: `脚本引用链达到文件、文本或探测预算，当前图可能不完整；文件上限为 ${this.maxFiles}，可检查 wxml.maxScriptFiles。`, uri: entry });
    this.program = source ? { program, entry: source } : undefined;
    if (revision && this.program && !this.cancelled) {
      // 受限图也观察目录结构，新建文件后重新尝试补全引用图。
      if (this.exhausted && !this.revisions.has(this.root)) this.revisions.set(this.root, revision(this.root));
      if (this.sources.has(this.request.document.uri)) this.revisions.set(this.request.document.uri, revision(this.request.document.uri));
      const weight = [...this.documents.values()].reduce((total, document) => total + (document?.text.length ?? 0), 0);
      if (weight <= 16_000_000 && [...this.revisions].every(([uri, version]) => revision(uri) === version)) {
        const entries = (projectCaches.get(revision) ?? []).filter((item) => item.key !== key);
        entries.push({ key, input, documents: this.documents, sources: this.sources, resolutions: this.resolutions, mapped: this.mapped, revisions: this.revisions, options: this.options, program: this.program, weight, exhausted: this.exhausted });
        while (entries.length > 8 || entries.reduce((total, item) => total + item.weight, 0) > 24_000_000) entries.shift();
        projectCaches.set(revision, entries);
      }
    }
    return this.program;
  }

  /** 原生语言服务复用已读取的图和模块映射，用于符号重命名。 */
  languageService(): ts.LanguageService {
    return ts.createLanguageService({
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [...this.sources.keys()],
      getScriptVersion: (uri) => String(this.documents.get(uri)?.version ?? 0),
      getScriptSnapshot: (uri) => {
        const text = this.documents.get(uri)?.text;
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getScriptKind: (uri) => /\.(?:js|wxs)$/i.test(uri) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: () => '',
      fileExists: (uri) => this.sources.has(uri),
      readFile: (uri) => this.documents.get(uri)?.text,
      resolveModuleNames: (names, from) => names.map((name) => this.resolutions.get(`${from}\0${name}`)),
    });
  }
}
