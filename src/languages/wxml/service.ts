import type { Completion, Hover, LanguageRequest, TextRange } from '../../api';
import { attributesFor, documentation, tags } from './catalog';
import type { AttributeData, TagData } from './catalog';
import { scanTags, tagAt } from './parser';
import { nearestOpenTag } from './tag-editing';

/** 光标可位于名称末尾，完整替换范围仍保留名称后半部分。 */
function contains(range: TextRange, offset: number): boolean {
  return offset >= range.start && offset <= range.end;
}

/** 标签、属性和固定值补全，不猜测脚本表达式类型。 */
export function provideCompletions(request: LanguageRequest, autoClosingTags = true, componentAttributes: readonly AttributeData[] = [], componentTags: readonly TagData[] = []): readonly Completion[] {
  if (request.cancellation.isCancellationRequested) return [];
  const { text } = request.document;
  const { offset } = request;
  const tag = tagAt(text, offset);
  if (!tag) return [];
  if (contains(tag.nameRange, offset)) {
    const prefix = text.slice(tag.nameRange.start, offset);
    if (tag.closing) {
      const opening = nearestOpenTag(text, tag.start);
      if (opening?.name.startsWith(prefix)) return [{
        label: opening.name, kind: 'tag', detail: '闭合当前标签', documentation: `闭合 <${opening.name}>。`,
        insertText: opening.name + (tag.closed ? '' : '>'), range: tag.nameRange,
      }];
    }
    const candidates = new Map([...tags, ...componentTags].map((item) => [item.name, documentation(item)]));
    for (const item of scanTags(text)) if (item.closed && !item.closing && item.name && !candidates.has(item.name)) candidates.set(item.name, '当前文档中使用的自定义组件。');
    const pair = autoClosingTags && !tag.closing && !tag.closed && tag.nameRange.end === tag.end;
    return [...candidates].filter(([name]) => name.startsWith(prefix)).map(([name, description]) => ({
      label: name, kind: 'tag', detail: 'WXML 组件', documentation: description,
      insertText: pair ? `${name}>$0</${name}>` : name, insertTextFormat: pair ? 'snippet' : 'plain', range: tag.nameRange,
    }));
  }
  if (tag.closing) return [];
  const attributes = [...new Map([...attributesFor(tag.name), ...componentAttributes].map((attribute) => [attribute.name, attribute])).values()];
  const value = tag.attributes.find((attribute) => attribute.valueRange && contains(attribute.valueRange, offset));
  if (value?.valueRange) {
    const prefix = text.slice(value.valueRange.start, offset);
    if (prefix.includes('{{')) return [];
    const data = attributes.find((attribute) => attribute.name === value.name);
    return (data?.values ?? []).filter((item) => item.startsWith(prefix)).map((item) => ({
      label: item, kind: 'value', detail: data!.type, documentation: [data!.valueDescriptions?.[item], documentation(data!)].filter(Boolean).join('\n'),
      insertText: item, range: value.valueRange!,
    }));
  }
  const current = tag.attributes.find((attribute) => contains(attribute.range, offset));
  // 仅在名称内或纯空白间隙提供属性，避免在赋值符附近插入重复属性。
  if (!current) {
    const previousEnd = Math.max(tag.nameRange.end, ...tag.attributes
      .filter((attribute) => (attribute.valueRange?.end ?? attribute.range.end) < offset)
      .map((attribute) => attribute.valueRange ? attribute.valueRange.end + (/["']/.test(text[attribute.valueRange.end] ?? '') ? 1 : 0) : attribute.range.end));
    if (!/^\s+$/.test(text.slice(previousEnd, offset))) return [];
  }
  const range = current?.range ?? { start: offset, end: offset };
  const prefix = text.slice(range.start, offset);
  const used = new Set(tag.attributes.filter((attribute) => attribute !== current).map((attribute) => attribute.name));
  return attributes.filter((attribute) => !used.has(attribute.name) && attribute.name.startsWith(prefix)).map((attribute) => ({
    label: attribute.name, kind: 'attribute', detail: attribute.type, documentation: documentation(attribute),
    insertText: current?.assigned || attribute.boolean ? attribute.name : `${attribute.name}="\${1}"`,
    insertTextFormat: current?.assigned || attribute.boolean ? 'plain' : 'snippet', range,
  }));
}

/** 标签和属性共用同一目录，补全文案与悬浮说明保持一致。 */
export function provideHover(request: LanguageRequest, componentAttributes: readonly AttributeData[] = [], componentTags: readonly TagData[] = []): Hover | undefined {
  if (request.cancellation.isCancellationRequested) return undefined;
  const tag = tagAt(request.document.text, request.offset);
  if (!tag) return undefined;
  if (request.offset >= tag.nameRange.start && request.offset < tag.nameRange.end) {
    const data = [...componentTags, ...tags].find((item) => item.name === tag.name);
    return data ? { title: `<${data.name}>`, description: documentation(data), range: tag.nameRange } : undefined;
  }
  if (tag.closing) return undefined;
  const attribute = tag.attributes.find((item) => request.offset >= item.range.start && request.offset < item.range.end);
  const data = attribute && [...componentAttributes, ...attributesFor(tag.name)].find((item) => item.name === attribute.name);
  return data && attribute ? { title: `${data.name}: ${data.type}`, description: documentation(data), range: attribute.range } : undefined;
}
