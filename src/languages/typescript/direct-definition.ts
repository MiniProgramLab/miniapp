import ts from 'typescript';
import type { Definition, Hover, LanguageRequest, NavigationStep, TemplateExpression, WorkspaceReader, WorkspaceText } from '../../api';
import { parse } from './template-values';
import { reference } from './query';
import { ScriptProject, type ScriptOptions } from './project';
import { declarationDocumentation } from './documentation';
import { completionSite } from './completion';

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

/** 按需值只保存语法节点和原始声明，不推测类型或执行项目代码。 */
interface DirectValue {
  readonly node: ts.Node;
  readonly declaration?: ts.Node;
  /** 配置对象的显式类型必须由完整检查器确认可见成员。 */
  readonly constrained?: boolean;
  /** 组件参数的运行时类型由完整语义确定。 */
  readonly property?: boolean;
}

/** 明确引用链按需读取；null 表示确定缺少成员，undefined 表示必须交回完整语义。 */
class DirectReferences {
  readonly documents = new Map<string, WorkspaceText>();
  readonly paths: NavigationStep[] = [];
  private readonly snapshots = new Map<string, WorkspaceText | undefined>();
  private readonly revisions = new Map<string, string>();
  private steps = 0;

  /** 每次查询独立保存快照，未保存内容和目标版本始终来自当前宿主。 */
  constructor(private readonly reader: WorkspaceReader, private readonly request: LanguageRequest, private readonly options: ScriptOptions, private project?: ScriptProject) {}

  /** 读取数量与文本总量有界，复杂页面不在快速路径里重复扫描全图。 */
  async source(uri: string): Promise<ts.SourceFile | undefined> {
    if (this.request.cancellation.isCancellationRequested || !this.documents.has(uri) && this.documents.size >= Math.min(32, this.options.maxFiles ?? 400)) return undefined;
    const revision = this.project?.dependencies.find((item) => item.uri === uri)?.revision ?? this.reader.revision?.(uri);
    const document = this.documents.get(uri) ?? await (this.project ? this.project.navigationSource(uri) : this.reader.read(uri));
    if (revision !== undefined && !this.revisions.has(uri)) this.revisions.set(uri, revision);
    this.snapshots.set(uri, document);
    if (!document || document.text.length > 2_000_000 || [...this.documents.values()].reduce((size, item) => size + item.text.length, 0) + document.text.length > 4_000_000) return undefined;
    this.documents.set(uri, document);
    return registrationSource(uri, document.text);
  }

  /** 路径别名、目录入口和源码映射继续使用既有官方模块解析器。 */
  private async module(node: ts.StringLiteralLike): Promise<ts.SourceFile | undefined> {
    this.project ??= new ScriptProject(this.reader, this.request, this.options);
    const uri = await this.project.navigationModule(node.text, node.getSourceFile().fileName);
    if (uri) this.paths.push({ code: 'path', message: `沿导入 ${node.text} 按需定位模块。`, uri });
    return uri ? this.source(uri) : undefined;
  }

  /** 正向、缺失路径和解析配置一起保存，结构变化不能复用旧结论。 */
  cache(): { documents: Map<string, WorkspaceText | undefined>; dependencies: Map<string, string> } {
    return {
      documents: new Map([...this.project?.documents ?? [], ...this.snapshots]),
      dependencies: new Map([...this.project?.dependencies.map((item) => [item.uri, item.revision] as const) ?? [], ...this.revisions]),
    };
  }

