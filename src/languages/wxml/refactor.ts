import type { CodeAction, ComponentResolver, LanguageRequest, ScriptDefinitionResolver, ScriptModule, StyleClassResolver, TextEdit, TextRange, WorkspaceReader } from '../../api';
import type { ComponentExtractionScope } from '../../api/semantic';
import { nodeAt, structure } from './structure';
import type { StructureIndex, StructureNode } from './structure';
import { bindingsAt } from './expression';
import { scriptExpression } from './wxs';
import { componentData } from './component-data';
import { componentStyles } from './component-styles';
import { materializeComponent } from './component-templates';
import { eventAttribute } from './events';
import { nativeTags } from './catalog';

/** 控制属性在单根条件节点提取时留在原位置，维持相邻条件分支。 */
const controls = new Set(['wx:if', 'wx:elif', 'wx:else', 'wx:for', 'wx:for-item', 'wx:for-index', 'wx:key']);
/** 模板名称使用可安全写入属性的字符，不允许路径或表达式注入。 */
const validName = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

/** 静态属性保持原始字符串；动态来源不作为确定的文件边。 */
function value(request: LanguageRequest, node: StructureNode, name: string): string | undefined {
  const range = node.opening.attributes.find((item) => item.name === name)?.valueRange;
  return range ? request.document.text.slice(range.start, range.end) : undefined;
}

/** 属性完整范围包含成对引号，删除控制属性后不残留引号。 */
function attributeRange(text: string, attribute: StructureNode['opening']['attributes'][number]): TextRange {
  const range = attribute.valueRange;
  const quoted = range && ['"', "'"].includes(text[range.start - 1] ?? '') && text[range.start - 1] === text[range.end];
  return { start: attribute.range.start, end: range ? range.end + Number(quoted) : attribute.range.end };
}

/** 选区必须包含完整兄弟节点，错误配对和半个标签不能生成编辑。 */
function selected(request: LanguageRequest, range: TextRange, maxCharacters = 250000) {
  const text = request.document.text;
  if (request.cancellation.isCancellationRequested || range.start < 0 || range.end > text.length || range.end < range.start) return undefined;
  while (range.start < range.end && /\s/.test(text[range.start]!)) range = { start: range.start + 1, end: range.end };
  while (range.end > range.start && /\s/.test(text[range.end - 1]!)) range = { start: range.start, end: range.end - 1 };
  if (range.start === range.end || range.end - range.start > maxCharacters) return undefined;
  const index = structure(text, request.cancellation);
  if (!index) return undefined;
  const nodes = index.nodes.filter((node) => node.opening.start >= range.start && node.range.end <= range.end);
  const contained = new Set(nodes), roots = nodes.filter((node) => !node.parent || !contained.has(node.parent));
  if (!roots.length || roots[0]!.opening.start !== range.start || roots.at(-1)!.range.end !== range.end || roots.some((node) => node.parent !== roots[0]!.parent)
    || nodes.some((node) => !node.opening.closed || !node.opening.selfClosing && !node.closing)) return undefined;
  return { index, nodes, roots, range };
}

/** 提前显示确定的结构边界，名称输入和生成阶段使用同一检查。 */
function templateProblem(request: LanguageRequest, chosen: NonNullable<ReturnType<typeof selected>>): string | undefined {
  if (chosen.nodes.some((node) => ['wxs', 'import'].includes(node.opening.name) || node.opening.name === 'template' && value(request, node, 'name') !== undefined)) return '选区包含模板或模块声明，请选择实际渲染节点。';
  if (chosen.nodes.some((node) => node.opening.attributes.some((attribute) => attribute.name.startsWith('model:')))) return '双向绑定不能仅通过模板 data 保持写回路径，未生成部分编辑。';
  if (chosen.roots.length > 1) {
    const first = chosen.roots[0]!, last = chosen.roots.at(-1)!;
    const siblings = first.parent?.children ?? chosen.index.roots;
    const next = siblings[siblings.indexOf(last) + 1];
    if (first.opening.attributes.some((attribute) => ['wx:elif', 'wx:else'].includes(attribute.name)) || next?.opening.attributes.some((attribute) => ['wx:elif', 'wx:else'].includes(attribute.name))) return '请同时选中完整条件链，避免提取后分支失去相邻关系。';
  }
  return undefined;
}

