import ts from 'typescript';
import type { TextEdit, TextRange, WorkspaceText } from '../api';

/** 数组迁移保留原表达式与注释，新增页面使用确定的本地路径字符串。 */
export interface RegistrationMove {
  readonly from: { readonly uri: string; readonly range: TextRange; readonly item: TextRange };
  readonly to: { readonly uri: string; readonly range: TextRange };
  readonly value: string;
}

/** 数组编辑合并内部字段更新，避免产生覆盖原生工作区编辑的重叠范围。 */
export async function registrationEdits(read: (uri: string) => Promise<WorkspaceText | undefined>, moves: readonly RegistrationMove[], edits: readonly TextEdit[]): Promise<readonly TextEdit[]> {
  const groups = new Map<string, { uri: string; range: TextRange; removals: TextRange[]; additions: string[] }>();
  const comments = new Map<string, string>();
  /** 移动页面的说明随注册项迁移，普通缩进由目标数组决定。 */
  for (const move of moves) {
    const document = await read(move.from.uri);
    if (!document) throw new Error('页面注册项源码已不可读取。');
    const source = ts.createSourceFile(move.from.uri, document.text, ts.ScriptTarget.Latest, true, /\.jsonc?$/i.test(move.from.uri) ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
    let trivia = '';
    /** 精确表达式定位避免把前一项的尾注释误当作当前页面说明。 */
    const visit = (node: ts.Node): void => {
      if (node.getStart(source) > move.from.item.start || node.end < move.from.item.end) return;
      if (node.getStart(source) === move.from.item.start && node.end === move.from.item.end) trivia = document.text.slice(node.getFullStart(), node.getStart(source));
      else ts.forEachChild(node, visit);
    };
    visit(source);
    if (/\/\*|\/\//.test(trivia)) comments.set(`${move.to.uri}:${move.to.range.start}:${move.value}`, trivia.trimStart());
  }
  /** 同一数组中的多项迁移只产生一次完整编辑。 */
  const group = (uri: string, range: TextRange) => {
    const key = `${uri}:${range.start}:${range.end}`;
    let result = groups.get(key);
    if (!result) { result = { uri, range, removals: [], additions: [] }; groups.set(key, result); }
    return result;
  };
  for (const move of moves) { group(move.from.uri, move.from.range).removals.push(move.from.item); group(move.to.uri, move.to.range).additions.push(move.value); }
  const result = [...edits];
  for (const item of groups.values()) {
    const document = await read(item.uri);
    if (!document) throw new Error('页面注册数组源码已不可读取。');
    const source = ts.createSourceFile(item.uri, document.text, ts.ScriptTarget.Latest, true, /\.jsonc?$/i.test(item.uri) ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
    let array: ts.ArrayLiteralExpression | undefined;
    /** 精确数组范围来自路由端口，普通同名字段不会参与迁移。 */
    const visit = (node: ts.Node): void => {
      if (node.getStart(source) > item.range.start || node.end < item.range.end) return;
      if (ts.isArrayLiteralExpression(node) && node.getStart(source) === item.range.start && node.end === item.range.end) array = node;
      else ts.forEachChild(node, visit);
    };
    visit(source);
    if (!array || array.elements.some(ts.isSpreadElement)) throw new Error('注册数组不是可完整编辑的静态数组。');
    const nested = result.filter((edit) => edit.uri === item.uri && edit.range.start >= item.range.start && edit.range.end <= item.range.end);
    for (const removal of item.removals) if (!array.elements.some((element) => element.getStart(source) === removal.start && element.end === removal.end)) throw new Error('待迁移页面已不属于原注册数组。');
    const chunks = array.elements.filter((element) => !item.removals.some((removal) => removal.start === element.getStart(source) && removal.end === element.end)).map((element) => {
      let text = document.text.slice(element.getFullStart(), element.end);
      for (const edit of nested.filter((edit) => edit.range.start >= element.getFullStart() && edit.range.end <= element.end).sort((left, right) => right.range.start - left.range.start)) text = text.slice(0, edit.range.start - element.getFullStart()) + edit.newText + text.slice(edit.range.end - element.getFullStart());
      return text;
    });
    const original = document.text.slice(item.range.start, item.range.end);
    const newline = document.text.includes('\r\n') ? '\r\n' : '\n';
    const multiline = original.includes('\n');
    const last = array.elements.at(-1);
    const trailing = document.text.slice(last?.end ?? item.range.start + 1, item.range.end - 1).replace(/^(\s*),/, '$1');
    const first = array.elements[0];
    const line = first ? document.text.lastIndexOf('\n', first.getStart(source) - 1) + 1 : document.text.lastIndexOf('\n', item.range.start) + 1;
    const indent = document.text.slice(line, first?.getStart(source) ?? item.range.start).match(/^[\t ]*/)?.[0] ?? '';
    for (const value of item.additions) chunks.push((multiline ? newline + indent + (first ? '' : '  ') : chunks.length ? ' ' : '') + (comments.get(`${item.uri}:${item.range.start}:${value}`) ?? '') + JSON.stringify(value));
    const text = '[' + chunks.join(',') + (chunks.length && array.elements.hasTrailingComma ? ',' : '') + trailing + ']';
    for (const edit of nested) result.splice(result.indexOf(edit), 1);
    result.push({ uri: item.uri, range: item.range, oldText: original, newText: text, ...(document.version === undefined ? {} : { version: document.version }) });
  }
  return result;
}
