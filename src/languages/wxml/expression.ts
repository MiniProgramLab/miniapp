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

/** 同文快照共享表达式和循环作用域，缓存按文本核对并限制总量。 */
const expressionCache = new Map<string, readonly TemplateExpression[]>();
let expressionCharacters = 0;

/** 卸载语言功能时释放文档索引。 */
export function clearExpressionCache(): void { expressionCache.clear(); expressionCharacters = 0; }

/** 一次扫描收集全部表达式，避免诊断按每个光标从头解析。 */
export function templateExpressions(text: string): readonly TemplateExpression[] {
  const cached = expressionCache.get(text);
  if (cached) { expressionCache.delete(text); expressionCache.set(text, cached); return cached; }
  const stack: TagToken[] = [], expressions: TemplateExpression[] = [];
  /** 属性和正文使用相同的插值边界与循环作用域。 */
  const collect = (start: number, end: number, tags: readonly TagToken[], objectLiteral = false): void => {
    for (let cursor = text.indexOf('{{', start); cursor >= start && cursor < end;) {
      const close = skipExpression(text, cursor);
      const range = { start: cursor + 2, end: Math.min(end, text.slice(close - 2, close) === '}}' ? close - 2 : close) };
      expressions.push({ text: text.slice(range.start, range.end), range, bindings: bindingsAt(text, tags, range.start), ...(objectLiteral ? { objectLiteral: true } : {}) });
      cursor = text.indexOf('{{', Math.max(cursor + 2, close));
    }
  };
  for (let cursor = 0; cursor < text.length;) {
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      cursor = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('{{', cursor)) {
      const end = skipExpression(text, cursor);
      collect(cursor, end, stack); cursor = end;
    } else if (text[cursor] === '<' && /[A-Za-z/]/.test(text[cursor + 1] ?? '')) {
      const tag = readTag(text, cursor);
      if (tag.closing) {
        const index = stack.map((item) => item.name).lastIndexOf(tag.name);
        if (index >= 0) stack.splice(index);
      } else {
        const tags = [...stack, tag];
        for (const attribute of tag.attributes) {
          const range = attribute.valueRange;
          if (!range) continue;
          collect(range.start, range.end, tags, tag.name === 'template' && attribute.name === 'data');
          if (/^(?:(?:capture-|mut-)?(?:bind|catch):?[\w-]+|worklet:[\w-]+)$/.test(attribute.name)) {
            const value = text.slice(range.start, range.end);
            if (/^\s*(?:[$\p{ID_Start}_][$\p{ID_Continue}]*(?:\.[$\p{ID_Start}_][$\p{ID_Continue}]*)*\.?)?\s*$/u.test(value)) expressions.push({ text: value, range, bindings: bindingsAt(text, tags, range.start), event: true });
          }
        }
        if (!tag.selfClosing && tag.name === 'wxs') {
          const end = text.indexOf('</wxs', tag.end);
          cursor = end < 0 ? text.length : end; continue;
        }
        if (!tag.selfClosing) stack.push(tag);
      }
      cursor = Math.max(cursor + 1, tag.end);
    } else cursor++;
  }
  expressions.sort((a, b) => a.range.start - b.range.start);
  if (text.length <= 250_000 && expressions.length <= 16_000) {
    expressionCache.set(text, expressions); expressionCharacters += text.length;
    while (expressionCache.size > 8 || expressionCharacters > 1_000_000) {
      const oldest = expressionCache.keys().next().value!;
      expressionCharacters -= oldest.length; expressionCache.delete(oldest);
    }
  }
  return expressions;
}

/** 二分定位当前表达式，右边界保留选中名称后的导航行为。 */
export function expressionAt(text: string, offset: number): TemplateExpression | undefined {
  const expressions = templateExpressions(text);
  let low = 0, high = expressions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expressions[middle]!.range.start <= offset) low = middle + 1; else high = middle;
  }
  const expression = expressions[low - 1];
  return expression && offset <= expression.range.end ? expression : undefined;
}
