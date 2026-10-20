import type { LanguageRequest, TextRange } from '../../api';
import { maskExpressions, skipExpression, tagAt } from './parser';

/** 当前类名保留完整文本、输入前缀和原始替换范围。 */
export interface ClassToken {
  readonly name: string;
  readonly prefix: string;
  readonly range: TextRange;
}

/** 跳过字符串及转义字符，返回闭合引号之后的位置。 */
function skipString(text: string, start: number, end: number): number {
  for (let index = start + 1; index < end; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === text[start]) return index + 1;
  }
  return end;
}

/** 沿表达式返回值查找字符串，条件、下标和拼接片段不作为完整类名。 */
function returnedStringAt(text: string, start: number, end: number, offset: number): TextRange | undefined {
  while (start < end) {
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (offset < start || offset >= end) return undefined;
    if ((text[start] === '"' || text[start] === "'") && skipString(text, start, end) === end && text[end - 1] === text[start]) {
      // 转义会改变类名及来源偏移，暂不推断带转义的字符串。
      if (text.slice(start + 1, end - 1).includes('\\')) return undefined;
      return { start: start + 1, end: end - 1 };
    }
    let depth = 0;
    let parenthesesEnd = -1;
    let question = -1;
    let colon = -1;
    let conditionalDepth = 0;
    let logical = -1;
    let conjunction = -1;
    for (let index = start; index < end; index++) {
      const character = text[index];
      if (character === '"' || character === "'" || character === '`') {
        index = skipString(text, index, end) - 1;
      } else if (text.startsWith('/*', index)) {
        const close = text.indexOf('*/', index + 2);
        index = close < 0 ? end : close + 1;
      } else if (text.startsWith('//', index)) {
        const close = text.indexOf('\n', index + 2);
        index = close < 0 ? end : close;
      } else if (character === '(' || character === '[' || character === '{') depth++;
      else if (character === ')' || character === ']' || character === '}') {
        depth--;
        if (depth === 0 && text[start] === '(' && parenthesesEnd < 0) parenthesesEnd = index + 1;
      } else if (depth === 0) {
        if (text.startsWith('||', index) || text.startsWith('??', index)) { logical = index; index++; }
        else if (text.startsWith('&&', index)) { conjunction = index; index++; }
        else if (character === '?' && text[index + 1] !== '.') {
          if (question < 0) question = index;
          conditionalDepth++;
        } else if (character === ':' && conditionalDepth > 0 && --conditionalDepth === 0) { colon = index; break; }
      }
    }
    // 只进入光标所在的返回分支，避免条件中的字符串产生样式跳转。
    if (question >= 0 && colon >= 0) {
      if (offset > question && offset < colon) { start = question + 1; end = colon; }
      else if (offset > colon) start = colon + 1;
      else return undefined;
    } else if (logical >= 0 || conjunction >= 0) {
      const operator = logical >= 0 ? logical : conjunction;
      if (offset > operator + 1) start = operator + 2;
      else if (logical >= 0 && offset < operator) end = operator;
      else return undefined;
    } else if (parenthesesEnd === end) { start++; end--; }
    else return undefined;
  }
  return undefined;
}

/** 定位静态 class 或表达式返回字符串中的类名，空词元可用于补全。 */
export function classTokenAt(request: LanguageRequest): ClassToken | undefined {
  if (request.cancellation.isCancellationRequested) return undefined;
  const tag = tagAt(request.document.text, request.offset);
  if (!tag || tag.closing) return undefined;
  const attribute = tag.attributes.find((item) => item.name === 'class' && item.valueRange && request.offset >= item.valueRange.start && request.offset <= item.valueRange.end);
  if (!attribute?.valueRange) return undefined;
  const value = request.document.text.slice(attribute.valueRange.start, attribute.valueRange.end);
  const offset = request.offset - attribute.valueRange.start;
  let classText = maskExpressions(value);
  let base = 0;
  for (let start = value.indexOf('{{'); start >= 0;) {
    const end = skipExpression(value, start);
    if (offset >= start && offset < end) {
      const range = returnedStringAt(value, start + 2, value.slice(end - 2, end) === '}}' ? end - 2 : end, offset);
      if (!range) return undefined;
      classText = value.slice(range.start, range.end);
      base = range.start;
      break;
    }
    start = value.indexOf('{{', end);
  }
  const cursor = offset - base;
  if (cursor < 0 || cursor > classText.length) return undefined;
  let start = cursor;
  let end = cursor;
  // 补全只替换光标所在词元，保留同一字符串里的其他类名。
  while (start > 0 && !/\s/.test(classText[start - 1]!)) start--;
  while (end < classText.length && !/\s/.test(classText[end]!)) end++;
  const absolute = attribute.valueRange.start + base;
  return { name: classText.slice(start, end), prefix: classText.slice(start, cursor), range: { start: absolute + start, end: absolute + end } };
}
