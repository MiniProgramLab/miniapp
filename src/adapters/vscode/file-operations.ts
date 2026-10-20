import * as vscode from 'vscode';
import type { LanguageRequest, Logger, WorkspaceReader } from '../../api';
import type { createFileOperations, RelatedFile } from '../../resolution';
import { toWorkspaceEdit } from './language-host';

/** 文件命令及原生移动事件共用编辑校验，实际移动始终由编辑器完成。 */
export function registerFileOperations(reader: WorkspaceReader, operations: ReturnType<typeof createFileOperations>, logger: Logger): vscode.Disposable {
  const pending = new Set<vscode.CancellationTokenSource>();
  const commands: vscode.Disposable[] = [];
  /** 当前编辑器或资源管理器的文件可作为切换起点。 */
  const switchFile = async (kind?: RelatedFile['kind'], uri?: vscode.Uri): Promise<void> => {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document) return;
    const source = new vscode.CancellationTokenSource(); pending.add(source);
    try {
      const request: LanguageRequest = { document: { uri: document.uri.toString(), languageId: document.languageId, version: document.version, text: document.getText() }, offset: 0, cancellation: source.token };
      const files = (await operations.related(request)).filter((file) => !kind || file.kind === kind);
      if (source.token.isCancellationRequested || document.version !== request.document.version) return;
      const labels = { template: '模板', script: '脚本', style: '样式', configuration: '配置' };
      const selected = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files.map((file) => ({ label: labels[file.kind], description: vscode.workspace.asRelativePath(vscode.Uri.parse(file.uri)), file })), { placeHolder: files.length ? '切换到关联文件' : '没有找到当前文件的关联源码' });
      const file = selected && ('file' in selected ? selected.file : selected);
      if (file && !source.token.isCancellationRequested) await vscode.window.showTextDocument(vscode.Uri.parse(file.uri), { preview: false });
    } finally { pending.delete(source); source.dispose(); }
  };
  commands.push(vscode.commands.registerCommand('miniprogramlab.miniapp.switchRelatedFile', (uri?: vscode.Uri) => switchFile(undefined, uri)));
  for (const [name, kind] of Object.entries({ switchTemplate: 'template', switchScript: 'script', switchStyle: 'style', switchConfiguration: 'configuration' } as const)) commands.push(vscode.commands.registerCommand('miniprogramlab.miniapp.' + name, (uri?: vscode.Uri) => switchFile(kind, uri)));
  const listener = vscode.workspace.onWillRenameFiles((event) => {
    const source = new vscode.CancellationTokenSource(); pending.add(source);
    /** 不提前重命名文件；同一批次的入站与出站引用按旧快照一起计算。 */
    const prepare = async (): Promise<vscode.WorkspaceEdit | undefined> => {
      try {
        const roots = new Map<string, vscode.Uri>();
        for (const move of event.files) {
          const root = reader.root(move.oldUri.toString());
          if (root) roots.set(root, move.oldUri);
        }
        const moves = event.files.map((file) => ({ oldUri: file.oldUri.toString(), newUri: file.newUri.toString() }));
        const edits = [];
        for (const uri of roots.values()) {
          let document: vscode.TextDocument | undefined;
          try { document = await vscode.workspace.openTextDocument(uri); } catch { /* 文件夹没有文档，仍可作为工作区发现起点。 */ }
          edits.push(...await operations.rename({ document: { uri: uri.toString(), languageId: document?.languageId ?? 'plaintext', version: document?.version ?? 0, text: document?.getText() ?? '' }, offset: 0, cancellation: source.token }, moves));
        }
        return await toWorkspaceEdit([...new Map(edits.map((edit) => [edit.uri + ':' + edit.range.start, edit])).values()], source.token);
      } catch (error) {
        logger.error('文件移动路径联动失败。', error);
        void vscode.window.showWarningMessage(`miniapp 未完成路径联动：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      } finally { pending.delete(source); source.dispose(); }
    };
    event.waitUntil(prepare());
  });
  return { dispose() { for (const source of pending) { source.cancel(); source.dispose(); } pending.clear(); listener.dispose(); for (const command of commands) command.dispose(); } };
}
