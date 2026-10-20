import type { Completion, Definition, Hover, LanguageRequest, LanguageResult, ScriptDefinitionResolver, WorkspaceDependency } from './index';
import type { CallSignature, CodeAction, Diagnostic, SemanticType } from './semantic';

/** 自定义事件保留所有静态发出位置及各分支的 detail 类型。 */
export interface ComponentEvent {
  readonly name: string;
  readonly description: string;
  readonly details: readonly SemanticType[];
  readonly definitions: readonly ComponentLocation[];
}

/** 组件的实现位置，不携带具体使用处的范围。 */
export type ComponentLocation = Omit<Definition, 'originRange'>;

/** 可传入组件的参数说明及其真实运行时声明。 */
export interface ComponentProperty {
  readonly name: string;
  readonly type: string;
  readonly defaultValue: string;
  readonly required: boolean;
  readonly description: string;
  readonly definitions: readonly ComponentLocation[];
  /** 静态参数契约用于模板赋值检查；旧解析器没有此字段时只显示说明。 */
  readonly valueType?: SemanticType;
}

/** 组件公开实例成员保留数据路径、调用签名和实际实现位置。 */
export interface ComponentMember {
  readonly path: readonly string[];
  readonly type: SemanticType;
  readonly description: string;
  readonly definitions: readonly ComponentLocation[];
  /** 字段声明与其引用的实现分开保存，改名不能修改别名指向的函数。 */
  readonly declarations?: readonly ComponentLocation[];
  readonly signatures?: readonly CallSignature[];
}

/** 脚本模块提供静态组件语义，模板模块负责路径与插槽结构。 */
export interface ComponentScriptInfo {
  readonly dependencies?: readonly WorkspaceDependency[];
  /** 不完整的引用图允许导航已知成员，但不得作为完整语义缓存复用。 */
  readonly complete?: boolean;
  readonly members?: readonly ComponentMember[];
  /** 包含方法及生命周期的函数范围，用于确认 this 查询属于哪一个页面。 */
  readonly instanceOwners?: readonly ComponentLocation[];
  readonly kind?: 'page' | 'component' | 'behavior' | 'app';
  /** 只有静态注册表完整时才判断未注册标签，未知构建宏不会产生猜测性错误。 */
  readonly registrationComplete?: boolean;
  readonly events?: readonly ComponentEvent[];
  readonly description: string;
  readonly definitions: readonly ComponentLocation[];
  readonly properties: readonly ComponentProperty[];
  readonly registrations: Readonly<Record<string, string>>;
}

/** 组件解析依赖此端口，不依赖 TypeScript 编译器或脚本模块内部。 */
export interface ComponentScriptResolver {
  /** 读取脚本或 JSON 配置，绝不执行工程代码。 */
  inspect(request: LanguageRequest, uri: string, includeInstance?: boolean): Promise<ComponentScriptInfo | undefined>;
}

/** 组件标签、参数及插槽共享一套源码解析规则。 */
export interface ComponentResolver {
  /** 提取组件沿用实际注册原文和配置位置，避免把源码复制路径写成运行时路径。 */
  registration?(request: LanguageRequest, name: string): LanguageResult<readonly { readonly reference: string; readonly from: string; readonly uri: string }[]>;
  /** 只枚举实际展开模板中的组件注册目标，不把未使用注册当作消费关系。 */
  usages?(request: LanguageRequest): LanguageResult<ComponentUsages>;
  /** 读取标签公开契约；includeMembers=false 只解析参数和事件，减少枚举查询成本。 */
  instance?(request: LanguageRequest, includeMembers?: boolean): LanguageResult<ComponentScriptInfo | undefined>;
  /** 根据真实组件注册和参数声明生成原生快速修复。 */
  codeActions?(request: LanguageRequest, range: import('./index').TextRange, scripts?: ScriptDefinitionResolver): LanguageResult<readonly CodeAction[]>;
  /** 校验自定义事件处理参数，不猜测动态事件名称。 */
  diagnostics?(request: LanguageRequest, scripts?: ScriptDefinitionResolver): LanguageResult<readonly Diagnostic[]>;
  /** 根据组件源码补全参数；可选以兼容已有外部解析器。 */
  completion?(request: LanguageRequest): LanguageResult<readonly Completion[]>;
  /** 返回当前使用处对应的实现代码位置。 */
  definition(request: LanguageRequest): LanguageResult<readonly Definition[]>;
  /** 返回组件、参数或插槽的注释说明。 */
  hover(request: LanguageRequest): LanguageResult<Hover | undefined>;
}

/** 消费关系保留注册原文，用于区分组件源码路径与运行时路径。 */
export interface ComponentUsages {
  readonly targets: readonly { readonly uri: string; readonly reference: string; readonly from: string }[];
  readonly complete: boolean;
  readonly dependencies: readonly WorkspaceDependency[];
}