  /** 仅追踪显式导出；星号导出存在歧义或循环时回退完整检查器。 */
  private async exported(source: ts.SourceFile, name: string, seen: Set<ts.Node>): Promise<DirectValue | null | undefined> {
    if (seen.has(source) || seen.size > 40) return undefined;
    const visited = new Set(seen).add(source);
    const stars: ts.StringLiteralLike[] = [];
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement) && name === 'default' && !statement.isExportEquals) return this.value(statement.expression, undefined, visited);
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!statement.exportClause && specifier && ts.isStringLiteralLike(specifier)) stars.push(specifier);
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) if (item.name.text === name) {
          if (!specifier) return this.symbol(source, (item.propertyName ?? item.name).text, visited);
          if (!ts.isStringLiteralLike(specifier)) return undefined;
          const target = await this.module(specifier);
          return target ? this.exported(target, (item.propertyName ?? item.name).text, visited) : undefined;
        }
      }
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword)) {
        if (name === 'default' && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) return { node: statement, declaration: statement.name ?? statement };
      } else if (ts.isVariableStatement(statement)) {
        for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && item.name.text === name) return this.value(item, undefined, visited);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === name) return ts.isFunctionDeclaration(statement) && !statement.body ? undefined : { node: statement, declaration: statement.name };
    }
    let found: DirectValue | null = null;
    for (const specifier of name === 'default' ? [] : stars) {
      const target = await this.module(specifier);
      const value = target ? await this.exported(target, name, visited) : undefined;
      if (value === undefined || value && found && value.declaration !== found.declaration) return undefined;
      if (value) found = value;
    }
    return found;
  }

  /** 只接受无歧义的顶层声明，函数内同名绑定交由完整作用域解析。 */
  private async symbol(source: ts.SourceFile, name: string, seen: Set<ts.Node>): Promise<DirectValue | undefined> {
    const declarations: ts.Node[] = [];
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        const named = clause.namedBindings;
        const imported = clause.name?.text === name ? 'default' : named && ts.isNamedImports(named) ? named.elements.find((item) => item.name.text === name) : undefined;
        if (imported) {
          const target = await this.module(statement.moduleSpecifier);
          return target ? await this.exported(target, typeof imported === 'string' ? imported : (imported.propertyName ?? imported.name).text, seen) ?? undefined : undefined;
        }
        if (named && ts.isNamespaceImport(named) && named.name.text === name) {
          const target = await this.module(statement.moduleSpecifier);
          return target ? { node: target } : undefined;
        }
      }
      if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && item.name.text === name) declarations.push(item);
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === name) declarations.push(statement);
    }
    return declarations.length === 1 ? this.value(declarations[0]!, undefined, seen) : undefined;
  }

  /** 字面量、别名和无参工厂可直接还原，参数工厂及动态表达式保留完整语义。 */
  private async value(node: ts.Node, declaration?: ts.Node, seen = new Set<ts.Node>()): Promise<DirectValue | undefined> {
    if (++this.steps > 512 || seen.has(node) || seen.size > 40 || this.request.cancellation.isCancellationRequested) return undefined;
    const visited = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
      const value = await this.value(node.expression, declaration, visited);
      return value && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) ? { ...value, constrained: true } : value;
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
      const value = node.initializer ? await this.value(node.initializer, node.name, visited) : { node, declaration: node.name };
      return value && ts.isVariableDeclaration(node) && node.type ? { ...value, constrained: true } : value;
    }
    if (ts.isShorthandPropertyAssignment(node)) return this.value(node.name, undefined, visited);
    if (ts.isIdentifier(node)) {
      for (let scope: ts.Node | undefined = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) if (ts.isFunctionLike(scope)) {
        if (scope.parameters.some((item) => !ts.isIdentifier(item.name) || item.name.text === node.text)) return undefined;
        if ('body' in scope && scope.body && ts.isBlock(scope.body) && scope.body.statements.some((item) => ts.isVariableStatement(item) && item.declarationList.declarations.some((item) => !ts.isIdentifier(item.name) || item.name.text === node.text))) return undefined;
      }
      return this.symbol(node.getSourceFile(), node.text, visited);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const parent = await this.value(node.expression, undefined, visited);
      if (!parent || parent.constrained) return undefined;
      if (ts.isSourceFile(parent.node)) return await this.exported(parent.node, node.name.text, visited) ?? undefined;
      const property = fields(parent.node)?.get(node.name.text);
      return property ? this.value(property, undefined, visited) : undefined;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Behavior' && node.arguments.length === 1) return this.value(node.arguments[0]!, undefined, visited);
      const target = await this.value(node.expression, undefined, visited);
      if (!target || !(ts.isArrowFunction(target.node) || ts.isFunctionExpression(target.node) || ts.isFunctionDeclaration(target.node)) || target.node.parameters.length || node.arguments.length || !target.node.body) return undefined;
      const body = target.node.body;
      if (!ts.isBlock(body)) return this.value(body, undefined, visited);
      const last = body.statements[body.statements.length - 1];
      if (!last || !ts.isReturnStatement(last) || !last.expression || !body.statements.slice(0, -1).every(ts.isVariableStatement)) return undefined;
      return this.value(last.expression, undefined, visited);
    }
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return { node, ...(declaration ? { declaration } : 'name' in node && node.name ? { declaration: node.name as ts.Node } : {}) };
    return undefined;
  }

  /** 有限字面量键只用于排除无关展开，不猜测动态对象的字段值。 */
  private async typeKeys(type: ts.TypeNode, seen = new Set<ts.Node>()): Promise<ReadonlySet<string> | undefined> {
    if (seen.has(type) || seen.size >= 20 || this.request.cancellation.isCancellationRequested) return undefined;
    const visited = new Set(seen).add(type);
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) return new Set([type.literal.text]);
    if (ts.isParenthesizedTypeNode(type)) return this.typeKeys(type.type, visited);
    if (ts.isUnionTypeNode(type)) {
      if (type.types.length > 128) return undefined;
      const parts = await Promise.all(type.types.map((part) => this.typeKeys(part, visited)));
      return parts.every((part) => part !== undefined) ? new Set(parts.flatMap((part) => [...part!])) : undefined;
    }
    if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.KeyOfKeyword && ts.isTypeQueryNode(type.type) && ts.isIdentifier(type.type.exprName)) {
      const value = await this.value(type.type.exprName);
      const members = value && !value.constrained && fields(value.node);
      return members && members.size <= 256 ? new Set(members.keys()) : undefined;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && !type.typeArguments?.length) {
      const name = type.typeName.text;
      const alias = type.getSourceFile().statements.find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === name);
      return alias ? this.typeKeys(alias.type, visited) : undefined;
    }
    return undefined;
  }

  /** 只承认未被本地声明遮蔽的有限 Record 键。 */
  private async recordKeys(value: DirectValue): Promise<ReadonlySet<string> | undefined> {
    const declaration = value.declaration?.parent;
    const type = declaration && ts.isVariableDeclaration(declaration) ? declaration.type : undefined;
    if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'Record' && type.typeArguments?.length === 2) {
      const source = type.getSourceFile();
      const shadowed = source.statements.some((statement) => (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) && statement.name?.text === 'Record'
        || ts.isImportDeclaration(statement) && (statement.importClause?.name?.text === 'Record' || statement.importClause?.namedBindings && (ts.isNamespaceImport(statement.importClause.namedBindings) ? statement.importClause.namedBindings.name.text === 'Record' : statement.importClause.namedBindings.elements.some((item) => item.name.text === 'Record'))));
      const keys = !shadowed && await this.typeKeys(type.typeArguments[0]!);
      return keys || undefined;
    }
    return undefined;
  }

  /** 静态字段表只展开对象和有限键，遇到开放类型整体回退。 */
  private async object(node: ts.Node, seen = new Set<ts.Node>()): Promise<Map<string, ts.Node> | undefined> {
    if (seen.has(node) || seen.size > 40) return undefined;
    const value = await this.value(node);
    if (!value) return undefined;
    if (value.constrained) {
      const keys = await this.recordKeys(value);
      return keys ? new Map([...keys].map((key) => [key, value.node])) : undefined;
    }
    if (!ts.isObjectLiteralExpression(value.node)) return undefined;
    const result = new Map<string, ts.Node>(), visited = new Set(seen).add(node);
    for (const property of value.node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = await this.object(property.expression, visited);
        if (!spread) return undefined;
        for (const [name, field] of spread) result.set(name, field);
      } else {
        const name = property.name;
        if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))) return undefined;
        result.set(name.text, property);
      }
    }
    return result;
  }

  /** 候选必须覆盖全部静态成员，任何不确定分支都保留完整语义处理。 */
  async names(node: ts.Node, seen = new Set<ts.Node>()): Promise<ReadonlySet<string> | undefined> {
    if (seen.has(node) || seen.size > 40) return undefined;
    const config = await this.object(node);
    if (!config) return undefined;
    const result = new Set<string>(), visited = new Set(seen).add(node);
    for (const group of ['behaviors', 'mixins']) {
      const section = config.get(group);
      if (!section) continue;
      const list = await this.value(section);
      if (!list || list.constrained || !ts.isArrayLiteralExpression(list.node) || list.node.elements.some(ts.isSpreadElement)) return undefined;
      for (const item of list.node.elements) {
        const inherited = await this.names(item, visited);
        if (!inherited) return undefined;
        for (const name of inherited) result.add(name);
      }
    }
    const groups = ['data', 'properties', 'props', 'template', 'setup', 'methods'];
    for (const group of groups) {
      const section = config.get(group);
      if (!section) continue;
      const fields = await this.object(section);
      if (!fields) return undefined;
      for (const name of fields.keys()) result.add(name);
    }
    for (const [name, property] of config) {
      if ([...groups, 'behaviors', 'mixins'].includes(name)) continue;
      const value = await this.value(property);
      if (!value) return undefined;
      if (ts.isFunctionLike(value.node)) result.add(name);
    }
    return result;
  }

  /** 逆序检查目标字段，只展开可能覆盖它的对象分支。 */
  private async property(node: ts.Node, name: string, seen = new Set<ts.Node>()): Promise<ts.ObjectLiteralElementLike | null | undefined> {
    if (seen.has(node) || seen.size > 40 || this.request.cancellation.isCancellationRequested) return undefined;
    const value = await this.value(node);
    if (!value) return undefined;
    if (value.constrained) {
      const keys = await this.recordKeys(value);
      if (keys && !keys.has(name)) return null;
      return undefined;
    }
    if (!ts.isObjectLiteralExpression(value.node)) return undefined;
    const visited = new Set(seen).add(node);
    for (const property of [...value.node.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) {
        const inherited = await this.property(property.expression, name, visited);
        if (inherited !== null) return inherited;
        continue;
      }
      const key = property.name;
      if (!key || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) return undefined;
      if (key.text === name) return property;
    }
    return null;
  }

  /** 先检查覆盖项，再逆序查找继承项，只读取决定目标的 Behavior 分支。 */
  async member(node: ts.Node, name: string, seen = new Set<ts.Node>()): Promise<DirectValue | null | undefined> {
    if (seen.has(node) || seen.size > 40) return undefined;
    const resolved = await this.value(node);
    const config = resolved && !resolved.constrained && ts.isObjectLiteralExpression(resolved.node) ? resolved.node : undefined;
    if (!config) return undefined;
    const visited = new Set(seen).add(node);
    const own = await this.property(config, name);
    if (own === undefined) return undefined;
    if (own) {
      const value = await this.value(own);
      if (!value) return undefined;
      if (ts.isFunctionLike(value.node)) return value;
    }
    for (const group of ['methods', 'setup', 'template', 'props', 'properties', 'data']) {
      const section = await this.property(config, group);
      if (section === undefined) return undefined;
      if (!section) continue;
      const property = await this.property(section, name);
      if (property === undefined) return undefined;
      if (property) return group === 'props' || group === 'properties' ? { node: property, declaration: property.name!, property: true } : local(property) ? { node: property, declaration: property.name! } : this.value(property);
    }
    for (const group of ['mixins', 'behaviors']) {
      const section = await this.property(config, group);
      if (section === undefined) return undefined;
      if (!section) continue;
      const list = await this.value(section);
      if (!list || !ts.isArrayLiteralExpression(list.node) || list.node.elements.some(ts.isSpreadElement)) return undefined;
      for (const item of [...list.node.elements].reverse()) {
        const value = await this.member(item, name, visited);
        if (value !== null) return value;
      }
    }
    return null;
  }
}

