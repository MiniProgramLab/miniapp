import ts from 'typescript';
import type { Diagnostic, LanguageRequest, ScriptModule, WorkspaceReader } from '../../api';
import type { ScriptOptions } from './project';
import { createWxsContext } from './wxs';
import { checkWxsCalls } from './wxs-calls';

/** WXS 不提供逻辑层及浏览器全局；同名局部声明仍按用户源码处理。 */
const unavailable = new Set(['wx', 'getApp', 'getCurrentPages', 'Page', 'Component', 'Behavior', 'window', 'document', 'Promise', 'Map', 'Set', 'setTimeout', 'setInterval']);

/** 编译器只检查当前模块，内联偏移始终映射到原 WXML。 */
async function syntax(reader: WorkspaceReader, request: LanguageRequest, module: ScriptModule | undefined, options: ScriptOptions): Promise<Diagnostic[]> {
  const context = await createWxsContext(reader, request, module, options);
  if (!context || context.project.cancelled) return [];
  const { program, values } = context, source = program.entry;
  const base = module?.inline?.range.start ?? 0;
  const result: Diagnostic[] = program.program.getSyntacticDiagnostics(source).filter((item) => item.code !== 1010).map((item) => ({ range: { start: base + (item.start ?? 0), end: base + (item.start ?? 0) + (item.length ?? 0) }, severity: 'error', code: 'wxs-syntax', message: 'WXS 语法错误：' + ts.flattenDiagnosticMessageText(item.messageText, '\n') }));
  /** 平台限制只作用于全局符号，不匹配属性名、注释或字符串。 */
  const global = (node: ts.Identifier): boolean => !(values.checker.getSymbolAtLocation(node)?.declarations ?? []).some((item) => !item.getSourceFile().isDeclarationFile);
  /** 同一语法位置的限制只报告一次。 */
  const issue = (node: ts.Node, message: string, code = 'wxs-api'): void => { result.push({ range: { start: base + node.getStart(source), end: base + node.end }, severity: 'warning', code, message }); };
  const pending: ts.Node[] = [source];
  let count = 0;
  while (pending.length && !context.project.cancelled) {
    const node = pending.pop()!;
    if (++count > 20000) { reader.navigation?.record({ code: 'budget', message: 'WXS 语法检查达到两万节点上限，未完成全部检查。', uri: request.document.uri }); break; }
    ts.forEachChild(node, (child) => { pending.push(child); });
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) issue(node, 'WXS 模块使用相对路径 require 和 module.exports，不支持 ES 模块声明。', 'wxs-module');
    if (ts.isIdentifier(node) && unavailable.has(node.text) && global(node)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node || 'name' in node.parent && node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent))) issue(node, `WXS 运行环境不提供全局 ${node.text}。`);
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && ['Date', 'RegExp'].includes(node.expression.text) && global(node.expression)) issue(node.expression, `WXS 请使用 ${node.expression.text === 'Date' ? 'getDate' : 'getRegExp'} 创建对象。`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && global(node.expression)) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument) && (!/^\.\.?\//.test(argument.text) || !argument.text.endsWith('.wxs'))) issue(argument, 'WXS require 只能引用相对路径的 .wxs 文件。', 'wxs-module');
    }
  }
  return result;
}

/** 独立文件检查自身语法和调用，内联模块检查使用所属模板快照。 */
export async function diagnoseWxs(reader: WorkspaceReader, request: LanguageRequest, modules: readonly ScriptModule[] | undefined, options: ScriptOptions): Promise<Diagnostic[]> {
  if (request.cancellation.isCancellationRequested) return [];
  if (!modules) return [...await syntax(reader, request, undefined, options), ...await checkWxsCalls(reader, request, undefined, options)];
  const result: Diagnostic[] = [];
  for (const module of modules) {
    if (request.cancellation.isCancellationRequested) return [];
    if (!module.inline) continue;
    const current = { ...request, offset: module.inline.range.start };
    result.push(...await syntax(reader, current, module, options), ...await checkWxsCalls(reader, current, { text: module.inline.text, range: module.inline.range, bindings: [], modules }, options));
  }
  return result;
}
