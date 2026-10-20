import ts from 'typescript';
import type { CallSignature, Diagnostic, LanguageRequest, ScriptModule, SemanticType, TemplateExpression, WorkspaceReader } from '../../api';
import type { ScriptOptions } from './project';
import { createWxsContext } from './wxs';
import { evaluate, parse } from './template-values';
import { rootName } from './query';
import { accepts, semanticType } from './semantic-types';
import { declarationDocumentation } from './documentation';
import type { Values } from './values';
import { valueType } from './analysis';

/** 真实签名同时供参数提示及调用检查使用。 */
interface Contract { readonly signature: CallSignature; readonly types: readonly SemanticType[]; readonly minimum: number; readonly maximum: number }
/** 不变语法树复用 arguments 扫描，弱键随原有有界 Program 一起回收。 */
const argumentUsage = new WeakMap<ts.SignatureDeclaration, boolean>();

/** 嵌套调用按实际参数区间定位，字符串和对象内部的逗号不影响参数序号。 */
function callAt(source: ts.SourceFile, offset: number): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const pending: ts.Node[] = [source];
  while (pending.length) {
    const node = pending.pop()!;
    if (offset < node.getStart(source) || offset > node.end) continue;
    if (ts.isCallExpression(node) && offset >= node.arguments.pos && offset <= node.arguments.end) found = node;
    ts.forEachChild(node, (child) => { pending.push(child); });
  }
  return found;
}

/** arguments 只属于当前函数，内层函数的动态参数不会放宽外层调用。 */
function usesArguments(node: ts.SignatureDeclaration | undefined, checker: ts.TypeChecker): boolean {
  if (!node || !('body' in node) || !node.body) return false;
  const cached = argumentUsage.get(node);
  if (cached !== undefined) return cached;
  const pending: ts.Node[] = [node.body as ts.Node];
  while (pending.length) {
    const current = pending.pop()!;
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) continue;
    if (ts.isIdentifier(current) && current.text === 'arguments' && !checker.getSymbolAtLocation(current)?.declarations?.length
      && !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current || 'name' in current.parent && current.parent.name === current && !ts.isShorthandPropertyAssignment(current.parent))) { argumentUsage.set(node, true); return true; }
    ts.forEachChild(current, (child) => { pending.push(child); });
  }
  argumentUsage.set(node, false); return false;
}

/** JSDoc 可选参数、默认值及剩余参数使用声明本身的约束。 */
function optional(parameter: ts.ParameterDeclaration): boolean {
  return !!(parameter.questionToken || parameter.initializer || parameter.dotDotDotToken || ts.getJSDocParameterTags(parameter).some((tag) => tag.isBracketed || tag.typeExpression && ts.isJSDocOptionalType(tag.typeExpression.type)));
}

/** require 与导出链先解析真实函数，模板的虚拟节点不交给脚本检查器。 */
function contracts(values: Values, call: ts.CallExpression, roots?: ReadonlyMap<string, ReturnType<Values['value']>[]>): Contract[] {
  const candidates = roots ? evaluate(call.expression, roots, values) : values.resolve(values.value(call.expression));
  const result: Contract[] = [];
  for (const item of candidates.flatMap((item) => values.resolve(item))) {
    const type = item.type ?? values.checker.getTypeAtLocation(item.node);
    for (const signature of values.checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      const declaration = signature.getDeclaration();
      const parameters = declaration?.parameters.filter((parameter) => parameter.name.getText() !== 'this') ?? [];
      const rest = !!parameters.at(-1)?.dotDotDotToken || usesArguments(declaration, values.checker);
      const types = signature.parameters.map((parameter, index) => {
        const type = semanticType(values.checker, values.checker.getTypeOfSymbolAtLocation(parameter, item.node), item.node);
        return index >= parameters.length ? { kind: 'unknown' as const, display: 'unknown' } : parameters[index]!.dotDotDotToken ? type.element ?? { kind: 'unknown' as const, display: 'unknown' } : type;
      });
      // 未标注的 JS 参数可能在函数体中回退，缺参只依据显式类型契约检查。
      const minimum = parameters.reduce((minimum, parameter, index) => !optional(parameter) && (parameter.type || ts.getJSDocParameterTags(parameter).some((tag) => tag.typeExpression)) ? index + 1 : minimum, 0);
      result.push({ minimum, maximum: rest ? Infinity : signature.parameters.length, types,
        signature: { label: call.expression.getText() + values.checker.signatureToString(signature, item.node, ts.TypeFormatFlags.NoTruncation), documentation: declarationDocumentation(item.declaration ?? item.node),
          parameters: signature.parameters.map((parameter, index) => ({ label: `${parameter.name}${parameters[index] && optional(parameters[index]!) ? '?' : ''}: ${types[index]!.display}`, documentation: ts.displayPartsToString(parameter.getDocumentationComment(values.checker)) })) } });
    }
  }
  return [...new Map(result.map((item) => [item.signature.label, item])).values()];
}

