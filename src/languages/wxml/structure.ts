import type { FoldingRegion, LanguageRequest, OutlineSymbol, TextRange } from '../../api';
import { maskExpressions, scanTags, skipExpression } from './parser';
import type { TagToken } from './parser';

/** 节点范围在配对完成后确定，内部父指针不进入公共返回数据。 */
export interface StructureNode {
  readonly opening: TagToken;
  closing?: TagToken;
  range: TextRange;
  readonly parent?: StructureNode;
  readonly children: StructureNode[];
}
/** 词法屏蔽区参与选区和折叠，不会产生伪标签。 */
interface Span { readonly kind: 'comment' | 'cdata' | 'expression'; readonly range: TextRange; readonly content: TextRange }
/** 各项结构能力共用一次解析，严格配对也供标签联动使用。 */
export interface StructureIndex {
  readonly tags: readonly TagToken[];
  readonly nodes: readonly StructureNode[];
  readonly roots: readonly StructureNode[];
  readonly pairs: ReadonlyMap<number, TagToken>;
  readonly unclosed: readonly TagToken[];
  readonly spans: readonly Span[];
  readonly lines: readonly number[];
}
/** 与词法缓存相同的文本预算，超过预算的解析结果只用于当前请求。 */
const cache = new Map<string, StructureIndex>();
let characters = 0, records = 0;

/** 卸载时释放结构快照，禁止后续注册复用旧节点。 */
export function clearStructureCache(): void { cache.clear(); characters = 0; records = 0; }

/** 统计结构记录，缓存同时限制文本和对象数量。 */
function weight(index: StructureIndex): number { return index.tags.length + index.nodes.length + index.spans.length; }

/** 原文空白按字符偏移裁去，CRLF 和中文仍使用 UTF-16 范围。 */
function trimmed(text: string, start: number, end: number): TextRange {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return { start, end };
}

/** 注释、CDATA 和插值只在真实文本区域中枚举。 */
function spansIn(text: string, start: number, end: number, spans: Span[], expressionsOnly = false): boolean {
  for (let offset = start; offset < end;) {
    if (!expressionsOnly && (text.startsWith('<!--', offset) || text.startsWith('<![CDATA[', offset))) {
      if (spans.length >= 50000) return false;
      const comment = text.startsWith('<!--', offset), prefix = comment ? 4 : 9, suffix = comment ? '-->' : ']]>';
      const closing = text.indexOf(suffix, offset + prefix);
      const stop = closing < 0 || closing >= end ? end : closing + suffix.length;
      spans.push({ kind: comment ? 'comment' : 'cdata', range: { start: offset, end: stop }, content: trimmed(text, offset + prefix, closing < 0 || closing >= end ? stop : closing) });
      offset = stop;
    } else if (!expressionsOnly && text.startsWith('<?', offset)) {
      const closing = text.indexOf('?>', offset + 2); offset = closing < 0 ? end : Math.min(end, closing + 2);
    } else if (text.startsWith('{{', offset)) {
      if (spans.length >= 50000) return false;
      const stop = Math.min(end, skipExpression(text, offset));
      spans.push({ kind: 'expression', range: { start: offset, end: stop }, content: trimmed(text, offset + 2, text.slice(stop - 2, stop) === '}}' ? stop - 2 : stop) });
      offset = stop;
    } else offset++;
  }
  return true;
}

