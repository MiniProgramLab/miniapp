import ts from 'typescript';
import type { Definition, HandlerSignature, LanguageRequest, TemplateExpression, TemplateScope } from '../../api';
import { ScriptProject } from './project';
import { Values } from './values';
import type { Value } from './values';
import { evaluate, explicitReference, parse, transfer } from './template-values';
import { declarationDocumentation } from './documentation';
import { signature } from './semantic-types';

/** 悬浮查询额外保留声明注释，定义导航继续只返回原始位置。 */
export interface ScriptDefinition extends Definition {
  readonly description?: string;
  readonly signature?: HandlerSignature;
}

/** 确定光标引用；data 字段名导航到绑定表达式，其余对象键及普通字符串跳过。 */
export function reference(source: ts.SourceFile, offset: number, objectLiteral = false): { node: ts.Node; token: ts.Node } | undefined {
  let token: ts.Node | undefined;
  /** 标识符包含右边界，兼容完整选择后的光标；字符串仍沿用原有范围。 */
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(source) || offset > node.getEnd()) return;
    if (ts.isIdentifier(node) || offset < node.getEnd() && (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))) token = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!token) return undefined;
  const parent = token.parent;
  if (ts.isPropertyAssignment(parent) && parent.name === token) return objectLiteral ? { node: parent.initializer, token } : undefined;
  if (ts.isMethodDeclaration(parent) && parent.name === token) return undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.name === token) return { node: parent, token };
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === token && !ts.isIdentifier(token)) return { node: parent, token };
  return ts.isIdentifier(token) ? { node: token, token } : undefined;
}

/** 成员访问仍属于传入的根字段，先返回该字段的最近一次绑定位置。 */
export function rootName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isCallExpression(node)) return rootName(node.expression);
  return undefined;
}

/** 从最近作用域查找可直接确定的 data 字段，允许页面脚本尚未创建。 */
function scopeReference(node: ts.Node, scopes: readonly TemplateScope[]): Omit<Definition, 'originRange'> | undefined {
  let name = rootName(node);
  if (!name) return undefined;
  for (const scope of [...scopes].reverse()) {
    for (const local of [...scope.bindings].reverse()) {
      if (local.name !== name) continue;
      if (ts.isIdentifier(node)) return { uri: scope.uri, range: local.range, ...(scope.version === undefined ? {} : { version: scope.version }) };
      if (local.kind !== 'item' || !local.collection) return undefined;
      const statement = parse(local.collection).statements[0];
      name = statement && ts.isExpressionStatement(statement) ? rootName(statement.expression) : undefined;
      if (!name) return undefined;
    }
    // 命名模板只看到最近一次传参，字段缺失时不能继续向外层猜测。
    if (scope.data) return explicitReference(scope, name);
  }
  return undefined;
}

