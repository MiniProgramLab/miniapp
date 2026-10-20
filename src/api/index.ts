export type { FileReference, FileReferenceKind, ProjectFileResolver } from './files';
export type { NavigationStep, NavigationTracking, NavigationReport } from './navigation';
export type { CheckProvider, CheckFile, CheckFinding, CheckIssue, CheckReport, CheckOptions, CheckResult } from './checks';
export type { OutlineSymbol, FoldingRegion } from './structure';
import type { OutlineSymbol, FoldingRegion } from './structure';
export type { RouteAccess, RouteManifest, RouteResult, RouteResolver, RouteContextResolver, PageQuery } from './routes';
import type { RouteAccess, RouteManifest } from './routes';
import type { ProjectFileResolver } from './files';
export type { ComponentMember, ComponentLocation, ComponentProperty, ComponentEvent, ComponentScriptInfo, ComponentScriptResolver, ComponentResolver, ComponentUsages } from './components';
export type { EventForwarding, StaticString, InstanceAccess, CallSignature, DatasetAccess, ScriptAdapter, ScriptModule, SemanticType, HandlerSignature, TextEdit, RenameTarget, Diagnostic, Reference, CodeAction, ExpressionInfo } from './semantic';
import type { InstanceAccess, CallSignature, DatasetAccess, ScriptModule, HandlerSignature, TextEdit, RenameTarget, Diagnostic, Reference, CodeAction, ExpressionInfo } from './semantic';

/** 可被底座统一释放的资源，不依赖编辑器实现。 */
export interface Disposable {
  /** 释放资源；重复调用应当安全。 */
  dispose(): void;
}

/** 插件所属的资源容器，初始化失败或卸载时自动清理。 */
export interface ResourceScope {
  /** 接管资源，并原样返回以便继续使用。 */
  add<T extends Disposable>(resource: T): T;
}

/** 由宿主实现的日志端口。 */
export interface Logger {
  /** 记录普通运行信息。 */
  info(message: string): void;
  /** 记录错误及可选的异常原因。 */
  error(message: string, error?: unknown): void;
}

