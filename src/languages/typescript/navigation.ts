import ts from 'typescript';
import type { Definition, LanguageRequest, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';

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
export async function provideScriptDefinition(reader: WorkspaceReader, request: LanguageRequest): Promise<readonly Definition[]> {
  if (request.cancellation.isCancellationRequested || !reader.fileResolver) return [];
  try { new URL('./', request.document.uri); } catch { return []; }
  const project = new ScriptProject(reader, request, { maxFiles: 200 });
  const result = await project.create(request.document.uri);
  if (!result || project.cancelled) return [];
  const node = nodeAt(result.entry, request.offset);
  if (ts.isStringLiteralLike(node)) {
    const target = project.module(node.text, result.entry.fileName);
    if (!target || !project.isMapped(target.fileName)) {
      reader.navigation?.record({ code: target ? 'context' : 'missing', message: target ? '此导入属于普通脚本路径，定义导航交由编辑器原生 TypeScript/JavaScript 提供器。' : '此导入未解析到模块，请检查文件路径、配置与依赖。', uri: request.document.uri });
      return [];
    }
    const version = project.documents.get(target.fileName)?.version;
    return [{ uri: target.fileName, range: { start: 0, end: 0 }, originRange: { start: node.getStart() + 1, end: node.end - 1 }, ...(version !== undefined ? { version } : {}) }];
  }
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
