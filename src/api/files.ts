/** 不同语言共享项目路径规则，具体扩展名仍由语言模块决定。 */
export type FileReferenceKind = 'component' | 'script' | 'style' | 'file';

/** 完整目录清单保留未知类型，符号链接继续按原路径核对。 */
export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'unknown';
}

/** 已缓存的路径结论携带原修订，未知路径继续异步读取。 */
export interface WorkspacePathSnapshot {
  readonly kind: 'file' | 'directory' | 'missing';
  readonly dependencies: readonly import('./index').WorkspaceDependency[];
}

/** 路径引用保留原始文本位置；扩展名由所属语言声明。 */
export interface FileReference {
  readonly reference: string;
  readonly range: import('./index').TextRange;
  readonly kind: FileReferenceKind;
  readonly extensions: readonly string[];
  /** Sass 隐式命名空间在文件改名后需要转为显式别名，保留已有成员引用。 */
  readonly implicitNamespace?: string;
}

/** 单次查询的配置快照，避免语言模块自行解释构建配置。 */
export interface ProjectFileResolver {
  /** 实际读取的配置与负向探测修订，用于调用方校验路径结果缓存。 */
  readonly dependencies?: readonly import('./index').WorkspaceDependency[];
  /** 按源码优先顺序返回候选 URI，不执行配置或构建项目。 */
  candidates(reference: string, from: string, kind: FileReferenceKind): Promise<readonly string[]>;
  /** 返回本次候选实际使用的依赖，供并发模块分别缓存。 */
  resolve?(reference: string, from: string, kind: FileReferenceKind): Promise<{ readonly candidates: readonly string[]; readonly dependencies: readonly import('./index').WorkspaceDependency[] }>;
}
