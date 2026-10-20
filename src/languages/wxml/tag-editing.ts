import type { LanguageRequest, LinkedEditing } from '../../api';
import { scanTags } from './parser';
import type { TagToken } from './parser';
import { structure } from './structure';

/** 名称字符与词法解析保持一致，自定义组件的连字符参与联动。 */
const tagWordPattern = '[A-Za-z0-9_:.-]+';

/** 为结束标签选择光标之前最近一个尚未闭合的开始标签。 */
export function nearestOpenTag(text: string, before: number): TagToken | undefined {
  const stack: TagToken[] = [];
  for (const tag of scanTags(text)) {
    if (tag.start >= before) break;
    if (!tag.closed || !tag.name || tag.selfClosing) continue;
    if (!tag.closing) stack.push(tag);
    else {
      let index = stack.length - 1;
      while (index >= 0 && stack[index]!.name !== tag.name) index--;
      if (index >= 0) stack.splice(index);
    }
  }
  return stack.at(-1);
}

/** 返回成对标签的名称范围，属性及原始脚本中的同名文本不会被修改。 */
export function provideLinkedTags(request: LanguageRequest): LinkedEditing | undefined {
  if (request.cancellation.isCancellationRequested || request.document.text.length > 2_000_000) return undefined;
  const index = structure(request.document.text, request.cancellation);
  if (!index) return undefined;
  const { tags, pairs } = index;
  const tag = tags.find((item) => request.offset >= item.nameRange.start && request.offset <= item.nameRange.end);
  const partner = tag && pairs.get(tag.start);
  if (!tag || !partner) return undefined;
  return { ranges: [tag.nameRange, partner.nameRange].sort((left, right) => left.start - right.start), wordPattern: tagWordPattern };
}

/** 输入大于号后补足缺失的结束标签，保留已有闭合及外层同名标签。 */
export function provideAutoClosingTag(request: LanguageRequest): string | undefined {
  const { text } = request.document;
  if (request.cancellation.isCancellationRequested || text.length > 2_000_000 || text[request.offset - 1] !== '>') return undefined;
  const index = structure(text, request.cancellation);
  if (!index) return undefined;
  const { tags, pairs, unclosed } = index;
  const tag = tags.find((item) => item.end === request.offset && item.closed && !item.closing && !item.selfClosing && item.name);
  if (!tag) return undefined;
  // 外层同名标签缺少配对时，已有结束标签属于外层，仍需补齐当前新标签。
  if (pairs.has(tag.start) && !unclosed.some((item) => item.start < tag.start && item.name === tag.name)) return undefined;
  return `</${tag.name}>`;
}