/** 完整模板名列表也用于输入阶段的即时冲突提示。 */
function templateNames(request: LanguageRequest, index: StructureIndex): Set<string> {
  return new Set(index.nodes.filter((node) => node.opening.name === 'template').map((node) => value(request, node, 'name')).filter((name): name is string => name !== undefined));
}

/** 判断包含文件中的声明区域，声明正文不随 include 渲染。 */
function declaration(request: LanguageRequest, index: StructureIndex, offset: number, range: TextRange): boolean {
  for (let node = nodeAt(index, offset); node; node = node.parent) if (node.opening.name === 'template' && node.range.start >= range.start && node.range.end <= range.end && value(request, node, 'name') !== undefined) return true;
  return false;
}

/** 包含节点继承的局部循环仍留在提取体内，不需要从调用者重新传入。 */
function localNames(request: LanguageRequest, node: StructureNode, range: TextRange, hoisted: readonly TextRange[]): Set<string> {
  const parents: StructureNode[] = [];
  for (let current: StructureNode | undefined = node; current; current = current.parent) parents.unshift(current);
  return new Set(bindingsAt(request.document.text, parents.map((node) => node.opening), node.opening.end).filter((binding) => binding.range.start >= range.start && binding.range.end <= range.end && !hoisted.some((part) => binding.range.start >= part.start && binding.range.end <= part.end)).map((binding) => binding.name));
}

/** 请求内文件缓存限定提取依赖；只沿静态 include/import 读取源码。 */
class Dependencies {
  readonly fields = new Set<string>();
  readonly modules = new Map<string, ScriptModule>();
  /** 组件提取使用同一份自由引用，简写对象键需要保持原契约名称。 */
  readonly uses: { name: string; uri: string; range: TextRange; shorthand?: boolean }[] = [];
  private readonly files = new Map<string, LanguageRequest>();
  private readonly targets = new Map<string, LanguageRequest>();
  private characters = 0;
  private expressions = 0;

  /** 当前页面始终使用选区快照，后续读取不能替换其坐标。 */
  constructor(private readonly reader: WorkspaceReader | undefined, private readonly scripts: ScriptDefinitionResolver | undefined, private readonly request: LanguageRequest) {
    this.files.set(request.document.uri, request); this.characters = request.document.text.length;
  }

  /** 未知路径、超限或读取失败必须停止，不提交缺少依赖的数据契约。 */
  async target(from: LanguageRequest, reference: string | undefined): Promise<LanguageRequest> {
    if (!reference || reference.includes('{{') || /^(?:[\w+.-]+:|\/\/)/.test(reference)) throw new Error('模板引用路径无法静态确定，不能完整分析提取依赖。');
    const key = from.document.uri + '\0' + reference;
    const cached = this.targets.get(key); if (cached) return cached;
    const resolved = await this.reader?.fileResolver?.(from.document.uri, this.request.cancellation).candidates(reference, from.document.uri, 'file') ?? [];
    let direct: string | undefined;
    try { if (!reference.startsWith('/')) direct = new URL(reference, from.document.uri).href; } catch { /* 虚拟文档需要可用的路径解析器。 */ }
    for (const candidate of [...resolved, ...direct ? [direct] : []]) {
      const uri = /\.wxml$/i.test(candidate) ? candidate : candidate + '.wxml';
      const previous = this.files.get(uri); if (previous) { this.targets.set(key, previous); return previous; }
      if (this.files.size >= 100) throw new Error('提取依赖超过一百份模板文件上限。');
      const snapshot = await this.reader?.read(uri);
      if (!snapshot) continue;
      if (snapshot.text.length > 2_000_000 || this.characters + snapshot.text.length > 4_000_000) throw new Error('提取依赖文本超过解析上限。');
      const result = { ...from, document: { ...from.document, uri, text: snapshot.text, version: snapshot.version ?? 0 } };
      this.characters += snapshot.text.length; this.files.set(uri, result); this.targets.set(key, result); return result;
    }
    throw new Error(`未找到模板引用 ${reference}，无法完整分析提取依赖。`);
  }

