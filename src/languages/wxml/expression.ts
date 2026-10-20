import type { TemplateBinding, TemplateExpression, TextRange } from '../../api';
import { readTag, skipExpression } from './parser';
import type { TagToken } from './parser';

/** 从属性插值取得循环集合，保留表达式本身的偏移。 */
export function interpolation(text: string, range: TextRange): TextRange | undefined {
  const start = text.indexOf('{{', range.start);
  if (start < 0 || start >= range.end) return undefined;
  const end = skipExpression(text, start);
  return { start: start + 2, end: Math.min(range.end, text.slice(end - 2, end) === '}}' ? end - 2 : end) };
}

/** 收集从外到内的循环变量，同一标签的集合表达式不引用自身绑定。 */
export function bindingsAt(text: string, tags: readonly TagToken[], offset: number): TemplateBinding[] {
  const bindings: TemplateBinding[] = [];
  for (const tag of tags) {
    const loop = tag.attributes.find((attribute) => attribute.name === 'wx:for');
    if (!loop?.valueRange || offset >= loop.valueRange.start && offset <= loop.valueRange.end) continue;
    const collection = interpolation(text, loop.valueRange);
    for (const kind of ['item', 'index'] as const) {
      const alias = tag.attributes.find((attribute) => attribute.name === `wx:for-${kind}`);
      const range = alias?.valueRange ?? loop.range;
      const name = alias?.valueRange ? text.slice(range.start, range.end).trim() : kind;
      if (!/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(name)) continue;
      bindings.push({ name, range, kind, ...(kind === 'item' && collection ? { collection: text.slice(collection.start, collection.end) } : {}) });
    }
  }
  return bindings;
}

/** 只识别模板插值与事件值；跳过注释及 WXS 原始脚本。 */
export function expressionAt(text: string, offset: number): TemplateExpression | undefined {
  const stack: TagToken[] = [];
  /** 在给定文本区间定位插值，不将普通字符串误判为脚本变量。 */
  const find = (start: number, end: number, tags: readonly TagToken[]): TemplateExpression | undefined => {
    for (let cursor = text.indexOf('{{', start); cursor >= start && cursor < end;) {
      const close = skipExpression(text, cursor);
      const range = { start: cursor + 2, end: Math.min(end, text.slice(close - 2, close) === '}}' ? close - 2 : close) };
      if (offset >= range.start && offset <= range.end) return { text: text.slice(range.start, range.end), range, bindings: bindingsAt(text, tags, offset) };
      cursor = text.indexOf('{{', Math.max(cursor + 2, close));
    }
    return undefined;
  };
  for (let cursor = 0; cursor < text.length && cursor <= offset;) {
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      cursor = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('{{', cursor)) {
      const end = skipExpression(text, cursor);
      const expression = find(cursor, end, stack);
      if (expression) return expression;
      cursor = end;
    } else if (text[cursor] === '<' && /[A-Za-z/]/.test(text[cursor + 1] ?? '')) {
      const tag = readTag(text, cursor);
      if (tag.closing) {
        const index = stack.map((item) => item.name).lastIndexOf(tag.name);
        if (index >= 0) stack.splice(index);
      } else {
        const tags = [...stack, tag];
        for (const attribute of tag.attributes) {
          const range = attribute.valueRange;
          // 完整选中方法或变量后，光标会停在值末尾，仍应进入原有声明链。
          if (!range || offset < range.start || offset > range.end) continue;
          const expression = find(range.start, range.end, tags);
          if (expression) return tag.name === 'template' && attribute.name === 'data'
            ? { ...expression, objectLiteral: true } : expression;
          if (/^(?:(?:capture-|mut-)?(?:bind|catch):?[\w-]+|worklet:[\w-]+)$/.test(attribute.name)) {
            const value = text.slice(range.start, range.end);
            if (/^\s*(?:[$\p{ID_Start}_][$\p{ID_Continue}]*(?:\.[$\p{ID_Start}_][$\p{ID_Continue}]*)*\.?)?\s*$/u.test(value)) {
              return { text: value, range, bindings: bindingsAt(text, tags, offset), event: true };
            }
          }
        }
        if (!tag.selfClosing && tag.name === 'wxs') {
          const end = text.indexOf('</wxs', tag.end);
          cursor = end < 0 ? text.length : end;
          continue;
        }
        if (!tag.selfClosing) stack.push(tag);
      }
      cursor = Math.max(cursor + 1, tag.end);
    } else cursor++;
  }
  return undefined;
}
