import type { Cancellation, Diagnostic, LanguageRequest, LanguageResult, WorkspaceDependency } from './index';

/** 工作区检查复用已注册语言规则，卸载后不能继续使用旧提供器。 */
export interface CheckProvider {
  readonly id: string;
  readonly name: string;
  readonly languages: readonly string[];
  readonly active: () => boolean;
  /** 输入磁盘或草稿快照，规则与实时诊断一致。 */
  provide(request: LanguageRequest): LanguageResult<readonly Diagnostic[]>;
}

/** 发现阶段已确定文件语言，检查阶段无需打开编辑器文档。 */
export interface CheckFile {
  readonly uri: string;
  readonly languageId: string;
}

/** 行与字符从零开始，与编辑器位置一致；偏移仍按 UTF-16 计算。 */
export interface CheckFinding extends Diagnostic {
  readonly uri: string;
  readonly provider: string;
  readonly source: string;
  readonly position: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
}

/** 检查未完成的原因与发现的代码问题分开保存。 */
export interface CheckIssue {
  readonly uri?: string;
  readonly provider?: string;
  readonly message: string;
}

/** 报告只保存位置和消息，不保留源码或依赖修订原文。 */
export interface CheckReport {
  readonly scopes: readonly string[];
  readonly checkedAt: string;
  readonly status: 'complete' | 'incomplete' | 'cancelled';
  readonly selected: number;
  readonly checked: number;
  readonly skipped: number;
  readonly findings: readonly CheckFinding[];
  readonly issues: readonly CheckIssue[];
}

/** 过滤只影响结果展示，检查仍按同一套语义规则执行。 */
export interface CheckOptions {
  readonly cancellation: Cancellation;
  readonly maxFiles?: number;
  readonly maxFindings?: number;
  readonly severities?: readonly Diagnostic['severity'][];
  readonly codes?: readonly string[];
  readonly scopes?: readonly string[];
  /** 每检查一份快照报告进度，不把诊断数量当作完成率。 */
  readonly progress?: (checked: number, total: number, file: CheckFile) => void;
}

/** 依赖只留在本地控制器中判断失效，导出仅使用 report。 */
export interface CheckResult {
  readonly report: CheckReport;
  readonly dependencies: readonly WorkspaceDependency[];
}

