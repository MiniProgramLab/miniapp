import type { Definition, LanguagePlugin, WorkspaceReader } from '../api';

/** 配置里的构建组件路径直接跳转到开发源码，无需生成 dist。 */
export function createFileNavigationPlugin(reader: WorkspaceReader): LanguagePlugin {
  return {
    id: 'miniprogramlab.file-navigation', displayName: '智能配置文件导航', languages: ['json', 'jsonc'],
    /** 注册只读定义提供器，配置草稿由请求快照提供。 */
    setup() {
      return { definition: { provide: async (request): Promise<readonly Definition[]> => {
        if (request.cancellation.isCancellationRequested) return [];
        try { new URL('./', request.document.uri); } catch { return []; }
        const { componentPath } = await import('./navigation-document');
        if (request.cancellation.isCancellationRequested) return [];
        const node = componentPath(request);
        const resolver = node && reader.fileResolver?.(request.document.uri, request.cancellation);
        if (!node || !resolver) return [];
        for (const base of await resolver.candidates(node.text, request.document.uri, 'component')) {
          if (/\.d\.[cm]?ts$/i.test(base)) continue;
          const candidates = /\.(?:[cm]?[jt]sx?|wxml)$/i.test(base) ? [base] : ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.wxml', '/index.ts', '/index.js', '/index.wxml'].map((extension) => base + extension);
          for (const candidate of candidates) {
            if (request.cancellation.isCancellationRequested) return [];
            const document = await reader.read(candidate);
            if (document) return [{ uri: candidate, range: { start: 0, end: 0 }, originRange: { start: node.getStart() + 1, end: node.end - 1 }, ...(document.version !== undefined ? { version: document.version } : {}) }];
          }
        }
        return [];
      } } };
    },
  };
}