  /** include 只继承调用处数据，模板声明和 WXS 正文不会误成为自由变量。 */
  async collect(request: LanguageRequest, index: StructureIndex, range: TextRange, hoisted: readonly TextRange[] = [], inherited = new Set<string>(), ancestry = new Set<string>()): Promise<void> {
    if (this.request.cancellation.isCancellationRequested) return;
    if (ancestry.has(request.document.uri)) throw new Error('模板 include 存在循环，无法安全提取。');
    const next = new Set(ancestry).add(request.document.uri);
    for (const span of index.spans) {
      if (span.kind !== 'expression' || span.range.start < range.start || span.range.end > range.end || declaration(request, index, span.range.start, range) || hoisted.some((part) => span.range.start >= part.start && span.range.end <= part.end)) continue;
      if (++this.expressions > 2000) throw new Error('提取依赖超过两千个表达式上限。');
      const current = { ...request, offset: span.content.start };
      const expression = scriptExpression(current);
      if (!expression || expression.event) continue;
      const names = await this.scripts?.expressionNames?.(current, expression);
      if (!names?.complete) throw new Error('表达式包含无法静态分析的语法，未生成部分提取编辑。');
      for (const item of names.names) {
        const module = expression.modules?.find((module) => module.name === item.name);
        if (module) { this.modules.set(module.name, module); continue; }
        if (inherited.has(item.name)) continue;
        const binding = [...expression.bindings].reverse().find((binding) => binding.name === item.name);
        if (binding && binding.range.start >= range.start && binding.range.end <= range.end && !hoisted.some((part) => binding.range.start >= part.start && binding.range.end <= part.end)) continue;
        if (['__proto__', 'prototype', 'constructor'].includes(item.name)) throw new Error(`字段 ${item.name} 无法安全写入模板数据对象。`);
        this.fields.add(item.name);
        if (this.uses.length >= 20000) throw new Error('提取依赖超过两万个数据引用上限。');
        this.uses.push({ ...item, uri: request.document.uri });
      }
    }
    for (const node of index.nodes) {
      if (node.opening.name !== 'include' || node.range.start < range.start || node.range.end > range.end || declaration(request, index, node.opening.start, range)) continue;
      const target = await this.target(request, value(request, node, 'src'));
      const targetIndex = structure(target.document.text, this.request.cancellation);
      if (!targetIndex) throw new Error('包含模板超过结构解析预算，无法安全提取。');
      await this.collect(target, targetIndex, { start: 0, end: target.document.text.length }, [], new Set([...inherited, ...localNames(request, node, range, hoisted)]), next);
    }
  }

  /** 新名称不能遮蔽当前文件直接导入的模板。 */
  async checkName(name: string): Promise<void> {
    const index = structure(this.request.document.text, this.request.cancellation)!;
    for (const node of index.nodes) if (node.opening.name === 'import') {
      const target = await this.target(this.request, value(this.request, node, 'src'));
      const targetIndex = structure(target.document.text, this.request.cancellation);
      if (!targetIndex) throw new Error('导入模板超过结构解析预算，无法检查名称冲突。');
      if (templateNames(target, targetIndex).has(name)) throw new Error(`导入模板已经声明 ${name}，提取会改变已有引用。`);
    }
  }
}

