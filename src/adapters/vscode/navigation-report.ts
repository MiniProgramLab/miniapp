import * as vscode from 'vscode';
import type { NavigationReport } from '../../api';

/** 报告使用普通日志文本，路径不作为可执行 Markdown 命令。 */
export function formatNavigationReport(report: NavigationReport): string {
  const status = { resolved: '已找到定义', ambiguous: '存在多个定义来源，保留全部候选', unresolved: '未找到可确定的定义', incomplete: '解析未完成，候选可能不完整' };
  const labels = { context: '上下文', path: '路径', alias: '别名', config: '配置', missing: '未找到', dynamic: '动态引用', budget: '扫描上限', unsupported: '支持范围', cached: '缓存', symbol: '符号', cycle: '循环引用', error: '解析错误' };
  const lines = [`导航说明：${status[report.status]}`, `文档：${report.uri}`, `光标偏移：${report.offset}`];
  for (const provider of report.providers) {
    if (!provider.definitions.length && !provider.steps.length) continue;
    lines.push(`\n${provider.name}：${provider.definitions.length} 个定义`);
    for (const step of provider.steps) lines.push(`  [${labels[step.code]}] ${step.message}${step.uri ? `\n    ${step.uri}` : ''}`);
    for (const target of provider.definitions) lines.push(`  定义：${target.uri}（偏移 ${target.range.start}）`);
  }
  if (!report.definitions.length && !report.providers.some((provider) => provider.steps.length)) lines.push('当前提供器未返回可确定的定义或详细解析步骤；普通 TS/JS 符号仍由编辑器原生导航处理。');
  return lines.join('\n');
}

/** 命令面板提供可取消说明，仍使用请求发起时的文档和选区。 */
export function registerNavigationExplanation(
  host: { explainNavigation(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<NavigationReport | undefined> },
  output: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('miniprogramlab.miniapp.explainNavigation', async (uri?: vscode.Uri, position?: vscode.Position) => {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!document) return undefined;
    const selected = position ?? (editor?.document === document ? editor.selection.active : new vscode.Position(0, 0));
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'miniapp：追踪当前导航', cancellable: true }, async (_progress, token) => {
      const report = await host.explainNavigation(document, selected, token);
      if (report) { output.info(formatNavigationReport(report)); output.show(true); }
      return report;
    });
  });
}
