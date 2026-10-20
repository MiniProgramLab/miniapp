import type { Definition, LanguageResult } from './index';

/** 导航步骤只记录解析结论和位置，不保存工程源码。 */
export interface NavigationStep {
  readonly code: 'context' | 'path' | 'alias' | 'config' | 'missing' | 'dynamic' | 'budget' | 'unsupported' | 'cached' | 'symbol' | 'cycle' | 'error';
  readonly message: string;
  readonly uri?: string;
}

/** 宿主可选地收集一次异步查询，普通语言请求不会保留追踪记录。 */
export interface NavigationTracking {
  /** 非说明请求跳过引用链整理，不增加常规查询成本。 */
  readonly active: boolean;
  /** 向当前追踪作用域追加真实解析步骤。 */
  record(step: NavigationStep): void;
  /** 并发查询各自保留步骤，取消和错误由调用方处理。 */
  capture<T>(provide: () => LanguageResult<T>): Promise<{ readonly value: T; readonly steps: readonly NavigationStep[] }>;
}

/** 原生定义提供器的结果与追踪步骤共同组成可读报告。 */
export interface NavigationReport {
  readonly uri: string;
  readonly offset: number;
  readonly status: 'resolved' | 'ambiguous' | 'unresolved' | 'incomplete';
  readonly definitions: readonly Definition[];
  readonly providers: readonly { readonly name: string; readonly steps: readonly NavigationStep[]; readonly definitions: readonly Definition[] }[];
}
