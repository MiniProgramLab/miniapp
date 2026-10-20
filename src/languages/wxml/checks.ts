import type { CodeAction, Diagnostic, LanguageRequest, ScriptDefinitionResolver, TextRange } from '../../api';
import { scanTags } from './parser';
import { scriptExpression, scriptModules } from './wxs';

/** 枚举真实插值和事件值，注释、普通文本及内联 WXS 的脚本内容不会混入。 */
function expressionRequests(request: LanguageRequest): LanguageRequest[] {
  const result = new Map<number, LanguageRequest>();
  const modules = scriptModules(request);
  const text = request.document.text;
  const pattern = /\{\{/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (request.cancellation.isCancellationRequested || result.size >= 2000) break;
    const offset = match.index + 2;
    if (modules.some((module) => module.inline && offset >= module.inline.range.start && offset < module.inline.range.end)) continue;
    const candidate = { ...request, offset };
    const expression = scriptExpression(candidate);
    if (!expression) continue;
    result.set(expression.range.start, candidate);
    pattern.lastIndex = Math.max(pattern.lastIndex, expression.range.end);
  }
  for (const tag of scanTags(text)) for (const attribute of tag.attributes) {
    if (!attribute.valueRange || result.size >= 2000) continue;
    const candidate = { ...request, offset: attribute.valueRange.start };
    const expression = scriptExpression(candidate);
    if (expression?.event) result.set(expression.range.start, candidate);
  }
  return [...result.values()];
}

/** 名称检查与快速修复共用脚本分析，诊断只处理可确定的页面或模板作用域。 */
export async function templateDiagnostics(request: LanguageRequest, scripts: ScriptDefinitionResolver): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const candidate of expressionRequests(request)) {
    if (request.cancellation.isCancellationRequested) return [];
    const expression = scriptExpression(candidate)!;
    const result = await scripts.analyze?.(candidate, expression);
    diagnostics.push(...result?.diagnostics ?? []);
  }
  return diagnostics;
}

/** 灯泡只分析选区涉及的表达式，避免一次修复重新检查整个工作区。 */
export async function templateCodeActions(request: LanguageRequest, range: TextRange, scripts: ScriptDefinitionResolver): Promise<readonly CodeAction[]> {
  const direct = scriptExpression(request);
  const requests = direct ? [request] : expressionRequests(request).filter((candidate) => {
    const expression = scriptExpression(candidate)!;
    return expression.range.start <= range.end && range.start <= expression.range.end;
  });
  const actions: CodeAction[] = [];
  for (const candidate of requests) {
    if (request.cancellation.isCancellationRequested) return [];
    const result = await scripts.analyze?.(candidate, scriptExpression(candidate)!);
    actions.push(...result?.actions.filter((action) => action.range.start <= range.end && range.start <= action.range.end) ?? []);
  }
  return [...new Map(actions.map((action) => [JSON.stringify([action.title, action.edits]), action])).values()];
}
