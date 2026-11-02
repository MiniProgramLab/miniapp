import ts from 'typescript';
import type { Definition, LanguageRequest, TemplateExpression, WorkspaceReader } from '../../api';
import { parse } from './template-values';
import { reference } from './query';

/** 直接注册只做语法定位，缓存按原文核对，不复用类型检查器修改过的节点。 */
const sources = new Map<string, ts.SourceFile>();

/** 小范围复用解析结果，连续导航不重复解析同一脚本。 */
export function registrationSource(uri: string, text: string): ts.SourceFile {
  let source = sources.get(uri);
  if (source?.text !== text) source = ts.createSourceFile(uri, text, ts.ScriptTarget.Latest, true);
  sources.delete(uri); sources.set(uri, source);
  while (sources.size > 12 || [...sources.values()].reduce((size, item) => size + item.text.length, 0) > 4_000_000) sources.delete(sources.keys().next().value!);
  return source;
}

/** 注册调用与既有语义入口保持一致，忽略未执行的函数体并识别导入别名。 */
export function directRegistrations(source: ts.SourceFile): ts.CallExpression[] {
  const aliases = new Map<string, string>();
  for (const statement of source.statements) if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) aliases.set(item.name.text, (item.propertyName ?? item.name).text);
  }
  const calls: ts.CallExpression[] = [];
  /** 逗号包装保留原始调用范围，函数内部注册由完整语义处理。 */
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      let target: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(target) || ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) target = ts.isParenthesizedExpression(target) ? target.expression : (target as ts.BinaryExpression).right;
      const name = ts.isIdentifier(target) ? aliases.get(target.text) ?? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : '';
      if (node.arguments.length && ['Component', 'VantComponent', 'Page'].includes(name)) { calls.push(node); return; }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** 只取没有动态展开的对象字段，复杂配置交给完整语义图。 */
function fields(node: ts.Node | undefined): Map<string, ts.ObjectLiteralElementLike> | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const result = new Map<string, ts.ObjectLiteralElementLike>();
  for (const property of node.properties) {
    const name = property.name;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))) return undefined;
    result.set(name.text, property);
  }
  return result;
}

/** 字面量和本地函数的首跳已确定；引用、调用及成员访问仍须追踪原声明。 */
function local(property: ts.ObjectLiteralElementLike): boolean {
  if (ts.isMethodDeclaration(property)) return true;
  if (!ts.isPropertyAssignment(property)) return false;
  let node = property.initializer;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
}

/** 本文件明确声明的根字段无需读取整个导入图，模板传参及复杂来源保留原有导航。 */
export async function directTemplateDefinition(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression): Promise<readonly Definition[] | undefined> {
  if (!/\.wxml$/i.test(request.document.uri) || expression.contexts || expression.objectLiteral || request.cancellation.isCancellationRequested) return undefined;
  const selected = reference(parse(expression.text), request.offset - expression.range.start + 1);
  if (!selected || !ts.isIdentifier(selected.node) || expression.bindings.some((binding) => binding.name === selected.node.getText())) return undefined;
  const name = selected.node.text;
  const base = request.document.uri.replace(/\.wxml$/i, '');
  for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
    const uri = base + suffix;
    const document = await reader.read(uri);
    if (request.cancellation.isCancellationRequested) return [];
    if (!document) continue;
    if (document.text.length > 2_000_000) return undefined;
    const calls = directRegistrations(registrationSource(uri, document.text));
    if (calls.length !== 1) return undefined;
    const config = fields(calls[0]!.arguments[0]);
    if (!config) return undefined;
    let declaration: ts.ObjectLiteralElementLike | undefined;
    for (const group of ['data', 'properties', 'props', 'template', 'setup', 'methods']) {
      const section = config.get(group);
      if (!section) continue;
      const members = ts.isPropertyAssignment(section) && fields(section.initializer);
      if (!members) return undefined;
      const property = members.get(name);
      if (property) declaration = group === 'properties' || group === 'props' || local(property) ? property : undefined;
      if (property && !declaration) return undefined;
    }
    const own = config.get(name);
    if (own) {
      if (!local(own)) return undefined;
      if (ts.isMethodDeclaration(own) || ts.isPropertyAssignment(own) && (ts.isFunctionExpression(own.initializer) || ts.isArrowFunction(own.initializer))) declaration = own;
    }
    const target = declaration?.name;
    if (!target) return undefined;
    const quote = Number(ts.isStringLiteralLike(target));
    reader.navigation?.record({ code: 'symbol', message: '当前脚本中的明确声明可直接定位，无需展开导入图。', uri });
    return [{ uri, range: { start: target.getStart() + quote, end: target.end - quote }, originRange: { start: expression.range.start + selected.token.getStart() - 1, end: expression.range.start + selected.token.end - 1 }, ...(document.version !== undefined ? { version: document.version } : {}) }];
  }
  return undefined;
}