/** 相同文件中的模板保持事件及样式归属，只显式传递选区的自由数据。 */
export async function extractTemplate(request: LanguageRequest, range: TextRange, name: string, scripts?: ScriptDefinitionResolver, reader?: WorkspaceReader): Promise<readonly TextEdit[]> {
  if (!validName.test(name)) throw new Error('请输入由文字、数字、下划线或连字符组成的模板名称。');
  const chosen = selected(request, range);
  if (!chosen) throw new Error('请选择一个或多个完整的兄弟节点。');
  if (templateNames(request, chosen.index).has(name)) throw new Error(`当前文件已经声明模板 ${name}。`);
  const problem = templateProblem(request, chosen); if (problem) throw new Error(problem);
  const root = chosen.roots[0]!;
  const attributes = chosen.roots.length === 1 && root.opening.attributes.some((attribute) => ['wx:if', 'wx:elif', 'wx:else'].includes(attribute.name)) ? root.opening.attributes.filter((attribute) => controls.has(attribute.name)) : [];
  const hoisted = attributes.map((attribute) => attributeRange(request.document.text, attribute));
  const dependencies = new Dependencies(reader, scripts, request);
  await dependencies.collect(request, chosen.index, chosen.range, hoisted);
  await dependencies.checkName(name);
  if (request.cancellation.isCancellationRequested) return [];
  const text = request.document.text, newline = text.includes('\r\n') ? '\r\n' : '\n';
  let body = text.slice(chosen.range.start, chosen.range.end);
  for (const part of [...hoisted].reverse()) body = body.slice(0, part.start - chosen.range.start) + body.slice(part.end - chosen.range.start);
  const data = [...dependencies.fields].map((field) => `${field}: ${field}`).join(', ');
  const control = hoisted.map((part) => ' ' + text.slice(part.start, part.end)).join('');
  const call = `<template is="${name}"${control}${data ? ` data="{{${data}}}"` : ''}/>`;
  const definition = `${newline}${newline}<!-- 提取节点沿用当前文件的事件与样式作用域。 -->${newline}<template name="${name}">${newline}${body}${newline}</template>${newline}`;
  return [{ uri: request.document.uri, range: chosen.range, newText: call, oldText: text.slice(chosen.range.start, chosen.range.end), expectedText: text, version: request.document.version },
    { uri: request.document.uri, range: { start: text.length, end: text.length }, newText: definition, oldText: '', expectedText: text, version: request.document.version }];
}

/** 组件迁移先改写数据，再重建 class 插值，避免同一属性的多个编辑交叉覆盖。 */
export async function prepareComponent(request: LanguageRequest, range: TextRange, scripts: ScriptDefinitionResolver, styles: StyleClassResolver, reader: WorkspaceReader, scope?: ComponentExtractionScope, templates = false) {
  const chosen = selected(request, range, templates ? 2_000_000 : 250000);
  if (!chosen) throw new Error(templates ? '展开后的组件超过结构解析预算或节点不完整。' : '请选择一个或多个完整的兄弟节点。');
  const problem = templateProblem(request, chosen); if (problem) throw new Error(problem);
  const root = chosen.roots[0]!;
  const attributes = chosen.roots.length === 1 ? root.opening.attributes.filter((attribute) => controls.has(attribute.name)) : [];
  const hoisted = attributes.map((attribute) => attributeRange(request.document.text, attribute));
  const dependencies = new Dependencies(reader, scripts, request);
  await dependencies.collect(request, chosen.index, chosen.range, hoisted);
  const data = componentData(request, chosen.range, [...dependencies.fields], dependencies.uses);
  let text = request.document.text, end = chosen.range.end;
  /** 阶段内编辑只改副本，最终文件生成仍使用原始请求的坐标与快照。 */
  const apply = (edits: readonly TextEdit[]): void => {
    for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) {
      if (edit.oldText !== undefined && text.slice(edit.range.start, edit.range.end) !== edit.oldText) throw new Error('迁移阶段的数据引用已变化，请重新发起提取。');
      text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
      if (edit.range.end <= end) end += edit.newText.length - (edit.range.end - edit.range.start);
    }
  };
  apply([...data.edits, ...hoisted.map((part) => ({ uri: request.document.uri, range: part, oldText: request.document.text.slice(part.start, part.end), newText: '' }))]);
  if (!styles.extractionStyles) throw new Error('当前样式解析器不能提供完整提取依赖。');
  const graph = await styles.extractionStyles(request, scope?.globalStyles);
  const staged = { ...request, document: { ...request.document, text } };
  const style = componentStyles(staged, { start: chosen.range.start, end: templates ? text.length : end }, graph, scope?.externalClasses, data.bindings.map((binding) => binding.property));
  apply(style.edits);
  if (request.cancellation.isCancellationRequested) throw new Error('组件依赖分析已取消。');
  const rendered = { ...request, document: { ...request.document, text } };
  const nodes = structure(text, request.cancellation)!.nodes.filter((node) => node.range.start >= chosen.range.start && node.range.end <= (templates ? text.length : end));
  return { range: chosen.range, body: text.slice(chosen.range.start, templates ? text.length : end), data: data.bindings, style, styleFiles: graph.files, modules: [...dependencies.modules.values()], rendered, nodes,
    control: hoisted.map((part) => ' ' + request.document.text.slice(part.start, part.end)).join('') };
}

