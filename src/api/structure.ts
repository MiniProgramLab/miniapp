import type { TextRange } from './index';

/** 大纲节点使用原文范围，宿主将通用类别映射为编辑器图标。 */
export interface OutlineSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: 'element' | 'template' | 'module' | 'file';
  readonly range: TextRange;
  readonly selectionRange: TextRange;
  readonly children?: readonly OutlineSymbol[];
}

/** 折叠范围的结束偏移不包含最后一行之后的内容。 */
export interface FoldingRegion {
  readonly range: TextRange;
  readonly kind?: 'comment' | 'region';
}
