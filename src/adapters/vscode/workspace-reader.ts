import * as vscode from 'vscode';
import type { WorkspaceDirectoryEntry, WorkspaceReader, WorkspaceText } from '../../api';
import { createWorkspaceRevisions } from '../../core/workspace-revisions';
import { createRevisionCache } from '../../core/revision-cache';
import { createDependencyTracking } from './dependency-tracking';
import { createNavigationTracking } from './navigation-tracking';

/** 使用 VS Code 文件系统读取本地、远程或虚拟工作区。 */
export function createWorkspaceReader(subscriptions?: vscode.Disposable[]): WorkspaceReader {
  /** 磁盘仅合并正在进行的读取，完成后立即移除，不缓存旧文件或缺失结果。 */
  const pending = new Map<string, Promise<WorkspaceText | undefined>>();
  /** 文档版本相同时复用文本，弱引用允许关闭的缓冲区被回收。 */
  const snapshots = new WeakMap<vscode.TextDocument, WorkspaceText>();
  /** 打开的文档按 URI 直接查找，避免每次路径探测遍历所有标签页。 */
  const buffers = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  /** 解码器无需为每个文件重新创建。 */
  const decoder = new TextDecoder();
  const revisions = createWorkspaceRevisions();
  const tracking = createDependencyTracking(revisions.revision);
  const navigation = createNavigationTracking();
  /** 磁盘快照与阴性探测按文件事件失效，各语言共享同一缓存。 */
  const disk = createRevisionCache(tracking.observe, async (value): Promise<WorkspaceText | undefined> => {
    try { return { text: decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(value))) }; }
    catch { return undefined; }
  }, (value) => value?.text.length ?? 0);
  /** 目录结构修订独立于普通内容变化，避免反复 stat。 */
  const directories = createRevisionCache(tracking.observe, async (value) => {
    try { return !!((await vscode.workspace.fs.stat(vscode.Uri.parse(value))).type & vscode.FileType.Directory); } catch { return false; }
  }, () => 1, 4096);
  /** 只缓存完整清单；超大目录或不可枚举目录继续逐路径读取。 */
  const loadEntries = async (value: string): Promise<readonly WorkspaceDirectoryEntry[] | undefined> => {
    try {
      const items = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(value));
      if (items.length > 20000) return undefined;
      return items.map(([name, type]) => ({ name, kind: type & vscode.FileType.Directory ? 'directory' : type & vscode.FileType.File ? 'file' : 'unknown' }));
    } catch { return undefined; }
  };
  /** 与目录结构修订绑定，普通文件内容变化不重读目录。 */
  const entries = createRevisionCache(tracking.observe, loadEntries, (items) => items?.reduce((size, item) => size + item.name.length + 64, 0) ?? 0);
  /** 新缓冲区补充了已缓存清单中的缺失路径时，立即刷新目录可见性。 */
  const revealsPath = (uri: vscode.Uri): boolean => {
    let path = uri.path;
    for (let depth = 0; depth < 64 && path !== '/'; depth++) {
      const separator = path.lastIndexOf('/');
      if (separator < 0) break;
      const name = path.slice(separator + 1), parent = path.slice(0, separator) || '/';
      const items = entries.peek(uri.with({ path: parent }).toString());
      const folded = name.normalize('NFC').toLowerCase();
      if (items && !items.some((item) => item.name.normalize('NFC').toLowerCase() === folded)) return true;
      path = parent;
    }
    return false;
  };
  const changes = new vscode.EventEmitter<{ uri?: string; kind: 'content' | 'structure' | 'open' | 'close' | 'configuration' }>();
  const catalogs = new Map<string, { revision: string; files: readonly vscode.Uri[] }>();
  /** 文件结构变化才影响目录探测，普通脚本或磁盘内容只更新自身修订。 */
  const changed = (uri: vscode.Uri, structural = false, kind: 'content' | 'structure' | 'open' | 'close' = structural ? 'structure' : 'content'): void => { revisions.changed(uri.toString(), vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(), structural); changes.fire({ uri: uri.toString(), kind }); };
  /** 配置更新不能依赖普通文档编辑事件触发诊断。 */
  const invalidate = (): void => { revisions.invalidate(); catalogs.clear(); changes.fire({ kind: 'configuration' }); };
  if (subscriptions) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    subscriptions.push(tracking, navigation, disk, directories, entries, { dispose: () => buffers.clear() }, changes, watcher, watcher.onDidChange((uri) => changed(uri)), watcher.onDidCreate((uri) => changed(uri, true)), watcher.onDidDelete((uri) => changed(uri, true)),
      vscode.workspace.onDidChangeTextDocument((event) => { if (event.contentChanges.length) changed(event.document.uri, event.document.isDirty && revealsPath(event.document.uri)); }),
      vscode.workspace.onDidOpenTextDocument((document) => { buffers.set(document.uri.toString(), document); changed(document.uri, document.isDirty || revealsPath(document.uri), 'open'); }), vscode.workspace.onDidCloseTextDocument((document) => { buffers.delete(document.uri.toString()); changed(document.uri, document.isDirty, 'close'); }),
      vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('miniprogramlab.miniapp')) invalidate(); }), vscode.workspace.onDidChangeWorkspaceFolders(invalidate));
  }
  return {
    /** 没有事件生命周期时不声明缓存能力，避免外部调用者读到过期图。 */
    ...(subscriptions ? { revision: tracking.observe, capture: tracking.capture, navigation, onDidChange: (listener: Parameters<NonNullable<WorkspaceReader['onDidChange']>>[0]) => changes.event((change) => listener(change.uri, change.kind)) } : {}),
    /** 草稿文件与虚拟子目录合并到完整磁盘清单，保持未保存模块可见。 */
    async entries(value) {
      const uri = vscode.Uri.parse(value), key = uri.with({ path: uri.path.replace(/\/$/, '') || '/' }).toString();
      const items = await (subscriptions ? entries.read(key) : loadEntries(key));
      if (!items) return undefined;
      const prefix = uri.path.replace(/\/?$/, '/');
      const result = new Map(items.map((item) => [item.name, item]));
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme !== uri.scheme || document.uri.authority !== uri.authority || !document.uri.path.startsWith(prefix)) continue;
        const relative = document.uri.path.slice(prefix.length), separator = relative.indexOf('/');
        const name = separator < 0 ? relative : relative.slice(0, separator);
        if (name) result.set(name, { name, kind: separator < 0 ? 'file' : 'directory' });
      }
      return [...result.values()];
    },
    /** 尚未落盘的缓冲区也使所属目录可见，兼容远程和虚拟文件系统。 */
    async directory(value) {
      tracking.observe(value);
      const uri = vscode.Uri.parse(value);
      const prefix = uri.toString().replace(/\/?$/, '/');
      if (vscode.workspace.textDocuments.some((document) => document.uri.toString().startsWith(prefix))) return true;
      if (subscriptions) return directories.read(uri.toString());
      try { return !!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory); } catch { return false; }
    },
    /** 打开的未保存内容优先；缺失文件是正常的路径探测结果。 */
    async read(value) {
      tracking.observe(value);
      const uri = vscode.Uri.parse(value);
      const key = uri.toString();
      const document = subscriptions ? buffers.get(key) : vscode.workspace.textDocuments.find((item) => item.uri.toString() === key);
      if (document) {
        const previous = snapshots.get(document);
        if (previous?.version === document.version) return previous;
        const snapshot = { text: document.getText(), version: document.version };
        snapshots.set(document, snapshot);
        return snapshot;
      }
      if (subscriptions) return disk.read(key);
      let reading = pending.get(key);
      if (!reading) {
        reading = Promise.resolve().then(async () => {
          try { return { text: decoder.decode(await vscode.workspace.fs.readFile(uri)) }; }
          catch { return undefined; }
          finally { pending.delete(key); }
        });
        pending.set(key, reading);
      }
      return reading;
    },
    /** 多工作区场景仅返回当前文档所属根目录。 */
    root(value) {
      return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(value))?.uri.toString();
    },
    /** 限定在当前工作区发现模板，合并尚未保存到磁盘的新文档。 */
    async findFiles(value, pattern, limit, scope) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(value));
      if (!folder) return [];
      const root = scope ? vscode.Uri.parse(scope.root) : folder.uri;
      if (root.toString().replace(/\/$/, '') !== folder.uri.toString().replace(/\/$/, '') && !root.toString().startsWith(folder.uri.toString().replace(/\/$/, '') + '/')) return [];
      const revision = tracking.observe(root.toString());
      const include = new vscode.RelativePattern(root, pattern);
      const exclude = new vscode.RelativePattern(root, '{**/{node_modules,dist,build,.git,.pnpm-store,.worktrees}/**,**/{.claude,.codex}/worktrees/**}');
      const key = `${root.toString()}:${pattern}:${limit}`;
      const cached = catalogs.get(key);
      const files = cached?.revision === revision ? cached.files : await vscode.workspace.findFiles(include, exclude, limit);
      if (tracking.observe(root.toString()) === revision) {
        catalogs.delete(key); catalogs.set(key, { revision, files });
        while (catalogs.size > 12 || [...catalogs.values()].reduce((total, item) => total + item.files.length, 0) > 50000) catalogs.delete(catalogs.keys().next().value!);
      }
      const opened = vscode.workspace.textDocuments.filter((document) => vscode.languages.match({ pattern: include }, document) > 0 && vscode.languages.match({ pattern: exclude }, document) === 0 && vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString());
      return [...new Set([...opened.map((document) => document.uri.toString()), ...files.map((uri) => uri.toString())])].slice(0, limit);
    },
  };
}
