import * as vscode from 'vscode';
import type { LanguageFeatures, Logger } from '../../api';

/** 把语言模块的自动插入能力接入真实输入，保护光标、版本和撤销语义。 */
export function registerAutoInsertion(selector: vscode.DocumentSelector, feature: NonNullable<LanguageFeatures['autoInsertion']>, logger: Logger): vscode.Disposable {
  let disposed = false;
  let inserting = false;
  let pending: vscode.CancellationTokenSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** 后续输入、切换编辑器或卸载均取消尚未落地的插入。 */
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending?.cancel();
    pending?.dispose();
    pending = undefined;
  };

  /** 只处理当前编辑器中一次单字符输入，整段粘贴、撤销和多光标不自动修改。 */
  const changes = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!vscode.languages.match(selector, event.document)) return;
    cancel();
    const editor = vscode.window.activeTextEditor;
    const change = event.contentChanges[0];
    if (disposed || inserting || event.reason !== undefined || !editor || editor.document !== event.document || editor.selections.length !== 1 || event.contentChanges.length !== 1 || !change || change.rangeLength !== 0 || change.text.length !== 1 || !feature.triggerCharacters.includes(change.text)) return;
    const document = event.document;
    const version = document.version;
    const offset = change.rangeOffset + change.text.length;
    const cancellation = new vscode.CancellationTokenSource();
    pending = cancellation;

    /** 异步求值前后都核对输入后的光标，防止旧结果落入新的编辑位置。 */
    const current = (): boolean => !disposed && !cancellation.token.isCancellationRequested && !document.isClosed && document.version === version && vscode.window.activeTextEditor === editor && editor.selections.length === 1 && editor.selection.isEmpty && document.offsetAt(editor.selection.active) === offset;
    // 输入事件先于光标更新到达；短暂延后使宿主完成本次键入及自动补括号。
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        if (!current()) return;
        const text = await feature.provide({ document: { uri: document.uri.toString(), languageId: document.languageId, text: document.getText(), version }, offset, cancellation: cancellation.token });
        if (!text || !current()) return;
        inserting = true;
        try {
          // 纯文本插入沿用本次键入的撤销组，避免片段会话形成额外的撤销边界。
          const applied = await editor.edit((edit) => edit.insert(document.positionAt(offset), text), { undoStopBefore: false, undoStopAfter: true });
          if (applied && !disposed && document.version === version + 1 && vscode.window.activeTextEditor === editor && editor.selections.length === 1 && editor.selection.isEmpty && [offset, offset + text.length].includes(document.offsetAt(editor.selection.active))) {
            const position = document.positionAt(offset);
            editor.selection = new vscode.Selection(position, position);
          }
        } finally {
          inserting = false;
        }
      } catch (error) {
        logger.error('自动插入失败。', error);
      } finally {
        if (pending === cancellation) { pending = undefined; cancellation.dispose(); }
      }
    }, 50);
  });
  const editors = vscode.window.onDidChangeActiveTextEditor(cancel);
  return new vscode.Disposable(() => { disposed = true; cancel(); changes.dispose(); editors.dispose(); });
}
