import ts from 'typescript';
import type { Completion, Definition, Hover, LanguageRequest, ScriptModule, TemplateExpression, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { Values } from './values';
import { evaluate, parse } from './template-values';
import { reference, rootName } from './query';
import { nodeAt } from './navigation';
import { declarationDocumentation } from './documentation';

/** 一个 WXS 查询同时产生导航、补全及说明，避免各入口重复实现导出规则。 */
export interface WxsResult {
  readonly definitions: readonly Definition[];
  readonly completions: readonly Completion[];
  readonly hover?: Hover;
}

/** 导航、参数提示和检查共用模块加载，保留真实文档及内联坐标。 */
export async function createWxsContext(reader: WorkspaceReader, request: LanguageRequest, module: ScriptModule | undefined, options: ScriptOptions) {
  if (request.cancellation.isCancellationRequested) return undefined;
  let uri = module?.inline ? request.document.uri + `.__wxs_${module.inline.range.start}.wxs` : module?.uri ?? request.document.uri;
  let document = module?.inline;
  if (module && !module.inline) {
    const paths = await reader.fileResolver?.(request.document.uri, request.cancellation).candidates(module.reference ?? module.uri, request.document.uri, 'file') ?? [];
    for (const candidate of [...paths, uri]) {
      const value = await reader.read(candidate);
      if (value) { uri = candidate; document = { ...value, range: { start: 0, end: value.text.length } }; break; }
    }
  }
  const snapshot = document ?? (request.document.uri === uri ? request.document : await reader.read(uri));
  if (request.cancellation.isCancellationRequested) return undefined;
  if (!snapshot) { reader.navigation?.record({ code: 'missing', message: '没有找到 WXS 模块源码，请检查 src 或 require 路径。', uri }); return undefined; }
  if (snapshot.text.length > 2_000_000) { reader.navigation?.record({ code: 'budget', message: 'WXS 模块超过两百万字符上限，未解析。', uri }); return undefined; }
  const offset = module?.inline ? request.offset - module.inline.range.start : request.offset;
  const projectRequest: LanguageRequest = { ...request, document: { uri, text: snapshot.text, version: snapshot.version ?? 0, languageId: 'wxs' }, offset };
  const project = new ScriptProject(reader, projectRequest, options);
  const program = await project.create(uri);
  if (!program || project.cancelled) return undefined;
  const values = new Values(program.program.getTypeChecker(), () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
  return { project, program, values, uri, offset };
}

/** 外部模块和内联模块共用 JS 类型检查器，内联位置映射回原始 WXML。 */
export async function queryWxs(reader: WorkspaceReader, request: LanguageRequest, expression?: TemplateExpression, options: ScriptOptions = {}, rename = false): Promise<WxsResult | undefined> {
  if (request.cancellation.isCancellationRequested || expression?.event) return undefined;
  const tree = expression && parse(expression.text);
  const selected = tree && reference(tree, request.offset - expression!.range.start + 1);
  const embedded = expression?.modules?.find((module) => module.inline && request.offset >= module.inline.range.start && request.offset < module.inline.range.end);
  const module = embedded ?? expression?.modules?.find((module) => selected && rootName(selected.node) === module.name);
  if (expression && !module) return undefined;
  const empty: WxsResult = { definitions: [], completions: [] };
  if (expression && !selected && !embedded) return empty;
  const context = await createWxsContext(reader, request, module, options);
  if (!context) return empty;
  const { project, program, values, uri, offset } = context;
  const roots = new Map(module ? [[module.name, [values.value(program.entry)]]] : []);
  const token = embedded || !expression ? nodeAt(program.entry, offset) : selected!.token;
  const node = embedded || !expression ? token.parent && ts.isPropertyAccessExpression(token.parent) && token.parent.name === token ? token.parent : token : selected!.node;
  const base = embedded || !expression ? embedded?.inline?.range.start ?? 0 : expression.range.start - 1;
  const originRange = { start: token.getStart() + base, end: token.end + base };
  /** 源码位置始终落到可编辑文件，绝不暴露内联模块的虚拟 URI。 */
  const location = (target: ts.Node): Omit<Definition, 'originRange'> => {
    const source = target.getSourceFile();
    const inline = module?.inline && source.fileName === uri;
    const quote = ts.isStringLiteralLike(target) ? 1 : 0;
    return { uri: inline ? module.uri : source.fileName, range: { start: target.getStart(source) + quote + (inline ? module.inline!.range.start : 0), end: target.end - quote + (inline ? module.inline!.range.start : 0) }, ...(project.documents.get(source.fileName)?.version === undefined ? {} : { version: project.documents.get(source.fileName)!.version! }) };
  };
  if (module && !embedded && ts.isIdentifier(node) && node.text === module.name) {
    return { ...empty, definitions: [{ uri: request.document.uri, range: module.nameRange, originRange, version: request.document.version }] };
  }
  const candidates = embedded || !expression ? values.resolve(values.value(node)) : evaluate(node, roots, values);
  const definitions: Definition[] = [];
  const descriptions: string[] = [];
  for (const candidate of candidates) {
    const raw = rename && candidate.declaration ? [candidate] : values.resolve(candidate);
    for (const resolved of raw) {
      if (ts.isIdentifier(resolved.node) && !resolved.declaration || resolved.node === program.entry) continue;
      const declaration = resolved.declaration ?? resolved.node;
      definitions.push({ ...location(declaration), originRange, ...(rename && ts.isShorthandPropertyAssignment(declaration.parent) ? { renameSuffix: ': ' + declaration.getText() } : {}) });
      project.explainDefinition(declaration.getSourceFile().fileName);
      const doc = declarationDocumentation(declaration) || declarationDocumentation(candidate.declaration ?? candidate.node);
      descriptions.push([doc, values.checker.typeToString(values.checker.getTypeAtLocation(resolved.node), resolved.node, ts.TypeFormatFlags.NoTruncation)].filter(Boolean).join('\n'));
    }
  }
  const completions: Completion[] = [];
  const access = ts.isPropertyAccessExpression(node) ? node : token.parent && ts.isPropertyAccessExpression(token.parent) ? token.parent : undefined;
  if (access && request.offset >= access.name.getStart() + base) {
    const range = { start: access.name.getStart() + base, end: access.name.end + base };
    const prefix = request.document.text.slice(range.start, request.offset);
    const parents = embedded || !expression ? values.resolve(values.value(access.expression)) : evaluate(access.expression, roots, values);
    for (const parent of parents) for (const [name, members] of values.fields(parent)) {
      if (!name.startsWith(prefix)) continue;
      const resolved = members.flatMap((member) => values.resolve(member));
      completions.push({ label: name, kind: 'value', detail: resolved.map((item) => values.checker.typeToString(values.checker.getTypeAtLocation(item.node))).join(' | '), documentation: resolved.map((item) => declarationDocumentation(item.declaration ?? item.node)).filter(Boolean).join('\n'), insertText: name, range });
    }
  }
  return { definitions: [...new Map(definitions.map((item) => [`${item.uri}:${item.range.start}:${item.range.end}`, item])).values()], completions: [...new Map(completions.map((item) => [item.label, item])).values()], ...(descriptions.length ? { hover: { title: request.document.text.slice(originRange.start, originRange.end), description: [...new Set(descriptions)].join('\n\n'), range: originRange } } : {}) };
}
