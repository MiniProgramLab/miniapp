import { posix as path } from 'node:path';
import ts from 'typescript';

/** 从构建配置提取出的目录映射，输出路径对应真实源码。 */
export interface PathMapping {
  readonly output: string;
  readonly source: string;
  readonly exact?: boolean;
  /** 只有源码编译目录映射可以还原扩展名，原样复制不改写文件类型。 */
  readonly compiled?: boolean;
}

/** 别名匹配保留精确规则与通配符，避免相似前缀误命中。 */
export interface PathAlias {
  readonly name: string;
  readonly targets: readonly string[];
  readonly exact: boolean;
}

/** 静态构建信息只包含解析所需字段，不保存或运行业务配置。 */
export interface BuildPaths {
  readonly aliases: readonly PathAlias[];
  readonly mappings: readonly PathMapping[];
  readonly sourceRoots: readonly string[];
  readonly outputRoots: readonly string[];
  readonly includes: readonly string[];
}

/** 去除包装语法，仍只解释白名单内的表达式。 */
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** 共享配置仅保留有界的完整语法树，路径上下文和求值结果仍由调用方独立持有。 */
const sourceCache = new Map<string, { readonly text: string; readonly source: ts.SourceFile }>();
/** 文本总量限制同时约束语法树保留量，不按工作区数量无限增长。 */
let sourceCharacters = 0;

