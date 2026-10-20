import type { Completion, Definition, LanguageRequest, ProjectFileResolver, TextRange, WorkspaceReader, WorkspaceText } from '../../api';
import { parseStylesheet, symbolName } from './parser';
import { baseName, dialectOf, isLocalReference, joinUri, parentUri } from './uri';
import type { CssOptions, Dialect, ImportEdge, StyleIndex, StyleSymbol, SymbolReference } from './types';

/** 一次请求的样式图，文件读取、图边、循环集合和预算均按请求隔离。 */
export class StyleProject {
  private readonly texts = new Map<string, Promise<WorkspaceText | undefined>>();
  private readonly indexes = new Map<string, StyleIndex>();
  private readonly edges = new Map<ImportEdge, Promise<readonly StyleIndex[]>>();
  private readonly maxFiles: number;
  private readonly workspaceRoot: string;
  private sourceRoot: Promise<string> | undefined;
  private bytes = 0;
  private exhausted = false;
  private readonly files: ProjectFileResolver | undefined;

  /** 文件读取通过端口注入，内存测试与真实编辑器使用相同解析流程。 */
  constructor(private readonly reader: WorkspaceReader, readonly request: LanguageRequest, private readonly options: CssOptions = {}) {
    this.files = reader.fileResolver?.(request.document.uri, request.cancellation);
    this.maxFiles = Number.isFinite(options.maxFiles) ? Math.max(1, Math.min(2000, options.maxFiles!)) : 300;
    this.workspaceRoot = reader.root(request.document.uri) ?? parentUri(request.document.uri);
    this.texts.set(request.document.uri, Promise.resolve({ text: request.document.text, version: request.document.version }));
  }

  /** 请求取消后不再访问文件或生成结果。 */
  private get cancelled(): boolean {
    return this.request.cancellation.isCancellationRequested;
  }

  /** 对缺失文件同样缓存，限制路径探测次数与文本总量。 */
  private async read(uri: string): Promise<WorkspaceText | undefined> {
    if (this.cancelled) return undefined;
    if (!this.texts.has(uri)) {
      if (this.texts.size >= this.maxFiles * 12 + 64) { this.exhausted = true; this.reader.navigation?.record({ code: 'budget', message: '样式路径探测达到上限，后续引用未检查。', uri }); return undefined; }
      this.texts.set(uri, this.reader.read(uri).then((value) => {
        if (!value || this.cancelled) return undefined;
        if (value.text.length > 2_000_000 || this.bytes + value.text.length > 8_000_000) { this.exhausted = true; this.reader.navigation?.record({ code: 'budget', message: '样式文本超过单文件或总量上限，后续引用未检查。', uri }); return undefined; }
        this.bytes += value.text.length;
        return value;
      }));
    }
    return this.texts.get(uri);
  }

  /** 按需索引实际访问的样式文件，禁止扫描整个工作区。 */
  async index(uri: string): Promise<StyleIndex | undefined> {
    if (this.cancelled) return undefined;
    if (this.indexes.has(uri)) return this.indexes.get(uri);
    if (this.indexes.size >= this.maxFiles) { this.exhausted = true; this.reader.navigation?.record({ code: 'budget', message: `样式图达到 ${this.maxFiles} 份文件上限，可检查 css.maxFiles。`, uri }); return undefined; }
    const content = await this.read(uri);
    if (!content || this.cancelled || content.text.length > 2_000_000) return undefined;
    const language = uri === this.request.document.uri ? this.request.document.languageId : undefined;
    const dialect = language && ['css', 'wxss', 'scss', 'less'].includes(language) ? language as Dialect : dialectOf(uri);
    const index = parseStylesheet(uri, content, dialect);
    this.indexes.set(uri, index);
    return index;
  }

  /** 寻找最近的小程序入口，显式配置优先且不会执行配置脚本。 */
  private root(): Promise<string> {
    this.sourceRoot ??= this.findRoot();
    return this.sourceRoot;
  }

