import ts from 'typescript';
import type { EventForwarding, LanguageRequest, TextEdit, WorkspaceReader, WorkspaceText } from '../../api';
import type { ComponentExtractionScope } from '../../api/semantic';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { queryContext } from './query';
import { insertObjectField, insertObjectMembers, registerComponent } from './config-edits';
import { componentFunctions } from './events';
import { isThis } from './instances';

/** 从静态注册对象读取隔离规则及可能受新组件边界影响的节点查询。 */
export async function componentExtractionScope(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions): Promise<ComponentExtractionScope | undefined> {
  const project = new ScriptProject(reader, request, options);
  const context = await queryContext(project, request, { text: '', range: { start: 0, end: 0 }, bindings: [], event: true });
  if (!context || project.exhausted || project.cancelled || context.registrations.length !== 1) return undefined;
  const { values, program } = context, registered = context.registrations[0]!;
  const resolved = values.resolve(registered), kind = resolved.find((item) => item.registrationKind)?.registrationKind;
  if (kind !== 'page' && kind !== 'component') return undefined;
  const issues = new Set<string>(), external = new Set<string>(), nodeQueries: { name: string; selectors: readonly string[] }[] = [];
  const fields = values.fields(registered);
  if (fields.has('relations')) issues.add('当前消费组件声明了 relations，提取前需要保持组件关联边界。');
  let isolation: string | undefined;
  const groups = [...fields.get('options') ?? [], ...fields.get('config') ?? []];
  const adapter = ts.isCallExpression(registered.node) ? values.adapter(registered.node) : undefined;
  if (adapter?.config) groups.push(...values.section(registered, adapter.config));
  for (const group of groups) {
    const options = values.fields(group), modes = options.get('styleIsolation');
    if (modes) {
      const names = [...new Set(modes.flatMap((mode) => values.keys(mode)))];
      if (names.length === 1) isolation = names[0]; else issues.add('样式隔离配置不能静态确定。');
    } else if (options.get('addGlobalClass')?.some((item) => values.resolve(item).some((value) => value.node.kind === ts.SyntaxKind.TrueKeyword))) isolation = 'apply-shared';
  }
  for (const declaration of fields.get('externalClasses') ?? []) for (const item of values.elements(declaration)) {
    const names = values.keys(item);
    if (!names.length) issues.add('外部样式类声明不能完整静态确定。');
    names.forEach((name) => external.add(name));
  }
  const config = await reader.read(request.document.uri.replace(/\.wxml$/i, '.json'));
  if (config) {
    const parsed = ts.parseConfigFileTextToJson('component.json', config.text);
    if (parsed.error) issues.add('消费配置包含语法错误。');
    else if (typeof parsed.config.styleIsolation === 'string') isolation = parsed.config.styleIsolation;
  }
  const functions = new Set(componentFunctions(values, registered));
  let visited = 0;
  /** 平台对象只接受未被源码局部声明覆盖的 wx。 */
  const platform = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === 'wx'
    && !(values.checker.getSymbolAtLocation(node)?.declarations ?? []).some((declaration) => !declaration.getSourceFile().isDeclarationFile);
  /** 查询链沿 const 别名追踪，普通对象的同名 select 不构成节点依赖。 */
  const query = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node) || seen.size >= 24) return false;
    const next = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return query(node.expression, next);
    if (ts.isIdentifier(node)) return (values.checker.getSymbolAtLocation(node)?.declarations ?? []).some((declaration) => ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const) && query(declaration.initializer, next));
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'createSelectorQuery' ? platform(node.expression.expression) || isThis(node.expression.expression, values.checker)
        : ['in', 'select', 'selectAll'].includes(node.expression.name.text) && query(node.expression.expression, next));
  };
  /** 只检查真实实例方法及箭头回调，普通函数的 this 不属于消费组件。 */
  const visit = (node: ts.Node): void => {
    if (++visited > 20000 || project.cancelled) return;
    if (ts.isFunctionLike(node) && !functions.has(node) && !ts.isArrowFunction(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text, receiver = node.expression.expression;
      const instance = isThis(receiver, values.checker), native = platform(receiver);
      if (['selectComponent', 'selectAllComponents', 'getRelationNodes'].includes(name) && instance
        || name === 'createSelectorQuery' && (instance || native) || ['select', 'selectAll'].includes(name) && query(receiver)
        || name === 'createCanvasContext' && native) nodeQueries.push({ name, selectors: node.arguments[0] ? values.keys(values.value(node.arguments[0])) : [] });
      if (name === 'selectOwnerComponent' && instance) issues.add('消费脚本依赖 selectOwnerComponent，提取前需要保持拥有者语义。');
    }
    ts.forEachChild(node, visit);
  };
  for (const callback of functions) visit(callback);
  if (visited > 20000) issues.add('消费脚本边界分析达到两万个节点上限。');
  if (project.exhausted || project.cancelled) return undefined;
  if (isolation && !['isolated', 'shared', 'apply-shared', 'page-isolated', 'page-shared', 'page-apply-shared'].includes(isolation)) issues.add('样式隔离配置不是已知的静态模式。');
  return { uri: program.entry.fileName, language: /\.[cm]?jsx?$/i.test(program.entry.fileName) ? 'javascript' : 'typescript', globalStyles: isolation ? !['isolated', 'page-isolated'].includes(isolation) : kind === 'page', externalClasses: [...external], nodeQueries, issues: [...issues] };
}

