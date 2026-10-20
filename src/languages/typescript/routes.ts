import ts from 'typescript';
import type { Definition, LanguageRequest, PageQuery, RouteAccess, RouteManifest, SemanticType, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { Values } from './values';
import type { Value } from './values';
import { nodeAt } from './navigation';
import { semanticType, signature } from './semantic-types';
import { declarationDocumentation } from './documentation';

/** 当前语义图内只计算一次真实实例方法集合。 */
const instanceOwners = new WeakMap<Values, ReadonlyMap<ts.Node, NonNullable<Value['registrationKind']>>>();

/** this 必须来自真实页面或组件方法，普通函数和箭头顶层 this 不能冒充实例。 */
function ownsThis(node: ts.Node, values: Values): Value['registrationKind'] {
  let owner: ts.Node | undefined;
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) { owner = parent; break; }
  if (!owner) return undefined;
  let owners = instanceOwners.get(values);
  if (!owners) {
    const collected = new Map<ts.Node, NonNullable<Value['registrationKind']>>();
    for (const entry of values.registration(node.getSourceFile(), true)) for (const registration of values.resolve(entry)) {
      if (!registration.registrationKind) continue;
      const members = [...values.context(registration).values()];
      for (const group of ['lifetimes', 'pageLifetimes']) for (const section of values.access(registration, [group])) members.push(...values.fields(section).values());
      for (const items of members) for (const value of items) for (const resolved of values.resolve(value)) if (ts.isFunctionLike(resolved.node)) collected.set(resolved.node, registration.registrationKind);
    }
    owners = collected; instanceOwners.set(values, owners);
  }
  return owners.get(owner);
}

/** 查询只读取当前源码图，草稿和参数绑定始终来自同一份 Program。 */
async function context(reader: WorkspaceReader, request: LanguageRequest, uri: string, options: ScriptOptions) {
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(uri);
  if (!created || project.cancelled) return undefined;
  const checker = created.program.getTypeChecker();
  return { project, source: created.entry, checker, values: new Values(checker, () => project.cancelled, (name, from) => project.module(name, from), options.adapters) };
}

/** 原生 wx 允许环境声明，工程内自行创建的同名对象不当作平台 API。 */
function globalWx(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(node) || node.text !== 'wx') return false;
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile || ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Ambient);
}

/** 静态函数别名及 this.router 保留平台调用身份，循环别名有界终止。 */
function native(node: ts.Node, values: Values, seen = new Set<ts.Node>()): Pick<RouteAccess, 'method' | 'base' | 'baseUri' | 'relativeTo' | 'owner'> | undefined {
  if (seen.has(node) || seen.size > 32) return undefined;
  const visited = new Set(seen).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return native(node.expression, values, visited);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : values.keys(values.value(node.argumentExpression))[0];
    if (!['navigateTo', 'redirectTo', 'switchTab', 'reLaunch'].includes(name ?? '')) return undefined;
    let receiver: ts.Node = node.expression;
    const receivers = new Set<ts.Node>();
    while (ts.isIdentifier(receiver) && !receivers.has(receiver) && receivers.size < 32) {
      receivers.add(receiver);
      const declaration = values.checker.getSymbolAtLocation(receiver)?.declarations?.find((item): item is ts.VariableDeclaration => ts.isVariableDeclaration(item) && !!item.initializer && !!(item.parent.flags & ts.NodeFlags.Const));
      if (!declaration?.initializer) break;
      receiver = declaration.initializer;
    }
    if (globalWx(receiver, values.checker)) return { method: name as RouteAccess['method'], base: 'page' };
    if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword && ['router', 'pageRouter'].includes(receiver.name.text) && ownsThis(node, values)) {
      const owner = routeOwner(node);
      return { method: name as RouteAccess['method'], base: ownsThis(node, values) === 'behavior' ? 'unknown' : receiver.name.text === 'router' ? 'component' : 'page', baseUri: node.getSourceFile().fileName, relativeTo: receiver.name.text === 'router' ? 'component' : 'page', ...(owner ? { owner } : {}) };
    }
  }
  if (ts.isIdentifier(node)) {
    for (const declaration of values.checker.getSymbolAtLocation(node)?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const) return native(declaration.initializer, values, visited);
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const owner = declaration.parent.parent;
        if (ts.isVariableDeclaration(owner) && owner.initializer && globalWx(owner.initializer, values.checker)) {
          const name = values.name(declaration.propertyName ?? declaration.name);
          if (['navigateTo', 'redirectTo', 'switchTab', 'reLaunch'].includes(name ?? '')) return { method: name as RouteAccess['method'], base: 'page' };
        }
      }
    }
  }
  return undefined;
}

