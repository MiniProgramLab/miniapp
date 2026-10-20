import ts from 'typescript';
import type { CodeAction, Diagnostic, ExpressionInfo, LanguageRequest, SemanticType, TemplateExpression, TemplateScope, TextEdit, TextRange } from '../../api';
import { ScriptProject } from './project';
import { queryContext } from './query';
import { evaluate, parse } from './template-values';
import type { Value, Values } from './values';
import { semanticType } from './semantic-types';
import { componentFunctions } from './events';

/** 模板字面量只投影静态类型，不将其虚拟语法树交给脚本检查器。 */
export function valueType(values: Values, items: readonly Value[], depth = 0): SemanticType {
  if (depth > 5 || !items.length) return { kind: 'unknown', display: 'unknown' };
  const types = items.flatMap((item) => values.resolve(item)).map((item): SemanticType => {
    if (!item.template && !item.members && !item.items) return semanticType(values.checker, item.type ?? values.checker.getTypeAtLocation(item.node), item.node);
    const node = item.node;
    if (ts.isStringLiteralLike(node)) return { kind: 'string', display: 'string', literal: node.text };
    if (ts.isNumericLiteral(node)) return { kind: 'number', display: 'number', literal: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', display: 'boolean', literal: node.kind === ts.SyntaxKind.TrueKeyword };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null', display: 'null' };
    if (item.items) return { kind: 'array', display: 'array', element: valueType(values, item.items, depth + 1) };
    const properties = Object.fromEntries([...(item.members ?? [])].slice(0, 100).map(([name, members]) => [name, valueType(values, members, depth + 1)]));
    return { kind: 'object', display: `{ ${Object.entries(properties).map(([name, type]) => `${name}: ${type.display}`).join('; ')} }`, properties };
  });
  const unique = [...new Map(types.map((type) => [type.display, type])).values()];
  return unique.length === 1 ? unique[0]! : { kind: 'unknown', display: unique.map((type) => type.display).join(' | ') || 'unknown', ...(unique.length ? { alternatives: unique } : {}) };
}

/** 编辑距离只在已知作用域中比较，用于提示少量可确认的拼写候选。 */
function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const next = [row];
    for (let column = 1; column <= right.length; column++) next.push(Math.min(next[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)));
    previous = next;
  }
  return previous[right.length]!;
}

/** 在当前文件的真实注册对象中插入方法，保留已有字段、注释及换行格式。 */
function createHandler(project: ScriptProject, context: NonNullable<Awaited<ReturnType<typeof queryContext>>>, name: string, range: TextRange): CodeAction | undefined {
  const { values, program } = context;
  for (const registered of context.registrations) for (const resolved of values.resolve(registered)) {
    if (!ts.isObjectLiteralExpression(resolved.node) || resolved.node.getSourceFile() !== program.entry) continue;
    const fields = values.fields(resolved);
    const adapter = ts.isCallExpression(registered.node) ? values.adapter(registered.node) : undefined;
    const methodPath = adapter?.methods ?? 'methods';
    const page = ts.isCallExpression(registered.node) && values.callName(registered.node) === 'Page' || methodPath === '.';
    const existing = fields.get('methods')?.flatMap((item) => values.resolve(item)).find((item) => ts.isObjectLiteralExpression(item.node));
    if (!page && fields.get('methods')?.length && !existing || !existing && methodPath.includes('.') && methodPath !== '.') continue;
    const object = (page ? resolved.node : existing?.node ?? resolved.node) as ts.ObjectLiteralExpression;
    const source = object.getSourceFile();
    const text = source.text;
    const close = object.end - 1;
    const line = text.lastIndexOf('\n', close - 1) + 1;
    const ownLine = /^[\t ]*$/.test(text.slice(line, close));
    const indent = ownLine ? text.slice(line, close) : text.slice(text.lastIndexOf('\n', object.getStart(source)) + 1, object.getStart(source)).match(/^[\t ]*/)?.[0] ?? '';
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const js = /\.[cm]?jsx?$/i.test(source.fileName);
    const parameter = js ? '_event' : '_event: unknown';
    const inner = indent + (!page && !existing ? '    ' : '  ');
    const method = [`${inner}/** 处理模板绑定的事件。 */`, `${inner}${name}(${parameter}) {`, `${inner}  // 在此处理事件。`, `${inner}},`].join(newline);
    const content = !page && !existing ? `${indent}  ${JSON.stringify(methodPath)}: {${newline}${method}${newline}${indent}  },` : method;
    const version = project.documents.get(source.fileName)?.version;
    /** 所有插入都带完整快照，避免磁盘内容变化后仍沿用旧坐标。 */
    const edit = (start: number, newText: string): TextEdit => ({ uri: source.fileName, range: { start, end: start }, newText, oldText: '', expectedText: text, ...(version === undefined ? {} : { version }) });
    const position = ownLine ? line : close;
    let insertion = (ownLine ? '' : newline) + content + newline + (ownLine ? '' : indent);
    const edits: TextEdit[] = [];
    const last = object.properties.at(-1);
    if (last && !object.properties.hasTrailingComma) {
      if (last.end === position) insertion = ',' + insertion;
      else edits.push(edit(last.end, ','));
    }
    edits.push(edit(position, insertion));
    return { title: `创建事件处理方法 ${name}`, kind: 'quickfix', range, edits };
  }
  return undefined;
}

