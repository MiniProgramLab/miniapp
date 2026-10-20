import type { LanguageRequest, ProjectFileResolver, ScriptDefinitionResolver, TemplateContext, TemplateExpression, TemplateScope, WorkspaceReader, WorkspaceText } from '../../api';
import { attribute, localBindings, ownerAt, templateData, templateNodes } from './template-document';
import type { TemplateNode } from './template-document';

/** 工作区反向模板索引的读取预算。 */
export interface TemplateOptions {
  readonly maxFiles?: number;
}

/** 一份模板快照及其中的结构和已解析引用。 */
interface TemplateDocument extends WorkspaceText {
  readonly uri: string;
  readonly nodes: readonly TemplateNode[];
  readonly imports: string[];
  readonly includes: { readonly target: string; readonly node: TemplateNode }[];
}

/** 一条静态调用边指向调用文件和对应标签。 */
interface TemplateCall {
  readonly document: TemplateDocument;
  readonly node: TemplateNode;
  readonly transfer: boolean;
}

/** 请求级模板引用图，只沿真实 include 和 template 调用追踪上下文。 */
class TemplateProject {
  private readonly documents = new Map<string, TemplateDocument | undefined>();
  private readonly maxFiles: number;
  private bytes = 0;
  private paths = 0;
  private readonly incoming = new Map<string, TemplateCall[]>();
  private readonly roots = new Map<string, string>();
  private readonly markers = new Map<string, boolean>();
  private readonly files: ProjectFileResolver | undefined;

  /** 当前文档快照始终优先于文件系统或编辑器的后续内容。 */
  constructor(private readonly reader: WorkspaceReader, private readonly request: LanguageRequest, settings: TemplateOptions) {
    this.files = reader.fileResolver?.(request.document.uri, request.cancellation);
    this.maxFiles = Number.isFinite(settings.maxFiles) ? Math.max(1, Math.min(2000, settings.maxFiles!)) : 500;
  }

  /** 读取并缓存缺失文件，限定模板数量和文本量。 */
  private async read(uri: string): Promise<TemplateDocument | undefined> {
    if (this.request.cancellation.isCancellationRequested) return undefined;
    if (this.documents.has(uri)) return this.documents.get(uri);
    if (this.documents.size >= this.maxFiles) { this.reader.navigation?.record({ code: 'budget', message: `模板图达到 ${this.maxFiles} 份文件上限，调用上下文可能不完整；可检查 wxml.maxTemplateFiles。`, uri }); return undefined; }
    const snapshot = uri === this.request.document.uri ? this.request.document : await this.reader.read(uri);
    if (this.request.cancellation.isCancellationRequested) return undefined;
    if (!snapshot || snapshot.text.length > 2_000_000 || this.bytes + snapshot.text.length > 8_000_000) {
      if (snapshot) this.reader.navigation?.record({ code: 'budget', message: '模板文本超过单文件或总量上限，未继续展开。', uri });
      this.documents.set(uri, undefined);
      return undefined;
    }
    this.bytes += snapshot.text.length;
    const document: TemplateDocument = { ...snapshot, uri, nodes: templateNodes(snapshot.text), imports: [], includes: [] };
    this.documents.set(uri, document);
    return document;
  }

  /** 从最近 app 标记识别小程序根目录，目录探测在请求内复用。 */
  private async sourceRoot(uri: string): Promise<string | undefined> {
    const root = this.reader.root(uri)?.replace(/\/$/, '');
    if (!root) return undefined;
    let current = new URL('./', uri).toString().replace(/\/$/, '');
    const visited: string[] = [];
    let result = root;
    for (let depth = 0; depth < 40 && (current === root || current.startsWith(root + '/')); depth++) {
      if (this.request.cancellation.isCancellationRequested) return undefined;
      const cached = this.roots.get(current);
      if (cached) { result = cached; break; }
      visited.push(current);
      let marker = this.markers.get(current);
      if (marker === undefined && this.markers.size < this.maxFiles * 4) {
        marker = false;
        for (const name of ['app.json', 'app.config.ts', 'app.config.js']) {
          if (await this.reader.read(`${current}/${name}`)) { marker = true; break; }
        }
        this.markers.set(current, marker);
      }
      if (marker) { result = current; break; }
      if (current === root) break;
      current = new URL('../', current + '/').toString().replace(/\/$/, '');
    }
    for (const directory of visited) this.roots.set(directory, result);
    return result;
  }

