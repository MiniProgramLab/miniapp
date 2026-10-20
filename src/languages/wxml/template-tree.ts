import type { LanguageRequest, WorkspaceReader } from '../../api';
import { scanTags } from './parser';
import type { TagToken } from './parser';

/** 查询节点保留实际模板及透明 include 的父节点关系。 */
export interface TemplateNode {
  readonly request: LanguageRequest;
  readonly tag: TagToken;
  readonly parents: readonly TemplateNode[];
  readonly version?: number;
}

/** 参数值只读取对应属性，不将相邻文本或插值当成静态选择器。 */
export function templateAttribute(node: TemplateNode, name: string): string | undefined {
  const range = node.tag.attributes.find((attribute) => attribute.name === name)?.valueRange;
  return range ? node.request.document.text.slice(range.start, range.end) : undefined;
}

/** include 和静态模板调用以实际文件展开，动态调用禁止猜测选择器不存在。 */
export async function readTemplateTree(reader: WorkspaceReader, request: LanguageRequest, uri: string, parents: readonly TemplateNode[] = [], seen = new Set<string>(), templateName?: string, dependencies = new Map<string, string>()): Promise<{ nodes: TemplateNode[]; complete: boolean }> {
  const key = `${uri}:${templateName ?? ''}`;
  if (seen.has(key) || seen.size >= 200 || request.cancellation.isCancellationRequested) return { nodes: [], complete: false };
  if (reader.revision) dependencies.set(uri, reader.revision(uri));
  const snapshot = uri === request.document.uri ? request.document : await reader.read(uri);
  if (!snapshot || snapshot.text.length > 2_000_000) return { nodes: [], complete: false };
  const document = { uri, text: snapshot.text, version: snapshot.version ?? 0, languageId: 'wxml' };
  const context: LanguageRequest = { document, offset: 0, cancellation: request.cancellation };
  const visited = new Set(seen).add(key);
  const tags = [...scanTags(document.text)];
  const imports = tags.filter((tag) => tag.name === 'import' && !tag.closing);
  const stack: { tag: TagToken; node?: TemplateNode; ignored: boolean }[] = [];
  const result: TemplateNode[] = [];
  let complete = true;
  let active = templateName === undefined;
  let selectedStart: number | undefined;
  /** 文件引用优先沿工程路径映射，保留相对路径兜底。 */
  const paths = async (path: string) => {
    const files = reader.fileResolver?.(uri, request.cancellation);
    const candidates = await files?.candidates(path, uri, path.startsWith('/') ? 'component' : 'file') ?? [];
    for (const item of files?.dependencies ?? []) dependencies.set(item.uri, item.revision);
    return [...candidates, new URL(path, uri).href];
  };
  for (const tag of tags) {
    if (request.cancellation.isCancellationRequested) return { nodes: [], complete: false };
    if (tag.closing) {
      const index = stack.map((entry) => entry.tag.name).lastIndexOf(tag.name);
      if (index >= 0 && stack[index]!.tag.start === selectedStart) active = false;
      if (index >= 0) stack.splice(index);
      continue;
    }
    const current = { request: context, tag, parents: [...parents, ...stack.flatMap((entry) => entry.node ? [entry.node] : [])], ...(snapshot.version === undefined ? {} : { version: snapshot.version }) };
    if (!tag.closed) complete = false;
    const declared = tag.name === 'template' ? templateAttribute(current, 'name') : undefined;
    if (!active) {
      if (!templateName || declared !== templateName) continue;
      active = true; selectedStart = tag.start;
    }
    const ignored = stack.some((entry) => entry.ignored) || !!declared && tag.start !== selectedStart;
    if (ignored) { if (!tag.selfClosing) stack.push({ tag, ignored: true }); continue; }
    if (tag.name === 'include') {
      const path = templateAttribute(current, 'src');
      if (!path || path.includes('{{')) { complete = false; continue; }
      let found = false;
      for (const target of await paths(path)) {
        if (reader.revision) dependencies.set(target, reader.revision(target));
        if (!await reader.read(target)) continue;
        const included = await readTemplateTree(reader, request, target, current.parents, visited, undefined, dependencies);
        result.push(...included.nodes); complete &&= included.complete; found = true; break;
      }
      if (!found) complete = false;
    } else if (tag.name === 'template' && !declared) {
      const name = templateAttribute(current, 'is');
      if (!name || name.includes('{{')) { complete = false; continue; }
      let found = false;
      const targets = [uri];
      for (const imported of imports) {
        const path = templateAttribute({ ...current, tag: imported }, 'src');
        if (path && !path.includes('{{')) targets.push(...await paths(path));
      }
      for (const target of targets) {
        if (reader.revision) dependencies.set(target, reader.revision(target));
        const source = await reader.read(target);
        if (!source || ![...scanTags(source.text)].some((tag) => tag.name === 'template' && tag.attributes.some((attribute) => attribute.name === 'name' && attribute.valueRange && source.text.slice(attribute.valueRange.start, attribute.valueRange.end) === name))) continue;
        const included = await readTemplateTree(reader, request, target, current.parents, visited, name, dependencies);
        result.push(...included.nodes); complete &&= included.complete; found = true; break;
      }
      if (!found) complete = false;
    } else if (!['template', 'block', 'import', 'wxs'].includes(tag.name)) {
      result.push(current);
      if (tag.name === 'slot') complete = false;
    }
    if (!tag.selfClosing) stack.push({ tag, ignored: false, ...result.includes(current) ? { node: current } : {} });
  }
  return { nodes: result, complete: complete && !stack.length };
}