/** 补全、导航及检查共享页面成员和逐层模板传参，不重复实现作用域。 */
export async function queryContext(project: ScriptProject, request: LanguageRequest, expression: TemplateExpression, scopes?: readonly TemplateScope[]) {
  if (expression.contexts?.length === 0) return undefined;
  const steps = expression.event ? [] : scopes ?? [{ uri: request.document.uri, bindings: expression.bindings, version: request.document.version }];
  const program = await project.create();
  if (!program || project.cancelled) return undefined;
  const values = new Values(program.program.getTypeChecker(), () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
  const roots = new Map<string, Value[]>();
  const registrations = values.registration(program.entry);
  for (const registration of registrations) {
    for (const [name, items] of values.context(registration)) roots.set(name, [...(roots.get(name) ?? []), ...items]);
  }
  const localDefinitions = new Map<string, Omit<Definition, 'originRange'>>();
  const dataReferences = new Map<string, Omit<Definition, 'originRange'>>();
  for (const scope of steps) {
    for (const local of scope.bindings) {
      const tree = local.collection ? parse(local.collection) : undefined;
      const statement = tree?.statements[0];
      const collection = statement && ts.isExpressionStatement(statement) ? evaluate(statement.expression, roots, values) : [];
      const collectionReference = statement && ts.isExpressionStatement(statement) ? dataReferences.get(rootName(statement.expression) ?? '') : undefined;
      roots.set(local.name, local.kind === 'item' ? collection.flatMap((item) => values.elements(item)) : []);
      dataReferences.delete(local.name);
      if (local.kind === 'item' && collectionReference) dataReferences.set(local.name, collectionReference);
      localDefinitions.set(local.name, { uri: scope.uri, range: local.range, ...(scope.version === undefined ? {} : { version: scope.version }) });
    }
    if (scope.data) {
      const next = transfer(scope, roots, values);
      roots.clear();
      localDefinitions.clear();
      dataReferences.clear();
      for (const [name, items] of next.members) roots.set(name, items);
      for (const [name, reference] of next.references) dataReferences.set(name, reference);
    }
  }
  // WXS 成员由独立模块解析，页面名称检查只需承认此词法模块作用域。
  if (!expression.event) for (const module of expression.modules ?? []) roots.set(module.name, [{ ...values.value(program.entry), type: values.checker.getAnyType() }]);
  return { values, roots, localDefinitions, dataReferences, registrations, program };
}

/** 在一次请求内组合项目上下文、模板局部绑定和原始声明位置。 */
export async function query(project: ScriptProject, request: LanguageRequest, expression: TemplateExpression, scopes?: readonly TemplateScope[], hover = false, rename = false): Promise<readonly ScriptDefinition[]> {
  const prefix = expression.objectLiteral ? 2 : 1;
  const source = parse(expression.objectLiteral ? `{${expression.text}}` : expression.text);
  const selected = reference(source, request.offset - expression.range.start + prefix, expression.objectLiteral);
  if (!selected || project.cancelled) return [];
  const quote = ts.isStringLiteralLike(selected.token) ? 1 : 0;
  const originRange = { start: expression.range.start + selected.token.getStart(source) - prefix + quote, end: expression.range.start + selected.token.getEnd() - prefix - quote };
  if (rename && expression.objectLiteral && ts.isPropertyAssignment(selected.token.parent) && selected.token.parent.name === selected.token) {
    const object = selected.token.parent.parent;
    const names = ts.isObjectLiteralExpression(object) ? object.properties.flatMap((property) => 'name' in property && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? [property.name.text] : []) : [];
    return [{ uri: request.document.uri, range: originRange, originRange, version: request.document.version, renameConflicts: names }];
  }
  const binding = ts.isIdentifier(selected.node) ? [...expression.bindings].reverse().find((item) => item.name === selected.node.getText(source)) : undefined;
  if (binding && !expression.event && !hover) return [{ uri: request.document.uri, range: binding.range, originRange, version: request.document.version }];
  if (expression.contexts?.length === 0) return [];
  const steps = expression.event ? [] : scopes ?? [{ uri: request.document.uri, bindings: expression.bindings, version: request.document.version }];
  const immediate = scopeReference(selected.node, steps);
  if (immediate && !hover) return [{ ...immediate, originRange }];
  const context = await queryContext(project, request, expression, scopes);
  if (!context) return [];
  const { values, roots, localDefinitions, dataReferences } = context;
  const local = ts.isIdentifier(selected.node) ? localDefinitions.get(selected.node.text) : undefined;
  if (local && !hover) return [{ ...local, originRange }];
  const dataReference = dataReferences.get(rootName(selected.node) ?? '');
  if (dataReference && !hover) return [{ ...dataReference, originRange }];
  const result = new Map<string, ScriptDefinition>();
  for (const candidate of evaluate(selected.node, roots, values)) for (const item of rename && candidate.declaration && (ts.isPropertyAssignment(candidate.node) || ts.isShorthandPropertyAssignment(candidate.node) || ts.isMethodDeclaration(candidate.node) || ts.isPropertySignature(candidate.node)) ? [candidate] : values.resolve(candidate)) {
    if (item.template) {
      result.set(`${item.template.uri}:${item.template.range.start}:${item.template.range.end}`, { ...item.template, originRange });
      continue;
    }
    if (item.members || item.items) continue;
    const declaration = item.declaration ?? item.node;
    const file = declaration.getSourceFile();
    const document = project.documents.get(file.fileName);
    if (!document || project.cancelled) continue;
    const quote = ts.isStringLiteralLike(declaration) ? 1 : 0;
    const range = { start: declaration.getStart(file) + quote, end: declaration.getEnd() - quote };
    project.explainDefinition(file.fileName);
    const description = hover ? declarationDocumentation(declaration) || declarationDocumentation(candidate.declaration ?? candidate.node) : '';
    const handler = signature(values.checker, item.node);
    result.set(`${file.fileName}:${range.start}:${range.end}`, { uri: file.fileName, range, originRange, ...(handler ? { signature: handler } : {}), ...(description ? { description } : {}), ...(document.version === undefined ? {} : { version: document.version }) });
  }
  if (!result.size) {
    const name = rootName(selected.node);
    project.explain({ code: 'symbol', message: name && !roots.has(name) ? `当前注册与模板传参中未静态确定 ${name}；请检查声明、Behavior 暴露字段或动态注入。` : '当前成员没有可确定的源码声明；动态属性、运行时返回值或开放类型不能据此猜测定义。' });
  }
  return project.cancelled ? [] : [...result.values()];
}
