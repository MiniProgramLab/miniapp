import type { LanguageRequest, ScriptModule, TemplateExpression } from '../../api';
import { expressionAt } from './expression';
import { scanTags } from './parser';

/** WXS 只在所属模板中可见，注释及内联脚本中的伪标签由词法器排除。 */
export function scriptModules(request: LanguageRequest): ScriptModule[] {
  const modules: ScriptModule[] = [];
  const { text, uri, version } = request.document;
  for (const tag of scanTags(text)) {
    if (tag.name !== 'wxs' || tag.closing) continue;
    const nameRange = tag.attributes.find((attribute) => attribute.name === 'module')?.valueRange;
    if (!nameRange) continue;
    const name = text.slice(nameRange.start, nameRange.end);
    if (!/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(name)) continue;
    const src = tag.attributes.find((attribute) => attribute.name === 'src')?.valueRange;
    if (src) {
      const path = text.slice(src.start, src.end);
      if (!path || path.includes('{{') || /^(?:[\w+.-]+:|\/\/)/.test(path)) continue;
      try { modules.push({ name, nameRange, uri: new URL(path, uri).href, reference: path }); } catch { /* 未命名模板没有相对文件路径。 */ }
    } else if (tag.closed && !tag.selfClosing) {
      const closing = /<\/wxs(?=[\s>])/g;
      closing.lastIndex = tag.end;
      const end = closing.exec(text)?.index ?? text.length;
      modules.push({ name, nameRange, uri, inline: { text: text.slice(tag.end, end), range: { start: tag.end, end }, version } });
    }
  }
  // 同一 WXML 的重复模块名由后声明覆盖，与运行时模块作用域保持一致。
  return [...new Map(modules.map((module) => [module.name, module])).values()];
}

/** 所有模板语义入口统一附带 WXS 作用域，内联脚本沿真实偏移查询。 */
export function scriptExpression(request: LanguageRequest): TemplateExpression | undefined {
  const modules = scriptModules(request);
  const inline = modules.find((module) => module.inline && request.offset >= module.inline.range.start && request.offset < module.inline.range.end)?.inline;
  const expression = inline ? { text: inline.text, range: inline.range, bindings: [] } : expressionAt(request.document.text, request.offset);
  return expression ? { ...expression, modules } : undefined;
}
