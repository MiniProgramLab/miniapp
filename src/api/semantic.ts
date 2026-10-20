import type { Definition, TextRange, WorkspaceText } from './index';

/** 静态字符串保留字面量来源及拼接偏移，编辑器只能修改可核验的原文。 */
export interface StaticString {
  readonly text: string;
  readonly complete: boolean;
  readonly sources?: readonly { readonly uri: string; readonly range: TextRange; readonly offset: number }[];
}

/** 声明宏通过导入符号和字段路径适配，规则来自设置或外部扩展。 */
export interface ScriptAdapter {
  readonly name: string;
  readonly module?: string;
  readonly kind: 'page' | 'component' | 'behavior';
  readonly argument?: number;
  readonly data?: string;
  readonly properties?: string;
  readonly methods?: string;
  readonly setup?: string;
  readonly config?: string;
  readonly components?: string;
  /** 声明式页面查询参数所在的字段路径，沿用构造器及 type/value 元数据。 */
  readonly query?: string;
}

/** 模板中的 WXS 模块，内联源码保留真实文档偏移。 */
export interface ScriptModule {
  readonly name: string;
  readonly uri: string;
  readonly reference?: string;
  readonly nameRange: TextRange;
  readonly inline?: WorkspaceText & { readonly range: TextRange };
}

/** 跨解析程序传递静态事件类型，不携带编译器对象。 */
export interface SemanticType {
  readonly display: string;
  readonly kind: 'unknown' | 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'undefined' | 'function';
  readonly properties?: Readonly<Record<string, SemanticType>>;
  readonly alternatives?: readonly SemanticType[];
  readonly element?: SemanticType;
  readonly optional?: boolean;
  readonly literal?: string | number | boolean;
}

/** 事件处理函数只检查可确认的参数，未标注的 any 不产生误报。 */
export interface HandlerSignature {
  readonly parameters: readonly { readonly optional: boolean; readonly type: SemanticType }[];
}

/** 修改由宿主转换为原生工作区编辑，版本用于阻止过期重命名。 */
export interface TextEdit {
  readonly uri: string;
  readonly range: TextRange;
  readonly newText: string;
  readonly version?: number;
  readonly oldText?: string;
  /** 插入位置没有原始字符，用整份快照保护尚未保存到缓冲区的修改坐标。 */
  readonly expectedText?: string;
  /** 创建不存在的关联配置文件；宿主禁止覆盖已有文件。 */
  readonly create?: boolean;
}

/** 提取组件通过父方法接收原始事件，保留处理函数的 this 和节点数据。 */
export interface EventForwarding {
  readonly bindings: readonly { readonly handler: string; readonly method: string; readonly event: string }[];
  readonly edits: readonly TextEdit[];
}

/** 组件提取需要确认消费文件、样式隔离和节点边界，不执行页面代码。 */
export interface ComponentExtractionScope {
  readonly uri: string;
  readonly language: 'typescript' | 'javascript';
  readonly globalStyles: boolean;
  readonly externalClasses: readonly string[];
  readonly nodeQueries: readonly { readonly name: string; readonly selectors: readonly string[] }[];
  readonly issues: readonly string[];
}

/** 重命名准备阶段确认完整符号范围及实际语义目标。 */
export interface RenameTarget {
  readonly range: TextRange;
  readonly name: string;
  readonly definitions: readonly Definition[];
}

/** 引用位置不包含编辑内容，可直接用于编辑器原生引用面板。 */
export interface Reference {
  readonly uri: string;
  readonly range: TextRange;
  readonly version?: number;
}

/** 语言诊断使用普通文本及偏移，由编辑器负责显示。 */
export interface Diagnostic {
  readonly range: TextRange;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly code?: string;
}

/** 原生快速修复和重构共用工作区编辑，语言层不直接写入文件。 */
export interface CodeAction {
  readonly title: string;
  readonly kind: 'quickfix' | 'refactor.extract';
  readonly range: TextRange;
  readonly edits: readonly TextEdit[];
  /** 重构编辑通过原生预览确认，普通快速修复保持原有应用方式。 */
  readonly preview?: boolean;
  /** 无法证明安全时保留具体原因，不生成部分修改。 */
  readonly disabled?: string;
  /** 名称和目标路径由用户输入，生成阶段使用新的取消信号。 */
  readonly input?: {
    readonly title: string;
    readonly value: string;
    readonly prompt?: string;
    validate(value: string): string | undefined;
    select(value: string, cancellation: import('./index').LanguageRequest['cancellation']): Promise<readonly TextEdit[]>;
  };
  /** 需要选择真实资源时由宿主显示列表，选定后才生成编辑。 */
  readonly choice?: {
    readonly title: string;
    readonly items: readonly { readonly label: string; readonly value: string; readonly description?: string }[];
    select(value: string): Promise<readonly TextEdit[]>;
  };
}

/** 表达式检查的静态结果，同时供模板诊断、参数检查和快速修复使用。 */
export interface ExpressionInfo {
  readonly type: SemanticType;
  readonly diagnostics: readonly Diagnostic[];
  readonly actions: readonly CodeAction[];
}

/** dataset 访问保留处理函数身份和路径，模板模块负责确认实际事件节点。 */
export interface DatasetAccess {
  readonly handler: Definition;
  readonly source: 'target' | 'currentTarget';
  readonly path: readonly string[];
  readonly range: TextRange;
  /** 解构简写改名保留局部变量，动态下标会阻止生成不完整编辑。 */
  readonly shorthand?: boolean;
  readonly dynamic?: boolean;
}

/** 函数签名由语言模块投影为文本，宿主只负责显示参数提示。 */
export interface CallSignature {
  readonly label: string;
  readonly documentation: string;
  readonly parameters: readonly { readonly label: string; readonly documentation: string }[];
}

/** 组件查询保留 this 所属函数，静态别名和数组元素共用选择器来源。 */
export interface InstanceAccess {
  readonly owner: Definition;
  readonly selectors: readonly string[];
  readonly path: readonly string[];
  readonly range: TextRange;
  readonly intent: 'selector' | 'member' | 'call';
  readonly argument?: number;
  /** 更新对象的简写变量与转义路径在字段改名后仍保留原有含义。 */
  readonly renameSuffix?: string;
  /** 导出的配置或函数可能被多个页面复用，不能只检查同名模板。 */
  readonly shared?: boolean;
}