/** 缓存只保存目标和依赖快照，模板使用处范围始终由当前请求重新计算。 */
interface CachedReference {
  readonly key: string;
  readonly target: Omit<Definition, 'originRange' | 'version'> | undefined;
  readonly names?: readonly string[];
  readonly literalType?: string;
  readonly description?: string;
  readonly documents: Map<string, WorkspaceText | undefined>;
  readonly dependencies: Map<string, string>;
  readonly paths: readonly NavigationStep[];
  readonly weight: number;
}

/** 同一宿主最多保留十二条引用链、四百万字符，宿主关闭后可整体回收。 */
const references = new WeakMap<NonNullable<WorkspaceReader['revision']>, CachedReference[]>();

/** 仅打开目标时复核文本并更新版本；内容、配置或目录变化重新解析引用链。 */
async function unchanged(reader: WorkspaceReader, request: LanguageRequest, cached: CachedReference): Promise<boolean> {
  const revision = reader.revision!;
  const changed = [...cached.dependencies].filter(([uri, previous]) => revision(uri) !== previous);
  if (changed.length > 8 || changed.some(([uri]) => !cached.documents.has(uri))) return false;
  const refreshed: [string, WorkspaceText | undefined, string][] = [];
  for (const [uri] of changed) {
    const before = revision(uri);
    const document = await reader.read(uri);
    if (request.cancellation.isCancellationRequested || document?.text !== cached.documents.get(uri)?.text || revision(uri) !== before) return false;
    refreshed.push([uri, document, before]);
  }
  const expected = new Map(refreshed.map(([uri, , version]) => [uri, version]));
  if ([...cached.dependencies].some(([uri, previous]) => revision(uri) !== (expected.get(uri) ?? previous))) return false;
  for (const [uri, document, version] of refreshed) { cached.documents.set(uri, document); cached.dependencies.set(uri, version); }
  return true;
}