/** 同名同文的配置依赖共用语法树，草稿变化或语法错误不会复用旧节点。 */
export function buildConfigSource(text: string, filename: string): ts.SourceFile {
  const cached = sourceCache.get(filename);
  if (cached?.text === text) { sourceCache.delete(filename); sourceCache.set(filename, cached); return cached.source; }
  if (cached) { sourceCharacters -= cached.text.length; sourceCache.delete(filename); }
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const errors = (source as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (text.length <= 1_000_000 && !errors?.length) {
    sourceCache.set(filename, { text, source }); sourceCharacters += text.length;
    while (sourceCache.size > 64 || sourceCharacters > 2_000_000) {
      const first = sourceCache.keys().next().value!;
      sourceCharacters -= sourceCache.get(first)!.text.length; sourceCache.delete(first);
    }
  }
  return source;
}

/** 静态配置解释器仅处理字符串、路径函数与本地纯路径辅助函数。 */
class StaticConfig {
  readonly source: ts.SourceFile;
  readonly variables = new Map<string, ts.Expression>();
  readonly helpers = new Map<string, ts.FunctionLikeDeclaration>();
  readonly paths = new Set<string>();
  readonly pathFunctions = new Map<string, string>();
  readonly copyPlugins = new Set<string>();
  readonly factories = new Map<string, string>();
  readonly imports = new Map<string, { module: string; member: string }>();
  readonly wrappers = new Set(['defineConfig', 'merge', 'mergeConfig']);
  readonly urlFunctions = new Set<string>();
  readonly builders = new Set<string>();

  /** 读取语法树与绑定名称，不加载 require 或 import 指向的模块。 */
  constructor(text: string, readonly filename: string, readonly cwd: string, private readonly modules: ReadonlyMap<string, StaticConfig>) {
    this.source = buildConfigSource(text, filename);
    for (const statement of this.source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) this.helpers.set(statement.name.text, statement);
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const name = statement.importClause?.name?.text;
        const specifier = statement.moduleSpecifier.text;
        if (name && /^(?:node:)?path$/.test(specifier)) this.paths.add(name);
        if (name && specifier === 'copy-webpack-plugin') this.copyPlugins.add(name);
        if (name && specifier.startsWith('.')) this.imports.set(name, { module: specifier, member: 'default' });
        if (name && /^(?:rollup-plugin-copy|vite-plugin-static-copy|esbuild-plugin-copy)$/.test(specifier)) this.factories.set(name, specifier);
        if (name && specifier === 'esbuild') { this.builders.add(name + '.build'); this.builders.add(name + '.context'); }
        const bindings = statement.importClause?.namedBindings;
        if (bindings && /^(?:node:)?path$/.test(specifier)) {
          if (ts.isNamespaceImport(bindings)) this.paths.add(bindings.name.text);
          else for (const binding of bindings.elements) this.pathFunctions.set(binding.name.text, (binding.propertyName ?? binding.name).text);
        }
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          const member = (binding.propertyName ?? binding.name).text;
          if (specifier.startsWith('.')) this.imports.set(binding.name.text, { module: specifier, member });
          if (/^(?:node:)?url$/.test(specifier) && member === 'fileURLToPath') this.urlFunctions.add(binding.name.text);
          if (member === 'defineConfig' || /^(?:webpack-merge|vite)$/.test(specifier) && /^merge(?:Config)?$/.test(member)) this.wrappers.add(binding.name.text);
          if (specifier === 'vite-plugin-static-copy' && member === 'viteStaticCopy' || specifier === 'esbuild-plugin-copy' && member === 'copy') this.factories.set(binding.name.text, specifier);
          if (specifier === 'esbuild' && /^(?:build|context)$/.test(member)) this.builders.add(binding.name.text);
        }
      }
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const name = declaration.name.text;
        const initializer = unwrap(declaration.initializer);
        this.variables.set(name, initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) this.helpers.set(name, initializer);
        if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require' && initializer.arguments[0] && ts.isStringLiteral(initializer.arguments[0])) {
          const specifier = initializer.arguments[0].text;
          if (/^(?:node:)?path$/.test(specifier)) this.paths.add(name);
          if (specifier === 'copy-webpack-plugin') this.copyPlugins.add(name);
          if (specifier.startsWith('.')) this.imports.set(name, { module: specifier, member: 'default' });
          if (specifier === 'rollup-plugin-copy') this.factories.set(name, specifier);
          if (specifier === 'esbuild') { this.builders.add(name + '.build'); this.builders.add(name + '.context'); }
        }
      }
    }
  }

  /** 查找配置工厂的词法常量，不将另一个函数的同名变量混入当前作用域。 */
  private binding(node: ts.Node, name: string): ts.Expression | undefined {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (!ts.isBlock(parent)) continue;
      for (const statement of parent.statements) {
        if (statement.getStart() > node.getStart()) break;
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
      }
    }
    return this.variables.get(name) ?? this.imported(name);
  }

  /** 只跟随预先读取的本地配置依赖，循环引用由深度上限截断。 */
  private imported(name: string): ts.Expression | undefined {
    const binding = this.imports.get(name);
    if (!binding) return undefined;
    const base = path.resolve(path.dirname(this.filename), binding.module);
    const module = [base, ...['.ts', '.js', '.cjs', '.mjs', '/index.ts', '/index.js'].map((suffix) => base + suffix)].map((filename) => this.modules.get(filename)).find(Boolean);
    if (!module) return undefined;
    return binding.member === 'default' ? module.exports()[0] : module.variables.get(binding.member);
  }

  /** 导出配置允许默认导出与 CommonJS，不读取同名未导出的对象。 */
  exports(): ts.Expression[] {
    const result: ts.Expression[] = [];
    for (const statement of this.source.statements) {
      if (ts.isExportAssignment(statement)) result.push(statement.expression);
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText(this.source) === 'module.exports') result.push(statement.expression.right);
    }
    /** 构建脚本常将 build 放在 await 或立即调用函数中，只读取其字面配置。 */
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && this.builders.has(node.expression.getText(this.source)) && node.arguments[0]) result.push(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(this.source);
    return result;
  }

  /** 保留工厂、合并配置和多配置数组中的可静态识别对象。 */
  objects(node: ts.Expression, depth = 0): ts.Expression[] {
    if (depth > 16) return [];
    const owner = this.modules.get(node.getSourceFile()?.fileName);
    if (owner && owner !== this) return owner.objects(node, depth + 1);
    const value = this.expression(node, depth + 1);
    if (!value) return [];
    if (ts.isObjectLiteralExpression(value)) return [value];
    if (ts.isArrayLiteralExpression(value)) return value.elements.flatMap((element) => this.objects(element, depth + 1));
    if (ts.isConditionalExpression(value)) return [...this.objects(value.whenTrue, depth + 1), ...this.objects(value.whenFalse, depth + 1)];
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      if (!ts.isBlock(value.body)) return this.objects(value.body, depth + 1);
      const result: ts.Expression[] = [];
      /** 收集配置工厂各返回分支，未知环境条件不在编辑器内求值。 */
      const visit = (node: ts.Node): void => {
        if (ts.isReturnStatement(node) && node.expression) result.push(...this.objects(node.expression, depth + 1));
        else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
      };
      visit(value.body);
      return result;
    }
    if (ts.isCallExpression(value) && (ts.isIdentifier(value.expression) && this.wrappers.has(value.expression.text) || value.expression.getText() === 'Object.assign')) return value.arguments.length > 1 ? [value] : value.arguments.flatMap((argument) => this.objects(argument, depth + 1));
    return [];
  }

  /** 展开变量引用，仅沿有限深度追踪，循环或动态值返回空值。 */
  expression(node: ts.Expression, depth = 0): ts.Expression | undefined {
    if (depth > 16) return undefined;
    node = unwrap(node);
    const owner = this.modules.get(node.getSourceFile()?.fileName);
    if (owner && owner !== this) return owner.expression(node, depth + 1);
    if (ts.isIdentifier(node)) {
      const value = this.binding(node, node.text);
      return value ? this.expression(value, depth + 1) : node;
    }
    return node;
  }

  /** 获取静态对象的指定字段，忽略同名动态键和未知对象展开。 */
  property(node: ts.Expression | undefined, name: string, depth = 0): ts.Expression | undefined {
    if (!node || depth > 16) return undefined;
    const owner = this.modules.get(node.getSourceFile()?.fileName);
    if (owner && owner !== this) return owner.property(node, name, depth + 1);
    const object = node && this.expression(node);
    if (object && ts.isCallExpression(object) && (ts.isIdentifier(object.expression) && this.wrappers.has(object.expression.text) || object.expression.getText() === 'Object.assign')) {
      for (const argument of [...object.arguments].reverse()) { const value = this.property(argument, name, depth + 1); if (value) return value; }
    }
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    for (const property of [...object.properties].reverse()) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return this.variables.get(name);
      if (ts.isSpreadAssignment(property)) { const value = this.property(property.expression, name, depth + 1); if (value) return value; }
    }
    return undefined;
  }

  /** 合并包装器的嵌套字段保留各来源，普通展开仍遵循后覆盖语义。 */
  fields(node: ts.Expression | undefined, names: readonly string[], depth = 0): ts.Expression[] {
    if (!node || depth > 16) return [];
    const owner = this.modules.get(node.getSourceFile()?.fileName);
    if (owner && owner !== this) return owner.fields(node, names, depth + 1);
    const value = this.expression(node);
    if (!value) return [];
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && this.wrappers.has(value.expression.text)) return value.arguments.flatMap((argument) => this.fields(argument, names, depth + 1));
    return names.length ? this.fields(this.property(value, names[0]!), names.slice(1), depth + 1) : [value];
  }

  /** 读取字符串或字符串数组，数组中有动态成员时整条路径规则不采纳。 */
  strings(node: ts.Expression | undefined): readonly string[] {
    const value = node && this.expression(node);
    if (!value) return [];
    const values = (ts.isArrayLiteralExpression(value) ? value.elements : [value]).map((item) => this.string(item));
    return values.some((item) => item === undefined) ? [] : values as string[];
  }

  /** 展开静态对象的别名字段，后出现的字段覆盖先前展开的同名字段。 */
  entries(node: ts.Expression, depth = 0): readonly [string, ts.Expression][] {
    if (depth > 16) return [];
    const owner = this.modules.get(node.getSourceFile()?.fileName);
    if (owner && owner !== this) return owner.entries(node, depth + 1);
    const value = this.expression(node);
    const result = new Map<string, ts.Expression>();
    if (value && ts.isObjectLiteralExpression(value)) for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) for (const [key, expression] of this.entries(property.expression, depth + 1)) result.set(key, expression);
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) result.set(property.name.text, property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) result.set(property.name.text, property.name);
    }
    return [...result];
  }

  /** 字符串求值不执行函数体、条件分支、环境变量或任意模块代码。 */
  string(node: ts.Expression | undefined, bindings = new Map<string, string>(), depth = 0): string | undefined {
    if (!node || depth > 24) return undefined;
    node = unwrap(node);
    const owner = this.modules.get(node.getSourceFile()?.fileName);
    if (owner && owner !== this) return owner.string(node, bindings, depth + 1);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      if (bindings.has(node.text)) return bindings.get(node.text);
      if (node.text === '__dirname') return path.dirname(this.filename);
      return this.string(this.binding(node, node.text), bindings, depth + 1);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.string(node.left, bindings, depth + 1);
      const right = this.string(node.right, bindings, depth + 1);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = this.string(span.expression, bindings, depth + 1);
        if (value === undefined) return undefined;
        text += value + span.literal.text;
      }
      return text;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0]) {
      const relative = this.string(node.arguments[0], bindings, depth + 1);
      if (relative === undefined || node.arguments[1]?.getText() !== 'import.meta.url') return undefined;
      return new URL(relative, 'file://' + this.filename.split('/').map(encodeURIComponent).join('/')).href;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname') {
      const value = this.string(node.expression, bindings, depth + 1);
      if (value?.startsWith('file:')) return decodeURIComponent(new URL(value).pathname);
    }
    if (!ts.isCallExpression(node)) return undefined;
    if (node.expression.getText() === 'process.cwd' && !node.arguments.length) return this.cwd;
    const args = node.arguments.map((argument) => this.string(argument, bindings, depth + 1));
    if (args.some((value) => value === undefined)) return undefined;
    const values = args as string[];
    if (ts.isIdentifier(node.expression) && this.urlFunctions.has(node.expression.text) && values[0]?.startsWith('file:')) return decodeURIComponent(new URL(values[0]).pathname);
    let method: string | undefined;
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && this.paths.has(node.expression.expression.text)) method = node.expression.name.text;
    if (ts.isIdentifier(node.expression)) method = this.pathFunctions.get(node.expression.text);
    if (method === 'join') return path.join(...values);
    if (method === 'resolve') return path.resolve(this.cwd, ...values);
    if (method === 'dirname' && values[0]) return path.dirname(values[0]);
    if (!ts.isIdentifier(node.expression)) return undefined;
    const helper = this.helpers.get(node.expression.text);
    if (!helper?.body || helper.parameters.length !== values.length || helper.parameters.some((parameter) => !ts.isIdentifier(parameter.name))) return undefined;
    const body = ts.isBlock(helper.body) ? helper.body.statements.length === 1 && ts.isReturnStatement(helper.body.statements[0]!) ? helper.body.statements[0]!.expression : undefined : helper.body;
    const parameters = new Map(bindings);
    helper.parameters.forEach((parameter, index) => parameters.set((parameter.name as ts.Identifier).text, values[index]!));
    return this.string(body, parameters, depth + 1);
  }
}

