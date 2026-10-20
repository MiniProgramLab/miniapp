import ts from 'typescript';
import type { LanguageRequest, ProjectFileResolver, ScriptAdapter, WorkspaceDependency, WorkspaceReader, WorkspaceText } from '../../api';

/** 脚本解析预算与随扩展交付的标准库位置。 */
export interface ScriptOptions {
  readonly adapters?: readonly ScriptAdapter[];
  readonly maxFiles?: number;
  readonly libraryUri?: string;
  /** 组件导航优先解析运行时入口，排除只提供类型的包入口。 */
  readonly preferImplementations?: boolean;
  /** 重命名扫描需要覆盖所有源码，超出上限时拒绝部分编辑。 */
  readonly maxRenameFiles?: number;
}

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

/** 只缓存完整语义图，依赖修订由宿主提供，取消的请求永不进入缓存。 */
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
}

/** 同一宿主的短期图最多保留四份、八百万字符，关闭工作区后可整体回收。 */
const projectCaches = new WeakMap<NonNullable<WorkspaceReader['revision']>, CachedProject[]>();

/** 只读脚本图将异步文件端口转换为 TypeScript 的同步内存宿主。 */
export class ScriptProject {
  readonly sources = new Map<string, ts.SourceFile>();
  readonly documents = new Map<string, WorkspaceText | undefined>();
  private readonly resolutions = new Map<string, ts.ResolvedModuleFull>();
  private readonly pending = new Set<string>();
  private readonly pendingDirectories = new Set<string>();
  private readonly directories = new Map<string, boolean>();
  private readonly maxFiles: number;
  private readonly root: string;
  private bytes = 0;
  private options: ts.CompilerOptions = {};
  private program: { program: ts.Program; entry: ts.SourceFile } | undefined;
  private built = false;
  private readonly files: ProjectFileResolver | undefined;
  private readonly mapped = new Set<string>();
  private readonly ambientRoots = new Set<string>();
  private ambientModules: Map<string, string> | undefined;
  private readonly revisions = new Map<string, string>();
  /** 重命名必须知道引用图是否完整，不能静默提交部分编辑。 */
  exhausted = false;

  /** 请求级缓存优先使用模板快照，不读取或执行项目代码。 */
  constructor(private readonly reader: WorkspaceReader, readonly request: LanguageRequest, private readonly settings: ScriptOptions) {
    this.files = reader.fileResolver?.(request.document.uri, request.cancellation);
    this.documents.set(request.document.uri, { text: request.document.text, version: request.document.version });
    this.maxFiles = Number.isFinite(settings.maxFiles) ? Math.max(1, Math.min(1000, settings.maxFiles!)) : 400;
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
    for (const item of this.files?.dependencies ?? []) this.revisions.set(item.uri, item.revision);
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
    if (this.documents.has(uri)) return this.documents.get(uri);
    if (this.reader.revision) this.revisions.set(uri, this.reader.revision(uri));
    if (this.documents.size >= this.maxFiles * 24 + 128) { this.exhausted = true; return undefined; }
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
  }

  /** 同步宿主仅访问内存，未知路径交由下一轮异步探测。 */
  private text(uri: string): string | undefined {
    uri = canonical(uri);
    if (!this.documents.has(uri)) {
      if (this.pending.size + this.documents.size < this.maxFiles * 24 + 128) this.pending.add(uri);
      else this.exhausted = true;
    }
    return this.documents.get(uri)?.text;
  }

  /** 未知目录先等待异步探测，重试时才允许官方解析器搜索其中的文件。 */
  private directory(uri: string): boolean {
    if (!this.reader.directory) return true;
    uri = canonical(uri);
    const known = this.directories.get(uri);
    if (known !== undefined) return known;
    if (this.directories.size + this.pendingDirectories.size >= this.maxFiles * 8 + 128) { this.exhausted = true; return false; }
    this.pendingDirectories.add(uri);
    return false;
  }

