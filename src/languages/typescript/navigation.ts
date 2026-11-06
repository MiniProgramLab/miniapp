import ts from 'typescript';
import type { Definition, LanguageRequest, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { registrationSource } from './direct-definition';

/** 查找光标所在的最小语法节点，注释和字符串之外的空隙不会误命中符号。 */
export function nodeAt(source: ts.SourceFile, offset: number): ts.Node {
  let result: ts.Node = source;
  /** 只深入包含光标的分支，不枚举其他语法节点。 */
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.EndOfFileToken || offset < node.getStart(source) || offset > node.end) return;
    if (offset < node.end || ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) result = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

/** WXS 的文件内引用高亮只查询当前文件，不枚举工作区或读取未关联页面。 */
export async function provideScriptHighlights(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions): Promise<readonly import('../../api').TextRange[]> {
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(request.document.uri);
  if (!created || project.cancelled) return [];
  const service = project.languageService();
  try {
    return (service.getDocumentHighlights(request.document.uri, request.offset, [request.document.uri]) ?? []).flatMap((document) => document.highlightSpans.map((item) => ({ start: item.textSpan.start, end: item.textSpan.start + item.textSpan.length })));
  } finally { service.dispose(); }
}

/** 为构建别名及复制文件补充 TS/JS 定义跳转，不替换原生类型检查。 */
export async function provideScriptDefinition(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions = {}): Promise<readonly Definition[]> {
  if (request.cancellation.isCancellationRequested || !reader.fileResolver) return [];
  try { new URL('./', request.document.uri); } catch { return []; }
  if (request.document.text.length > 2_000_000) { reader.navigation?.record({ code: 'budget', message: '脚本超过两百万字符，未执行同步语法解析。', uri: request.document.uri }); return []; }
  const source = registrationSource(request.document.uri, request.document.text);
  const selected = nodeAt(source, request.offset);
  if (!ts.isIdentifier(selected) && !ts.isStringLiteralLike(selected)) return [];
  const project = new ScriptProject(reader, request, { maxFiles: 200, ...options });
  if (ts.isStringLiteralLike(selected)) {
    const parent = selected.parent;
    const module = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === selected
      || ts.isExternalModuleReference(parent) && parent.expression === selected
      || ts.isCallExpression(parent) && parent.arguments[0] === selected && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(parent.expression) && parent.expression.text === 'require');
    if (!module) return [];
    const target = await project.navigationModule(selected.text, source.fileName);
    if (!target || !project.isMapped(target)) {
      reader.navigation?.record({ code: target ? 'context' : 'missing', message: target ? '普通脚本路径由编辑器原生提供器处理。' : '当前导入未解析到源码，请检查路径、配置与依赖。', uri: request.document.uri });
      return [];
    }
    const version = project.documents.get(target)?.version;
    return [{ uri: target, range: { start: 0, end: 0 }, originRange: { start: selected.getStart(source) + 1, end: selected.end - 1 }, ...(version !== undefined ? { version } : {}) }];
  }
  /** 明确导入的成员只展开所属模块，保留转发模块中的源码映射。 */
  let root: ts.Node = selected;
  while (ts.isPropertyAccessExpression(root.parent)) root = root.parent;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  const imported = ts.isIdentifier(root) ? source.statements.find((statement): statement is ts.ImportDeclaration => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) return false;
    const clause = statement.importClause, bindings = clause.namedBindings;
    return clause.name?.text === root.getText(source) || !!bindings && (ts.isNamespaceImport(bindings) ? bindings.name.text === root.getText(source) : bindings.elements.some((item) => item.name.text === root.getText(source)));
  }) : undefined;
  let imports: string[] | undefined;
  if (imported && ts.isStringLiteralLike(imported.moduleSpecifier)) {
    imports = [imported.moduleSpecifier.text];
  }
  const result = await project.create(request.document.uri, [], imports);
  if (!result || project.cancelled) return [];
  const node = nodeAt(result.entry, request.offset);
  if (!ts.isIdentifier(node)) return [];
  const checker = result.program.getTypeChecker();
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const definitions: Definition[] = [];
  for (const declaration of symbol?.declarations ?? []) {
    const source = declaration.getSourceFile();
    if (!project.isMapped(source.fileName)) continue;
    const name = (declaration as ts.NamedDeclaration).name ?? declaration;
    const version = project.documents.get(source.fileName)?.version;
    definitions.push({ uri: source.fileName, range: { start: name.getStart(source), end: name.end }, originRange: { start: node.getStart(result.entry), end: node.end }, ...(version !== undefined ? { version } : {}) });
  }
  if (!definitions.length && symbol?.declarations?.length) reader.navigation?.record({ code: 'context', message: '此符号存在普通脚本声明，插件仅补充源码映射入口，请使用编辑器原生导航。', uri: request.document.uri });
  return project.cancelled ? [] : [...new Map(definitions.map((definition) => [`${definition.uri}:${definition.range.start}:${definition.range.end}`, definition])).values()];
}
