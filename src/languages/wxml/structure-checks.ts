import type { CodeAction, Diagnostic, LanguageRequest, TextEdit, TextRange, WorkspaceReader } from '../../api';
import type { AttributeToken, TagToken } from './parser';
import { structure } from './structure';
import type { StructureNode } from './structure';

/** 完整属性范围包含成对引号，删除时只吸收标签内部的前导空白。 */
function attributeRange(text: string, tag: TagToken, attribute: AttributeToken): TextRange {
  let start = attribute.range.start, end = attribute.valueRange?.end ?? attribute.range.end;
  if (attribute.valueRange && ['"', "'"].includes(text[attribute.valueRange.start - 1] ?? '') && text[end] === text[attribute.valueRange.start - 1]) end++;
  while (start > tag.nameRange.end && /\s/.test(text[start - 1]!)) start--;
  return { start, end };
}

/** 独占一行时沿用开始标签缩进；同行内容只补标签，不重排正文。 */
function closingEdit(text: string, tags: readonly TagToken[], offset: number): { range: TextRange; newText: string } {
  const line = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  const indentation = text.slice(line, offset), newline = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  if (/^\s*$/.test(indentation)) {
    const newText = tags.map((tag) => {
      const start = Math.max(text.lastIndexOf('\n', tag.start - 1), text.lastIndexOf('\r', tag.start - 1)) + 1;
      const prefix = text.slice(start, tag.start);
      return (/^[\t ]*$/.test(prefix) ? prefix : indentation) + `</${tag.name}>`;
    }).join(newline) + newline;
    return { range: { start: line, end: line }, newText };
  }
  return { range: { start: offset, end: offset }, newText: tags.map((tag) => `</${tag.name}>`).join('') };
}

