import type { TextRange } from '../../api';

/** 属性保留名称、赋值符和值范围，补全时不会覆盖已有值。 */
export interface AttributeToken {
  readonly name: string;
  readonly range: TextRange;
  readonly assigned: boolean;
  readonly valueRange?: TextRange;
}

/** 可容忍尚未闭合标签的词法结果。 */
export interface TagToken {
  readonly name: string;
  readonly nameRange: TextRange;
  readonly closing: boolean;
  readonly attributes: readonly AttributeToken[];
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
  readonly selfClosing: boolean;
}

/** 仅复用完整文本相同的词法结果，限制文档数量、文本量和标签数量。 */
const tagCache = new Map<string, readonly TagToken[]>();
/** 缓存预算包含源文本和标签，连续编辑不会无限保留旧快照。 */
let cachedCharacters = 0;
let cachedTags = 0;

/** 模块卸载时释放词法快照，重新注册后按需建立缓存。 */
export function clearTagCache(): void {
  tagCache.clear();
  cachedCharacters = 0;
  cachedTags = 0;
}

/** 判断标签或属性名称字符，支持指令和事件前缀。 */
function isName(character: string | undefined): boolean {
  return character !== undefined && /[\w:.-]/.test(character);
}

/** 跳过插值表达式，字符串中的闭合符不提前结束表达式。 */
export function skipExpression(text: string, start: number): number {
  let quote = '';
  let depth = 0;
  for (let index = start + 2; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (!depth && text.startsWith('}}', index)) return index + 2;
    else if (character === '{') depth++;
    else if (character === '}') depth = Math.max(0, depth - 1);
  }
  return text.length;
}

/** 保持字符偏移地遮盖插值，表达式字符串中的闭合符不会泄漏为静态类名。 */
export function maskExpressions(text: string, mask: ' ' | '\0' = ' '): string {
  let result = '';
  let offset = 0;
  for (let start = text.indexOf('{{'); start >= 0; start = text.indexOf('{{', offset)) {
    const end = skipExpression(text, start);
    result += text.slice(offset, start) + mask.repeat(end - start);
    offset = end;
  }
  return result + text.slice(offset);
}

/** 读取一个标签；扫描引号中的内容时忽略大于号和插值。 */
export function readTag(text: string, start: number): TagToken {
  const closing = text[start + 1] === '/';
  let index = start + (closing ? 2 : 1);
  const nameStart = index;
  while (isName(text[index])) index++;
  const nameRange = { start: nameStart, end: index };
  const attributes: AttributeToken[] = [];
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '') || text[index] === '/') index++;
    if (index >= text.length || text[index] === '>' || text[index] === '<') break;
    if (!isName(text[index])) { index++; continue; }
    const attributeStart = index;
    while (isName(text[index])) index++;
    const range = { start: attributeStart, end: index };
    while (/\s/.test(text[index] ?? '')) index++;
    const assigned = text[index] === '=';
    let valueRange: TextRange | undefined;
    if (assigned) {
      index++;
      while (/\s/.test(text[index] ?? '')) index++;
      const quote = text[index] === '"' || text[index] === "'" ? text[index++] : undefined;
      const valueStart = index;
      while (index < text.length) {
        if (text.startsWith('{{', index)) { index = skipExpression(text, index); continue; }
        if (quote ? text[index] === quote : /[\s<>]/.test(text[index] ?? '') || text.startsWith('/>', index)) break;
        index++;
      }
      valueRange = { start: valueStart, end: index };
      if (quote && text[index] === quote) index++;
    }
    attributes.push({ name: text.slice(range.start, range.end), range, assigned, ...(valueRange ? { valueRange } : {}) });
  }
  const closed = text[index] === '>';
  return { name: text.slice(nameRange.start, nameRange.end), nameRange, closing, attributes, start, end: closed ? index + 1 : index, closed, selfClosing: text[index - 1] === '/' };
}

/** 统一枚举真实标签，跳过注释、CDATA、处理指令、插值和 WXS 脚本内容。 */
export function* scanTags(text: string): Generator<TagToken> {
  const cached = tagCache.get(text);
  if (cached) {
    tagCache.delete(text);
    tagCache.set(text, cached);
    yield* cached;
    return;
  }
  let parsed: TagToken[] | undefined = text.length <= 250_000 ? [] : undefined;
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      index = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      index = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (text.startsWith('{{', index)) {
      index = skipExpression(text, index);
    } else if (text[index] === '<' && (/[A-Za-z/]/.test(text[index + 1] ?? '') || index + 1 === text.length)) {
      const tag = readTag(text, index);
      if (parsed && parsed.length < 16_000) parsed.push(tag);
      else parsed = undefined;
      yield tag;
      index = Math.max(index + 1, tag.end);
      if (tag.name === 'wxs' && tag.closed && !tag.closing && !tag.selfClosing) {
        const closing = /<\/wxs(?=[\s>])/g;
        closing.lastIndex = index;
        index = closing.exec(text)?.index ?? text.length;
      }
    } else index++;
  }
  // 提前结束的扫描不会进入这里，避免把不完整结果当成完整文档。
  if (parsed) {
    const previous = tagCache.get(text);
    if (previous) {
      cachedCharacters -= text.length;
      cachedTags -= previous.length;
      tagCache.delete(text);
    }
    tagCache.set(text, parsed);
    cachedCharacters += text.length;
    cachedTags += parsed.length;
    while (tagCache.size > 8 || cachedCharacters > 1_000_000 || cachedTags > 20_000) {
      const oldest = tagCache.keys().next().value!;
      cachedCharacters -= oldest.length;
      cachedTags -= tagCache.get(oldest)!.length;
      tagCache.delete(oldest);
    }
  }
}

/** 光标位于标签名称或属性时返回词法结果，未闭合标签支持末尾补全。 */
export function tagAt(text: string, offset: number): TagToken | undefined {
  if (offset < 0 || offset > text.length) return undefined;
  for (const tag of scanTags(text)) {
    if (tag.start > offset) break;
    if (offset >= tag.nameRange.start && (tag.closed ? offset < tag.end : offset <= tag.end)) return tag;
  }
  return undefined;
}