/** 基于 UTF-16 偏移的半开区间，与编辑器位置转换保持一致。 */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** 当前请求的只读文档快照，包含尚未保存的文本。 */
export interface DocumentSnapshot {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

/** 编辑器中立的取消信号，异步提供器应定期读取。 */
export interface Cancellation {
  readonly isCancellationRequested: boolean;
}

/** 语言功能的一次调用上下文。 */
export interface LanguageRequest {
  readonly document: DocumentSnapshot;
  readonly offset: number;
  readonly cancellation: Cancellation;
}

/** 支持同步及异步的语言功能结果。 */
export type LanguageResult<T> = T | PromiseLike<T>;

/** 补全内容使用显式文本格式，避免把普通文本意外解释成片段。 */
export interface Completion {
  readonly label: string;
  readonly kind: 'tag' | 'attribute' | 'value';
  readonly detail: string;
  readonly documentation: string;
  readonly insertText: string;
  readonly insertTextFormat?: 'plain' | 'snippet';
  readonly range: TextRange;
}

/** 悬浮说明只承载普通文本，安全渲染由适配层负责。 */
export interface Hover {
  readonly title: string;
  readonly description: string;
  readonly range: TextRange;
}

/** 当前文档中同步编辑的名称范围，正则描述允许保留联动的字符。 */
export interface LinkedEditing {
  readonly ranges: readonly TextRange[];
  readonly wordPattern?: string;
}

/** 跨文件定义位置，保留来源范围及打开文档的版本以排除过期结果。 */
export interface Definition {
  readonly uri: string;
  readonly range: TextRange;
  readonly originRange: TextRange;
  /** 引用处的逻辑名称可与转义原文不同，范围仍指向原始文本。 */
  readonly originName?: string;
  readonly version?: number;
  /** 自定义事件的字符串声明使用事件命名规则，不参与普通字符串替换。 */
  readonly symbolKind?: 'event';
  /** 内联简写字段保留变量绑定，相关字段用于检查名称冲突。 */
  readonly renameSuffix?: string;
  readonly renameConflicts?: readonly string[];
}

/** 工作区文本快照；磁盘文件没有编辑器版本号。 */
export interface WorkspaceText {
  readonly text: string;
  readonly version?: number;
}

/** 语义结果记录实际读取时的依赖修订，供跨请求缓存和诊断刷新校验。 */
export interface WorkspaceDependency {
  readonly uri: string;
  readonly revision: string;
}

/** 文件读取端口由宿主实现，语言模块不直接访问磁盘或编辑器。 */
export interface WorkspaceReader {
  /** 导航说明复用真实解析器；未提供时不会影响既有语言功能。 */
  readonly navigation?: import('./navigation').NavigationTracking;
  /** 可选的异步读取作用域用于精准诊断刷新，外部宿主无需实现。 */
  capture?<T>(provide: () => LanguageResult<T>): Promise<{ readonly value: T; readonly dependencies: readonly WorkspaceDependency[] }>;
  /** 文件或环境变化后通知消费者；没有 URI 表示配置或工作区整体变化。 */
  onDidChange?(listener: (uri?: string, kind?: 'content' | 'structure' | 'open' | 'close' | 'configuration') => void): Disposable;
  /** 同步修订标识覆盖草稿、配置和文件系统变化；未提供时禁用跨请求语义缓存。 */
  revision?(uri: string): string;
  /** 可选的目录探测减少模块解析的无效文件读取，目录内容变化也应更新修订标识。 */
  directory?(uri: string): Promise<boolean>;
  /** 为一次语言查询创建独立的项目配置解析器，兼容未实现此能力的外部宿主。 */
  readonly fileResolver?: (uri: string, cancellation?: Cancellation) => ProjectFileResolver;
  /** 优先读取打开的缓冲区，不存在的文件返回空值。 */
  read(uri: string): Promise<WorkspaceText | undefined>;
  /** 返回当前文件所属工作区根目录的 URI。 */
  root(uri: string): string | undefined;
  /** 可选的工作区文件发现能力，仅枚举指定模式且限制数量。 */
  findFiles?(uri: string, pattern: string, limit: number): Promise<readonly string[]>;
}

/** 模板通过此端口解析样式类，不导入 CSS 模块的内部实现。 */
export interface StyleClassResolver {
  /** 查找样式引用链内的类定义，保留全部候选位置。 */
  resolveClass(request: LanguageRequest, name: string, range: TextRange): LanguageResult<readonly Definition[]>;
  /** 可选的类名补全沿用样式引用链，替换范围由模板提供。 */
  completeClass?(request: LanguageRequest, prefix: string, range: TextRange): LanguageResult<readonly Completion[]>;
  /** 提取重构读取完整样式图，不把可接受部分结果的导航当作迁移依据。 */
  extractionStyles?(request: LanguageRequest, includeGlobal?: boolean): LanguageResult<{
    readonly classes: readonly string[];
    readonly files: readonly { readonly uri: string; readonly text: string; readonly version?: number; readonly selectors: readonly string[]; readonly local: boolean }[];
    readonly issues: readonly string[];
  }>;
}

/** 模板局部绑定记录声明位置，以及循环项对应的集合表达式。 */
export interface TemplateBinding {
  readonly name: string;
  readonly range: TextRange;
  readonly collection?: string;
  readonly kind: 'item' | 'index';
}

/** 模板引用路径上的作用域步骤：先应用循环绑定，再应用显式传参。 */
export interface TemplateScope {
  readonly uri: string;
  readonly bindings: readonly TemplateBinding[];
  readonly version?: number;
  /** 存在此字段代表进入新的模板作用域，text 为空代表未传入数据。 */
  readonly data?: { readonly text: string; readonly range: TextRange };
}

/** 一个真实模板调用位置所对应的页面入口及逐层作用域。 */
export interface TemplateContext {
  readonly uri: string;
  readonly scopes: readonly TemplateScope[];
}

/** 模板提供表达式和局部作用域，具体脚本语法交给脚本解析器。 */
export interface TemplateExpression {
  readonly text: string;
  readonly range: TextRange;
  readonly bindings: readonly TemplateBinding[];
  readonly contexts?: readonly TemplateContext[];
  /** template 的 data 使用对象成员语法，字段名称可继续导航到绑定表达式。 */
  readonly objectLiteral?: boolean;
  /** 静态事件名称绑定页面方法，不使用模板 data 的局部名称。 */
  readonly event?: boolean;
  /** WXS 作用域由模板提供，脚本模块负责解析其实际导出。 */
  readonly modules?: readonly ScriptModule[];
}

/** 模板脚本导航端口，WXML 不直接依赖 TypeScript 编译器。 */
export interface ScriptDefinitionResolver {
  /** 路由 URL 沿常量、导入和静态包装器追踪，普通同名方法不参与。 */
  routeQueries?(request: LanguageRequest, all?: boolean): LanguageResult<readonly RouteAccess[]>;
  /** 应用配置与页面参数沿用脚本静态求值，不执行配置宏。 */
  routeManifest?(request: LanguageRequest, uri: string): LanguageResult<RouteManifest | undefined>;
  /** 页面已声明的 onLoad 参数用于 URL 查询字段提示。 */
  pageQuery?(request: LanguageRequest, uri: string): LanguageResult<import('./routes').PageQuery | undefined>;
  /** 静态组件选择器沿 const 别名和实际 this 作用域识别。 */
  instanceAccess?(request: LanguageRequest): LanguageResult<InstanceAccess | undefined>;
  /** 全文件检查复用脚本图；指定成员名时枚举其实际实例访问并要求完整结果。 */
  instanceQueries?(request: LanguageRequest, members?: readonly string[]): LanguageResult<readonly InstanceAccess[]>;
  /** 根据导入链筛选所属模板，真实函数身份仍由组件元数据确认。 */
  instanceTemplates?(request: LanguageRequest, access: InstanceAccess): LanguageResult<readonly string[]>;
  /** 事件参数、解构及静态局部别名使用真实符号确认 dataset 的来源。 */
  datasetAccess?(request: LanguageRequest): LanguageResult<DatasetAccess | undefined>;
  /** 只查指定处理函数参数的 dataset 使用，排除普通同名对象。 */
  datasetUses?(request: LanguageRequest, handler: Definition): LanguageResult<readonly DatasetAccess[]>;
  /** 解析表达式中的符号，并沿静态脚本引用定位原始声明。 */
  resolve(request: LanguageRequest, expression: TemplateExpression): LanguageResult<readonly Definition[]>;
  /** 可选的声明注释查询，与定义导航共享表达式和模板作用域。 */
  hover?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<Hover | undefined>;
  /** 返回暴露字段本身，重命名不会误改字段背后的不同名函数。 */
  symbols?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<readonly Definition[]>;
  /** 模板内 WXS 成员补全沿用相同模块引用链。 */
  complete?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<readonly Completion[]>;
  /** 事件参数签名与定义查询使用同一真实页面上下文。 */
  signature?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<readonly HandlerSignature[]>;
  /** WXS 调用提示保留参数序号及声明注释，模板负责传入模块作用域。 */
  callSignature?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<{ readonly signatures: readonly CallSignature[]; readonly activeParameter: number } | undefined>;
  /** 所属 WXML 的内联模块诊断映射回原文档，外部文件由独立提供器检查。 */
  wxsDiagnostics?(request: LanguageRequest, modules: readonly ScriptModule[]): LanguageResult<readonly Diagnostic[]>;
  /** 脚本编辑器中的符号也可以进入跨模板重命名链。 */
  scriptSymbols?(request: LanguageRequest): LanguageResult<readonly Definition[]>;
  /** 只生成静态可确认的脚本编辑，不写入工程文件。 */
  rename?(request: LanguageRequest, targets: readonly Definition[], newName: string): LanguageResult<readonly TextEdit[]>;
  /** 静态脚本引用同时包含原生符号及小程序的 this、setData 与 observers 使用。 */
  references?(request: LanguageRequest, targets: readonly Definition[], includeDeclaration: boolean): LanguageResult<readonly Reference[]>;
  /** 类型、未定义名称及快速修复共用一个静态查询，不执行模板或工程代码。 */
  analyze?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<ExpressionInfo | undefined>;
  /** 为当前页面的静态配置注册选中的组件，保留原配置的注释和格式。 */
  registerComponent?(request: LanguageRequest, name: string, reference: string): LanguageResult<readonly TextEdit[]>;
  /** 组件提取合并静态注册及事件转发，未知作用域不生成部分修改。 */
  extractComponentParent?(request: LanguageRequest, name: string, reference: string, handlers: readonly string[]): LanguageResult<import('./semantic').EventForwarding | undefined>;
  /** 读取真实消费脚本的提取边界，未知注册不会采用页面或组件默认值。 */
  componentExtractionScope?(request: LanguageRequest): LanguageResult<import('./semantic').ComponentExtractionScope | undefined>;
  /** 语法级依赖保留真实引用位置，局部循环及模块作用域由模板层判定。 */
  expressionNames?(request: LanguageRequest, expression: TemplateExpression): LanguageResult<{ readonly names: readonly { readonly name: string; readonly range: TextRange; readonly shorthand?: boolean }[]; readonly complete: boolean }>;
}

/** 插件按需提供能力，不必实现与自身无关的方法。 */
export interface LanguageFeatures {
  readonly documentSymbols?: {
    /** 当前文档的大纲不需要扫描工作区或读取关联脚本。 */
    provide(request: LanguageRequest): LanguageResult<readonly OutlineSymbol[]>;
  };
  readonly foldingRanges?: {
    /** 语言模块给出偏移范围，行号由宿主按原始文档换算。 */
    provide(request: LanguageRequest): LanguageResult<readonly FoldingRegion[]>;
  };
  readonly selectionRanges?: {
    /** 每个输入光标对应一条从内到外严格包含的范围链。 */
    provide(request: LanguageRequest, offsets: readonly number[]): LanguageResult<readonly (readonly TextRange[])[]>;
  };
  readonly signatureHelp?: {
    readonly triggerCharacters: readonly string[];
    /** 函数调用的参数位置由语法树计算，类型签名不通过宿主推断。 */
    provide(request: LanguageRequest): LanguageResult<{ readonly signatures: readonly CallSignature[]; readonly activeParameter: number } | undefined>;
  };
  readonly highlights?: {
    /** 当前文档的语义引用高亮不得为光标移动枚举整个工作区。 */
    provide(request: LanguageRequest): LanguageResult<readonly TextRange[]>;
  };
  readonly codeActions?: {
    /** 只返回与当前选区相交的操作，由宿主转换为原生灯泡菜单。 */
    provide(request: LanguageRequest, range: TextRange, kind?: 'quickfix' | 'refactor.extract'): LanguageResult<readonly CodeAction[]>;
  };
  readonly references?: {
    /** 查找真实声明的引用，名称相同但作用域不同的位置不会混入。 */
    provide(request: LanguageRequest, includeDeclaration: boolean): LanguageResult<readonly Reference[]>;
  };
  readonly rename?: {
    /** 在输入新名称前确认使用处及实际声明。 */
    prepare(request: LanguageRequest): LanguageResult<RenameTarget | undefined>;
    /** 返回原生工作区编辑，由编辑器提供预览及撤销。 */
    provide(request: LanguageRequest, newName: string): LanguageResult<readonly TextEdit[]>;
  };
  readonly diagnostics?: {
    /** 依赖语言草稿变化时，重新检查已打开的消费文档。 */
    readonly dependencyLanguages?: readonly string[];
    /** 仅检查当前文档中可静态确认的事件契约。 */
    provide(request: LanguageRequest): LanguageResult<readonly Diagnostic[]>;
  };
  readonly linkedEditing?: {
    /** 返回文本一致且不重叠的关联范围。 */
    provide(request: LanguageRequest): LanguageResult<LinkedEditing | undefined>;
  };
  readonly autoInsertion?: {
    readonly triggerCharacters: readonly string[];
    /** 在单字符输入后的光标处补入普通文本，光标保留在新增文本之前。 */
    provide(request: LanguageRequest): LanguageResult<string | undefined>;
  };
  readonly definition?: {
    /** 将当前位置解析为一个或多个原始定义。 */
    provide(request: LanguageRequest): LanguageResult<readonly Definition[]>;
  };
  readonly completion?: {
    readonly triggerCharacters: readonly string[];
    /** 计算当前光标处的补全项。 */
    provide(request: LanguageRequest): LanguageResult<readonly Completion[]>;
  };
  readonly hover?: {
    /** 计算当前光标处的悬浮说明。 */
    provide(request: LanguageRequest): LanguageResult<Hover | undefined>;
  };
}

/** 描述插件身份及其支持的语言，不携带宿主对象。 */
export interface PluginInfo {
  readonly id: string;
  readonly displayName: string;
  readonly languages: readonly string[];
}

/** 插件只依赖明确的能力端口，不通过服务定位器查找依赖。 */
export interface PluginContext {
  readonly logger: Logger;
  readonly subscriptions: ResourceScope;
}

/** 同一契约适用于内置语言模块和外部扩展。 */
export interface LanguagePlugin extends PluginInfo {
  /** 同步创建提供器；异步工作放在具体能力请求中。 */
  setup(context: PluginContext): LanguageFeatures;
}

/** 底座依赖的编辑器注册端口，由具体宿主适配器实现。 */
export interface LanguageHost {
  /** 注册插件能力，返回可整体撤销的注册句柄。 */
  register(plugin: PluginInfo, features: LanguageFeatures): Disposable;
}

/** activate 返回的公开接口，外部扩展通过版本号确认兼容性。 */
export interface MiniAppApi {
  readonly apiVersion: 1;
  /** 注册语言插件，句柄释放后立即移除其能力。 */
  registerPlugin(plugin: LanguagePlugin): Disposable;
  /** 返回当前已成功注册的插件快照。 */
  getPlugins(): readonly PluginInfo[];
}
