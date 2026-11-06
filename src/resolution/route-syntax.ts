import type { RouteDocumentResolver } from '../api';

/** JSON/JSONC 解析保持延迟加载，可直接运行在语义线程。 */
export function createRouteDocumentResolver(): RouteDocumentResolver {
  return {
    manifest: async (uri, text) => (await import('./routes-document')).jsonRoutes(uri, text),
    accesses: async (request) => (await import('./routes-document')).jsonRouteAccesses(request),
  };
}