/** 字符串内部范围用于替换和导航；常量及调用表达式保持原始范围。 */
function range(node: ts.Node): import('../../api').TextRange {
  const quote = ts.isStringLiteralLike(node) ? 1 : 0;
  return { start: node.getStart() + quote, end: node.end - quote };
}

/** 事件方法和生命周期的完整函数范围用于核验消费组件，箭头回调沿用外层函数。 */
function routeOwner(node: ts.Node): Definition | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) {
    const range = { start: parent.getStart(), end: parent.end };
    return { uri: parent.getSourceFile().fileName, range, originRange: range };
  }
  return undefined;
}

/** 包装器中的参数还原到调用者位置，外部函数体不能成为当前诊断坐标。 */
function origin(value: Value, source: ts.SourceFile, call: ts.CallExpression, values: Values, seen = new Set<ts.Node>()): ts.Node | undefined {
  if (seen.has(value.node) || seen.size >= 40) return undefined;
  const visited = new Set(seen).add(value.node);
  if (ts.isPropertyAssignment(value.node)) return origin({ ...value, node: value.node.initializer }, source, call, values, visited);
  if (ts.isShorthandPropertyAssignment(value.node)) {
    // 简写属性的名称符号属于属性，参数绑定需要使用真实值符号。
    const symbol = values.checker.getShorthandAssignmentValueSymbol(value.node);
    const bound = symbol && value.bindings.get(symbol);
    return origin(bound ?? { ...value, node: value.node.name }, source, call, values, visited);
  }
  if (value.node.getSourceFile() === source && value.node.getStart() >= call.getStart() && value.node.end <= call.end) return value.node;
  const candidates: ts.Node[] = [];
  /** 只沿当前值的参数绑定查找，不把包装器的其他实参误当成 URL。 */
  const visit = (node: ts.Node): void => {
    const symbol = values.checker.getSymbolAtLocation(node);
    const bound = symbol && value.bindings.get(symbol);
    if (bound) {
      const candidate = origin(bound, source, call, values, visited);
      if (candidate) candidates.push(candidate);
    }
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  visit(value.node);
  return candidates.sort((a, b) => a.getStart() - b.getStart())[0];
}

/** 原生调用和静态包装器共享 URL 求值，动态查询字符串不掩盖明确的页面路径。 */
export async function routeQueries(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions, all = true): Promise<readonly RouteAccess[]> {
  const graph = await context(reader, request, request.document.uri, options);
  if (!graph) return [];
  const { source, values } = graph;
  const result = new Map<string, RouteAccess>();
  /** 全文件诊断只追踪当前调用的执行体，不执行工程函数。 */
  const visit = (node: ts.Node): void => {
    if (graph.project.cancelled) return;
    if (ts.isCallExpression(node)) for (const called of values.calls(values.value(node), (call) => !!native(call.expression, values))) {
      const call = called.node as ts.CallExpression;
      const navigation = native(call.expression, values);
      if (!navigation || !call.arguments[0]) continue;
      for (const url of values.access({ ...called, node: call.arguments[0] }, ['url'])) {
        const original = origin(url, source, node, values);
        if (!original) continue;
        const selected = request.offset >= original.getStart() && request.offset <= original.end ? nodeAt(source, request.offset) : original;
        const token = (ts.isIdentifier(selected) || ts.isStringLiteralLike(selected)) && selected.getStart() >= original.getStart() && selected.end <= original.end ? selected : original;
        const owner = navigation.owner ?? routeOwner(node);
        const access: RouteAccess = { ...navigation, ...(owner ? { owner, relativeTo: navigation.relativeTo ?? 'page' } : {}), range: range(token), urls: values.strings(url), ...(ts.isStringLiteralLike(token) && token === original ? { editable: true } : {}) };
        result.set(`${access.range.start}:${access.range.end}:${access.method}`, access);
      }
    }
    if (all) ts.forEachChild(node, visit);
  };
  if (all) visit(source);
  else for (let node: ts.Node | undefined = nodeAt(source, request.offset); node; node = node.parent) if (ts.isCallExpression(node)) visit(node);
  if (/\/app\.config\.[cm]?[jt]s$/i.test(request.document.uri)) {
    const manifest = await routeManifest(reader, request, request.document.uri, options);
    for (const page of manifest?.pages ?? []) if (page.definition.uri === request.document.uri) result.set(`registration:${page.definition.range.start}`, { range: page.definition.range, urls: [{ text: '/' + page.path, complete: true }], method: 'reLaunch', base: 'page', editable: true, registration: page.package ?? '' });
  }
  return graph.project.cancelled ? [] : [...result.values()];
}

/** 应用配置保留页面注册范围；未知展开使缺失页面检查保持开放。 */
export async function routeManifest(reader: WorkspaceReader, request: LanguageRequest, uri: string, options: ScriptOptions): Promise<RouteManifest | undefined> {
  const graph = await context(reader, request, uri, options);
  if (!graph) return undefined;
  const { source, values, project } = graph;
  const entries = values.registration(source).flatMap((entry) => ts.isCallExpression(entry.node) && values.callName(entry.node) === 'defineAppConfig' && entry.node.arguments[0] ? [values.value(entry.node.arguments[0])] : [entry]);
  if (!entries.length) return undefined;
  const pages: RouteManifest['pages'][number][] = [];
  const tabs: string[] = [];
  const registrations: NonNullable<RouteManifest['registrations']>[number][] = [];
  const collections: NonNullable<RouteManifest['collections']>[number][] = [];
  let complete = !project.exhausted, tabComplete = !project.exhausted;
  /** 页面注册取实际字符串声明位置，分包根只影响路径、不改变来源范围。 */
  const page = (item: Value, prefix = '', independent = false): void => {
    const paths = values.strings(item);
    if (!paths.length || paths.some((path) => !path.complete)) complete = false;
    for (const path of paths.filter((path) => path.complete)) {
      const original = values.resolve(item)[0]?.node ?? item.node;
      const definition: Definition = { uri: original.getSourceFile().fileName, range: range(original), originRange: range(original) };
      pages.push({ path: prefix ? prefix.replace(/\/$/, '') + '/' + path.text.replace(/^\//, '') : path.text.replace(/^\//, ''), definition, ...(prefix ? { package: prefix, independent } : {}) });
      const parent = item.node.parent;
      registrations.push({ kind: 'page', path: pages.at(-1)!.path, value: path, ...(prefix ? { package: prefix } : {}), ...(ts.isArrayLiteralExpression(parent) ? { collection: { uri: parent.getSourceFile().fileName, range: { start: parent.getStart(), end: parent.end }, item: { start: item.node.getStart(), end: item.node.end } } } : {}) });
    }
  };
  /** 从真实数组声明记录迁移位置，导入数组仍指向原始模块。 */
  const pagesIn = (list: Value, prefix = '', independent = false): void => {
    complete &&= values.closed(list, true);
    for (const resolved of values.resolve(list)) if (ts.isArrayLiteralExpression(resolved.node)) collections.push({ uri: resolved.node.getSourceFile().fileName, range: { start: resolved.node.getStart(), end: resolved.node.end }, ...(prefix ? { package: prefix } : {}) });
    for (const item of values.elements(list)) page(item, prefix, independent);
  };
  for (const entry of entries) {
    const fields = values.fields(entry);
    complete &&= values.closed(entry);
    for (const list of fields.get('pages') ?? []) pagesIn(list);
    for (const name of ['subPackages', 'subpackages']) for (const list of fields.get(name) ?? []) {
      complete &&= values.closed(list, true);
      for (const group of values.elements(list)) {
        complete &&= values.closed(group);
        const roots = values.access(group, ['root']).flatMap((item) => values.strings(item));
        if (roots.length !== 1 || !roots[0]?.complete) { complete = false; continue; }
        registrations.push({ kind: 'package', path: roots[0].text, value: roots[0] });
        const independent = values.access(group, ['independent']).some((item) => values.resolve(item).some((value) => value.node.kind === ts.SyntaxKind.TrueKeyword));
        for (const items of values.access(group, ['pages'])) pagesIn(items, roots[0].text, independent);
      }
    }
    tabComplete &&= values.closed(entry);
    for (const tab of fields.get('tabBar') ?? []) {
      tabComplete &&= values.closed(tab);
      for (const list of values.access(tab, ['list'])) {
        tabComplete &&= values.closed(list, true);
        for (const item of values.elements(list)) for (const value of values.access(item, ['pagePath'])) {
          const paths = values.strings(value);
          tabComplete &&= !!paths.length && paths.every((path) => path.complete);
          tabs.push(...paths.filter((path) => path.complete).map((path) => path.text.replace(/^\//, '')));
          registrations.push(...paths.filter((path) => path.complete).map((value) => ({ kind: 'tab' as const, path: value.text.replace(/^\//, ''), value })));
        }
      }
    }
  }
  return { pages, tabs, complete, tabComplete, dependencies: project.dependencies, registrations, collections };
}

/** 标准构造器与显式构造签名投影为解析后的参数类型，不执行转换函数。 */
function queryType(value: Value, values: Values): SemanticType {
  const types: SemanticType[] = [];
  for (const resolved of values.resolve(value)) {
    // 标准构造器常与同名接口合并声明，类型空间不能成为另一种运行时构造器。
    if (ts.isInterfaceDeclaration(resolved.node) || ts.isTypeAliasDeclaration(resolved.node)) continue;
    const node = ts.isVariableDeclaration(resolved.node) ? resolved.node.name : resolved.node;
    const name = values.name(node);
    const declarations = values.checker.getSymbolAtLocation(node)?.declarations ?? [];
    if (!declarations.length || declarations.every((item) => item.getSourceFile().hasNoDefaultLib)) {
      if (name === 'String') { types.push({ kind: 'string', display: 'string' }); continue; }
      if (name === 'Number') { types.push({ kind: 'number', display: 'number' }); continue; }
      if (name === 'Boolean') { types.push({ kind: 'boolean', display: 'boolean' }); continue; }
      if (name === 'Object') { types.push({ kind: 'object', display: 'Record<string, unknown>', properties: {} }); continue; }
      if (name === 'Array') { types.push({ kind: 'array', display: 'unknown[]', element: { kind: 'unknown', display: 'unknown' } }); continue; }
    }
    const type = values.checker.getTypeAtLocation(resolved.node);
    const construct = values.checker.getSignaturesOfType(type, ts.SignatureKind.Construct)[0];
    types.push(construct ? semanticType(values.checker, values.checker.getReturnTypeOfSignature(construct), resolved.node) : { kind: 'unknown', display: 'unknown' });
  }
  const alternatives = [...new Map(types.map((type) => [type.display, type])).values()];
  return alternatives.length === 1 ? alternatives[0]! : alternatives.length ? { kind: 'unknown', display: alternatives.map((type) => type.display).join(' | '), alternatives } : { kind: 'unknown', display: 'unknown' };
}

/** 查询字段位置来自真实声明，构造器或默认值不会成为字段改名的目标。 */
function queryDefinition(node: ts.Node): Definition {
  const name = 'name' in node && node.name && typeof node.name === 'object' ? node.name as ts.Node : node;
  const selected = range(name);
  return { uri: node.getSourceFile().fileName, range: selected, originRange: selected };
}

/** 类型参数与静态 schema 共用完整依赖，普通 any 和未知展开保持开放。 */
export async function pageQuery(reader: WorkspaceReader, request: LanguageRequest, uri: string, options: ScriptOptions): Promise<PageQuery | undefined> {
  const graph = await context(reader, request, uri, options);
  if (!graph) return undefined;
  const { values, checker } = graph;
  const entries = values.registration(graph.source);
  const fields = new Map<string, NonNullable<PageQuery['fields']>[number]>();
  let complete = !graph.project.exhausted;
  for (const entry of entries) {
    const configs = [entry];
    const registered = values.resolve(entry).some((item) => item.registrationKind === 'page' || item.registrationKind === 'component');
    // 实际注册包装器允许原始选项保留 query，声明宏通过导入符号与字段路径映射。
    if (registered && ts.isCallExpression(entry.node) && !values.adapter(entry.node)) configs.push(...entry.node.arguments.map((node) => ({ ...entry, node })));
    const schemas = configs.flatMap((config) => values.access(config, ['query']));
    for (const schema of schemas) {
      complete &&= values.closed(schema);
      for (const [name, items] of values.fields(schema)) {
        const item = items[0];
        if (!item) continue;
        const descriptors = values.access(item, ['type']);
        const type = queryType(descriptors[0] ?? item, values);
        const defaults = [...values.access(item, ['value']), ...values.access(item, ['default'])];
        const flags = values.access(item, ['required']).flatMap((value) => values.resolve(value));
        const required = !defaults.length && !!flags.length && flags.every((resolved) => resolved.node.kind === ts.SyntaxKind.TrueKeyword);
        const definitions = items.map((value) => queryDefinition(value.declaration ?? value.node));
        const description = declarationDocumentation(item.declaration ?? item.node);
        const defaultValue = defaults[0] && values.resolve(defaults[0])[0]?.node.getText();
        fields.set(name, { name, type: { ...type, optional: !required }, required, description, definitions, ...(defaultValue === undefined ? {} : { defaultValue }) });
      }
    }
    if (schemas.length) continue;
    for (const method of values.context(entry).get('onLoad') ?? []) for (const fn of values.resolve(method)) {
      const type = signature(checker, fn.node)?.parameters[0]?.type;
      if (!type?.properties || !ts.isFunctionLike(fn.node)) continue;
      const parameter = fn.node.parameters.find((item) => item.name.getText() !== 'this');
      for (const [name, property] of Object.entries(type.properties)) {
        const symbol = parameter && checker.getPropertyOfType(checker.getTypeAtLocation(parameter), name);
        const declarations = symbol?.declarations ?? [];
        fields.set(name, { name, type: property, required: property.optional !== true, description: declarations[0] ? declarationDocumentation(declarations[0]) : '', definitions: declarations.map(queryDefinition) });
      }
    }
  }
  return { type: { kind: 'object', display: '页面查询参数', properties: Object.fromEntries([...fields].map(([name, field]) => [name, field.type])) }, fields: [...fields.values()], complete, dependencies: graph.project.dependencies };
}