/** 完整文本索引可复用，取消、超大文本或过深结构不返回部分配对。 */
export function structure(text: string, cancellation?: LanguageRequest['cancellation']): StructureIndex | undefined {
  if (cancellation?.isCancellationRequested || text.length > 2_000_000) return undefined;
  const cached = cache.get(text);
  if (cached) { cache.delete(text); cache.set(text, cached); return cached; }
  const tags: TagToken[] = [], nodes: StructureNode[] = [], roots: StructureNode[] = [], stack: StructureNode[] = [], spans: Span[] = [];
  const pairs = new Map<number, TagToken>();
  let previous: TagToken | undefined;
  for (const tag of scanTags(text)) {
    if (cancellation?.isCancellationRequested || tags.length >= 50000) return undefined;
    if (!(previous?.name === 'wxs' && previous.closed && !previous.closing && !previous.selfClosing) && !spansIn(text, previous?.end ?? 0, tag.start, spans)) return undefined;
    previous = tag; tags.push(tag);
    if (!tag.name) continue;
    if (!tag.closing) {
      const parent = stack.at(-1);
      const node: StructureNode = { opening: tag, range: { start: tag.start, end: tag.closed && !tag.selfClosing ? text.length : tag.end }, children: [], ...(parent ? { parent } : {}) };
      (parent?.children ?? roots).push(node); nodes.push(node);
      for (const attribute of tag.attributes) if (attribute.valueRange && !spansIn(text, attribute.valueRange.start, attribute.valueRange.end, spans, true)) return undefined;
      if (tag.closed && !tag.selfClosing) { if (stack.length >= 256) return undefined; stack.push(node); }
      continue;
    }
    if (!tag.closed || tag.selfClosing) continue;
    let match = stack.length - 1;
    while (match >= 0 && stack[match]!.opening.name !== tag.name) match--;
    if (match === stack.length - 1 && match >= 0) {
      const node = stack[match]!;
      node.closing = tag; node.range = { start: node.opening.start, end: tag.end };
      pairs.set(node.opening.start, tag); pairs.set(tag.start, node.opening);
    }
    // 错误交叉闭合仍保留可读的大纲边界，但不能成为安全标签对。
    for (let index = Math.max(0, match); index < stack.length; index++) if (!stack[index]!.closing) stack[index]!.range = { start: stack[index]!.opening.start, end: index === match ? tag.end : tag.start };
    if (match >= 0) stack.splice(match); else stack.length = 0;
  }
  if (!(previous?.name === 'wxs' && previous.closed && !previous.closing && !previous.selfClosing) && !spansIn(text, previous?.end ?? 0, text.length, spans)) return undefined;
  const lines = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) { if (lines.length >= 50000) return undefined; lines.push(match.index + match[0].length); }
  const result: StructureIndex = { tags, nodes, roots, pairs, unclosed: stack.map((node) => node.opening), spans, lines };
  const own = weight(result);
  if (text.length <= 250000 && own <= 20000) {
    cache.set(text, result); characters += text.length; records += own;
    while (cache.size > 8 || characters > 1_000_000 || records > 20000) {
      const oldest = cache.keys().next().value!; characters -= oldest.length; records -= weight(cache.get(oldest)!); cache.delete(oldest);
    }
  }
  return result;
}

/** 二分定位最近的原文起点，调用者再校验所属范围。 */
function before<T>(items: readonly T[], offset: number, start: (item: T) => number): T | undefined {
  let low = 0, high = items.length;
  while (low < high) { const middle = (low + high) >>> 1; if (start(items[middle]!) <= offset) low = middle + 1; else high = middle; }
  return low ? items[low - 1] : undefined;
}

/** 当前位置只进入真实包含它的最近节点，已结束的兄弟节点不形成作用域。 */
export function nodeAt(index: StructureIndex, offset: number): StructureNode | undefined {
  let node = before(index.nodes, offset, (node) => node.opening.start);
  while (node && node.range.end < offset) node = node.parent;
  return node;
}

/** 字段值只作为普通显示文本，不执行插值或脚本。 */
function attribute(text: string, tag: TagToken, name: string): string | undefined {
  const range = tag.attributes.find((item) => item.name === name)?.valueRange;
  return range ? text.slice(range.start, range.end) : undefined;
}

/** 模板、模块和静态标识使重复布局节点在大纲中容易辨认。 */
function symbol(text: string, node: StructureNode): OutlineSymbol {
  const tag = node.opening;
  let name = tag.name, kind: OutlineSymbol['kind'] = 'element';
  if (tag.name === 'template') { kind = 'template'; name += ' ' + (attribute(text, tag, 'name') ?? attribute(text, tag, 'is') ?? ''); }
  else if (tag.name === 'wxs') { kind = 'module'; name += ' ' + (attribute(text, tag, 'module') ?? ''); }
  else if (tag.name === 'include' || tag.name === 'import') { kind = 'file'; name += ' ' + (attribute(text, tag, 'src') ?? ''); }
  else {
    const id = attribute(text, tag, 'id'); if (id && !id.includes('{{')) name += '#' + id.slice(0, 160);
    const classes = maskExpressions((attribute(text, tag, 'class') ?? '').slice(0, 160), '\0').trim().split(/\s+/).filter((value) => value && !value.includes('\0')).slice(0, 3);
    if (classes.length) name += ' ' + classes.map((value) => '.' + value).join(' ');
  }
  const detail = tag.attributes.filter((item) => ['wx:if', 'wx:elif', 'wx:else', 'wx:for', 'slot'].includes(item.name)).slice(0, 8).map((item) => item.name + (item.valueRange ? '=' + text.slice(item.valueRange.start, Math.min(item.valueRange.end, item.valueRange.start + 80)).replace(/\s+/g, ' ') : '')).join(' · ').slice(0, 240);
  return { name: name.trim().replace(/\s+/g, ' ').slice(0, 160), kind, range: node.range, selectionRange: tag.nameRange, ...(detail ? { detail } : {}), children: node.children.map((child) => symbol(text, child)) };
}