/** 语法不明确时只放弃快速路径，完整类型图仍负责最终导航结论。 */
async function locate(request: LanguageRequest, name: string, graph: DirectReferences): Promise<(Omit<Definition, 'originRange' | 'version'> & { literalType?: string; description?: string }) | undefined> {
  const base = request.document.uri.replace(/\.wxml$/i, '');
  for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
    const uri = base + suffix;
    const source = await graph.source(uri);
    if (request.cancellation.isCancellationRequested) return undefined;
    if (!source) continue;
    const calls = directRegistrations(source);
    if (calls.length !== 1) return undefined;
    const resolved = await graph.member(calls[0]!.arguments[0]!, name);
    if (request.cancellation.isCancellationRequested) return undefined;
    const target = resolved?.declaration;
    if (!target) return undefined;
    const targetUri = target.getSourceFile().fileName;
    const quote = Number(ts.isStringLiteralLike(target));
    let literalType: string | undefined;
    if (resolved && !resolved.property && !resolved.constrained && ts.isPropertyAssignment(resolved.node)) {
      let initial = resolved.node.initializer;
      while (ts.isParenthesizedExpression(initial)) initial = initial.expression;
      if (ts.isStringLiteralLike(initial)) literalType = JSON.stringify(initial.text);
      else if (ts.isNumericLiteral(initial)) literalType = String(Number(initial.text));
      else if (initial.kind === ts.SyntaxKind.TrueKeyword || initial.kind === ts.SyntaxKind.FalseKeyword) literalType = initial.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false';
    }
    return { uri: targetUri, range: { start: target.getStart() + quote, end: target.end - quote }, ...(literalType === undefined ? {} : { literalType, description: declarationDocumentation(target) }) };
  }
  return undefined;
}

