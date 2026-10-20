import ts from 'typescript';
import type { LanguageRequest, TemplateExpression, TextRange } from '../../api';
import { parse } from './template-values';

/** 提取真正的变量引用；对象键、成员名和字符串不作为依赖字段。 */
export function expressionNames(request: LanguageRequest, expression: TemplateExpression): { names: { name: string; range: TextRange; shorthand?: boolean }[]; complete: boolean } {
  const names: { name: string; range: TextRange; shorthand?: boolean }[] = [];
  if (request.cancellation.isCancellationRequested || expression.text.length > 250000) return { names, complete: false };
  const source = parse(expression.objectLiteral ? `{${expression.text}}` : expression.text), prefix = expression.objectLiteral ? 2 : 1;
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return { names, complete: false };
  const pending: ts.Node[] = [source];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++count > 20000 || request.cancellation.isCancellationRequested || ts.isFunctionLike(node) || ts.isClassLike(node)) return { names: [], complete: false };
    ts.forEachChild(node, (child) => { pending.push(child); });
    if (!ts.isIdentifier(node)) continue;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node || 'name' in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent) || ts.isLabeledStatement(parent)) continue;
    names.push({ name: node.text, range: { start: expression.range.start + node.getStart(source) - prefix, end: expression.range.start + node.end - prefix }, ...(ts.isShorthandPropertyAssignment(parent) ? { shorthand: true } : {}) });
  }
  return { names: names.sort((left, right) => left.range.start - right.range.start), complete: true };
}
