import ts from 'typescript';
import type { Definition, TemplateScope } from '../../api';
import type { Values, Value } from './values';

/** 模板表达式中的原始坐标，虚拟语法树不参与脚本类型检查。 */
export interface ExpressionSource {
  readonly uri: string;
  readonly offset: number;
  readonly prefix: number;
  readonly version?: number;
}

/** 数据传参保留求值结果及本次使用处字段，分开处理语义和跳转层级。 */
export interface TemplateTransfer {
  readonly members: ReadonlyMap<string, Value[]>;
  readonly references: ReadonlyMap<string, Omit<Definition, 'originRange'>>;
}

/** 将模板表达式解析为独立语法树，不加入用户工程。 */
export function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('expression.ts', `(${text})`, ts.ScriptTarget.Latest, true);
}

/** 包装模板内的字面量和对象，保留其定义位置。 */
function literal(node: ts.Node, source: ExpressionSource | undefined, declaration = node): Value {
  const quote = ts.isStringLiteralLike(declaration) ? 1 : 0;
  return { node, bindings: new Map(), members: new Map(), ...(source ? { template: {
    uri: source.uri,
    range: { start: source.offset + declaration.getStart() - source.prefix + quote, end: source.offset + declaration.getEnd() - source.prefix - quote },
    ...(source.version === undefined ? {} : { version: source.version }),
  } } : {}) };
}

/** 提取 data 对象语法及真实坐标，供字段导航和语义传参共同使用。 */
function dataSource(scope: TemplateScope): { object: ts.ObjectLiteralExpression; coordinates: ExpressionSource } | undefined {
  const data = scope.data;
  if (!data?.text.trim()) return undefined;
  const source = parse(`{${data.text}}`);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression) || !ts.isObjectLiteralExpression(statement.expression.expression)) return undefined;
  return { object: statement.expression.expression, coordinates: { uri: scope.uri, offset: data.range.start, prefix: 2, ...(scope.version === undefined ? {} : { version: scope.version }) } };
}

/** 显式字段无需解析脚本；可能被后续展开覆盖时交给完整语义判断。 */
export function explicitReference(scope: TemplateScope, name: string): Omit<Definition, 'originRange'> | undefined {
  const source = dataSource(scope);
  if (!source) return undefined;
  for (const property of [...source.object.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) return undefined;
    const key = property.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) && key.text === name) return literal(key, source.coordinates).template;
  }
  return undefined;
}

/** 把访问路径和传参对象投影到已知上下文，不执行模板表达式。 */
export function evaluate(node: ts.Node, roots: ReadonlyMap<string, Value[]>, values: Values, source?: ExpressionSource, depth = 0): Value[] {
  if (depth > 80) return [];
  /** 子表达式沿用当前作用域及坐标，限制递归深度。 */
  const next = (child: ts.Node): Value[] => evaluate(child, roots, values, source, depth + 1);
  if (ts.isIdentifier(node)) return roots.get(node.text) ?? [];
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return next(node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const parent = next(node.expression);
    const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : next(node.argumentExpression).flatMap((item) => values.keys(item));
    return parent.flatMap((item) => values.access(item, keys));
  }
  if (ts.isCallExpression(node)) return next(node.expression).flatMap((item) => values.resolve(item).flatMap((callee) => values.returns(callee)));
  if (ts.isConditionalExpression(node)) return [...next(node.whenTrue), ...next(node.whenFalse)];
  if (ts.isObjectLiteralExpression(node)) {
    const members = new Map<string, Value[]>();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const item of next(property.expression)) for (const [name, items] of values.fields(item)) members.set(name, items);
      } else {
        const name = values.name(property.name);
        if (!name) continue;
        if (ts.isShorthandPropertyAssignment(property)) members.set(name, roots.get(name) ?? []);
        else if (ts.isPropertyAssignment(property)) {
          const items = next(property.initializer);
          const initial = property.initializer;
          const primitive = ts.isStringLiteralLike(initial) || ts.isNumericLiteral(initial) || initial.kind === ts.SyntaxKind.TrueKeyword || initial.kind === ts.SyntaxKind.FalseKeyword || initial.kind === ts.SyntaxKind.NullKeyword;
          members.set(name, items.map((item) => item.template && primitive ? { ...item, template: literal(initial, source, property.name).template! } : item));
        }
      }
    }
    return [{ ...literal(node, source), members }];
  }
  if (ts.isArrayLiteralExpression(node)) return [{ ...literal(node, source), items: node.elements.flatMap((element) => ts.isSpreadElement(element) ? next(element.expression).flatMap((item) => values.elements(item)) : next(element)) }];
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return [literal(node, source)];
  return [];
}

/** WXML 的 data 内容按对象成员解析，支持简写、改名和展开。 */
export function transfer(scope: TemplateScope, roots: ReadonlyMap<string, Value[]>, values: Values): TemplateTransfer {
  const source = dataSource(scope);
  const result: TemplateTransfer = { members: new Map(), references: new Map() };
  if (!source) return result;
  const { object, coordinates } = source;
  const members = new Map<string, Value[]>();
  const references = new Map<string, Omit<Definition, 'originRange'>>();
  for (const item of evaluate(object, roots, values, coordinates)) {
    for (const [name, items] of values.fields(item)) members.set(name, [...(members.get(name) ?? []), ...items]);
  }
  // 字段优先指向最近使用处，展开参数则指向对应的展开表达式。
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const item of evaluate(property.expression, roots, values, coordinates)) {
        for (const name of values.fields(item).keys()) references.set(name, literal(property.expression, coordinates).template!);
      }
    } else {
      const name = values.name(property.name);
      if (name) references.set(name, literal(property.name, coordinates).template!);
    }
  }
  return { members, references };
}
