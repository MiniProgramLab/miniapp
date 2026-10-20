import type { LanguageRequest, StyleClassResolver, TextEdit, TextRange } from '../../api';
import { scanTags, skipExpression } from './parser';
import { scriptModules } from './wxs';
import { nativeTags } from './catalog';

/** 样式图由 CSS 模块提供，WXML 只负责外部类映射和模板属性改写。 */
type StyleGraph = Awaited<ReturnType<NonNullable<StyleClassResolver['extractionStyles']>>>;

/** 保持外层属性引号，静态片段使用另一种引号转为表达式字符串。 */
function quoted(value: string, outer: string): string {
  const quote = outer === "'" ? '"' : "'";
  return quote + value.replace(/\\/g, '\\\\').replaceAll(quote, '\\' + quote).replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + quote;
}

/** 先按原插值拼接完整 class，再映射词元，不能把拼接前缀误认为独立类名。 */
function fragments(value: string, outer: string): string[] {
  const result: string[] = [];
  let offset = 0;
  for (let start = value.indexOf('{{'); start >= 0; start = value.indexOf('{{', offset)) {
    const end = skipExpression(value, start);
    if (!value.slice(start, end).endsWith('}}')) throw new Error('class 插值未闭合，不能生成完整样式映射。');
    if (start > offset) result.push(quoted(value.slice(offset, start), outer));
    result.push('(' + value.slice(start + 2, end - 2) + ')'); offset = end;
  }
  if (offset < value.length) result.push(quoted(value.slice(offset), outer));
  return result;
}

/** 为选区生成外部类映射，保留样式优先级并避免属性名与数据字段冲突。 */
export function componentStyles(request: LanguageRequest, range: TextRange, graph: StyleGraph, external: readonly string[] = [], avoid: readonly string[] = []) {
  if (graph.issues.length) throw new Error(graph.issues.join('\n'));
  const text = request.document.text, attributes = [...scanTags(text)].filter((tag) => !tag.closing && tag.start >= range.start && tag.end <= range.end).flatMap((tag) => tag.attributes.filter((attribute) => attribute.valueRange && (attribute.name === 'class' || nativeTags.has(tag.name) && ['hover-class', 'placeholder-class'].includes(attribute.name))));
  const candidates = new Set([...graph.classes, ...external]);
  const dynamic = attributes.some((attribute) => text.slice(attribute.valueRange!.start, attribute.valueRange!.end).includes('{{'));
  const used = dynamic ? candidates : new Set(attributes.flatMap((attribute) => text.slice(attribute.valueRange!.start, attribute.valueRange!.end).split(/\s+/)).filter((name) => candidates.has(name)));
  if (used.size > 512) throw new Error('组件提取涉及超过五百一十二个样式类，请缩小样式依赖范围。');
  const bindings = [...used].map((name, index) => ({ name, alias: 'extract-style-' + index }));
  const aliases = new Map(bindings.map((binding) => [binding.name, binding.alias]));
  const modules = new Set([...scriptModules(request).map((module) => module.name), ...avoid]);
  // 具名模板的参数和局部循环同样不能被新模块遮蔽。
  for (const match of text.matchAll(/__extractStyles\d*/g)) modules.add(match[0]);
  let module = '__extractStyles', suffix = 0;
  while (modules.has(module)) module = '__extractStyles' + ++suffix;
  const edits: TextEdit[] = [];
  for (const attribute of attributes) {
    const part = attribute.valueRange!, original = text.slice(part.start, part.end);
    if (attribute.name === 'hover-class' && original === 'none') continue;
    const value = original.includes('{{') && bindings.length ? `{{${module}.map(${attribute.name === 'hover-class'}, ${fragments(original, text[part.start - 1] ?? '"').join(', ')})}}` : original.split(/(\s+)/).map((part) => aliases.get(part) ?? part).join('');
    if (value !== original) edits.push({ uri: request.document.uri, range: part, oldText: original, newText: value, version: request.document.version, expectedText: text });
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const source = dynamic && bindings.length ? [
    '/** 将原作用域类名映射到组件声明的外部样式类。 */',
    'function alias(name) {', '  switch (name) {',
    ...bindings.map((binding) => `    case ${JSON.stringify(binding.name)}: return ${JSON.stringify(binding.alias)};`),
    '    default: return name;', '  }', '}',
    '/** 保留插值拼接和空值，再按完整类名进行映射。 */',
    'function map(preserveNone) {', '  var value = "";', '  for (var i = 1; i < arguments.length; i++) {',
    '    if (arguments[i] !== null && arguments[i] !== undefined) value += String(arguments[i]);', '  }',
    '  // 原生悬停类的 none 表示不应用样式，不能改为外部类。',
    '  if (preserveNone && value === "none") return value;',
    '  var names = value.replace(getRegExp("\\\\s+", "g"), " ").split(" ");',
    '  for (var j = 0; j < names.length; j++) names[j] = alias(names[j]);',
    '  return names.join(" ");', '}', 'module.exports = { map: map };',
  ].join(newline) + newline : undefined;
  return { bindings, edits, ...(source ? { module, source } : {}) };
}
