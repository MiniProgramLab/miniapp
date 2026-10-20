import ts from 'typescript';
import type { Definition, InstanceAccess, LanguageRequest, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { nodeAt } from './navigation';
import { Values } from './values';
import { importIndex, importKey } from './import-index';
import { dataPathKey, dataPathReference } from './data-path-key';

/** 组件集合必须先取元素，不能把组件方法错误补全在数组本身。 */
interface Selection {
  readonly call: ts.CallExpression;
  readonly path: readonly string[];
  readonly element: boolean;
}

/** 返回 const 别名真正引用的 this 节点，调用者可进一步确认其函数所有者。 */
export function thisOrigin(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Node>()): ts.Node | undefined {
  if (seen.has(node) || seen.size > 24) return undefined;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return node;
  const visited = new Set(seen).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return thisOrigin(node.expression, checker, visited);
  if (ts.isIdentifier(node)) for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) continue;
    const origin = thisOrigin(declaration.initializer, checker, visited); if (origin) return origin;
  }
  return undefined;
}

/** 实例查询与边界分析共享 const 别名规则，普通对象保持原有语义。 */
export function isThis(node: ts.Node, checker: ts.TypeChecker): boolean { return !!thisOrigin(node, checker); }

/** 实例来源沿静态别名、可选链和集合元素追踪，不解释用户赋值或运行时选择器。 */
function selection(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Node>()): Selection | undefined {
  if (seen.has(node) || seen.size > 40) return undefined;
  const visited = new Set(seen).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return selection(node.expression, checker, visited);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (['selectComponent', 'selectAllComponents'].includes(method) && isThis(node.expression.expression, checker)) return { call: node, path: [], element: method === 'selectComponent' };
    if (['find', 'at', 'pop', 'shift'].includes(method)) {
      const parent = selection(node.expression.expression, checker, visited);
      if (parent && !parent.path.length && !parent.element) return { ...parent, element: true };
    }
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const parent = selection(node.expression, checker, visited);
    if (!parent) return undefined;
    if (ts.isElementAccessExpression(node) && !parent.element && !parent.path.length) {
      const index = checker.getTypeAtLocation(node.argumentExpression);
      const numeric = (type: ts.Type): boolean => type.isUnion() ? type.types.every(numeric) : !!(type.flags & ts.TypeFlags.NumberLike) || type.isStringLiteral() && /^\d+$/.test(type.value);
      return numeric(index) ? { ...parent, element: true } : undefined;
    }
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    return name === undefined || !parent.element ? undefined : { ...parent, path: [...parent.path, name] };
  }
  if (ts.isIdentifier(node)) {
    for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) return selection(declaration.initializer, checker, visited);
      if (ts.isParameter(declaration) && ts.isArrowFunction(declaration.parent) && declaration.parent.parameters[0] === declaration) {
        const call = declaration.parent.parent;
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ['forEach', 'map', 'filter', 'find', 'some', 'every'].includes(call.expression.name.text)) {
          const parent = selection(call.expression.expression, checker, visited);
          if (parent && !parent.element && !parent.path.length) return { ...parent, element: true };
        }
      }
    }
  }
  return undefined;
}

/** 箭头回调继承外层 this，普通嵌套函数构成新的所有者边界。 */
function owner(call: ts.Node): ts.Node | undefined {
  for (let node = call.parent; node; node = node.parent) if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return node;
  return undefined;
}

/** 公开配置和工厂可从其他页面导入，直接原生注册的私有方法保留本地快路径。 */
function sharedOwner(callback: ts.Node, checker: ts.TypeChecker, values: Values): boolean {
  const source = callback.getSourceFile();
  const module = checker.getSymbolAtLocation(source);
  const exports = module ? checker.getExportsOfModule(module).map((symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol) : [];
  for (let node: ts.Node | undefined = callback; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isCallExpression(node) && values.resolve(values.value(node)).some((value) => value.registrationKind === 'page' || value.registrationKind === 'component')) {
      let nested = false;
      for (let parent: ts.Node | undefined = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) if (ts.isFunctionLike(parent)) nested = true;
      if (!nested) return false;
    }
    if (ts.isExportAssignment(node) || ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && exports.includes(checker.getSymbolAtLocation(node.name)!)) return true;
  }
  return source.statements.some((statement) => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^(?:module\.)?exports(?:\.|$)/.test(statement.expression.left.getText().replace(/\s/g, '')));
}