/** 补全字段索引仅跟随注册链，类型详情由选中项再查询。 */
export async function directTemplateNames(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression, options: ScriptOptions): Promise<readonly string[] | undefined> {
  if (!/\.wxml$/i.test(request.document.uri) || expression.contexts || expression.objectLiteral || expression.event || expression.bindings.length || options.adapters?.length || request.cancellation.isCancellationRequested) return undefined;
  const key = JSON.stringify(['completion', reader.root(request.document.uri), request.document.uri, options]);
  const cached = reader.revision && references.get(reader.revision)?.find((item) => item.key === key);
  if (cached && await unchanged(reader, request, cached)) return cached.names;
  const graph = new DirectReferences(reader, request, options);
  let names: readonly string[] | undefined;
  for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
    const source = await graph.source(request.document.uri.replace(/\.wxml$/i, suffix));
    if (request.cancellation.isCancellationRequested) return undefined;
    if (!source) continue;
    const calls = directRegistrations(source);
    if (calls.length === 1) names = [...await graph.names(calls[0]!.arguments[0]!) ?? []];
    // 空集合可能来自不确定语法，交给完整语义确认。
    if (!names?.length) names = undefined;
    break;
  }
  const snapshot = graph.cache();
  const weight = [...snapshot.documents.values()].reduce((size, document) => size + (document?.text.length ?? 0), 0);
  if (reader.revision && !request.cancellation.isCancellationRequested && weight <= 4_000_000 && [...snapshot.dependencies].every(([uri, version]) => reader.revision!(uri) === version)) {
    const entries = (references.get(reader.revision) ?? []).filter((item) => item.key !== key);
    entries.push({ key, target: undefined, ...(names ? { names } : {}), ...snapshot, weight, paths: graph.paths });
    while (entries.length > 12 || entries.reduce((size, item) => size + item.weight, 0) > 4_000_000) entries.shift();
    references.set(reader.revision, entries);
  }
  return names;
}