  /** 模板只读取静态本地引用，绝对路径从最近的小程序根目录开始。 */
  private async target(document: TemplateDocument, node: TemplateNode): Promise<string | undefined> {
    const path = attribute(document.text, node, 'src');
    if (!path || /^(?:[\w+.-]+:|\/\/)/.test(path) || /[?#]/.test(path)) return undefined;
    const root = path.startsWith('/') ? await this.sourceRoot(document.uri) : undefined;
    if (path.startsWith('/') && !root) return undefined;
    const uri = new URL(path.startsWith('/') ? path.slice(1) : path, path.startsWith('/') ? root!.replace(/\/$/, '') + '/' : document.uri).toString();
    const resolved = await this.files?.candidates(path, document.uri, 'component') ?? [];
    const candidates = [...resolved, uri].map((candidate) => /\.wxml$/i.test(candidate) ? candidate : candidate + '.wxml');
    for (const candidate of candidates) if (await this.read(candidate)) return candidate;
    return undefined;
  }

  /** 文件枚举只建立调用关系，不将未引用页面的同名脚本成员作为候选。 */
  private async index(): Promise<void> {
    await this.read(this.request.document.uri);
    if (this.request.cancellation.isCancellationRequested) return;
    const files = await this.reader.findFiles?.(this.request.document.uri, '**/*.wxml', this.maxFiles) ?? [];
    for (const uri of files) {
      if (this.request.cancellation.isCancellationRequested) return;
      await this.read(uri);
    }
    // Map 迭代会包含后续发现的直接引用，支持尚未被文件枚举覆盖的模板。
    for (const document of this.documents.values()) {
      if (!document || this.request.cancellation.isCancellationRequested) continue;
      for (const node of document.nodes) {
        if (node.tag.name !== 'import' && node.tag.name !== 'include') continue;
        const target = await this.target(document, node);
        if (!target) continue;
        if (node.tag.name === 'import') document.imports.push(target);
        else document.includes.push({ target, node });
      }
    }
    // 反向边只索引一次，递归追踪不重复扫描所有文件中的调用标签。
    let edges = 0;
    for (const document of this.documents.values()) {
      if (!document || this.request.cancellation.isCancellationRequested) continue;
      for (const include of document.includes) {
        if (++edges > 10000) return;
        this.link(`${include.target}#root`, { document, node: include.node, transfer: false });
      }
      for (const node of document.nodes) {
        if (node.tag.name !== 'template') continue;
        for (const target of this.definitions(document, node)) {
          if (++edges > 10000) return;
          this.link(`${target.document.uri}#${target.node.tag.start}`, { document, node, transfer: true });
        }
      }
    }
  }

  /** 为确定的目标记录实际调用边，保留同文件中的不同调用位置。 */
  private link(key: string, call: TemplateCall): void {
    const incoming = this.incoming.get(key) ?? [];
    incoming.push(call);
    this.incoming.set(key, incoming);
  }

  /** import 仅公开目标文件自身定义的模板，不转发其导入的模板。 */
  private definitions(document: TemplateDocument, call: TemplateNode): { document: TemplateDocument; node: TemplateNode }[] {
    const name = attribute(document.text, call, 'is');
    if (name === undefined) return [];
    const candidates = [document, ...document.imports.flatMap((uri) => this.documents.get(uri) ?? [])];
    return candidates.flatMap((target) => target.nodes
      .filter((node) => node.tag.name === 'template' && attribute(target.text, node, 'name') === name)
      .map((node) => ({ document: target, node })));
  }

  /** 记录当前文件中实际可见的循环，带上原始绑定位置与版本。 */
  private scope(document: TemplateDocument, offset: number): TemplateScope {
    return { uri: document.uri, bindings: localBindings(document.text, document.nodes, offset), ...(document.version === undefined ? {} : { version: document.version }) };
  }

  /** 反向追踪调用位置；不同页面保留候选，循环模板不会无限展开。 */
  private contexts(document: TemplateDocument, offset: number, seen: ReadonlySet<string>): TemplateContext[] {
    if (this.request.cancellation.isCancellationRequested) return [];
    if (++this.paths > 4000 || seen.size >= 32) { this.reader.navigation?.record({ code: 'budget', message: '模板调用路径超过四千条或三十二层上限，后续上下文未展开。' }); return []; }
    const owner = ownerAt(document.text, document.nodes, offset);
    const key = `${document.uri}#${owner?.tag.start ?? 'root'}`;
    if (seen.has(key)) { this.reader.navigation?.record({ code: 'cycle', message: '模板引用形成循环，已终止当前循环分支。', uri: document.uri }); return []; }
    const visited = new Set(seen).add(key);
    const local = this.scope(document, offset);
    const result: TemplateContext[] = owner ? [] : [{ uri: document.uri, scopes: [local] }];
    for (const call of this.incoming.get(key) ?? []) {
      if (result.length >= 64) { this.reader.navigation?.record({ code: 'budget', message: '模板调用来源达到六十四个候选上限，后续来源未展开。' }); break; }
      const caller = call.document;
      const transfer: TemplateScope[] = call.transfer ? [{ uri: caller.uri, bindings: [], data: templateData(caller.text, call.node), ...(caller.version === undefined ? {} : { version: caller.version }) }] : [];
      for (const context of this.contexts(caller, call.node.tag.start, visited)) {
        result.push({ ...context, scopes: [...context.scopes, ...transfer, local] });
        if (result.length >= 64) break;
      }
    }
    return result.slice(0, 64);
  }

  /** 给语义端口传递模板上下文，模板模块不解析 TypeScript。 */
  async expression(expression: TemplateExpression): Promise<TemplateExpression> {
    await this.index();
    const document = this.documents.get(this.request.document.uri);
    const contexts = document ? this.contexts(document, this.request.offset, new Set()) : [];
    if (!contexts.length) this.reader.navigation?.record({ code: 'context', message: '没有找到当前位置对应的实际页面调用及模板传参，不能借用其他页面的同名字段。', uri: this.request.document.uri });
    else this.reader.navigation?.record({ code: 'context', message: `沿实际模板调用得到 ${contexts.length} 个页面上下文。`, uri: this.request.document.uri });
    const bindings = document ? localBindings(document.text, document.nodes, this.request.offset) : expression.bindings;
    return { ...expression, bindings, contexts };
  }
}

/** 组件注册也沿实际模板调用关系获取使用页面，不根据同名标签猜测。 */
export async function componentContexts(reader: WorkspaceReader, request: LanguageRequest, options: TemplateOptions = {}): Promise<readonly TemplateContext[]> {
  const expression = await new TemplateProject(reader, request, options).expression({ text: '', range: { start: request.offset, end: request.offset }, bindings: [] });
  return expression.contexts ?? [];
}

/** 装饰脚本导航端口，使独立模板可通过调用图继承页面上下文。 */
export function createTemplateResolver(reader: WorkspaceReader, scripts: ScriptDefinitionResolver, options: (uri: string) => TemplateOptions = () => ({})): ScriptDefinitionResolver {
  return {
    /** 实例来源和消费模板筛选保留原脚本端口的取消与预算行为。 */
    instanceAccess: (request) => scripts.instanceAccess?.(request),
    /** 选择器列表从实际脚本快照获得。 */
    instanceQueries: (request, members) => scripts.instanceQueries?.(request, members) ?? [],
    /** 不将组件实例绑定到同名但无关的模板文件。 */
    instanceTemplates: (request, owner) => scripts.instanceTemplates?.(request, owner) ?? [],
    /** dataset 的脚本起点直接委托，模板事件节点由独立语义功能确认。 */
    datasetAccess: (request) => scripts.datasetAccess?.(request),
    /** 使用位置按处理函数身份查询，不能按 dataset 字段名全文匹配。 */
    datasetUses: (request, handler) => scripts.datasetUses?.(request, handler) ?? [],
    /** WXS 模块仅在定义它的模板中可见，调用提示不借用其他页面模块。 */
    callSignature: (request, expression) => scripts.callSignature?.(request, expression),
    /** 内联脚本自身不依赖模板传参，诊断使用原始文档快照。 */
    wxsDiagnostics: (request, modules) => scripts.wxsDiagnostics?.(request, modules) ?? [],
    /** 提取依赖由当前位置的词法名称决定，绑定归属留给模板层。 */
    expressionNames: (request, expression) => scripts.expressionNames?.(request, expression) ?? { names: [], complete: false },
    /** 修改当前消费页面的静态配置，不改动被导入的模板文件。 */
    registerComponent: (request, name, reference) => scripts.registerComponent?.(request, name, reference) ?? [],
    /** 转发方法写入当前消费页面，不修改 Behavior 或共享模板源码。 */
    extractComponentParent: (request, name, reference, handlers) => scripts.extractComponentParent?.(request, name, reference, handlers),
    /** 提取仍以当前消费文件为注册及样式作用域。 */
    componentExtractionScope: (request) => scripts.componentExtractionScope?.(request),
    /** 具名模板检查实际调用参数，普通页面优先复用直接脚本语义图。 */
    async analyze(request, expression) {
      if (request.cancellation.isCancellationRequested || !scripts.analyze) return undefined;
      if (!ownerAt(request.document.text, templateNodes(request.document.text), request.offset)) {
        const direct = await scripts.analyze(request, expression);
        if (direct || request.cancellation.isCancellationRequested) return direct;
      }
      return scripts.analyze(request, await new TemplateProject(reader, request, options(request.document.uri)).expression(expression));
    },
    /** 普通页面优先直接补全，具名模板和独立片段沿实际调用图传递作用域。 */
    async complete(request, expression) {
      if (request.cancellation.isCancellationRequested || !scripts.complete) return [];
      if (!ownerAt(request.document.text, templateNodes(request.document.text), request.offset)) {
        const direct = await scripts.complete(request, expression);
        if (direct.length || request.cancellation.isCancellationRequested) return direct;
      }
      return scripts.complete(request, await new TemplateProject(reader, request, options(request.document.uri)).expression(expression));
    },
    /** 原生脚本起点和编辑生成直接复用脚本端口。 */
    scriptSymbols: (request) => scripts.scriptSymbols?.(request) ?? [],
    /** 模板重命名也使用现有脚本编辑生成器。 */
    rename: (request, targets, newName) => scripts.rename?.(request, targets, newName) ?? [],
    /** 模板引用面板使用同一脚本图查找声明的实际调用。 */
    references: (request, targets, includeDeclaration) => scripts.references?.(request, targets, includeDeclaration) ?? [],
    /** 字段重命名保留模板 data 和循环的实际作用域。 */
    async symbols(request, expression) {
      if (request.cancellation.isCancellationRequested || !scripts.symbols) return [];
      if (!ownerAt(request.document.text, templateNodes(request.document.text), request.offset)) {
        const direct = await scripts.symbols(request, expression);
        if (direct.length || request.cancellation.isCancellationRequested) return direct;
      }
      return scripts.symbols(request, await new TemplateProject(reader, request, options(request.document.uri)).expression(expression));
    },
    /** 独立模板事件的参数来自真实调用页面，不能借用同名无关方法。 */
    async signature(request, expression) {
      if (request.cancellation.isCancellationRequested || !scripts.signature) return [];
      if (!ownerAt(request.document.text, templateNodes(request.document.text), request.offset)) {
        const direct = await scripts.signature(request, expression);
        if (direct.length || request.cancellation.isCancellationRequested) return direct;
      }
      return scripts.signature(request, await new TemplateProject(reader, request, options(request.document.uri)).expression(expression));
    },
    /** 引用图与脚本解析共享取消信号，不在语言模块间建立实现依赖。 */
    async resolve(request, expression) {
      if (request.cancellation.isCancellationRequested) return [];
      // 普通页面已有同名脚本时复用直接导航，不为每次 F12 枚举工作区。
      if (!ownerAt(request.document.text, templateNodes(request.document.text), request.offset)) {
        const direct = await scripts.resolve(request, expression);
        if (direct.length || request.cancellation.isCancellationRequested) return direct;
      }
      const resolved = await new TemplateProject(reader, request, options(request.document.uri)).expression(expression);
      return request.cancellation.isCancellationRequested ? [] : scripts.resolve(request, resolved);
    },
    /** 悬浮沿真实调用图直接读取原声明注释，导航仍保留逐层 data 字段跳转。 */
    async hover(request, expression) {
      if (request.cancellation.isCancellationRequested || !scripts.hover) return undefined;
      if (!ownerAt(request.document.text, templateNodes(request.document.text), request.offset)) {
        const direct = await scripts.hover(request, expression);
        if (direct || request.cancellation.isCancellationRequested) return direct;
      }
      const resolved = await new TemplateProject(reader, request, options(request.document.uri)).expression(expression);
      return request.cancellation.isCancellationRequested ? undefined : scripts.hover(request, resolved);
    },
  };
}
