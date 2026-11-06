/** 脚本解析预算与随扩展交付的标准库位置。 */
export interface ScriptSettings {
  readonly adapters?: readonly import('./semantic').ScriptAdapter[];
  readonly maxFiles?: number;
  /** 引用链最大层数，零表示仅受文件和文本预算限制。 */
  readonly maxDepth?: number;
  readonly libraryUri?: string;
  /** 组件导航优先解析运行时入口，排除只提供类型的包入口。 */
  readonly preferImplementations?: boolean;
  /** 重命名扫描需要覆盖所有源码，超出上限时拒绝部分编辑。 */
  readonly maxRenameFiles?: number;
}
