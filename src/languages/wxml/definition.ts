import type { Definition, LanguageRequest, StyleClassResolver } from '../../api';
import { classTokenAt } from './class-context';

/** 静态类名及插值返回的字符串类名共用样式引用链。 */
export function provideClassDefinition(request: LanguageRequest, styles: StyleClassResolver): PromiseLike<readonly Definition[]> | readonly Definition[] {
  const token = classTokenAt(request);
  return token?.name ? styles.resolveClass(request, token.name, token.range) : [];
}