/** 结构诊断与灯泡共享已有索引；只为当前选区生成带快照保护的编辑。 */
export function structureChecks(request: LanguageRequest, selected?: TextRange, navigation?: Pick<NonNullable<WorkspaceReader['navigation']>, 'record'>): { diagnostics: Diagnostic[]; actions: CodeAction[] } {
  const diagnostics: Diagnostic[] = [], actions: CodeAction[] = [], text = request.document.text;
  const index = structure(text, request.cancellation);
  if (!index) {
    if (!request.cancellation.isCancellationRequested) navigation?.record({ code: 'budget', message: 'WXML 结构超过文本、记录或嵌套预算，未完成结构检查。', uri: request.document.uri });
    return { diagnostics, actions };
  }
  /** 修复按明确意图命名，无法确定条件或列表标识时只报告问题。 */
  const report = (range: TextRange, code: string, message: string, severity: Diagnostic['severity'], fixes?: () => readonly { title: string; range: TextRange; newText: string }[]): void => {
    diagnostics.push({ range, code, message, severity });
    if (!selected || selected.start > range.end || selected.end < range.start) return;
    for (const fix of fixes?.() ?? []) {
      const edit: TextEdit = { uri: request.document.uri, range: fix.range, newText: fix.newText, oldText: text.slice(fix.range.start, fix.range.end), expectedText: text, ...(request.document.version === undefined ? {} : { version: request.document.version }) };
      actions.push({ title: fix.title, kind: 'quickfix', range, edits: [edit] });
    }
  };
  /** 条件链之间的注释和处理指令不产生渲染节点。 */
  const trivia = (start: number, end: number): boolean => !text.slice(start, end).replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '').trim();
  const stack: TagToken[] = [], affected = new Set<TagToken>();
  for (const tag of index.tags) {
    if (request.cancellation.isCancellationRequested) return { diagnostics: [], actions: [] };
    if (!tag.closed || !tag.name) continue;
    if (tag.closing) {
      if (tag.selfClosing) report(tag.nameRange, 'wxml-invalid-close', '结束标签不能使用自闭合写法。', 'error', () => [{ title: '移除结束标签的自闭合斜线', range: { start: tag.end - 2, end: tag.end - 1 }, newText: '' }]);
      const expected = stack.at(-1);
      let match = stack.length - 1;
      while (match >= 0 && stack[match]!.name !== tag.name) match--;
      if (!expected) report(tag.nameRange, 'wxml-unexpected-close', `结束标签 </${tag.name}> 没有对应的开始标签。`, 'error', () => [{ title: `删除多余的结束标签 </${tag.name}>`, range: { start: tag.start, end: tag.end }, newText: '' }]);
      else if (match === stack.length - 1) stack.pop();
      else if (match >= 0) {
        const missing = stack.slice(match + 1).reverse();
        report(tag.nameRange, 'wxml-mismatched-tag', `</${tag.name}> 前缺少 </${missing[0]!.name}> 等结束标签。`, 'error', () => [{ title: '补齐此处缺失的结束标签', ...closingEdit(text, missing, tag.start) }]);
        stack.splice(match);
      } else {
        affected.add(expected);
        report(tag.nameRange, 'wxml-mismatched-tag', `此处应结束 <${expected.name}>，实际为 </${tag.name}>。`, 'error', () => [
          { title: `将结束标签改为 </${expected.name}>`, range: tag.nameRange, newText: expected.name },
          { title: `删除多余的结束标签 </${tag.name}>`, range: { start: tag.start, end: tag.end }, newText: '' },
        ]);
      }
      continue;
    }
    if (!tag.selfClosing) {
      if (stack.length >= 256) {
        navigation?.record({ code: 'budget', message: '错误恢复后的 WXML 嵌套超过二百五十六层，未完成结构检查。', uri: request.document.uri });
        return { diagnostics: [], actions: [] };
      }
      stack.push(tag);
    }
    const attributes = new Map<string, AttributeToken>();
    for (const attribute of tag.attributes) {
      if (attributes.has(attribute.name)) report(attribute.range, 'wxml-duplicate-attribute', `属性 ${attribute.name} 重复声明。`, 'warning', () => [{ title: `删除重复属性 ${attribute.name}（保留首个）`, range: attributeRange(text, tag, attribute), newText: '' }]);
      else attributes.set(attribute.name, attribute);
    }
    const key = attributes.get('wx:key');
    if (!key) continue;
    const value = key.valueRange ? text.slice(key.valueRange.start, key.valueRange.end) : '';
    if (!attributes.has('wx:for')) report(key.range, 'wxml-invalid-key', 'wx:key 仅对同一标签上的 wx:for 生效。', 'warning', () => [{ title: '删除没有 wx:for 的 wx:key', range: attributeRange(text, tag, key), newText: '' }]);
    else if (!value.trim() || value.includes('{{')) {
      const item = attributes.get('wx:for-item'), alias = item?.valueRange ? text.slice(item.valueRange.start, item.valueRange.end) : 'item';
      const member = value.match(/^\{\{\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*\.\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*\}\}$/u);
      const field = member?.[1] === alias ? member[2] : undefined;
      report(key.valueRange ?? key.range, 'wxml-invalid-key', 'wx:key 应填写列表项的静态属性名或 *this，无需使用 {{ }}，也不能留空。', 'warning', field && key.valueRange ? () => [{ title: `将 wx:key 改为静态属性 ${field}`, range: key.valueRange!, newText: field }] : undefined);
    }
  }
  // 标签、插值或注释尚在输入时，不对外层节点产生尾部级联错误。
  const tail = index.spans.at(-1);
  const incomplete = index.tags.some((tag) => !tag.closed) || tail && tail.range.end === text.length && !text.endsWith(tail.kind === 'comment' ? '-->' : tail.kind === 'cdata' ? ']]>' : '}}');
  if (!incomplete) for (const opening of stack) if (!affected.has(opening)) report(opening.nameRange, 'wxml-unclosed-tag', `未找到 <${opening.name}> 的结束标签。`, 'error', () => [{ title: '补齐文件末尾缺失的结束标签', ...closingEdit(text, [...stack].reverse(), text.length) }]);
  /** 每个父节点独立维护条件链，WXS 透明但其前后的真实文本仍会打断分支。 */
  const previous = new Map<StructureNode | undefined, { end: number; chain: boolean | undefined }>();
  for (const node of index.nodes) {
    if (request.cancellation.isCancellationRequested) return { diagnostics: [], actions: [] };
    const tag = node.opening, prior = previous.get(node.parent);
    if (tag.name === 'wxs' && tag.closed && (tag.selfClosing || node.closing)) {
      if (prior) previous.set(node.parent, { ...prior, end: node.range.end, chain: prior.chain && trivia(prior.end, tag.start) });
      continue;
    }
    const conditions = [...new Map(tag.attributes.filter((attribute) => ['wx:if', 'wx:elif', 'wx:else'].includes(attribute.name)).map((attribute) => [attribute.name, attribute])).values()];
    const condition = conditions[0], adjacent = !!prior?.chain && trivia(prior.end, tag.start);
    if (tag.closed && conditions.length > 1) for (const extra of conditions.slice(1)) report(extra.range, 'wxml-conditional-conflict', '同一节点只能使用一个 wx:if、wx:elif 或 wx:else。', 'error', () => [{ title: `删除 ${extra.name}（保留首个条件 ${condition!.name}）`, range: attributeRange(text, tag, extra), newText: '' }]);
    else if (tag.closed && condition && condition.name !== 'wx:if' && !adjacent && (!prior || prior.chain !== undefined)) report(condition.range, 'wxml-orphan-conditional', `${condition.name} 必须紧跟同级的 wx:if 或 wx:elif 分支。`, 'error', condition.name === 'wx:elif' && condition.valueRange ? () => [{ title: '将孤立的 wx:elif 改为 wx:if', range: condition.range, newText: 'wx:if' }] : undefined);
    previous.set(node.parent, { end: node.range.end, chain: !tag.closed || !tag.selfClosing && !node.closing ? undefined : conditions.length <= 1 && (condition?.name === 'wx:if' || condition?.name === 'wx:elif' && adjacent) });
  }
  return { diagnostics, actions: [...new Map(actions.map((action) => [JSON.stringify([action.title, action.edits]), action])).values()] };
}