/** 相对引用以原配置为基准迁移，不把编辑器映射后的源码地址当作运行时地址。 */
function relativeReference(from: string, target: string): string {
  const base = new URL('./', from), destination = new URL(target);
  if (base.protocol !== destination.protocol || base.host !== destination.host) throw new Error('组件依赖跨越不同文件系统，不能生成相对注册。');
  const left = base.pathname.split('/').filter(Boolean), right = destination.pathname.split('/').filter(Boolean);
  while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
  const reference = [...left.map(() => '..'), ...right.map(decodeURIComponent)].join('/');
  return reference.startsWith('.') ? reference : './' + reference;
}

/** 输出仅允许工作区内的静态相对路径，组件标签从入口名称推导。 */
function componentTarget(request: LanguageRequest, path: string, reader: WorkspaceReader) {
  if (!/^(?:\.\.?\/)*(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path) || path.length > 240) throw new Error('请输入不带扩展名的相对组件路径，例如 ./components/card-view/index。');
  const uri = new URL(path.startsWith('.') ? path : './' + path, request.document.uri), root = reader.root(request.document.uri);
  const boundary = root && new URL(root.replace(/\/?$/, '/'));
  if (!boundary || uri.protocol !== boundary.protocol || uri.host !== boundary.host || !uri.pathname.startsWith(boundary.pathname)) throw new Error('组件必须创建在当前工作区内。');
  const parts = uri.pathname.split('/'), name = parts.at(-1) === 'index' ? parts.at(-2)! : parts.at(-1)!;
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || nativeTags.has(name)) throw new Error('组件目录或入口名称必须是小写标签名，且不能与原生标签重名。');
  return { uri: uri.href, name, reference: relativeReference(request.document.uri, uri.href) };
}

/** 结构上确定会改变作用域的情况先说明原因，避免只搬标签。 */
function componentProblem(request: LanguageRequest, chosen: NonNullable<ReturnType<typeof selected>>): string | undefined {
  const problem = templateProblem(request, chosen); if (problem) return problem;
  if (chosen.nodes.some((node) => node.opening.name === 'slot')) return '选区包含插槽，提取前需要保持其独立作用域。';
  for (let parent = chosen.roots[0]!.parent; parent; parent = parent.parent) {
    if (parent.opening.name === 'form' || parent.opening.attributes.some((attribute) => eventAttribute(attribute.name))) return '外部祖先包含表单或事件绑定，提取会改变节点及事件边界。';
  }
  for (const node of chosen.nodes) for (const attribute of node.opening.attributes) {
    if (attribute.name === 'slot' || attribute.name.startsWith('generic:') || attribute.name.startsWith('worklet:')) return '选区包含插槽、抽象节点或 Worklet，不能直接改变其组件边界。';
    if (eventAttribute(attribute.name)?.name === 'input') return 'input 事件可能通过返回值写回原生输入框，需要保持该返回契约后才能提取。';
  }
  return undefined;
}

