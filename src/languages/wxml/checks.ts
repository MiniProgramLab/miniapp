import type { CodeAction, Diagnostic, LanguageRequest, ScriptDefinitionResolver, TextRange } from '../../api';
import { templateExpressions } from './expression';
import { scriptExpression, scriptModules } from './wxs';

/** 枚举真实插值和事件值，注释、普通文本及内联 WXS 的脚本内容不会混入。 */
function expressionRequests(request: LanguageRequest) {
  const modules = scriptModules(request);
  return templateExpressions(request.document.text).slice(0, 2000).map((expression) => ({ request: { ...request, offset: expression.range.start }, expression: { ...expression, modules } }));
}

/** 名称检查与快速修复共用脚本分析，诊断只处理可确定的页面或模板作用域。 */
export async function templateDiagnostics(request: LanguageRequest, scripts: ScriptDefinitionResolver): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const checkpoint = request.checkpoint;
  for (const { request: candidate, expression } of expressionRequests(request)) {
    if (request.cancellation.isCancellationRequested || checkpoint && !await checkpoint(request.cancellation)) return [];
    const result = await scripts.analyze?.(candidate, expression);
    diagnostics.push(...result?.diagnostics ?? []);
  }
  return diagnostics;
}

/** 灯泡只分析选区涉及的表达式，避免一次修复重新检查整个工作区。 */
export async function templateCodeActions(request: LanguageRequest, range: TextRange, scripts: ScriptDefinitionResolver): Promise<readonly CodeAction[]> {
  const direct = scriptExpression(request);
  const requests = direct ? [{ request, expression: direct }] : expressionRequests(request).filter(({ expression }) => {
    return expression.range.start <= range.end && range.start <= expression.range.end;
  });
  const actions: CodeAction[] = [];
  for (const { request: candidate, expression } of requests) {
    if (request.cancellation.isCancellationRequested) return [];
    const result = await scripts.analyze?.(candidate, expression);
    actions.push(...result?.actions.filter((action) => action.range.start <= range.end && range.start <= action.range.end) ?? []);
  }
  return [...new Map(actions.map((action) => [JSON.stringify([action.title, action.edits]), action])).values()];
}
