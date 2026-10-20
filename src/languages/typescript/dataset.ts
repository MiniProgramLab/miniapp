import ts from 'typescript';
import type { DatasetAccess, Definition, LanguageRequest, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { nodeAt } from './navigation';

/** 事件访问链中的参数来自真实符号，路径中的动态下标不进行猜测。 */
interface EventPath {
  readonly parameter: ts.ParameterDeclaration;
  readonly path: readonly string[];
  readonly dynamic?: boolean;
}

/** 注册方法及导出函数使用其暴露声明名，匿名函数使用所属字段名。 */
function handlerName(node: ts.Node): ts.Node | undefined {
  if (!ts.isFunctionLike(node)) return undefined;
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) return node.name;
  const parent = node.parent;
  return ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) ? parent.name : undefined;
}

/** 沿静态访问、参数解构和 const 别名回溯事件参数，不执行函数或跟随可变赋值。 */
function eventPath(checker: ts.TypeChecker, node: ts.Node, seen = new Set<ts.Node>()): EventPath | undefined {
  if (seen.has(node) || seen.size > 40) return undefined;
  const visited = new Set(seen).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return eventPath(checker, node.expression, visited);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const parent = eventPath(checker, node.expression, visited);
    return parent ? { ...parent, path: [...parent.path, key ?? '*'], ...(key === undefined ? { dynamic: true } : {}) } : undefined;
  }
  if (ts.isParameter(node)) return { parameter: node, path: [] };
  if (ts.isBindingElement(node)) {
    if (node.dotDotDotToken || !ts.isObjectBindingPattern(node.parent)) return undefined;
    const key = node.propertyName ?? node.name;
    if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key))) return undefined;
    const parent = eventPath(checker, node.parent.parent, visited);
    return parent ? { ...parent, path: [...parent.path, key.text] } : undefined;
  }
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) return eventPath(checker, node.initializer, visited);
  if (ts.isIdentifier(node)) {
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
    if (declarations.length === 1) return eventPath(checker, declarations[0]!, visited);
  }
  return undefined;
}

/** 只接受第一个参数的 dataset 成员，回调中的同名参数具有不同身份。 */
function access(checker: ts.TypeChecker, token: ts.Node, project: ScriptProject): DatasetAccess | undefined {
  const parent = token.parent;
  const expression = ts.isPropertyAccessExpression(parent) && parent.name === token || ts.isElementAccessExpression(parent) && parent.argumentExpression === token ? parent
    : ts.isBindingElement(parent) && (parent.name === token || parent.propertyName === token) ? parent : undefined;
  if (!expression) return undefined;
  const traced = eventPath(checker, expression);
  const owner = traced?.parameter.parent;
  const name = owner && handlerName(owner);
  if (!traced || !owner || !ts.isFunctionLike(owner) || owner.parameters[0] !== traced.parameter || !name) return undefined;
  const [source, dataset, ...path] = traced.path;
  if (!['target', 'currentTarget'].includes(source ?? '') || dataset !== 'dataset') return undefined;
  const file = name.getSourceFile();
  if (file.isDeclarationFile) return undefined;
  const version = project.documents.get(file.fileName)?.version;
  const literal = ts.isStringLiteralLike(token);
  const range = { start: token.getStart() + (literal ? 1 : 0), end: token.end - (literal ? 1 : 0) };
  const quote = ts.isStringLiteralLike(name) ? 1 : 0;
  return { handler: { uri: file.fileName, range: { start: name.getStart(file) + quote, end: name.end - quote }, originRange: range, ...(version ===undefined ? {} : { version }) }, source: source as DatasetAccess['source'], path, range,
    ...(traced.dynamic ? { dynamic: true } : {}), ...(ts.isBindingElement(parent) && !parent.propertyName ? { shorthand: true } : {}) };
}

/** 普通脚本查询不枚举模板，错误恢复语法树可识别 dataset 后尚未输入的成员。 */
export async function datasetAccess(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions): Promise<DatasetAccess | undefined> {
  if (!request.document.text.includes('dataset') || request.cancellation.isCancellationRequested) return undefined;
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(request.document.uri);
  if (!created || project.cancelled || project.exhausted) return undefined;
  const node = nodeAt(created.entry, request.offset);
  return access(created.program.getTypeChecker(), node, project);
}

/** 引用扫描只接受当前处理函数参数，未知来源和其他函数中的同名字段不会混入。 */
export async function datasetUses(reader: WorkspaceReader, request: LanguageRequest, handler: Definition, options: ScriptOptions): Promise<readonly DatasetAccess[]> {
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(handler.uri);
  if (!created || project.cancelled || project.exhausted) return [];
  const result = new Map<string, DatasetAccess>();
  const checker = created.program.getTypeChecker();
  /** 外传事件对象和剩余解构保留未知消费标记，重命名不能静默遗漏这些路径。 */
  const unsafe = (node: ts.Node, source = node): void => {
    const traced = eventPath(checker, source);
    const name = traced && handlerName(traced.parameter.parent);
    const quote = name && ts.isStringLiteralLike(name) ? 1 : 0;
    if (!traced || !name || name.getStart() + quote !== handler.range.start || traced.path.length >= 3) return;
    const range = { start: node.getStart(), end: node.end };
    result.set(`${range.start}:${range.end}`, { handler, source: 'currentTarget', path: ['*'], range, dynamic: true });
  };
  /** 每个访问令牌通过参数身份检查，解构属性保留原键而非局部变量别名。 */
  const visit = (node: ts.Node): void => {
    if (project.cancelled) return;
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      const found = access(checker, node, project);
      if (found?.handler.uri === handler.uri && found.handler.range.start === handler.range.start && found.path.length === 1 && found.path[0]) {
        const binding = ts.isBindingElement(node.parent) && node.parent.propertyName;
        if (!binding || binding === node) result.set(`${found.range.start}:${found.range.end}`, found);
      }
      const parent = node.parent;
      const escaped = ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)
        || ts.isReturnStatement(parent) && parent.expression === node || ts.isSpreadAssignment(parent) && parent.expression === node;
      if (escaped) unsafe(node);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node) || ts.isReturnStatement(parent) && parent.expression === node || ts.isSpreadAssignment(parent) && parent.expression === node) {
        unsafe(node);
      }
    }
    if (ts.isBindingElement(node) && node.dotDotDotToken) unsafe(node, node.parent.parent);
    ts.forEachChild(node, visit);
  };
  visit(created.entry);
  return project.cancelled ? [] : [...result.values()];
}
