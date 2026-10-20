import type { LanguageRequest, TextEdit, TextRange } from '../../api';

/** 自由引用由脚本语法解析及模板作用域确认，不能按全文替换同名局部变量。 */
export interface DataUse {
  readonly name: string;
  readonly uri: string;
  readonly range: TextRange;
  readonly shorthand?: boolean;
}

/** 保留常用属性名，大写及特殊名称使用可稳定转换的属性别名。 */
export function componentData(request: LanguageRequest, range: TextRange, fields: readonly string[], uses: readonly DataUse[]) {
  const names = [...new Set(fields)];
  if (names.length > 256) throw new Error('组件提取超过二百五十六个数据字段，请缩小选区。');
  const reserved = new Set(names.filter((name) => /^[a-z_][\w]*$/.test(name))), assigned = new Set<string>();
  const bindings = names.map((name, index) => {
    const readable = name.replace(/^[A-Z]+(?=[A-Z][a-z]|$)/, (prefix) => prefix.toLowerCase()).replace(/^[A-Z]/, (prefix) => prefix.toLowerCase());
    const base = /^[a-z_][\w]*$/.test(readable) ? readable : 'field' + index;
    let property = base, suffix = 1;
    while (assigned.has(property) || property !== name && reserved.has(property)) property = base + ++suffix;
    assigned.add(property);
    return { name, property, attribute: property.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()) };
  });
  const aliases = new Map(bindings.map((binding) => [binding.name, binding.property]));
  const edits = new Map<string, TextEdit>();
  for (const use of uses) {
    if (use.uri !== request.document.uri || use.range.start < range.start || use.range.end > range.end) continue;
    const alias = aliases.get(use.name);
    if (!alias || request.document.text.slice(use.range.start, use.range.end) !== use.name) throw new Error('数据引用快照已变化，不能生成部分组件迁移。');
    const key = use.range.start + ':' + use.range.end;
    if (alias === use.name) continue;
    const replacement = use.shorthand ? use.name + ': ' + alias : alias;
    const previous = edits.get(key);
    if (previous && previous.newText !== replacement) throw new Error('数据引用存在不一致的契约，请重新发起提取。');
    edits.set(key, { uri: use.uri, range: use.range, oldText: use.name, newText: replacement, version: request.document.version, expectedText: request.document.text });
  }
  return { bindings, edits: [...edits.values()] };
}