  /** 重试标准模块解析直到所需文件已读入，不手写包导出规则。 */
  private async probe<T>(operation: () => T): Promise<T> {
    let result = operation();
    for (let round = 0; (this.pending.size || this.pendingDirectories.size) && round < 32 && !this.cancelled; round++) {
      const directories = [...this.pendingDirectories];
      this.pendingDirectories.clear();
      for (let offset = 0; offset < directories.length; offset += 16) await Promise.all(directories.slice(offset, offset + 16).map(async (uri) => {
        if (this.cancelled) return;
        if (this.reader.revision) this.revisions.set(uri, this.reader.revision(uri));
        this.directories.set(uri, await this.reader.directory!(uri));
      }));
      const pending = [...this.pending];
      this.pending.clear();
      for (let offset = 0; offset < pending.length; offset += 16) await Promise.all(pending.slice(offset, offset + 16).map((uri) => this.read(uri)));
      result = operation();
    }
    if (this.pending.size || this.pendingDirectories.size) this.exhausted = true;
    this.pending.clear();
    this.pendingDirectories.clear();
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
      const result = await this.probe(() => ts.getParsedCommandLineOfConfigFile(uri, {}, {
        useCaseSensitiveFileNames: true,
        readDirectory: () => [],
        fileExists: (file) => this.text(file) !== undefined,
        readFile: (file) => this.text(file),
        getCurrentDirectory: () => this.root,
        onUnRecoverableConfigFileDiagnostic: (error) => this.explain({ code: 'config', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), uri }),
      }));
      this.options = result?.options ?? {};
      this.reader.navigation?.record({ code: 'config', message: `读取脚本配置，识别 ${Object.keys(this.options.paths ?? {}).length} 条 paths 映射。`, uri });
      for (const error of result?.errors ?? []) if (error.code !== 18003) this.reader.navigation?.record({ code: 'config', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), uri });
    }
    this.options = { ...this.options, noEmit: true, noLib: true, allowJs: true, checkJs: false, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: this.options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true, skipLibCheck: true,
      ...(this.settings.preferImplementations ? { noDtsResolution: true, maxNodeModuleJsDepth: 100 } : {}),
    };
  }

  /** 使用官方解析器处理相对路径、路径映射、目录入口和包声明。 */
  private async resolve(reference: string, from: string): Promise<string | undefined> {
    // WXS 和显式 JSON 引用只读取静态文件，保留源模块身份及类型检查器。
    if (/\.(?:wxs|json)$/i.test(reference)) {
      const candidates = [...await this.files?.candidates(reference, from, 'file') ?? [], new URL(reference, from).href];
      for (const target of candidates) if (await this.read(target)) {
        this.resolutions.set(`${from}\0${reference}`, { resolvedFileName: target, extension: reference.endsWith('.json') ? ts.Extension.Json : ts.Extension.Js });
        return target;
      }
      return undefined;
    }
    /** 官方解析规则负责包导出、声明文件及扩展名探测。 */
    const resolve = (name: string) => this.probe(() => ts.resolveModuleName(name, from, this.options, {
      fileExists: (file) => this.text(file) !== undefined,
      readFile: (file) => this.text(file),
      directoryExists: (uri) => this.directory(uri),
      getCurrentDirectory: () => this.root,
      realpath: (file) => file,
    }).resolvedModule);
    const original = await resolve(reference);
    let result = original;
    if (!this.cancelled) for (const candidate of await this.files?.candidates(reference, from, 'script') ?? []) {
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
      if (!reference.startsWith('.') && !reference.startsWith('/') && this.reader.findFiles) {
        if (!this.ambientModules) {
          this.ambientModules = new Map();
          if (this.reader.revision) this.revisions.set(this.root, this.reader.revision(this.root));
          const uris = await this.reader.findFiles(this.request.document.uri, '**/*.d.ts', this.maxFiles + 1);
          if (uris.length > this.maxFiles) this.exhausted = true;
          for (const uri of uris.slice(0, this.maxFiles)) {
            const snapshot = await this.read(uri);
            if (!snapshot || this.cancelled) continue;
            const source = ts.createSourceFile(uri, snapshot.text, ts.ScriptTarget.Latest, true);
            for (const statement of source.statements) if (ts.isModuleDeclaration(statement) && ts.isStringLiteralLike(statement.name)) this.ambientModules.set(statement.name.text, uri);
          }
        }
        const uri = this.ambientModules.get(reference);
        if (uri) { this.ambientRoots.add(uri); return uri; }
      }
      return undefined;
    }
    const resolvedFileName = canonical(result.resolvedFileName);
    if (this.mapped.has(from) || resolvedFileName !== (original && canonical(original.resolvedFileName))) this.mapped.add(resolvedFileName);
    this.resolutions.set(`${from}\0${reference}`, { ...result, resolvedFileName });
    return resolvedFileName;
  }

  /** 优先按层级加载项目源码，再读取包依赖，避免声明包耗尽页面解析预算。 */
  private async load(uri: string): Promise<void> {
    const pending = new Set([uri]);
    const dependencies = new Set<string>();
    const deferred: { reference: string; from: string }[] = [];
    let nextDependency = 0;
    // 两个队列都保持发现顺序，已加载索引负责终止循环依赖。
    while (pending.size || dependencies.size || nextDependency < deferred.length) {
      if (this.cancelled) return;
      if (this.sources.size >= this.maxFiles) { this.exhausted = true; return; }
      if (!pending.size && nextDependency < deferred.length) {
        const imported = deferred[nextDependency++]!;
        const target = await this.resolve(imported.reference, imported.from);
        if (target && !this.sources.has(target)) (target.includes('/node_modules/') ? dependencies : pending).add(target);
        continue;
      }
      const queue = pending.size ? pending : dependencies;
      const current = queue.values().next().value!;
      queue.delete(current);
      if (this.sources.has(current)) continue;
      const content = await this.read(current);
      if (!content) continue;
      const source = ts.createSourceFile(current, content.text, ts.ScriptTarget.Latest, true, /\.wxs$/i.test(current) ? ts.ScriptKind.JS : undefined);
      this.sources.set(current, source);
      const info = ts.preProcessFile(content.text, true, true);
      for (const imported of info.importedFiles) {
        const reference = imported.fileName;
        const mapped = Object.keys(this.options.paths ?? {}).some((pattern) => pattern.includes('*')
          ? reference.startsWith(pattern.slice(0, pattern.indexOf('*'))) && reference.endsWith(pattern.slice(pattern.indexOf('*') + 1)) : reference === pattern);
        // 包入口的路径探测同样会占用预算，先保留本地路径和 tsconfig 别名。
        if (!reference.startsWith('.') && !reference.startsWith('/') && !mapped) {
          deferred.push({ reference, from: current });
          continue;
        }
        const target = await this.resolve(imported.fileName, current);
        if (target && !this.sources.has(target)) (target.includes('/node_modules/') ? dependencies : pending).add(target);
      }
      for (const reference of info.referencedFiles) pending.add(new URL(reference.fileName, current).toString());
      if (this.settings.libraryUri && current.startsWith(directory(this.settings.libraryUri))) {
        for (const library of info.libReferenceDirectives) pending.add(new URL(`lib.${library.fileName}.d.ts`, current).toString());
      }
    }
  }

  /** 找到同名源码后建立仅在内存运行的类型检查器。 */
  async create(entryUri?: string, additional: readonly string[] = []): Promise<{ program: ts.Program; entry: ts.SourceFile } | undefined> {
    if (this.built) return this.program;
    this.built = true;
    if (this.cancelled || (!entryUri && !/\.wxml$/i.test(this.request.document.uri))) return undefined;
    const revision = this.reader.revision;
    const cache = revision && projectCaches.get(revision);
    const key = JSON.stringify([this.root, this.request.document.uri, entryUri, additional, this.settings]);
    // 普通模板文本不进入脚本 Program，编辑模板仍可复用未变化的页面脚本图。
    const input = /\.wxml$/i.test(this.request.document.uri) ? undefined : this.request.document.text;
    const cached = cache?.find((item) => item.key === key && item.input === input && [...item.revisions].every(([uri, version]) => revision!(uri) === version));
    if (cached) {
      this.reader.navigation?.record({ code: 'cached', message: `复用已核验依赖修订的完整脚本图，包含 ${cached.sources.size} 份源码及 ${Object.keys(cached.options.paths ?? {}).length} 条 paths 映射。`, uri: cached.program.entry.fileName });
      for (const [uri, document] of cached.documents) if (uri !== this.request.document.uri) this.documents.set(uri, document);
      for (const [uri, source] of cached.sources) this.sources.set(uri, source);
      for (const [name, target] of cached.resolutions) this.resolutions.set(name, target);
      for (const uri of cached.mapped) this.mapped.add(uri);
      for (const [uri, revision] of cached.revisions) this.revisions.set(uri, revision);
      this.options = cached.options;
      this.program = cached.program;
      cache!.splice(cache!.indexOf(cached), 1); cache!.push(cached);
      return this.program;
    }
    const base = this.request.document.uri.replace(/\.wxml$/i, '');
    let entry: string | undefined = entryUri;
    for (const extension of entry ? [] : ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
      if (await this.read(base + extension)) { entry = base + extension; break; }
    }
    if (!entry) { this.reader.navigation?.record({ code: 'missing', message: '当前模板没有找到同名 TS/JS 脚本，无法建立页面成员上下文。', uri: this.request.document.uri }); return undefined; }
    await this.configure(entry);
    await this.load(entry);
    for (const uri of additional) await this.load(uri);
    if (this.settings.libraryUri) await this.load(this.settings.libraryUri);
    if (this.cancelled) return undefined;
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
    const program = ts.createProgram([...new Set([entry, ...additional, ...this.ambientRoots, ...this.sources.keys()])], this.options, host);
    const source = program.getSourceFile(entry);
    if (this.exhausted) this.reader.navigation?.record({ code: 'budget', message: `脚本引用链达到文件、文本或探测预算，当前图可能不完整；文件上限为 ${this.maxFiles}，可检查 wxml.maxScriptFiles。`, uri: entry });
    this.program = source ? { program, entry: source } : undefined;
    for (const dependency of this.files?.dependencies ?? []) this.revisions.set(dependency.uri, dependency.revision);
    if (revision && this.program && !this.exhausted && !this.cancelled) {
      if (this.sources.has(this.request.document.uri)) this.revisions.set(this.request.document.uri, revision(this.request.document.uri));
      const weight = [...this.documents.values()].reduce((total, document) => total + (document?.text.length ?? 0), 0);
      if (weight <= 8_000_000 && [...this.revisions].every(([uri, version]) => revision(uri) === version)) {
        const entries = (projectCaches.get(revision) ?? []).filter((item) => item.key !== key);
        entries.push({ key, input, documents: this.documents, sources: this.sources, resolutions: this.resolutions, mapped: this.mapped, revisions: this.revisions, options: this.options, program: this.program, weight });
        while (entries.length > 4 || entries.reduce((total, item) => total + item.weight, 0) > 8_000_000) entries.shift();
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
