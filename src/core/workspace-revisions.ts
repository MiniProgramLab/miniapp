/** 文件与目录共享规范 URI，末尾斜线不能产生两套修订记录。 */
export function workspaceRevisionKey(value: string): string {
  try {
    const uri = new URL(value);
    if (uri.pathname.length > 1) uri.pathname = uri.pathname.replace(/\/$/, '');
    return uri.href;
  } catch { return value; }
}

/** 有界修订仅记录实际观察过的依赖，构建噪声不占满语义缓存索引。 */
export function createWorkspaceRevisions() {
  let environment = 0;
  const revisions = new Map<string, number>();
  const normalized = new Map<string, string>();
  /** 配置变化和索引回收保守失效，普通内容变化不增加全局版本。 */
  const invalidate = (): void => { environment++; revisions.clear(); normalized.clear(); };
  /** 没有观察过的文件在首次读取前无需保存事件历史。 */
  const bump = (uri: string): void => { const own = workspaceRevisionKey(uri); if (revisions.has(own)) revisions.set(own, revisions.get(own)! + 1); };
  return {
    /** 首次读取建立修订槽位，超过上限时统一废弃旧快照。 */
    revision(uri: string): string {
      const own = normalized.get(uri) ?? workspaceRevisionKey(uri);
      if (!revisions.has(own)) { if (revisions.size >= 65536) invalidate(); revisions.set(own, 0); }
      if (normalized.size < 65536) normalized.set(uri, own);
      return `${environment}:${revisions.get(own)}`;
    },
    invalidate,
    /** 新增与删除更新相关祖先目录；排除目录的事件只影响其内部已观察依赖。 */
    changed(uri: string, root?: string, structural = false): void {
      bump(uri);
      if (!structural) return;
      const boundary = root && workspaceRevisionKey(root);
      const ignored = /\/(?:node_modules|dist|build|\.git|\.pnpm-store)(?:\/|$)/;
      const excluded = ignored.test(uri);
      let current = uri;
      for (let depth = 0; depth < 64; depth++) {
        let parent: string;
        try { parent = workspaceRevisionKey(new URL('../', current.replace(/\/?$/, '/')).href); } catch { break; }
        if (parent === workspaceRevisionKey(current) || boundary && parent !== boundary && !parent.startsWith(boundary.replace(/\/$/, '') + '/')) break;
        if (excluded && !ignored.test(parent)) break;
        bump(parent);
        if (parent === boundary) break;
        current = parent;
      }
    },
  };
}