/** 明确根字段只展开必要引用，模板传参及复杂来源保留完整语义导航。 */
export async function directTemplateDefinition(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression, options: ScriptOptions = {}, project?: ScriptProject): Promise<readonly Definition[] | undefined> {
  if (!/\.wxml$/i.test(request.document.uri) || expression.contexts || expression.objectLiteral || request.cancellation.isCancellationRequested) return undefined;
  const selected = reference(parse(expression.text), request.offset - expression.range.start + 1);
  if (!selected || !ts.isIdentifier(selected.node) || expression.bindings.some((binding) => binding.name === selected.node.getText())) return undefined;
  const key = JSON.stringify([reader.root(request.document.uri), request.document.uri, selected.node.text, options]);
  const cached = reader.revision && references.get(reader.revision)?.find((item) => item.key === key);
  let current: CachedReference;
  if (cached && await unchanged(reader, request, cached)) {
    current = cached;
    reader.navigation?.record({ code: 'cached', message: '复用已核验依赖的按需引用链。', uri: cached.target?.uri ?? request.document.uri });
    for (const path of cached.paths) reader.navigation?.record(path);
  } else {
    const graph = new DirectReferences(reader, request, options, project);
    const located = await locate(request, selected.node.text, graph);
    const target = located && { uri: located.uri, range: located.range };
    const snapshot = graph.cache();
    const weight = [...snapshot.documents.values()].reduce((size, document) => size + (document?.text.length ?? 0), 0);
    current = { key, target, ...snapshot, weight, paths: graph.paths, ...(located?.literalType === undefined ? {} : { literalType: located.literalType, description: located.description ?? '' }) };
    if (reader.revision && !request.cancellation.isCancellationRequested && weight <= 4_000_000 && [...current.dependencies].every(([uri, version]) => reader.revision!(uri) === version)) {
      const entries = (references.get(reader.revision) ?? []).filter((item) => item.key !== key);
      entries.push(current);
      while (entries.length > 12 || entries.reduce((size, item) => size + item.weight, 0) > 4_000_000) entries.shift();
      references.set(reader.revision, entries);
    }
  }
  if (request.cancellation.isCancellationRequested) return [];
  if (!current.target) return undefined;
  const version = current.documents.get(current.target.uri)?.version;
  reader.navigation?.record({ code: 'symbol', message: '明确声明沿必要引用链定位，无需展开无关导入。', uri: current.target.uri });
  return [{ ...current.target, originRange: { start: expression.range.start + selected.token.getStart() - 1, end: expression.range.start + selected.token.end - 1 }, ...(version !== undefined ? { version } : {}) }];
}