/** 内联模块放到原目录并由双方引用，保留 require 基准和原有单例身份。 */
async function migrateModules(request: LanguageRequest, target: { uri: string; name: string }, modules: readonly ScriptModule[], reader: WorkspaceReader, aliases?: ReadonlyMap<string, string>) {
  const files = new Map<string, string>(), edits: TextEdit[] = [], declarations: string[] = [];
  const index = structure(request.document.text, request.cancellation);
  if (!index) throw new Error('模块声明超过结构解析预算。');
  for (const module of modules) {
    if (request.cancellation.isCancellationRequested) return undefined;
    let uri = module.uri;
    if (module.inline) {
      const root = reader.root(target.uri)?.replace(/\/?$/, '/');
      if (!root || !request.document.uri.startsWith(root) || /\/(?:node_modules|\.pnpm-store|dist|build)\//.test(new URL(request.document.uri).pathname)) throw new Error('内联 WXS 位于工作区之外或依赖目录，不能改写其原始共享声明。');
      const node = index.nodes.find((node) => node.opening.name === 'wxs' && node.opening.attributes.some((attribute) => attribute.valueRange?.start === module.nameRange.start));
      if (!node?.closing) throw new Error('内联模块声明不完整，不能迁移其共享作用域。');
      const basename = new URL(request.document.uri).pathname.split('/').at(-1)!.replace(/\.wxml$/i, '');
      const stem = basename + '.' + target.name + '.' + module.name;
      let candidate = new URL('./' + stem + '.wxs', request.document.uri).href, suffix = 1;
      while (await reader.read(candidate)) {
        if (++suffix > 100) throw new Error('内联模块迁移的候选文件名过多，请选择其他组件名称。');
        candidate = new URL('./' + stem + '-' + suffix + '.wxs', request.document.uri).href;
      }
      uri = candidate;
      files.set(uri, module.inline.text);
      edits.push({ uri: request.document.uri, range: node.range, oldText: request.document.text.slice(node.range.start, node.range.end), expectedText: request.document.text, ...(request.document.version ? { version: request.document.version } : {}),
        newText: `<wxs module="${module.name}" src="${relativeReference(request.document.uri, uri)}"/>` });
    } else {
      const resolver = reader.fileResolver?.(request.document.uri, request.cancellation);
      const candidates = [...await resolver?.candidates(module.reference ?? uri, request.document.uri, 'script') ?? [], uri];
      let found = false;
      for (const candidate of candidates) if (await reader.read(candidate)) { found = true; break; }
      if (!found) throw new Error(`未找到 WXS 模块 ${module.name}，无法确认迁移依赖。`);
    }
    const reference = relativeReference(target.uri, uri);
    if (/["<&]/.test(reference)) throw new Error('WXS 路径包含需要转义的属性字符，请先整理模块路径。');
    declarations.push(`<wxs module="${aliases?.get(module.name) ?? module.name}" src="${reference}"/>`);
  }
  return { files, edits, declarations };
}

/** 创建原生组件及调用处、注册和转发编辑，所有内容先进入原生预览。 */
export async function extractComponent(request: LanguageRequest, range: TextRange, path: string, scripts: ScriptDefinitionResolver, styles: StyleClassResolver, reader: WorkspaceReader, components?: ComponentResolver): Promise<readonly TextEdit[]> {
  const target = componentTarget(request, path, reader), chosen = selected(request, range);
  if (!chosen) throw new Error('请选择完整兄弟节点。');
  const problem = componentProblem(request, chosen); if (problem) throw new Error(problem);
  const scope = await scripts.componentExtractionScope?.(request);
  if (!scope) throw new Error('未找到完整且静态可确认的消费页面或组件。');
  if (scope.issues.length) throw new Error(scope.issues.join('\n'));
  if (scope.nodeQueries.length) throw new Error('消费脚本存在节点查询，需要保持查询边界后才能提取组件。');
  const dependencies = new Dependencies(reader, scripts, request);
  const materialized = chosen.nodes.some((node) => ['include', 'template'].includes(node.opening.name))
    ? await materializeComponent(request, chosen.range, scripts, (from, reference) => dependencies.target(from, reference)) : undefined;
  const plan = await prepareComponent(materialized?.request ?? request, materialized?.range ?? range, scripts, styles, reader, scope, !!materialized);
  const modules = materialized ? { files: new Map<string, string>(), edits: [] as TextEdit[], declarations: [] as string[] } : await migrateModules(request, target, plan.modules, reader);
  if (!modules) return [];
  if (materialized) for (const transfer of materialized.modules) {
    const migrated = await migrateModules(transfer.request, target, [transfer.module], reader, new Map([[transfer.module.name, transfer.alias]]));
    if (!migrated) return [];
    for (const [uri, text] of migrated.files) modules.files.set(uri, text);
    modules.edits.push(...migrated.edits); modules.declarations.push(...migrated.declarations);
  }
  const nodes = plan.nodes;
  // 展开的模板正文也必须通过组件边界检查，不能只校验原调用标签。
  for (const node of nodes) if (node.opening.name === 'slot' || node.opening.attributes.some((attribute) => attribute.name.startsWith('model:') || attribute.name === 'slot' || attribute.name.startsWith('generic:') || attribute.name.startsWith('worklet:') || eventAttribute(attribute.name)?.name === 'input')) throw new Error('依赖模板包含插槽、写回、Worklet 或 input 返回契约，需要保持原组件边界。');
  const tags = new Set(nodes.map((node) => node.opening.name)), ids = new Set(nodes.map((node) => value(plan.rendered, node, 'id')).filter(Boolean));
  for (const file of plan.styleFiles) for (const selector of file.selectors) {
    const types = [...selector.matchAll(/(?:^|[\s>+~,(])([a-z][\w-]*)(?=[\s>+~.#:[,(]|$)/gi)].map((match) => match[1]!);
    const selectors = [...selector.matchAll(/#([\w-]+)/g)].map((match) => match[1]!);
    if (types.some((name) => tags.has(name)) || selectors.some((id) => ids.has(id)) || selector.includes('[') || /(?:^|[\s>+~])\*/.test(selector)) throw new Error('相关样式包含标签、ID、属性或通配选择器，尚不能通过外部样式类保持作用域。');
  }
  const handlers = new Set<string>();
  for (const node of nodes) for (const attribute of node.opening.attributes) if (eventAttribute(attribute.name) && attribute.valueRange) {
    const name = plan.rendered.document.text.slice(attribute.valueRange.start, attribute.valueRange.end);
    if (!/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(name)) throw new Error('事件处理方法不能静态确定，不能生成不完整转发。');
    handlers.add(name);
  }
  const registrations: Record<string, string> = {};
  for (const name of tags) if (!nativeTags.has(name) && !['block', 'template', 'wxs', 'import', 'include'].includes(name)) {
    const sources = await components?.registration?.(request, name) ?? [];
    if (sources.length !== 1) throw new Error(`组件 ${name} 的注册来源不能唯一确定。`);
    const source = sources[0]!;
    const childRequest = { ...request, document: { ...request.document, uri: source.uri.replace(/\.(?:[cm]?[jt]sx?|wxml)$/i, '.wxml') } };
    const child = await scripts.componentExtractionScope?.(childRequest);
    if (!child || child.issues.length || child.externalClasses.some((attribute) => nodes.some((node) => node.opening.name === name && node.opening.attributes.some((item) => item.name === attribute)))) throw new Error(`组件 ${name} 的关联、拥有者或外部样式类需要保持原组件边界。`);
    registrations[name] = source.reference.startsWith('.') ? relativeReference(target.uri, new URL(source.reference, source.from).href) : source.reference;
  }
  const forwarding = await scripts.extractComponentParent?.(request, target.name, target.reference, [...handlers]);
  if (!forwarding) throw new Error('消费文件的注册或方法表不能安全修改，未生成部分组件文件。');
  const newline = request.document.text.includes('\r\n') ? '\r\n' : '\n', js = scope.language === 'javascript';
  const methods = forwarding.bindings.map((binding) => `    /** 转发原始事件，保留消费方法的 this 与节点数据。 */\n    ${JSON.stringify(binding.handler)}(event${js ? '' : ': any'}) {\n      this.triggerEvent(${JSON.stringify(binding.event)}, { originalEvent: event });\n    }`).join(',\n');
  const script = ['/** 由选区提取的组件，数据和事件由消费方显式传入。 */', 'Component({', '  options: { virtualHost: true },', `  externalClasses: ${JSON.stringify(plan.style.bindings.map((binding) => binding.alias))},`, '  /** 接收原选区使用的数据。 */', `  properties: {${plan.data.map((binding) => '\n    ' + JSON.stringify(binding.property) + ': { type: null, value: undefined }').join(',')}\n  },`, '  methods: {', methods, '  }', '});', ''].join('\n').replace(/\n/g, newline);
  const data = plan.data.map((binding) => ` ${binding.attribute}="{{${binding.name}}}"`).join('');
  const classes = plan.style.bindings.map((binding) => ` ${binding.alias}="${binding.name}"`).join('');
  const events = forwarding.bindings.map((binding) => ` bind:${binding.event}="${binding.method}"`).join('');
  // 调用处仍在原模块作用域，不能使用展开阶段为子组件分配的 WXS 别名。
  const control = chosen.roots.length === 1 ? chosen.roots[0]!.opening.attributes.filter((attribute) => controls.has(attribute.name)).map((attribute) => {
    const part = attributeRange(request.document.text, attribute); return ' ' + request.document.text.slice(part.start, part.end);
  }).join('') : '';
  const caller = `<${target.name}${control}${data}${classes}${events}/>`;
  const styleModule = new URL(target.uri).pathname.split('/').at(-1)! + '.styles.wxs';
  const declarations = [...modules.declarations, ...plan.style.source ? [`<wxs module="${plan.style.module}" src="./${styleModule}"/>`] : []];
  const files = new Map<string, string>([[target.uri + '.wxml', [...declarations, plan.body, ''].join(newline)], [target.uri + (js ? '.js' : '.ts'), script], [target.uri + '.json', JSON.stringify({ component: true, usingComponents: registrations }, null, 2).replace(/\n/g, newline) + newline], [target.uri + '.wxss', '/* 通过外部样式类保留消费方的样式作用域。 */' + newline], ...modules.files]);
  if (plan.style.source) files.set(target.uri + '.styles.wxs', plan.style.source);
  const siblings = ['.ts', '.js', '.json', '.wxml', '.wxss', '.scss', '.less', '.css'].map((extension) => target.uri + extension);
  for (const uri of new Set([...siblings, ...files.keys()])) if (await reader.read(uri)) throw new Error('目标组件或样式辅助文件已经存在，请选择新的路径。');
  if (request.cancellation.isCancellationRequested) return [];
  return [...forwarding.edits, ...modules.edits, { uri: request.document.uri, range: chosen.range, oldText: request.document.text.slice(chosen.range.start, chosen.range.end), newText: caller, expectedText: request.document.text, version: request.document.version }, ...[...files].map(([uri, newText]) => ({ uri, range: { start: 0, end: 0 }, newText, create: true }))];
}

/** 只有显式选中完整节点才提供组件提取，普通灯泡查询不读取项目语义。 */
export function componentRefactors(request: LanguageRequest, range: TextRange, scripts: ScriptDefinitionResolver | undefined, styles: StyleClassResolver | undefined, reader: WorkspaceReader | undefined, components?: ComponentResolver): readonly CodeAction[] {
  if (!scripts?.extractComponentParent || !scripts.componentExtractionScope || !styles?.extractionStyles || !reader || range.start === range.end) return [];
  const chosen = selected(request, range); if (!chosen) return [];
  const title = '提取为独立组件', problem = componentProblem(request, chosen);
  if (problem) return [{ title, kind: 'refactor.extract', range: chosen.range, edits: [], disabled: problem }];
  return [{ title, kind: 'refactor.extract', range: chosen.range, edits: [], preview: true,
    input: { title: '提取组件路径', value: './components/extracted-' + chosen.roots[0]!.opening.name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() + '/index', prompt: '创建组件、注册和事件转发，在原生预览中勾选所需改动后应用。',
      validate: (path) => { try { componentTarget(request, path, reader); return undefined; } catch (error) { return error instanceof Error ? error.message : '组件路径无效。'; } },
      select: (path, cancellation) => extractComponent({ ...request, cancellation }, chosen.range, path, scripts, styles, reader, components) } }];
}

/** 普通光标查询不进行依赖扫描，只有明确的完整节点选区提供提取入口。 */
export function templateRefactors(request: LanguageRequest, range: TextRange, scripts?: ScriptDefinitionResolver, reader?: WorkspaceReader): readonly CodeAction[] {
  if (request.cancellation.isCancellationRequested || range.start === range.end) return [];
  const chosen = selected(request, range);
  if (!chosen) return [];
  const problem = templateProblem(request, chosen);
  if (problem) return [{ title: '提取为当前文件的具名模板', kind: 'refactor.extract', range: chosen.range, edits: [], disabled: problem }];
  const names = templateNames(request, chosen.index);
  let name = 'extracted-' + chosen.roots[0]!.opening.name.replace(/[^\w-]/g, '-'), suffix = 1;
  while (names.has(name)) name = 'extracted-' + chosen.roots[0]!.opening.name + '-' + suffix++;
  return [{ title: '提取为当前文件的具名模板', kind: 'refactor.extract', range: chosen.range, edits: [], preview: true,
    input: { title: '提取模板名称', value: name, prompt: '生成数据传参及模板定义，在编辑器预览中勾选改动后应用。',
      validate: (value) => !validName.test(value) ? '名称只能包含文字、数字、下划线或连字符，且不能以数字开头。' : names.has(value) ? `当前文件已声明 ${value}。` : undefined,
      select: (value, cancellation) => extractTemplate({ ...request, cancellation }, chosen.range, value, scripts, reader) } }];
}
