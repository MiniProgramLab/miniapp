import type { ComponentEvent, SemanticType } from '../../api';

/** 事件名称与绑定前缀分离，冒泡、捕获和互斥绑定沿用相同契约。 */
export function eventAttribute(name: string): { prefix: string; name: string } | undefined {
  const match = name.match(/^((?:(?:capture-|mut-)?(?:bind|catch)):?)([\w-]*)$/);
  return match ? { prefix: match[1]!, name: match[2]! } : undefined;
}

/** 补全及悬浮共同展示 detail 的静态分支类型。 */
export function eventDescription(event: ComponentEvent): string {
  return [event.description, `detail：${[...new Set(event.details.map((detail) => detail.display))].join(' | ') || 'unknown'}`].filter(Boolean).join('\n');
}

/** 只拒绝静态可证明的类型冲突；未知、开放对象和未标注参数继续兼容。 */
export function accepts(actual: SemanticType, expected: SemanticType): boolean {
  if (actual.alternatives) return actual.alternatives.every((part) => accepts(part, expected));
  if (expected.alternatives) return expected.alternatives.some((part) => accepts(actual, part));
  if (actual.kind === 'unknown' || expected.kind === 'unknown') return true;
  if (actual.kind !== expected.kind) return false;
  if (expected.literal !== undefined) return actual.literal === expected.literal;
  if (actual.kind === 'array' && actual.element && expected.element) return accepts(actual.element, expected.element);
  if (actual.kind !== 'object') return true;
  return Object.entries(expected.properties ?? {}).every(([name, type]) => {
    const provided = actual.properties?.[name];
    return provided ? (!provided.optional || !!type.optional) && accepts(provided, type) : !!type.optional;
  });
}
