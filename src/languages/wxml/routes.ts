import type { LanguagePlugin, LanguageRequest, RouteAccess, RouteResolver } from '../../api';
import { scanTags, skipExpression } from './parser';

/** navigator 仅处理当前小程序的静态 URL，跨小程序与动态插值保持开放。 */
export function navigatorAccesses(request: LanguageRequest): readonly RouteAccess[] {
  const result: RouteAccess[] = [];
  for (const tag of scanTags(request.document.text)) {
    if (tag.closing || tag.name !== 'navigator') continue;
    const field = (name: string): string | undefined => { const range = tag.attributes.find((item) => item.name === name)?.valueRange; return range ? request.document.text.slice(range.start, range.end) : undefined; };
    const url = tag.attributes.find((item) => item.name === 'url')?.valueRange;
    const text = field('url');
    const target = field('target');
    const mode = field('open-type') ?? 'navigate';
    const method = ({ navigate: 'navigateTo', redirect: 'redirectTo', switchTab: 'switchTab', reLaunch: 'reLaunch' } as const)[mode as 'navigate'];
    if (!url || text === undefined || text.split(/[?#]/, 1)[0]!.includes('{{') || target && target !== 'self' || !method) continue;
    let staticUrl = '', offset = 0;
    for (let start = text.indexOf('{{'); start >= 0; start = text.indexOf('{{', offset)) { staticUrl += text.slice(offset, start) + '{动态}'; offset = skipExpression(text, start); }
    staticUrl += text.slice(offset);
    const length = text.includes('{{') ? text.indexOf('{{') : text.length;
    result.push({ range: url, urls: [{ text: staticUrl, complete: !text.includes('{{'), sources: [{ uri: request.document.uri, range: { start: url.start, end: url.start + length }, offset: 0 }] }], method, base: 'page', editable: true });
  }
  return result;
}

/** 模板 URL 使用相同的目录与平台规则，语言模块只负责提供真实属性范围。 */
export function createNavigatorPlugin(routes: RouteResolver): LanguagePlugin {
  /** 当前属性查询不会扫描无关模板或解析普通字符串。 */
  async function selected(request: LanguageRequest) {
    const access = navigatorAccesses(request).find((item) => request.offset >= item.range.start && request.offset <= item.range.end);
    return access ? routes.query(request, access) : undefined;
  }
  return { id: 'miniprogramlab.navigator-routes', displayName: '模板页面路由', languages: ['wxml'],
    /** 补全、悬浮、导航和诊断均由公共路由端口决定。 */
    setup: () => ({
      definition: { provide: async (request) => (await selected(request))?.definitions ?? [] },
      completion: { triggerCharacters: ['/', '?', '&'], provide: async (request) => (await selected(request))?.completions ?? [] },
      hover: { provide: async (request) => (await selected(request))?.hover },
      diagnostics: { dependencyLanguages: ['json', 'jsonc', 'typescript', 'javascript'],
        /** 静态模板属性复用请求目录，不将跨小程序页面当作本地未注册页面。 */
        async provide(request) { const result: import('../../api').Diagnostic[] = []; for (const access of navigatorAccesses(request)) result.push(...(await routes.query(request, access)).diagnostics); return result; },
      },
    }),
  };
}