/** 选择器、成员和调用参数位置由真实语法树识别，空成员也支持补全。 */
function describe(project: ScriptProject, created: { program: ts.Program; entry: ts.SourceFile }, request: LanguageRequest): InstanceAccess | undefined {
  const checker = created.program.getTypeChecker();
  const values = new Values(checker, () => project.cancelled, (reference, from) => project.module(reference, from), project.adapters);
  const current = nodeAt(created.entry, request.offset);
  // 完整选中方法后，紧邻的 ?. 属于另一个令牌；保留名称右边界的语义。
  const token = current.kind === ts.SyntaxKind.QuestionDotToken && current.getStart() === request.offset ? nodeAt(created.entry, Math.max(0, request.offset - 1)) : current;
  let found: Selection | undefined;
  let range = { start: token.getStart(), end: token.end };
  let intent: InstanceAccess['intent'] = 'member';
  let argument: number | undefined;
  for (let node: ts.Node | undefined = token; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isCallExpression(node) && node.arguments[0] && request.offset >= node.arguments[0].getStart() && request.offset <= node.arguments[0].end) {
      const candidate = selection(node, checker);
      if (candidate?.call === node) {
        found = candidate; intent = 'selector';
        const first = node.arguments[0];
        const quote = ts.isStringLiteralLike(first) ? 1 : 0;
        range = { start: first.getStart() + quote, end: first.end - quote };
        break;
      }
    }
    if (ts.isCallExpression(node) && request.offset > node.expression.end) {
      const candidate = selection(node.expression, checker);
      if (candidate?.path.length) {
        found = candidate; intent = 'call';
        argument = node.arguments.filter((item) => item.end < request.offset).length;
        range = { start: node.expression.getStart(), end: node.expression.end };
        break;
      }
    }
    const expression = ts.isPropertyAccessExpression(node) && request.offset >= node.name.getStart() && request.offset <= node.name.end ? node
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && request.offset >= node.argumentExpression.getStart() && request.offset <= node.argumentExpression.end ? node : undefined;
    if (expression) {
      found = selection(expression, checker);
      const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression.argumentExpression;
      const quote = ts.isStringLiteralLike(name) ? 1 : 0;
      range = { start: name.getStart() + quote, end: name.end - quote };
      if (found) break;
    }
  }
  const callback = found && owner(found.call);
  if (!found || !callback || intent !== 'selector' && !found.element) return undefined;
  const first = found.call.arguments[0];
  if (!first) return undefined;
  const selectors = values.keys(values.value(first));
  const source = callback.getSourceFile();
  const version = project.documents.get(source.fileName)?.version;
  const definition: Definition = { uri: source.fileName, range: { start: callback.getStart(source), end: callback.end }, originRange: range, ...(version === undefined ? {} : { version }) };
  return { owner: definition, selectors, path: found.path, range, intent, shared: sharedOwner(callback, checker, values), ...(argument === undefined ? {} : { argument }) };
}

/** 单点查询只建立一份脚本快照，组件集合使用复数 API 名称。 */
export async function instanceAccess(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions): Promise<InstanceAccess | undefined> {
  if (!/select(?:All)?Components?\s*[<(]/.test(request.document.text) || request.cancellation.isCancellationRequested) return undefined;
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(request.document.uri);
  return created && !project.cancelled && !project.exhausted ? describe(project, created, request) : undefined;
}

/** 文件检查共享同一 Program，不能为每一个选择器重复读取引用图。 */
export async function instanceQueries(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions, members?: readonly string[]): Promise<readonly InstanceAccess[]> {
  if (!/select(?:All)?Components?\s*[<(]/.test(request.document.text) || request.cancellation.isCancellationRequested) return [];
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(request.document.uri);
  if (project.exhausted && members) throw new Error('组件实例脚本图超过解析预算，未生成部分引用或改名。');
  if (!created || project.cancelled || project.exhausted) return [];
  const result: InstanceAccess[] = [];
  const names = members && new Set(members);
  let visited = 0;
  /** 只枚举平台实例查询，其他调用参数不进行完整的实例回溯。 */
  const visit = (node: ts.Node): void => {
    if (project.cancelled) return;
    if (++visited > 20000 || result.length >= 256) {
      if (members) throw new Error('组件实例引用超过节点或结果预算，未生成部分引用或改名。');
      reader.navigation?.record({ code: 'budget', message: '组件实例检查超过节点或结果预算。', uri: request.document.uri }); return;
    }
    if (names) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setData' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const setter = describe(project, created, { ...request, offset: node.expression.name.getStart() });
        if (setter?.intent === 'member' && setter.path.join('.') === 'setData') for (const property of node.arguments[0].properties) {
          if (!('name' in property)) continue;
          const key = dataPathKey(property.name), field = key?.text.split(/[.[]/, 1)[0];
          if (!field || !names.has(field)) continue;
          const reference = dataPathReference(property.name, field, created.entry);
          if (reference) result.push({ ...setter, path: ['data', field], range: reference.range,
            ...(ts.isShorthandPropertyAssignment(property) ? { renameSuffix: ': ' + field } : reference.suffix === undefined ? {} : { renameSuffix: reference.suffix }) });
        }
      }
      const member = ts.isPropertyAccessExpression(node) ? node.name : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression : undefined;
      if (member && names.has(member.text)) {
        const found = describe(project, created, { ...request, offset: member.getStart() + Number(ts.isStringLiteralLike(member)) });
        if (found?.intent === 'member') result.push(found);
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['selectComponent', 'selectAllComponents'].includes(node.expression.name.text) && node.arguments[0]) {
      const first = node.arguments[0];
      if (!ts.isStringLiteralLike(first) || first.getText().at(-1) === first.getText()[0]) {
        const found = describe(project, created, { ...request, offset: first.getStart() + 1 });
        if (found?.intent === 'selector') result.push(found);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(created.entry);
  return project.cancelled ? [] : result;
}

/** 按导入图反查消费页面，仅解析模块名称，实际所有者由组件语义再次核验。 */
export async function instanceTemplates(reader: WorkspaceReader, request: LanguageRequest, access: InstanceAccess, options: ScriptOptions): Promise<readonly string[]> {
  const owner = access.owner;
  const local = owner.uri.replace(/\.[cm]?[jt]sx?$/i, '.wxml');
  if (await reader.read(local) && access.shared === false) return [local];
  const limit = options.maxRenameFiles ?? 5000;
  const indexed = await importIndex(reader, request, limit);
  if (!indexed) return [];
  const { files, reverse } = indexed;
  if (files.length > limit) throw new Error(`组件消费图超过扫描上限 ${limit}，请缩小工作区或提高 maxRenameFiles。`);
  const reached = new Set([owner.uri]);
  for (const uri of reached) for (const parent of reverse.get(importKey(uri)) ?? []) reached.add(parent);
  const templates = new Set(files.filter((file) => file.endsWith('.wxml')));
  return [...reached].map((uri) => uri.replace(/\.[cm]?[jt]sx?$/i, '.wxml')).filter((uri) => templates.has(uri));
}
