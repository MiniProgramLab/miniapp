import ts from 'typescript';
import type { Completion, LanguageRequest, TemplateExpression, TemplateScope } from '../../api';
import { ScriptProject } from './project';
import { queryContext, reference } from './query';
import { evaluate, parse } from './template-values';
import { declarationDocumentation } from './documentation';
import type { Value } from './values';

/** 用临时标识符补全空表达式和末尾点号，替换范围只覆盖当前名称。 */
export function completionSite(request: LanguageRequest, expression: TemplateExpression) {
  const offset = request.offset - expression.range.start;
  if (offset < 0 || offset > expression.text.length) return undefined;
  const before = expression.text.slice(0, offset).match(/[$\p{ID_Continue}]*$/u)?.[0] ?? '';
  const after = expression.text.slice(offset).match(/^[$\p{ID_Continue}]*/u)?.[0] ?? '';
  const start = offset - before.length;
  const end = offset + after.length;
  const marker = '__miniapp_completion__';
  const text = expression.text.slice(0, start) + marker + expression.text.slice(end);
  const prefix = expression.objectLiteral ? 2 : 1;
  const source = parse(expression.objectLiteral ? `{${text}}` : text);
  const selected = reference(source, start + prefix + marker.length);
  if (!selected || !ts.isIdentifier(selected.token) || selected.token.text !== marker) return undefined;
  return { node: selected.node, prefix: before, range: { start: expression.range.start + start, end: expression.range.start + end } };
}

/** 当前调用页面、循环项、传参对象及 Behavior 使用相同的语义上下文。 */
export async function completeTemplate(project: ScriptProject, request: LanguageRequest, expression: TemplateExpression, scopes?: readonly TemplateScope[]): Promise<readonly Completion[]> {
  const site = completionSite(request, expression);
  if (!site || project.cancelled) return [];
  const context = await queryContext(project, request, expression, scopes);
  const members = new Map<string, Value[]>();
  if (context) {
    const { values, roots } = context;
    if (ts.isPropertyAccessExpression(site.node)) {
      for (const parent of evaluate(site.node.expression, roots, values)) for (const [name, items] of values.fields(parent)) {
        members.set(name, [...(members.get(name) ?? []), ...items]);
      }
    } else if (ts.isIdentifier(site.node)) for (const [name, items] of roots) members.set(name, items);
  }
  const result: Completion[] = [];
  for (const [name, items] of members) {
    if (!name.startsWith(site.prefix) || !/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(name)) continue;
    const values = context!.values;
    const resolved = items.flatMap((item) => values.resolve(item));
    if (expression.event && !resolved.some((item) => ts.isFunctionLike(item.node) || values.checker.getSignaturesOfType(item.type ?? values.checker.getTypeAtLocation(item.node), ts.SignatureKind.Call).length)) continue;
    const types = resolved.filter((item) => !item.template).map((item) => values.checker.typeToString(item.type ?? values.checker.getTypeAtLocation(item.node), item.node, ts.TypeFormatFlags.NoTruncation));
    const docs = [...items, ...resolved].filter((item) => !item.template).map((item) => declarationDocumentation(item.declaration ?? item.node)).filter(Boolean);
    result.push({ label: name, kind: 'value', detail: [...new Set(types)].join(' | ') || (context?.localDefinitions.has(name) ? '模板局部变量' : '模板字段'), documentation: [...new Set(docs)].join('\n'), insertText: name, range: site.range });
  }
  if (ts.isIdentifier(site.node) && !expression.event) for (const module of expression.modules ?? []) {
    if (module.name.startsWith(site.prefix)) result.push({ label: module.name, kind: 'value', detail: 'WXS 模块', documentation: '当前模板声明的 WXS 模块。', insertText: module.name, range: site.range });
  }
  return project.cancelled ? [] : [...new Map(result.map((item) => [item.label, item])).values()];
}
