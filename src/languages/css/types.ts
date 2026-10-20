import type { TextRange, WorkspaceText } from '../../api';

/** 同一模块内支持的样式方言，缩进式 Sass 暂不参与解析。 */
export type Dialect = 'css' | 'wxss' | 'scss' | 'less';

/** 词法单元保留原始 UTF-16 区间，不把注释和字符串当作代码。 */
export interface Token extends TextRange {
  readonly kind: 'word' | 'string' | 'punctuation';
  readonly value: string;
}

/** 块作用域保留父级关系，以区分同名局部成员。 */
export interface Scope extends TextRange {
  end: number;
  readonly parent?: Scope;
  readonly selectors: readonly string[];
}

/** 静态声明类型区分类、变量、混入与函数。 */
export type SymbolKind = 'class' | 'custom-property' | 'variable' | 'mixin' | 'function';

/** 所有跳转最终落在原始声明的名称上。 */
export interface StyleSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly range: TextRange;
  readonly scope: Scope;
}

/** 模块边保存引用区间、命名空间与转发可见性。 */
export interface ImportEdge {
  readonly kind: 'import' | 'use' | 'forward';
  readonly reference: string;
  readonly range: TextRange;
  readonly scope: Scope;
  readonly namespace: string;
  readonly prefix: string;
  readonly show?: readonly string[];
  readonly hide?: readonly string[];
}

/** 文件索引保留当前内容与版本，相同文本可复用只读语法结构。 */
export interface StyleIndex extends WorkspaceText {
  readonly uri: string;
  readonly dialect: Dialect;
  readonly tokens: readonly Token[];
  readonly symbols: readonly StyleSymbol[];
  readonly imports: readonly ImportEdge[];
  readonly selectors: readonly TextRange[];
}

/** 当前光标对应的符号引用，命名空间仅用于 Sass 模块成员。 */
export interface SymbolReference {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly range: TextRange;
  readonly namespace?: string;
}

/** 仅配置静态路径和解析预算，不运行工作区中的构建配置。 */
export interface CssOptions {
  readonly sourceRoot?: string;
  readonly includePaths?: readonly string[];
  readonly maxFiles?: number;
}