/** 仅完整且已识别的页面作用域参与名称检查，未知宏、动态索引和开放类型不误报。 */
export async function analyzeTemplate(project: ScriptProject, request: LanguageRequest, expression: TemplateExpression, scopes?: readonly TemplateScope[], context?: Awaited<ReturnType<typeof queryContext>>): Promise<ExpressionInfo | undefined> {
  context ??= await queryContext(project, request, expression, scopes);
  if (!context || !context.registrations.length || project.exhausted || project.cancelled) return undefined;
  const { values, roots } = context;
  /** 动态 setData 或未知 Behavior 不能证明名称不存在，静态更新字段则作为有效名称。 */
  let openScope = false;
  const updated = new Set<string>();
  for (const registered of context.registrations) {
    const functions = new Set(componentFunctions(values, registered));
    for (const resolved of values.resolve(registered)) {
      const fields = values.fields(resolved);
      for (const list of fields.get('behaviors') ?? []) for (const inherited of values.elements(list)) {
        if (!values.resolve(inherited).some((value) => ts.isObjectLiteralExpression(value.node) || values.fields(value).size)) openScope = true;
      }
    }
    /** 普通嵌套函数的 this 不属于页面，箭头回调沿用所在方法的上下文。 */
    const updates = (node: ts.Node, scope = false): void => {
      if (ts.isFunctionLike(node)) {
        if (functions.has(node)) scope = true;
        else if (!ts.isArrowFunction(node) || !scope) return;
      }
      if (scope && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === 'setData') {
        const data = node.arguments[0];
        if (!data || !ts.isObjectLiteralExpression(data)) openScope = true;
        else for (const property of data.properties) {
          const name = 'name' in property ? values.name(property.name) : undefined;
          if (!name) openScope = true;
          else updated.add(name.split(/[.\[]/)[0]!);
        }
      }
      ts.forEachChild(node, (child) => updates(child, scope));
    };
    for (const callback of functions) updates(callback);
  }
  const prefix = expression.objectLiteral ? 2 : 1;
  const source = parse(expression.objectLiteral ? `{${expression.text}}` : expression.text);
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined;
  const diagnostics: Diagnostic[] = [];
  const actions: CodeAction[] = [];
  /** 一个错误只比较对应作用域的名称，不按全文猜测相似字符串。 */
  const missing = (node: ts.Identifier, names: readonly string[], member = false): void => {
    const range = { start: expression.range.start + node.getStart(source) - prefix, end: expression.range.start + node.end - prefix };
    const message = member ? `当前对象未声明成员 ${node.text}。` : expression.event ? `当前页面未声明事件处理方法 ${node.text}。` : `当前模板作用域未声明 ${node.text}。`;
    diagnostics.push({ range, message, severity: 'warning', code: member ? 'unknown-member' : expression.event ? 'unknown-handler' : 'unknown-variable' });
    const candidates = names.map((name) => ({ name, distance: distance(node.text, name) })).filter((item) => item.distance <= Math.min(2, Math.floor(node.text.length / 2))).sort((left, right) => left.distance - right.distance).slice(0, 3);
    for (const candidate of candidates) actions.push({ title: `改为 ${candidate.name}`, kind: 'quickfix', range, edits: [{ uri: request.document.uri, range, oldText: node.text, newText: candidate.name, version: request.document.version }] });
    if (expression.event && !member && /^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(expression.text.trim())) {
      const action = createHandler(project, context, node.text, range);
      if (action) actions.push(action);
    }
  };
  /** 成员只在所有已知分支均不存在时报告；对象键与普通字符串没有变量语义。 */
  const visit = (node: ts.Node): void => {
    if (project.cancelled) return;
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      const parents = evaluate(node.expression, roots, values);
      const fields = parents.map((item) => values.fields(item));
      const known = parents.length && parents.every((item) => {
        if (item.members) return true;
        const resolved = values.resolve(item);
        return resolved.length && resolved.every((value) => {
          const type = value.type ?? values.checker.getTypeAtLocation(value.node);
          return !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) && !values.checker.getIndexTypeOfType(type, ts.IndexKind.String);
        });
      });
      if (known && ts.isIdentifier(node.name) && fields.every((field) => !field.has(node.name.text))) missing(node.name, [...new Set(fields.flatMap((field) => [...field.keys()]))], true);
      return;
    }
    if (ts.isPropertyAssignment(node)) { visit(node.initializer); return; }
    if (ts.isIdentifier(node)) {
      const passed = scopes?.some((scope) => scope.data);
      if (!roots.has(node.text) && !expression.modules?.some((module) => module.name === node.text) && !['undefined', 'NaN', 'Infinity'].includes(node.text)
        && (!openScope || passed) && (expression.event || passed || !updated.has(node.text))) missing(node, [...roots.keys()]);
      return;
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  const statement = source.statements[0];
  const node = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
  if (node) visit(node);
  const type = node ? valueType(values, evaluate(node, roots, values)) : { kind: 'unknown' as const, display: 'unknown' };
  /** 已存在的标量或对象字段不能充当处理函数，未知类型和通用 Function 保持兼容。 */
  const nonCallable = (type: SemanticType): boolean => type.alternatives ? type.alternatives.every(nonCallable) : type.kind !== 'unknown' && type.kind !== 'function' && type.display !== 'Function';
  if (expression.event && !diagnostics.length && nonCallable(type)) {
    diagnostics.push({ range: expression.range, message: `${expression.text.trim()} 的类型为 ${type.display}，不能作为事件处理方法。`, severity: 'warning', code: 'invalid-handler' });
  }
  return { type, diagnostics, actions };
}
