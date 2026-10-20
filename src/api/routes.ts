import type { Completion, Definition, Diagnostic, Hover, LanguageRequest, SemanticType, StaticString, TextRange, WorkspaceDependency } from './index';

/** 路由只承载静态结果，不向跨语言消费者暴露编译器对象。 */
export interface RouteAccess {
  readonly method: 'navigateTo' | 'redirectTo' | 'switchTab' | 'reLaunch';
  readonly base: 'page' | 'component' | 'unknown';
  readonly baseUri?: string;
  readonly owner?: Definition;
  readonly relativeTo?: 'page' | 'component';
  readonly range: TextRange;
  readonly urls: readonly StaticString[];
  /** 只有实际 URL 字符串可被补全替换，常量名称保留原有符号补全。 */
  readonly editable?: boolean;
  /** 注册字符串使用应用或分包根，补全不添加运行 URL 的前导斜线。 */
  readonly registration?: string;
}

/** 注册页面保留原始配置位置，分包根目录已经合并到路径。 */
export interface RouteManifest {
  readonly pages: readonly { readonly path: string; readonly definition: Definition; readonly package?: string; readonly independent?: boolean }[];
  readonly tabs: readonly string[];
  readonly complete: boolean;
  readonly tabComplete: boolean;
  readonly dependencies: readonly WorkspaceDependency[];
  /** 注册值来源用于文件移动；分包页面值仍保留自己的相对路径。 */
  readonly registrations?: readonly { readonly kind: 'page' | 'package' | 'tab'; readonly path: string; readonly package?: string; readonly value: StaticString; readonly collection?: { readonly uri: string; readonly range: TextRange; readonly item: TextRange } }[];
  /** 静态页面数组保留空数组的位置，跨分包迁移无需重建整个应用配置。 */
  readonly collections?: readonly { readonly uri: string; readonly range: TextRange; readonly package?: string }[];
}

/** 路由结果可被脚本、模板和配置提供器共同使用。 */
export interface RouteResult {
  readonly definitions: readonly Definition[];
  readonly completions: readonly Completion[];
  readonly diagnostics: readonly Diagnostic[];
  readonly hover?: Hover;
  readonly query?: SemanticType;
  /** 页面文件与运行路径分开保留，查询参数声明不会覆盖页面目标。 */
  readonly targets?: readonly { readonly uri: string; readonly path: string; readonly url: string; readonly root: string; readonly from?: { readonly uri: string; readonly path: string } }[];
  readonly complete?: boolean;
}

/** 页面参数类型携带实际读取依赖，不能只校验页面入口的修订。 */
export interface PageQuery {
  readonly type: SemanticType;
  readonly complete?: boolean;
  /** 字段保留声明位置、默认值和注释，URL 查询字段可直接导航声明。 */
  readonly fields?: readonly {
    readonly name: string;
    readonly type: SemanticType;
    readonly description: string;
    readonly defaultValue?: string;
    readonly required: boolean;
    readonly definitions: readonly Definition[];
  }[];
  readonly dependencies: readonly WorkspaceDependency[];
}

/** 路由目录与源码映射由公共解析端口提供，不依赖某种模板语法。 */
export interface RouteResolver {
  /** 最近应用的完整目录与已有查询共用配置快照。 */
  catalog?(request: LanguageRequest): Promise<{ readonly uri: string; readonly root: string; readonly manifest: RouteManifest } | undefined>;
  /** 一份请求内复用目录，实际来源和页面参数保持草稿依赖校验。 */
  query(request: LanguageRequest, access: RouteAccess): Promise<RouteResult>;
}

/** 组件相对路由通过实际模板消费关系取得全部静态基准。 */
export interface RouteContextResolver {
  resolve(request: LanguageRequest, access: RouteAccess, application: { readonly root: string; readonly pages: readonly { readonly path: string }[] }): Promise<{
    readonly bases: readonly { readonly path: string; readonly uri: string }[];
    readonly complete: boolean;
    readonly dependencies: readonly WorkspaceDependency[];
  }>;
}
