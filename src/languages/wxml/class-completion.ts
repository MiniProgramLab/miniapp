import type { Completion, LanguageRequest, StyleClassResolver } from '../../api';
import { classTokenAt } from './class-context';

/** 静态 class 与表达式返回字符串共用类名补全和精确替换范围。 */
export function provideClassCompletions(request: LanguageRequest, styles: StyleClassResolver): PromiseLike<readonly Completion[]> | readonly Completion[] {
  if (!styles.completeClass) return [];
  const token = classTokenAt(request);
  return token ? styles.completeClass(request, token.prefix, token.range) : [];
}