/** 只向当前消费文件的静态方法表追加转发，Behavior 实现保持原声明归属。 */
export async function forwardEvents(reader: WorkspaceReader, request: LanguageRequest, handlers: readonly string[], options: ScriptOptions): Promise<EventForwarding | undefined> {
  if (!handlers.length) return { bindings: [], edits: [] };
  if (handlers.length > 100 || handlers.some((name) => !/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(name))) return undefined;
  const project = new ScriptProject(reader, request, options);
  const context = await queryContext(project, request, { text: '', range: { start: 0, end: 0 }, bindings: [], event: true });
  if (!context || project.exhausted || project.cancelled || context.registrations.length !== 1) return undefined;
  const { values, program, roots } = context;
  const registered = context.registrations[0]!;
  for (const handler of handlers) {
    const targets = roots.get(handler)?.flatMap((value) => values.resolve(value)) ?? [];
    if (!targets.length || targets.some((target) => !ts.isFunctionLike(target.node) && !values.checker.getTypeAtLocation(target.node).getCallSignatures().length)) return undefined;
  }
  const adapter = ts.isCallExpression(registered.node) ? values.adapter(registered.node) : undefined;
  const nativePage = ts.isCallExpression(registered.node) && values.callName(registered.node) === 'Page';
  const path = nativePage ? '.' : adapter?.methods ?? 'methods';
  const argument = adapter && ts.isCallExpression(registered.node) ? registered.node.arguments[adapter.argument ?? 0] : undefined;
  const candidates = adapter ? argument ? [values.value(argument)] : [] : values.resolve(registered);
  const object = candidates.find((value) => ts.isObjectLiteralExpression(value.node) && value.node.getSourceFile() === program.entry);
  if (!object || !ts.isObjectLiteralExpression(object.node)) return undefined;
  const members = path === '.' ? [object] : values.section(object, path).flatMap((value) => values.resolve(value));
  const existing = members.find((value) => ts.isObjectLiteralExpression(value.node) && value.node.getSourceFile() === program.entry);
  if (!existing && (members.length || path === '.' || path.includes('.') || values.fields(object).has(path))) return undefined;
  const bindings: EventForwarding['bindings'][number][] = [], used = new Set(roots.keys());
  for (const handler of new Set(handlers)) {
    let index = bindings.length, method = '__extractEvent' + index;
    while (used.has(method)) method = '__extractEvent' + ++index;
    used.add(method); bindings.push({ handler, method, event: 'extract-event-' + index });
  }
  const snapshot = project.documents.get(program.entry.fileName)!;
  const js = /\.[cm]?jsx?$/i.test(program.entry.fileName), newline = snapshot.text.includes('\r\n') ? '\r\n' : '\n';
  /** 原始事件整体传回，不能用新组件节点的 dataset 替换原节点数据。 */
  const body = (handler: string): string => `(event${js ? '' : ': { detail: { originalEvent: any } }'}) {${newline}  return this.${handler}(event.detail.originalEvent);${newline}}`;
  const source = bindings.map((binding) => `/** 转发提取组件的原始事件。 */${newline}${JSON.stringify(binding.method)}${body(binding.handler)}`).join(',' + newline);
  const edits: TextEdit[] = [];
  if (existing && ts.isObjectLiteralExpression(existing.node)) {
    // 多方法合并一次插入，避免同一偏移的编辑顺序影响对象语法。
    edits.push(...insertObjectMembers(existing.node, source, program.entry.fileName, snapshot));
  } else {
    edits.push(...insertObjectField(object.node, path, `{${newline}${source}${newline}}`, program.entry.fileName, snapshot));
  }
  return project.cancelled ? undefined : { bindings, edits };
}

