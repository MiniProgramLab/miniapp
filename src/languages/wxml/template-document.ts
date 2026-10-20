import type { TextRange } from '../../api';
import { bindingsAt, interpolation } from './expression';
import { readTag, skipExpression } from './parser';
import type { TagToken } from './parser';

/** 模板节点记录完整范围，用于隔离命名模板与循环作用域。 */
export interface TemplateNode {
  readonly tag: TagToken;
  end: number;
}

/** 保留模板结构而不执行表达式，忽略注释和 WXS 中的伪标签。 */
export function templateNodes(text: string): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  const stack: TemplateNode[] = [];
  for (let cursor = 0; cursor < text.length;) {
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      cursor = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('{{', cursor)) cursor = skipExpression(text, cursor);
    else if (text[cursor] === '<' && /[A-Za-z/]/.test(text[cursor + 1] ?? '')) {
      const tag = readTag(text, cursor);
      if (tag.closing) {
        let index = stack.length - 1;
        while (index >= 0 && stack[index]!.tag.name !== tag.name) index--;
        if (index >= 0) for (const node of stack.splice(index)) node.end = tag.end;
      } else {
        const node: TemplateNode = { tag, end: tag.selfClosing ? tag.end : text.length };
        nodes.push(node);
        if (!tag.selfClosing && tag.name === 'wxs') {
          const end = text.indexOf('</wxs', tag.end);
          cursor = end < 0 ? text.length : end;
          node.end = cursor;
          continue;
        }
        if (!tag.selfClosing) stack.push(node);
      }
      cursor = Math.max(cursor + 1, tag.end);
    } else cursor++;
  }
  return nodes;
}

/** 取得静态属性；动态名称不作为引用图的确定边。 */
export function attribute(text: string, node: TemplateNode, name: string): string | undefined {
  const range = node.tag.attributes.find((item) => item.name === name)?.valueRange;
  if (!range) return undefined;
  const value = text.slice(range.start, range.end);
  return value.includes('{{') ? undefined : value.trim();
}

/** 找到当前位置所属的命名模板；顶层内容返回空值。 */
export function ownerAt(text: string, nodes: readonly TemplateNode[], offset: number): TemplateNode | undefined {
  return nodes.filter((node) => node.tag.name === 'template' && attribute(text, node, 'name') !== undefined && offset >= node.tag.end && offset < node.end).at(-1);
}

/** 只保留当前命名模板内部的循环，避免定义位置的外层循环泄漏。 */
export function localBindings(text: string, nodes: readonly TemplateNode[], offset: number) {
  const owner = ownerAt(text, nodes, offset);
  const tags = nodes.filter((node) => node.tag.start <= offset && offset < node.end && (!owner || node.tag.start >= owner.tag.start)).map((node) => node.tag);
  return bindingsAt(text, tags, offset);
}

/** 读取 template data 的表达式文本和在调用文件中的原始范围。 */
export function templateData(text: string, node: TemplateNode): { text: string; range: TextRange } {
  const value = node.tag.attributes.find((item) => item.name === 'data')?.valueRange;
  const range = value && interpolation(text, value);
  return range ? { text: text.slice(range.start, range.end), range } : { text: '', range: { start: node.tag.start, end: node.tag.start } };
}