/** 内联脚本和模板表达式保留不同的偏移基准与模块作用域。 */
function source(reader: WorkspaceReader, request: LanguageRequest, expression?: TemplateExpression) {
  const inline = expression?.modules?.find((module) => module.inline && request.offset >= module.inline.range.start && request.offset < module.inline.range.end);
  const template = !!expression && !inline;
  const base = template ? expression!.range.start - (expression!.objectLiteral ? 2 : 1) : inline?.inline?.range.start ?? 0;
  const text = template ? expression!.objectLiteral ? `{${expression!.text}}` : expression!.text : inline?.inline?.text ?? request.document.text;
  if (text.length > 2_000_000) { reader.navigation?.record({ code: 'budget', message: 'WXS 调用输入超过两百万字符上限，未解析。', uri: request.document.uri }); return undefined; }
  const tree = template ? parse(text) : ts.createSourceFile(request.document.uri, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return { inline, template, base, tree, offset: request.offset - base };
}

/** 函数调用的逗号和当前参数由语法树计算，模块只在需要时加载。 */
export async function signatureWxs(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression | undefined, options: ScriptOptions) {
  if (request.cancellation.isCancellationRequested || expression?.event) return undefined;
  const parsed = source(reader, request, expression);
  if (!parsed) return undefined;
  const selected = callAt(parsed.tree, parsed.offset);
  if (!selected) return undefined;
  const module = parsed.inline ?? expression?.modules?.find((module) => module.name === rootName(selected.expression));
  if (parsed.template && !module) return undefined;
  const context = await createWxsContext(reader, request, module, options);
  if (!context || context.project.exhausted || context.project.cancelled) return undefined;
  const call = parsed.template ? selected : callAt(context.program.entry, parsed.offset);
  if (!call) return undefined;
  const roots = parsed.template ? new Map([[module!.name, [context.values.value(context.program.entry)]]]) : undefined;
  const signatures = contracts(context.values, call, roots).map((item) => item.signature);
  return signatures.length ? { signatures, activeParameter: call.arguments.filter((argument) => argument.end < parsed.offset).length } : undefined;
}

/** 调用检查使用完整表达式，多个导出分支只有共同不兼容时才报告。 */
export async function checkWxsCalls(reader: WorkspaceReader, request: LanguageRequest, expression: TemplateExpression | undefined, options: ScriptOptions, argumentType?: (argument: ts.Expression) => SemanticType): Promise<Diagnostic[]> {
  if (request.cancellation.isCancellationRequested || expression?.event) return [];
  const parsed = source(reader, request, expression), result: Diagnostic[] = [];
  if (!parsed) return result;
  const contexts = new Map<ScriptModule | undefined, ReturnType<typeof createWxsContext>>();
  const pending: ts.Node[] = [parsed.tree];
  let count = 0;
  while (pending.length && !request.cancellation.isCancellationRequested) {
    const node = pending.pop()!;
    if (++count > 20000) { reader.navigation?.record({ code: 'budget', message: 'WXS 调用检查达到两万节点上限，未完成全部检查。', uri: request.document.uri }); break; }
    ts.forEachChild(node, (child) => { pending.push(child); });
    if (!ts.isCallExpression(node) || node.arguments.some(ts.isSpreadElement)) continue;
    const module = parsed.inline ?? expression?.modules?.find((module) => module.name === rootName(node.expression));
    if (parsed.template && !module) continue;
    let context = contexts.get(module);
    if (!context) { context = createWxsContext(reader, request, module, options); contexts.set(module, context); }
    const loaded = await context;
    if (!loaded || loaded.project.exhausted || loaded.project.cancelled) continue;
    // 文件脚本必须使用 Program 内的节点，模板仅以名称访问模块导出。
    const call = parsed.template ? node : callAt(loaded.program.entry, node.arguments.pos);
    if (!call) continue;
    const roots = parsed.template ? new Map([[module!.name, [loaded.values.value(loaded.program.entry)]]]) : undefined;
    const signatures = contracts(loaded.values, call, roots);
    if (!signatures.length) continue;
    const range = { start: node.expression.getStart(parsed.tree) + parsed.base, end: node.expression.end + parsed.base };
    const suitable = signatures.filter((item) => node.arguments.length >= item.minimum && node.arguments.length <= item.maximum);
    if (!suitable.length) { result.push({ range, severity: 'warning', code: 'wxs-call-count', message: `WXS 调用 ${node.expression.getText()} 的参数数量 ${node.arguments.length} 与声明不兼容。` }); continue; }
    for (let index = 0; index < node.arguments.length; index++) {
      const argument = node.arguments[index]!;
      let actual = parsed.template ? argumentType?.(argument) : semanticType(loaded.values.checker, loaded.values.checker.getTypeAtLocation(call.arguments[index]!), call.arguments[index]!);
      // 页面作用域无法推断的 WXS 返回值，继续在模块自身的检查器中投影。
      if (parsed.template && (!actual || actual.kind === 'unknown' && !actual.alternatives)) actual = valueType(loaded.values, evaluate(argument, roots!, loaded.values, { uri: request.document.uri, offset: expression!.range.start, prefix: expression!.objectLiteral ? 2 : 1 }));
      const expected = suitable.map((item) => index < item.types.length ? item.types[index]! : item.maximum === Infinity ? item.types.at(-1) ?? { kind: 'unknown' as const, display: 'unknown' } : { kind: 'unknown' as const, display: 'unknown' });
      if (actual && expected.every((type) => !accepts(actual!, type))) result.push({ range: { start: argument.getStart(parsed.tree) + parsed.base, end: argument.end + parsed.base }, severity: 'warning', code: 'wxs-call-type', message: `WXS 第 ${index + 1} 个参数需要 ${[...new Set(expected.map((type) => type.display))].join(' | ')}，实际为 ${actual.display}。` });
    }
  }
  return result;
}