/** 从配置的实际导出对象读取路径，避免把无关对象的 alias 当作项目设置。 */
function parseBuildConfig(text: string, filename: string, cwd: string, dependencies: ReadonlyMap<string, string>, versions: ReadonlyMap<string, string>): BuildPaths {
  const modules = new Map<string, StaticConfig>();
  for (const [location, content] of [...dependencies, [filename, text] as const]) modules.set(location, new StaticConfig(content, location, cwd, modules));
  const parser = modules.get(filename)!;
  if ((parser.source as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return { aliases: [], mappings: [], sourceRoots: [], outputRoots: [], includes: [] };
  const aliases: PathAlias[] = [];
  const mappings: PathMapping[] = [];
  const sourceRoots: string[] = [];
  const outputRoots: string[] = [];
  const includes: string[] = [];
  const configs = parser.exports().flatMap((node) => parser.objects(node));
  for (let config of configs) {
    const expanded = parser.expression(config);
    if (!expanded) continue;
    config = ts.isCallExpression(expanded) && ts.isIdentifier(expanded.expression) && expanded.expression.text === 'defineConfig' && expanded.arguments[0] ? expanded.arguments[0] : expanded;
    const context = path.resolve(cwd, parser.string(parser.property(config, 'context')) ?? parser.string(parser.property(config, 'absWorkingDir')) ?? parser.string(parser.property(config, 'root')) ?? '.');
    const output = parser.property(config, 'output');
    const build = parser.property(config, 'build');
    const sourceRoot = parser.string(parser.property(config, 'sourceRoot'));
    const outputFile = parser.string(parser.property(config, 'outfile')) ?? parser.string(parser.property(output, 'file'));
    const outputRoot = parser.string(parser.property(output, 'path')) ?? parser.string(parser.property(output, 'dir')) ?? parser.string(parser.property(config, 'outputRoot')) ?? parser.string(parser.property(config, 'outdir')) ?? parser.string(parser.property(config, 'outDir')) ?? parser.string(parser.property(build, 'outDir')) ?? (outputFile ? path.dirname(outputFile) : /\bvite\b/.test(filename) ? 'dist' : undefined);
    if (sourceRoot) sourceRoots.push(path.resolve(cwd, sourceRoot));
    if (outputRoot) outputRoots.push(path.resolve(context, outputRoot));
    for (const alias of [...parser.fields(config, ['resolve', 'alias']), ...parser.fields(config, ['alias'])]) {
      const aliasObject = alias && parser.expression(alias);
      if (aliasObject && ts.isObjectLiteralExpression(aliasObject)) for (const [name, expression] of parser.entries(aliasObject)) {
        const value = parser.expression(expression);
        const targets = value && ts.isArrayLiteralExpression(value) ? value.elements.map((element) => parser.string(element)).filter((item): item is string => item !== undefined) : [parser.string(expression)].filter((item): item is string => item !== undefined);
        if (targets.length) aliases.push({ name: name.replace(/\$$/, ''), exact: name.endsWith('$'), targets: targets.map((target) => path.resolve(context, target)) });
      }
      if (aliasObject && ts.isArrayLiteralExpression(aliasObject)) for (const entry of aliasObject.elements) {
        const find = parser.property(entry, 'find');
        const pattern = find && ts.isRegularExpressionLiteral(find) ? find.text.match(/^\/\^((?:\\.|[\w@#/-])+)(\$)?\/$/) : undefined;
        const literalPrefix = pattern?.[1]?.replace(/\\([/@#.-])/g, '$1').replace(/\/$/, '');
        const name = parser.string(find) ?? literalPrefix;
        const replacement = parser.string(parser.property(entry, 'replacement'));
        if (name !== undefined && replacement !== undefined) aliases.push({ name, exact: Boolean(pattern?.[2]), targets: [path.resolve(context, replacement)] });
      }
    }
    // Sass 的查找目录与构建别名共用源码候选，语言模块继续处理 partial 和转发规则。
    for (const language of ['scss', 'sass', 'less']) for (const options of parser.fields(config, ['css', 'preprocessorOptions', language])) {
      for (const key of ['includePaths', 'loadPaths', 'paths']) for (const value of parser.strings(parser.property(options, key))) includes.push(path.resolve(context, value));
    }
    /** Webpack 嵌套规则中的样式加载目录同样使用静态路径白名单。 */
    const loaders = (node: ts.Expression | undefined, depth = 0): void => {
      if (!node || depth > 12) return;
      const value = parser.expression(node);
      if (!value) return;
      if (ts.isArrayLiteralExpression(value)) { value.elements.forEach((item) => loaders(item, depth + 1)); return; }
      const loader = parser.string(parser.property(value, 'loader'));
      if (loader && /(?:sass|less)-loader/.test(loader)) {
        const options = parser.property(value, 'options');
        const sass = parser.property(options, 'sassOptions');
        const less = parser.property(options, 'lessOptions');
        for (const option of [options, sass, less]) for (const key of ['includePaths', 'loadPaths', 'paths']) for (const directory of parser.strings(parser.property(option, key))) includes.push(path.resolve(context, directory));
      }
      for (const key of ['rules', 'oneOf', 'use']) loaders(parser.property(value, key), depth + 1);
    };
    parser.fields(config, ['module', 'rules']).forEach((node) => loaders(node));
    // Taro 等构建器的静态 copy.patterns 使用工程目录作为目标路径基准。
    const copies = parser.property(parser.property(config, 'copy'), 'patterns');
    const copyList = copies && parser.expression(copies);
    if (copyList && ts.isArrayLiteralExpression(copyList)) for (const pattern of copyList.elements) {
      const from = parser.string(parser.property(pattern, 'from')), to = parser.string(parser.property(pattern, 'to'));
      if (from && to && !/[*?{}[(@!]/.test(from + to)) mappings.push({ source: path.resolve(context, from), output: path.resolve(context, to) });
    }
    // 只分析真实插件列表，不采纳配置文件里未被使用的 CopyPlugin 调用。
    for (let plugins of parser.fields(config, ['plugins'])) {
      const expandedPlugins = plugins && parser.expression(plugins);
      if (expandedPlugins && ts.isCallExpression(expandedPlugins) && ts.isPropertyAccessExpression(expandedPlugins.expression) && expandedPlugins.expression.name.text === 'filter') plugins = expandedPlugins.expression.expression;
      const list = plugins && parser.expression(plugins);
      if (!list || !ts.isArrayLiteralExpression(list)) continue;
      for (const item of list.elements) {
        const owner = modules.get(item.getSourceFile().fileName) ?? parser;
        if (ts.isCallExpression(item) && ts.isIdentifier(item.expression)) {
          const factory = owner.factories.get(item.expression.text);
          const options = item.arguments[0];
          const targets = factory === 'esbuild-plugin-copy' ? parser.property(options, 'assets') : parser.property(options, 'targets');
          const array = targets && parser.expression(targets);
          const entries = array && ts.isArrayLiteralExpression(array) ? array.elements : array ? [array] : [];
          for (const target of entries) {
            if (!factory) continue;
            const renameNode = parser.property(target, 'rename');
            const rename = parser.string(renameNode);
            // 动态重命名及转换可能改变对应关系，不能为其构造虚假的来源。
            if (renameNode && rename === undefined || parser.property(target, 'transform')) continue;
            const froms = parser.strings(parser.property(target, factory === 'esbuild-plugin-copy' ? 'from' : 'src'));
            const tos = parser.strings(parser.property(target, factory === 'esbuild-plugin-copy' ? 'to' : 'dest'));
            for (const from of froms) for (const to of tos) {
              if (!from || /[*?{}[(@!]/.test(to) || from.startsWith('!')) continue;
              const absolute = path.resolve(factory === 'esbuild-plugin-copy' ? cwd : context, from);
              const wildcard = absolute.search(/[*?{[(@!]/);
              const source = wildcard < 0 ? absolute : absolute.slice(0, absolute.lastIndexOf('/', wildcard));
              const file = wildcard < 0 && Boolean(path.extname(source));
              let output: string;
              if (factory === 'esbuild-plugin-copy') {
                const resolveFrom = parser.string(parser.property(options, 'resolveFrom')) ?? 'out';
                const destination = path.resolve(cwd, resolveFrom === 'cwd' ? '.' : resolveFrom === 'out' ? outputRoot ?? '.' : resolveFrom, to);
                if (wildcard >= 0 && !/\/\*\*\/[^/]+$/.test(from) || wildcard < 0 && !file) continue;
                output = path.extname(to) ? destination : file ? path.join(destination, path.basename(source)) : destination;
                if (wildcard >= 0 && path.extname(to)) continue;
              } else if (factory === 'rollup-plugin-copy') {
                // 默认扁平化的 glob 不能通过目录前缀还原，静态目录复制仍可准确映射。
                if (wildcard >= 0 || parser.property(options, 'flatten')?.kind === ts.SyntaxKind.FalseKeyword) continue;
                output = path.resolve(cwd, to, rename ?? path.basename(source));
              } else {
                // 第四版保留源目录结构；未知版本的默认行为不猜测。
                if (!/^4\./.test(versions.get(factory) ?? '') || rename || froms.some((item) => item.startsWith('!'))) continue;
                const relative = path.relative(context, source).replace(/^(?:\.\.\/)+/, '');
                output = path.resolve(context, outputRoot ?? 'dist', to, relative);
              }
              mappings.push({ source, output, ...(file ? { exact: true } : {}) });
            }
          }
        }
        if (!ts.isNewExpression(item) || !ts.isIdentifier(item.expression) || !owner.copyPlugins.has(item.expression.text)) continue;
        const first = item.arguments?.[0];
        const firstValue = first && parser.expression(first);
        const patterns = firstValue && ts.isArrayLiteralExpression(firstValue) ? firstValue : firstValue && parser.property(firstValue, 'patterns');
        const values = patterns && parser.expression(patterns);
        if (!values || !ts.isArrayLiteralExpression(values)) continue;
        const oldContext = parser.string(parser.property(item.arguments?.[1], 'context'));
        for (const pattern of values.elements) {
          const rawFrom = parser.property(pattern, 'from');
          const from = parser.string(rawFrom) ?? parser.string(parser.property(rawFrom, 'glob'));
          const to = parser.string(parser.property(pattern, 'to')) ?? '';
          if (!from || /\[[^\]]+\]|[*?{}]/.test(to) || parser.property(pattern, 'flatten')?.kind === ts.SyntaxKind.TrueKeyword) continue;
          const patternContext = path.resolve(context, parser.string(parser.property(pattern, 'context')) ?? oldContext ?? '.');
          const absolute = path.resolve(patternContext, from);
          const wildcard = absolute.search(/[*?{[(@!]/);
          const source = wildcard >= 0 ? absolute.slice(0, absolute.lastIndexOf('/', wildcard) + 1).replace(/\/$/, '') || '/' : absolute;
          let target = path.resolve(path.resolve(context, outputRoot ?? 'dist'), to);
          const file = wildcard < 0 && /\.[\w-]+$/.test(source);
          if (file && !/\.[\w-]+$/.test(target)) target = path.join(target, path.basename(source));
          const relative = wildcard >= 0 ? path.relative(patternContext, source) : '';
          if (relative.startsWith('../') || relative === '..') continue;
          mappings.push({ output: path.resolve(target, relative), source, ...(file ? { exact: true } : {}) });
        }
      }
    }
  }
  return { aliases: [...new Map(aliases.map((alias) => [alias.name, alias])).values()], mappings, sourceRoots, outputRoots, includes };
}

/** 纯静态解析按完整输入缓存，目录查询不会反复分析同一构建文件。 */
const buildCache = new Map<string, BuildPaths>();

/** 文件、依赖文本与插件版本共同构成键，不依赖执行工程配置。 */
export function inspectBuildConfig(text: string, filename: string, cwd: string, dependencies: ReadonlyMap<string, string> = new Map(), versions: ReadonlyMap<string, string> = new Map()): BuildPaths {
  const key = JSON.stringify([filename, cwd, text, [...dependencies], [...versions]]);
  const cached = buildCache.get(key);
  if (cached) { buildCache.delete(key); buildCache.set(key, cached); return cached; }
  const result = parseBuildConfig(text, filename, cwd, dependencies, versions);
  if (key.length <= 2_000_000) {
    buildCache.set(key, result);
    while (buildCache.size > 8 || [...buildCache.keys()].reduce((sum, key) => sum + key.length, 0) > 2_000_000) buildCache.delete(buildCache.keys().next().value!);
  }
  return result;
}