/** 大纲只读取当前快照，基础结构不加载 TypeScript。 */
export function provideSymbols(request: LanguageRequest): readonly OutlineSymbol[] {
  return structure(request.document.text, request.cancellation)?.roots.map((node) => symbol(request.document.text, node)) ?? [];
}

/** 折叠保留独立闭合标签行，同行起点只保留最大的合法区域。 */
export function provideFolding(request: LanguageRequest): readonly FoldingRegion[] {
  const index = structure(request.document.text, request.cancellation);
  if (!index) return [];
  const result = new Map<number, FoldingRegion>();
  /** 行起点来自同一快照，长单行文档不会反复向前扫描。 */
  const lineStart = (offset: number): number => before(index.lines, offset, (line) => line) ?? 0;
  /** 单行范围无需折叠，重叠起点按实际可见行合并。 */
  const add = (range: TextRange, kind?: FoldingRegion['kind']): void => {
    const start = lineStart(range.start), end = lineStart(Math.max(range.start, range.end - 1));
    if (end <= start) return;
    const previous = result.get(start);
    if (!previous || previous.range.end < range.end) result.set(start, { range, ...(kind ? { kind } : {}) });
  };
  for (const node of index.nodes) if (node.closing) {
    const start = lineStart(node.closing.start);
    add({ start: node.opening.start, end: /^\s*$/.test(request.document.text.slice(start, node.closing.start)) ? start : node.closing.end });
  }
  else if (node.opening.closed) add({ start: node.opening.start, end: node.opening.end });
  for (const span of index.spans) if (span.kind !== 'expression') add(span.range, span.kind === 'comment' ? 'comment' : 'region');
  return [...result.values()].sort((left, right) => left.range.start - right.range.start);
}

/** 单词范围先按当前位置选择，右边界仍可选择前一个词。 */
function word(text: string, offset: number): TextRange {
  const character = (position: number): boolean => /[$\p{L}\p{N}_:-]/u.test(text[position] ?? '');
  let start = offset, end = offset;
  if (!character(offset) && character(offset - 1)) start--;
  while (start > 0 && character(start - 1)) start--;
  while (end < text.length && character(end)) end++;
  return { start, end };
}

/** 多光标复用索引，按单词、表达式、属性、节点和父节点逐层扩大。 */
export function provideSelections(request: LanguageRequest, offsets: readonly number[]): readonly (readonly TextRange[])[] {
  const text = request.document.text, index = structure(text, request.cancellation);
  if (!index) return [];
  return offsets.map((input) => {
    const offset = Number.isFinite(input) ? Math.max(0, Math.min(text.length, Math.floor(input))) : 0, ranges: TextRange[] = [];
    /** 只追加严格包含且覆盖光标的范围，避免重复和交叉父链。 */
    const add = (range: TextRange | undefined): void => {
      if (!range || range.start > offset || range.end < offset) return;
      const previous = ranges.at(-1);
      if (!previous || range.start <= previous.start && range.end >= previous.end && (range.start < previous.start || range.end > previous.end)) ranges.push(range);
    };
    add(word(text, offset));
    const span = before(index.spans, offset, (span) => span.range.start);
    if (span && span.range.end >= offset) { add(span.content); add(span.range); }
    let node = nodeAt(index, offset);
    const tag = node && [node.opening, node.closing].find((tag) => tag && offset >= tag.start && offset <= tag.end);
    /** 成对引号属于完整属性，不能留下孤立的闭合引号。 */
    const quoted = (range: TextRange | undefined): boolean => !!range && ['"', "'"].includes(text[range.start - 1] ?? '') && text[range.start - 1] === text[range.end];
    const field = tag?.attributes.find((item) => offset >= item.range.start && offset <= (item.valueRange ? item.valueRange.end + Number(quoted(item.valueRange)) : item.range.end));
    if (field) {
      add(field.valueRange);
      if (quoted(field.valueRange)) add({ start: field.valueRange!.start - 1, end: field.valueRange!.end + 1 });
      add({ start: field.range.start, end: field.valueRange ? field.valueRange.end + Number(quoted(field.valueRange)) : field.range.end });
    }
    if (tag) add({ start: tag.start, end: tag.end });
    if (node?.opening.closed && !node.opening.selfClosing) add({ start: node.opening.end, end: node.closing?.start ?? node.range.end });
    while (node) { add(node.range); node = node.parent; }
    add({ start: 0, end: text.length });
    return ranges;
  });
}
