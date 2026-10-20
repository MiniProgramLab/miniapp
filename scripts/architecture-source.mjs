import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** 按稳定顺序遍历源码，新增语言目录无需维护图表清单。 */
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [filename] : [];
  });
}

/** 目录定义模块边界；具体依赖和能力仍由 AST 提取。 */
function moduleName(filename) {
  const parts = filename.split('/');
  if (parts[0] === 'languages' || parts[0] === 'adapters') return parts.slice(0, 2).join('/');
  return parts.length === 1 ? filename.replace(/\.[^.]+$/, '') : parts[0];
}

/** 同时覆盖静态导入、重导出、类型导入及字面量动态导入。 */
function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require')) return node.arguments[0];
  return undefined;
}

/** 判断整个依赖是否仅存在于类型层面，混合导入按运行时依赖展示。 */
function isTypeOnly(node) {
  if (ts.isImportTypeNode(node)) return true;
  if (ts.isExportDeclaration(node)) return node.isTypeOnly || !!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every((item) => item.isTypeOnly));
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  return !!(clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length && clause.namedBindings.elements.every((item) => item.isTypeOnly)));
}

/** 从真实类型和 AST 获取依赖、对外接口与 setup 返回能力，不执行插件代码。 */
export function inspectArchitecture(root) {
  const sourceRoot = path.join(root, 'src');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost(root)));
  const files = sourceFiles(sourceRoot);
  const program = ts.createProgram(files, { ...parsed.options, allowJs: true, noEmit: true });
  const diagnostics = program.getSyntacticDiagnostics();
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost(root)));
  const checker = program.getTypeChecker();
  const modules = new Map();
  const dependencies = new Map();
  const entrypoints = new Set();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const api = program.getSourceFile(path.join(sourceRoot, 'api/index.ts'));
  const featureDeclaration = api?.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'LanguageFeatures');
  const featureNames = new Set(featureDeclaration?.members.map((member) => member.name?.getText(api)) ?? []);

  for (const filename of files) {
    const source = program.getSourceFile(filename);
    const relative = path.relative(sourceRoot, filename).split(path.sep).join('/');
    const name = moduleName(relative);
    if (!modules.has(name)) modules.set(name, { name, files: [], exports: new Set(), ports: new Set(), features: new Set(), resources: new Set() });
    const module = modules.get(name);
    module.files.push(`src/${relative}`);
    if (/\/index\.[cm]?[jt]sx?$/.test(relative) || !relative.includes('/')) {
      entrypoints.add(filename);
    }

    /** 只分析 setup 返回的结构，避免把其他对象的同名字段误当成编辑器能力。 */
    function collectFeatures(node) {
      if (ts.isReturnStatement(node) && node.expression) {
        for (const property of checker.getTypeAtLocation(node.expression).getProperties()) {
          if (featureNames.has(property.name)) module.features.add(property.name);
        }
      }
      if (ts.isFunctionLike(node)) return;
      ts.forEachChild(node, collectFeatures);
    }

    /** 遍历模块引用和能力注册点，合并模块内部多个文件产生的依赖。 */
    function visit(node) {
      const specifier = moduleSpecifier(node);
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const spec = specifier.text;
        const resolved = ts.resolveModuleName(spec, filename, parsed.options, ts.sys).resolvedModule;
        const resolvedRelative = resolved && path.relative(sourceRoot, resolved.resolvedFileName).split(path.sep).join('/');
        const internal = resolvedRelative && !resolvedRelative.startsWith('../') && !path.isAbsolute(resolvedRelative);
        if (spec.startsWith('.') && !internal) throw new Error(`无法解析架构依赖：src/${relative} → ${spec}`);
        const target = internal ? moduleName(resolvedRelative) : `npm:${spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]}`;
        if (target !== name) {
          if (internal) entrypoints.add(resolved.resolvedFileName);
          const key = `${name} -> ${target}`;
          const typeOnly = isTypeOnly(node);
          const previous = dependencies.get(key);
          dependencies.set(key, { from: name, to: target, typeOnly: typeOnly && (previous?.typeOnly ?? true) });
        }
        if (target === 'api' && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const item of node.importClause.namedBindings.elements) module.ports.add((item.propertyName ?? item.name).text);
        }
      }
      if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name?.getText(source).replace(/['"]/g, '') === 'setup') {
        const implementation = ts.isMethodDeclaration(node) ? node : node.initializer;
        if (ts.isFunctionLike(implementation) && implementation.body) {
          if (ts.isBlock(implementation.body)) collectFeatures(implementation.body);
          else for (const property of checker.getTypeAtLocation(implementation.body).getProperties()) {
            if (featureNames.has(property.name)) module.features.add(property.name);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  // 既统计 index 入口，也统计被其他模块直接引用的公开文件。
  for (const filename of entrypoints) {
    const source = program.getSourceFile(filename);
    const module = modules.get(moduleName(path.relative(sourceRoot, filename).split(path.sep).join('/')));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (symbol && module) for (const item of checker.getExportsOfModule(symbol)) module.exports.add(item.name);
  }

  for (const [kind, resources] of Object.entries(manifest.contributes ?? {})) {
    if (!Array.isArray(resources)) continue;
    for (const resource of resources) {
      const location = resource.path ?? resource.configuration;
      if (typeof location !== 'string' || !location.replace(/^\.\//, '').startsWith('src/')) continue;
      const owner = moduleName(location.replace(/^\.\//, '').slice(4));
      modules.get(owner)?.resources.add(`${kind}: ${resource.language ?? resource.id}`);
    }
  }
  return {
    extension: `${manifest.publisher}.${manifest.name}`,
    modules: [...modules.values()].map((module) => Object.fromEntries(Object.entries(module).map(([key, value]) => [key, value instanceof Set ? [...value].sort() : value]))).sort((a, b) => a.name.localeCompare(b.name, 'en')),
    dependencies: [...dependencies.values()].sort((a, b) => `${a.from}/${a.to}`.localeCompare(`${b.from}/${b.to}`, 'en')),
  };
}

/** 诊断使用项目相对位置，方便开发监听报告未完成的编辑。 */
function diagnosticHost(root) {
  return { getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n' };
}