/** 字面量字段的类型和原注释可直接确认，不为简单详情启动完整类型图。 */
export async function directCompletionDetails(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression, name: string, options: ScriptOptions): Promise<{ detail: string; documentation: string } | undefined> {
  if (!reader.revision || options.adapters?.length) return undefined;
  const site = completionSite(request, expression);
  if (!site || !ts.isIdentifier(site.node)) return undefined;
  const current = { ...request, document: { ...request.document, text: name }, offset: name.length };
  const selected = { ...expression, text: name, range: { start: 0, end: name.length } };
  const definitions = await directTemplateDefinition(reader, current, selected, options);
  if (!definitions?.length || request.cancellation.isCancellationRequested) return undefined;
  const key = JSON.stringify([reader.root(request.document.uri), request.document.uri, name, options]);
  const cached = references.get(reader.revision)?.find((item) => item.key === key);
  return cached?.literalType === undefined ? undefined : { detail: cached.literalType, documentation: cached.description ?? '' };
}

/** 简单声明直接读取原注释；null 表示已确定没有说明，复杂类型继续走语义图。 */
export async function directTemplateHover(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression, options: ScriptOptions): Promise<Hover | null | undefined> {
  const definitions = await directTemplateDefinition(reader, request, expression, options);
  if (definitions?.length !== 1 || request.cancellation.isCancellationRequested) return undefined;
  const definition = definitions[0]!;
  const document = await reader.read(definition.uri);
  if (!document || document.text.length > 2_000_000 || definition.version !== undefined && document.version !== definition.version) return undefined;
  const source = registrationSource(definition.uri, document.text);
  let declaration: ts.Node | undefined;
  /** 只沿目标范围寻找声明，不遍历其他函数体。 */
  const visit = (node: ts.Node): void => {
    if (node.end < definition.range.start || node.getStart(source) > definition.range.end) return;
    if ('name' in node && node.name && typeof node.name === 'object') {
      const name = node.name as ts.Node, quote = Number(ts.isStringLiteralLike(name));
      if (name.getStart(source) + quote === definition.range.start && name.end - quote === definition.range.end) declaration = node;
    }
    if (!declaration) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration || !(ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) || 'type' in declaration && declaration.type) return undefined;
  const section = declaration.parent.parent;
  if (section && ts.isPropertyAssignment(section) && (ts.isIdentifier(section.name) || ts.isStringLiteralLike(section.name)) && ['properties', 'props'].includes(section.name.text)) return undefined;
  if ('initializer' in declaration && declaration.initializer) {
    let initializer = declaration.initializer;
    while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
    if (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer)) return undefined;
  }
  const description = declarationDocumentation('name' in declaration && declaration.name ? declaration.name : declaration);
  if (!description && !(ts.isMethodDeclaration(declaration) || ts.isPropertyAssignment(declaration))) return undefined;
  return description ? { title: request.document.text.slice(definition.originRange.start, definition.originRange.end), description, range: definition.originRange } : null;
}