/** 先在内存中注册，再生成转发；同一对象的多个插入最终合并为一份原文保护编辑。 */
export async function extractComponentParent(reader: WorkspaceReader, request: LanguageRequest, name: string, reference: string, handlers: readonly string[], options: ScriptOptions): Promise<EventForwarding | undefined> {
  const originals = new Map<string, WorkspaceText | undefined>(), rewritten = new Map<string, WorkspaceText>();
  const staged: WorkspaceReader = { ...reader,
    read: async (uri) => rewritten.get(uri) ?? await reader.read(uri),
    ...(reader.revision ? { revision: (uri: string) => rewritten.has(uri) ? reader.revision!(uri) + ':component-extraction' : reader.revision!(uri) } : {}),
  };
  /** 每批编辑核对坐标和旧快照，拒绝重复创建与交叉范围。 */
  async function apply(edits: readonly TextEdit[]): Promise<boolean> {
    const groups = new Map<string, TextEdit[]>();
    for (const edit of edits) groups.set(edit.uri, [...groups.get(edit.uri) ?? [], edit]);
    for (const [uri, parts] of groups) {
      if (request.cancellation.isCancellationRequested) return false;
      const snapshot = await staged.read(uri);
      if (!originals.has(uri)) originals.set(uri, snapshot);
      if (parts.some((edit) => edit.create ? snapshot !== undefined : !snapshot || edit.expectedText !== undefined && edit.expectedText !== snapshot.text || edit.version !== undefined && edit.version !== snapshot.version)) return false;
      let text = snapshot?.text ?? '', previous = text.length + 1;
      for (const edit of parts.sort((left, right) => right.range.start - left.range.start)) {
        if (edit.range.start < 0 || edit.range.end > previous || edit.range.end < edit.range.start || edit.oldText !== undefined && text.slice(edit.range.start, edit.range.end) !== edit.oldText) return false;
        text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end); previous = edit.range.start;
      }
      rewritten.set(uri, { text, ...(snapshot?.version === undefined ? {} : { version: snapshot.version }) });
    }
    return true;
  }
  const registration = await registerComponent(reader, request, name, reference, options);
  if (!registration.length || !await apply(registration)) return undefined;
  const forwarding = await forwardEvents(staged, request, handlers, options);
  if (!forwarding || !await apply(forwarding.edits)) return undefined;
  const edits: TextEdit[] = [];
  for (const [uri, snapshot] of rewritten) {
    const original = originals.get(uri), latest = await reader.read(uri);
    if (latest?.text !== original?.text || latest?.version !== original?.version || request.cancellation.isCancellationRequested) return undefined;
    if (snapshot.text === original?.text) continue;
    edits.push({ uri, range: { start: 0, end: original?.text.length ?? 0 }, newText: snapshot.text, ...(original ? { oldText: original.text, expectedText: original.text, ...(original.version === undefined ? {} : { version: original.version }) } : { create: true }) });
  }
  return { bindings: forwarding.bindings, edits };
}