  /** 向上搜索在所属工作区终止，避免借用相邻项目的全局样式。 */
  private async findRoot(): Promise<string> {
    if (this.options.sourceRoot) return joinUri(this.workspaceRoot, this.options.sourceRoot.replace(/^\//, ''));
    let directory = parentUri(this.request.document.uri);
    for (let depth = 0; depth < 40 && !this.cancelled; depth++) {
      for (const name of ['app.json', 'app.config.ts', 'app.config.js']) {
        if (await this.read(joinUri(directory, name))) return directory;
      }
      if (directory.replace(/\/$/, '') === this.workspaceRoot.replace(/\/$/, '')) break;
      const parent = parentUri(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return this.workspaceRoot;
  }

  /** 解析文件、Sass partial 和目录入口；各候选均需实际存在。 */
  private async candidates(base: string, from: string): Promise<readonly StyleIndex[]> {
    const dialect = dialectOf(from);
    const name = baseName(base);
    const directory = parentUri(base);
    const explicit = /\.(?:css|wxss|scss|less)$/.test(name);
    const extensions = dialect === 'scss' ? ['.scss', '.css'] : dialect === 'less' ? ['.less', '.css'] : [`.${dialect}`];
    const direct = explicit ? [base] : extensions.map((extension) => base + extension);
    if (dialect === 'scss') direct.push(...(explicit ? [joinUri(directory, '_' + name)] : extensions.map((extension) => joinUri(directory, '_' + name + extension))));
    const found: StyleIndex[] = [];
    for (const uri of new Set(direct)) {
      const value = await this.index(uri);
      if (value) found.push(value);
    }
    if (found.length || explicit) return found;
    for (const extension of extensions) {
      for (const file of dialect === 'scss' ? [`_index${extension}`, `index${extension}`] : [`index${extension}`]) {
        const value = await this.index(joinUri(base, file));
        if (value) found.push(value);
      }
    }
    return found;
  }

  /** 同一条导入边只解析一次，远程 URL 和动态路径直接忽略。 */
  async targets(index: StyleIndex, edge: ImportEdge): Promise<readonly StyleIndex[]> {
    if (!this.edges.has(edge)) this.edges.set(edge, this.resolve(index, edge));
    return this.edges.get(edge)!;
  }

  /** 路径按相对文件、配置搜索目录的顺序解析，不做全库猜测。 */
  private async resolve(index: StyleIndex, edge: ImportEdge): Promise<readonly StyleIndex[]> {
    if (this.cancelled || !isLocalReference(edge.reference) && !this.files) return [];
    const roots = !isLocalReference(edge.reference) ? [] : edge.reference.startsWith('/') ? [await this.root()] : [parentUri(index.uri), ...(this.options.includePaths ?? []).map((value) => joinUri(this.workspaceRoot, value))];
    const reference = edge.reference.replace(/^\//, '');
    const original = roots.map((root) => joinUri(root, reference));
    const configured = await this.files?.candidates(edge.reference, index.uri, 'style') ?? [];
    const candidates = this.options.sourceRoot || this.options.includePaths?.length ? [...original, ...configured] : [...configured, ...original];
    for (const candidate of new Set(candidates)) {
      const found = await this.candidates(candidate, index.uri);
      if (found.length) return found;
    }
    this.reader.navigation?.record({ code: 'missing', message: `样式导入 ${edge.reference} 未找到对应源码。`, uri: index.uri });
    return [];
  }

  /** WXML 仅从同名样式和所属小程序 app 样式建立类名可见图。 */
  async templateRoots(includeGlobal = true): Promise<readonly StyleIndex[]> {
    const uri = this.request.document.uri;
    if (!/\.wxml$/i.test(new URL(uri).pathname)) return [];
    const base = uri.replace(/\.wxml$/i, '');
    const global = includeGlobal ? joinUri(await this.root(), 'app') : undefined;
    const result: StyleIndex[] = [];
    for (const candidate of new Set([base, ...global ? [global] : []])) {
      for (const extension of ['.wxss', '.scss', '.less', '.css']) {
        const index = await this.index(candidate + extension);
        if (index) result.push(index);
      }
    }
    return result;
  }

  /** 完整样式依赖保留局部与全局传播路径，缺失引用不能静默跳过。 */
  async extractionStyles(includeGlobal = true) {
    const classes = new Set<string>(), issues = new Set<string>();
    const files = new Map<string, { uri: string; text: string; version?: number; selectors: readonly string[]; local: boolean }>();
    const base = this.request.document.uri.replace(/\.wxml$/i, '');
    const visited = new Set<string>();
    /** 相同文件允许同时由全局和局部导入，二次访问升级归属而不重复解析。 */
    const visit = async (index: StyleIndex, local: boolean): Promise<void> => {
      const key = index.uri + ':' + local;
      if (visited.has(key) || this.cancelled) return;
      visited.add(key);
      if (visited.size > this.maxFiles * 2) { this.exhausted = true; return; }
      const selectors = index.selectors.map((range) => index.text.slice(range.start, range.end));
      if (selectors.some((selector) => /[#$@]\{/.test(selector))) issues.add(`样式 ${index.uri} 包含动态选择器，不能完整枚举外部样式类。`);
      if (selectors.some((selector) => selector.includes('\\'))) issues.add(`样式 ${index.uri} 包含转义选择器，尚不能完整枚举外部样式类。`);
      const balance: string[] = [];
      for (const token of index.tokens) if (token.kind === 'punctuation') {
        if (['{', '(', '['].includes(token.value)) balance.push(token.value);
        else if (['}', ')', ']'].includes(token.value) && balance.pop() !== ({ '}': '{', ')': '(', ']': '[' } as Record<string, string>)[token.value]) issues.add(`样式 ${index.uri} 包含未配对的结构。`);
      }
      if (balance.length) issues.add(`样式 ${index.uri} 包含未闭合的结构。`);
      files.set(index.uri, { uri: index.uri, text: index.text, ...(index.version === undefined ? {} : { version: index.version }), selectors, local: local || files.get(index.uri)?.local === true });
      for (const symbol of index.symbols) if (symbol.kind === 'class') classes.add(symbol.name);
      for (const edge of index.imports) {
        // Sass 内置函数模块不加载用户样式；meta 的样式加载仍需单独分析。
        if (index.dialect === 'scss' && edge.kind !== 'import' && /^sass:(?:math|string|color|list|map|selector)$/.test(edge.reference)) continue;
        const raw = index.tokens.find((token) => token.kind === 'string' && token.value === '' && token.start <= edge.range.start && edge.range.start < token.end);
        if (/[#$@]\{/.test(edge.reference) || raw && /[#$@]\{/.test(index.text.slice(raw.start, raw.end))) { issues.add(`样式 ${index.uri} 包含动态导入。`); continue; }
        if (/^(?:[\w+.-]+:|\/\/)/.test(edge.reference)) { issues.add(`样式 ${index.uri} 引用外部样式，无法完整分析作用域。`); continue; }
        const targets = await this.targets(index, edge);
        if (!targets.length) issues.add(`样式 ${index.uri} 的导入 ${edge.reference} 没有找到完整源码。`);
        for (const target of targets) await visit(target, local);
      }
    };
    for (const root of await this.templateRoots(includeGlobal)) await visit(root, root.uri.replace(/\.(?:wxss|scss|less|css)$/i, '') === base);
    if (this.exhausted) issues.add('样式图达到解析预算，不能生成缺少依赖的组件提取。');
    if (this.cancelled) issues.add('样式依赖分析已取消。');
    return { classes: [...classes], files: [...files.values()], issues: [...issues] };
  }

  /** 将声明转换为公共定义契约，打开文档携带版本号。 */
  private definition(index: StyleIndex, symbol: StyleSymbol, originRange: TextRange): Definition {
    return { uri: index.uri, range: symbol.range, originRange, ...(index.version !== undefined ? { version: index.version } : {}) };
  }

  /** 导航与补全共用静态导入遍历、取消信号及文件预算。 */
  private async visit(roots: readonly StyleIndex[], inspect: (index: StyleIndex) => void): Promise<void> {
    const visited = new Set<string>();
    /** 每个文件只访问一次，循环导入不会无限递归。 */
    const visit = async (index: StyleIndex): Promise<void> => {
      if (visited.has(index.uri) || visited.size >= this.maxFiles || this.cancelled) return;
      visited.add(index.uri);
      inspect(index);
      for (const edge of index.imports) for (const target of await this.targets(index, edge)) await visit(target);
    };
    for (const root of roots) await visit(root);
  }

  /** 类和 CSS 自定义属性跨所有静态导入可见，多处声明保留全部候选。 */
  async collect(roots: readonly StyleIndex[], reference: SymbolReference): Promise<readonly Definition[]> {
    const result: Definition[] = [];
    await this.visit(roots, (index) => {
      for (const symbol of index.symbols) {
        if (symbol.kind === reference.kind && symbol.name === reference.name) result.push(this.definition(index, symbol, reference.range));
      }
    });
    return this.unique(result);
  }

  /** 按输入前缀补全可见类名，同名声明只显示一个候选。 */
  async completeClasses(prefix: string, range: TextRange): Promise<readonly Completion[]> {
    const result = new Map<string, Completion>();
    await this.visit(await this.templateRoots(), (index) => {
      for (const symbol of index.symbols) {
        if (symbol.kind !== 'class' || !symbol.name.startsWith(prefix) || result.has(symbol.name)) continue;
        result.set(symbol.name, { label: symbol.name, kind: 'value', detail: '样式类名', documentation: `样式文件：${index.uri}`, insertText: symbol.name, range });
      }
    });
    return this.cancelled ? [] : [...result.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  /** 查询模块出口，@use 的成员不会自动变为当前模块的公开成员。 */
  private async exported(index: StyleIndex, reference: SymbolReference, seen: Set<string>, publicOnly: boolean): Promise<readonly Definition[]> {
    const key = `${index.uri}:${reference.kind}:${reference.name}:${publicOnly}`;
    if (seen.has(key) || seen.size >= this.maxFiles || this.cancelled || publicOnly && /^[_-]/.test(reference.name)) return [];
    seen.add(key);
    const local = index.symbols.filter((symbol) => symbol.scope.start === 0 && symbol.name === reference.name && symbol.kind === reference.kind);
    const imported = index.imports.filter((edge) => edge.scope.start === 0 && edge.kind === 'import');
    const declarations = [...local.map((symbol) => ({ offset: symbol.range.start, symbol })), ...imported.map((edge) => ({ offset: edge.range.start, edge }))].sort((left, right) => right.offset - left.offset);
    for (const declaration of declarations) {
      if ('symbol' in declaration) return [this.definition(index, declaration.symbol, reference.range)];
      const found: Definition[] = [];
      for (const target of await this.targets(index, declaration.edge)) found.push(...await this.exported(target, reference, seen, publicOnly));
      if (found.length) return found;
    }
    const result: Definition[] = [];
    for (const edge of [...index.imports].reverse()) {
      if (edge.kind !== 'forward' || edge.scope.start !== 0) continue;
      if (edge.prefix && !reference.name.startsWith(symbolName(edge.prefix, index.dialect))) continue;
      // show/hide 针对转发后的公开名称匹配，随后再去掉转发前缀。
      const member = `${reference.kind === 'variable' ? '$' : ''}${reference.name}`;
      if (edge.hide?.includes(member) || edge.show && !edge.show.includes(member)) continue;
      const name = edge.prefix ? reference.name.slice(edge.prefix.length) : reference.name;
      for (const target of await this.targets(index, edge)) {
        result.push(...await this.exported(target, { ...reference, name }, seen, publicOnly || edge.kind === 'forward'));
      }
    }
    return result;
  }

  /** 按词法作用域和导入位置查找变量、混入及函数。 */
  async resolveSymbol(index: StyleIndex, reference: SymbolReference): Promise<readonly Definition[]> {
    if (reference.kind === 'class' || reference.kind === 'custom-property') return this.collect([index], reference);
    const offset = this.request.offset;
    const visible = (scope: TextRange): boolean => scope.start <= offset && offset <= scope.end;
    const local = reference.namespace ? [] : index.symbols.filter((symbol) => symbol.name === reference.name && symbol.kind === reference.kind && visible(symbol.scope) && (index.dialect === 'less' || symbol.range.start <= offset));
    const edges = index.imports.filter((edge) => edge.kind !== 'forward' && visible(edge.scope) && (index.dialect === 'less' || edge.range.start <= offset) && (edge.kind === 'use' ? edge.namespace === (reference.namespace ?? '*') : !reference.namespace));
    const entries = [...local.map((symbol) => ({ scope: symbol.scope, offset: symbol.range.start, symbol })), ...edges.map((edge) => ({ scope: edge.scope, offset: edge.range.start, edge }))]
      .sort((left, right) => right.scope.start - left.scope.start || right.offset - left.offset);
    for (const entry of entries) {
      if ('symbol' in entry) return [this.definition(index, entry.symbol, reference.range)];
      const result: Definition[] = [];
      for (const target of await this.targets(index, entry.edge)) result.push(...await this.exported(target, reference, new Set(), entry.edge.kind === 'use'));
      if (result.length) return this.unique(result);
    }
    return [];
  }

  /** 菱形导入只返回同一原始位置一次；取消后不交付部分结果。 */
  private unique(definitions: readonly Definition[]): readonly Definition[] {
    if (this.cancelled) return [];
    return [...new Map(definitions.map((item) => [`${item.uri}:${item.range.start}:${item.range.end}`, item])).values()];
  }
}
