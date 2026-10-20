import * as vscode from 'vscode';
import type { CheckFile, CheckFinding, CheckProvider, CheckReport, CheckResult, Diagnostic, WorkspaceReader } from '../../api';
import { checkWorkspace } from '../../core/workspace-check';

/** 文件范围使用编辑器原生 glob，结果筛选无需重新执行语义检查。 */
export interface WorkspaceCheckFilters {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly severities?: readonly Diagnostic['severity'][];
  readonly codes?: readonly string[];
  readonly file?: string;
  readonly maxFiles?: number;
}

/** 标准小程序源码按后缀选择语言，打开缓冲区可保留用户指定的语言。 */
function language(uri: vscode.Uri): string {
  const extension = uri.path.split('.').at(-1)?.toLowerCase();
  return ({ wxml: 'wxml', wxs: 'wxs', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact', json: 'json', jsonc: 'jsonc' } as Record<string, string>)[extension ?? ''] ?? '';
}

/** 位置来自检查时的快照，发布诊断无需打开所有文件。 */
function diagnostic(finding: CheckFinding): vscode.Diagnostic {
  const { start, end } = finding.position;
  const item = new vscode.Diagnostic(new vscode.Range(start.line, start.character, end.line, end.character), finding.message, finding.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
  if (finding.code) item.code = finding.code;
  item.source = `miniapp 工作区检查 · ${finding.source}`;
  return item;
}

/** JSON 与 Markdown 导出都保留覆盖范围、未完成原因及快照时间。 */
export function formatCheckReport(report: CheckReport, stale = false, markdown = false, filter: WorkspaceCheckFilters = {}): string {
  if (!markdown) return JSON.stringify({ ...report, stale, filter }, null, 2) + '\n';
  const status = { complete: '检查结束', incomplete: '检查不完整', cancelled: '已取消' };
  const lines = ['# miniapp 工作区检查', '', `状态：${status[report.status]}${stale ? '；结果已过期，请重新检查' : ''}`, `快照时间：${report.checkedAt}`, `文件：发现 ${report.selected}，检查 ${report.checked}，跳过 ${report.skipped}`, `问题：${report.findings.length}`, '', '范围：', ...report.scopes.map((scope) => '- ' + scope)];
  if (report.issues.length) lines.push('', '未完成原因：', ...report.issues.map((issue) => `- ${issue.uri ?? ''} ${issue.provider ?? ''} ${issue.message}`.trimEnd()));
  /** 消息按代码文本显示，避免元数据文字改变导出文档结构。 */
  for (const item of report.findings) lines.push('', `- ${item.severity === 'error' ? '错误' : '警告'}：${item.uri}:${item.position.start.line + 1}:${item.position.start.character + 1}`, '', '```text', item.message.replace(/```/g, '` ` `'), '```');
  return lines.join('\n') + '\n';
}

/** 控制器复用诊断端口，只有稳定的未打开文件进入工作区快照集合。 */
export function registerWorkspaceCheck(host: { checkProviders(): readonly CheckProvider[] }, reader: WorkspaceReader, output: vscode.LogOutputChannel): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('miniapp.workspace-check');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
  status.command = 'miniprogramlab.miniapp.checkWorkspace';
  let active = true, running: vscode.CancellationTokenSource | undefined;
  let state: { result: CheckResult; filter: WorkspaceCheckFilters; stale: boolean } | undefined;
  let observed = new Set<string>();
  const resources: vscode.Disposable[] = [collection, status];

  /** 结果筛选同时用于问题面板和导出，保留原报告的检查状态。 */
  function filtered(): CheckReport | undefined {
    if (!state) return undefined;
    const { filter } = state;
    return { ...state.result.report, findings: state.result.report.findings.filter((item) => (!filter.severities?.length || filter.severities.includes(item.severity)) && (!filter.codes?.length || filter.codes.includes(item.code ?? '')) && (!filter.file || item.uri.includes(filter.file))) };
  }

  /** 打开文档由实时集合接管，避免同一问题出现两次。 */
  function publish(): void {
    collection.clear();
    const report = filtered();
    if (!report || !active || state?.stale) return;
    const opened = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    const files = new Map<string, vscode.Diagnostic[]>();
    for (const item of report.findings) if (!opened.has(item.uri)) { const list = files.get(item.uri) ?? []; list.push(diagnostic(item)); files.set(item.uri, list); }
    for (const [uri, items] of files) collection.set(vscode.Uri.parse(uri), items);
    status.text = `$(checklist) miniapp ${report.checked} 文件 · ${report.findings.length} 问题`;
    status.tooltip = `${report.status === 'complete' ? '检查结束' : report.status === 'cancelled' ? '已取消，保留已检查结果' : '检查未完成'}；快照 ${report.checkedAt}`;
    status.show();
  }

  /** 原生 glob 负责过滤磁盘文件，已打开的新草稿使用相同模式合并。 */
  async function discover(scopes: readonly vscode.Uri[], filters: WorkspaceCheckFilters, source: vscode.CancellationTokenSource): Promise<CheckFile[]> {
    const result = new Map<string, CheckFile>();
    const limit = Number.isFinite(filters.maxFiles) ? Math.max(1, Math.min(100000, Math.floor(filters.maxFiles!))) : 10000;
    for (const scope of scopes) {
      const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.checks', scope);
      const include = filters.include ?? settings.get<string[]>('include', ['**/*.{wxml,wxs,ts,tsx,js,jsx,mts,cts,mjs,cjs,json,jsonc}']);
      const excludes = filters.exclude ?? settings.get<string[]>('exclude', ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.pnpm-store/**']);
      const exclude = excludes.length ? new vscode.RelativePattern(scope, excludes.length === 1 ? excludes[0]! : '{' + excludes.join(',') + '}') : undefined;
      for (const pattern of include) {
        if (source.token.isCancellationRequested || result.size > limit) return [...result.values()];
        const glob = new vscode.RelativePattern(scope, pattern);
        let disk: readonly vscode.Uri[];
        // 每种模式独立保留超限探针，重叠结果不能消耗剩余发现预算。
        try { disk = await vscode.workspace.findFiles(glob, exclude, limit + 1, source.token); }
        catch (error) { if (source.token.isCancellationRequested) return [...result.values()]; throw error; }
        for (const uri of disk) { result.set(uri.toString(), { uri: uri.toString(), languageId: language(uri) }); if (result.size > limit) return [...result.values()]; }
        for (const document of vscode.workspace.textDocuments) if (vscode.languages.match({ pattern: glob }, document) && !excludes.some((pattern) => vscode.languages.match({ pattern: new vscode.RelativePattern(scope, pattern) }, document))) result.set(document.uri.toString(), { uri: document.uri.toString(), languageId: document.languageId });
      }
    }
    return [...result.values()];
  }

  /** 可选择资源管理器目录，默认检查全部工作区根。 */
  resources.push(vscode.commands.registerCommand('miniprogramlab.miniapp.checkWorkspace', async (target?: vscode.Uri, filters: WorkspaceCheckFilters = {}) => {
    if (!active) return undefined;
    const scopes = target ? [target] : vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
    if (!scopes.length) { void vscode.window.showInformationMessage('请先打开需要检查的小程序工作区。'); return undefined; }
    running?.cancel(); running?.dispose();
    // 准备阶段也归属当前任务，较早的异步路径检查不能覆盖新任务。
    const source = running = new vscode.CancellationTokenSource();
    state = undefined; observed.clear(); collection.clear();
    status.text = '$(sync~spin) miniapp 检查中'; status.show();
    try {
      if (target) { try { if (!((await vscode.workspace.fs.stat(target)).type & vscode.FileType.Directory)) scopes[0] = vscode.Uri.joinPath(target, '..'); } catch { if (language(target)) scopes[0] = vscode.Uri.joinPath(target, '..'); } }
      if (!active || running !== source) return undefined;
      const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.checks', scopes[0]);
      const resolved: WorkspaceCheckFilters = { ...filters, maxFiles: filters.maxFiles ?? settings.get<number>('maxFiles', 10000) };
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'miniapp：检查工作区', cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => source.cancel());
        try {
          progress.report({ message: '发现源码文件' });
          const scopeDependencies = reader.revision ? scopes.map((scope) => ({ uri: scope.toString(), revision: reader.revision!(scope.toString()) })) : [];
          const files = await discover(scopes, resolved, source);
          const checkedResult = await checkWorkspace(reader, files, host.checkProviders(), { cancellation: source.token, scopes: scopes.map((scope) => scope.toString()), maxFiles: resolved.maxFiles!, maxFindings: settings.get<number>('maxFindings', 50000), progress: (checked, total, file) => progress.report({ message: `${checked}/${total} · ${vscode.workspace.asRelativePath(vscode.Uri.parse(file.uri))}` }) });
          // 检查范围内新增或删除源码时，文件发现快照也需要失效。
          const result = { ...checkedResult, dependencies: [...scopeDependencies, ...checkedResult.dependencies.filter((item) => !scopeDependencies.some((scope) => scope.uri === item.uri))] };
          if (!active || running !== source) return result.report;
          state = { result, filter: resolved, stale: !!reader.revision && result.dependencies.some((item) => reader.revision!(item.uri) !== item.revision) };
          observed = new Set(result.dependencies.map((item) => item.uri));
          publish();
          const report = filtered()!;
          output.info(`工作区检查：${report.status === 'complete' ? '已结束' : report.status === 'cancelled' ? '已取消' : '未完成'}；检查 ${report.checked}/${report.selected} 文件，跳过 ${report.skipped}，${report.findings.length} 个问题。`);
          for (const issue of report.issues) output.warn(`${issue.uri ?? ''} ${issue.provider ?? ''} ${issue.message}`);
          if (state.stale) { status.text = '$(warning) miniapp 检查需更新'; status.tooltip = '检查期间依赖发生变化，旧结果未进入问题面板。'; }
          return report;
        } finally { cancellation.dispose(); }
      });
    } catch (error) {
      if (running === source) { status.text = '$(warning) miniapp 检查失败'; output.error(error instanceof Error ? error.message : String(error)); }
      return undefined;
    } finally { if (running === source) running = undefined; source.dispose(); }
  }));

  /** 常用严重程度和文件筛选直接作用于上一份结果。 */
  resources.push(vscode.commands.registerCommand('miniprogramlab.miniapp.filterCheckResults', async (filter?: WorkspaceCheckFilters) => {
    if (!state) { void vscode.window.showInformationMessage('请先执行 miniapp 工作区检查。'); return undefined; }
    const selected = state;
    if (!filter) {
      const choice = await vscode.window.showQuickPick(['全部问题', '仅错误', '仅警告', '按文件筛选', '清除文件筛选'], { title: '筛选工作区检查结果' });
      if (!choice || state !== selected) return undefined;
      if (choice === '按文件筛选') { const file = await vscode.window.showInputBox({ title: '文件路径包含', value: selected.filter.file ?? '' }); if (file === undefined) return undefined; filter = { file }; }
      else filter = choice === '清除文件筛选' ? { file: '' } : { severities: choice === '仅错误' ? ['error'] : choice === '仅警告' ? ['warning'] : [] };
    }
    if (state !== selected) return undefined;
    state.filter = { ...state.filter, ...filter }; publish(); return filtered();
  }));

  /** 命令面板与原生进度取消按钮使用同一个取消源。 */
  resources.push(vscode.commands.registerCommand('miniprogramlab.miniapp.cancelWorkspaceCheck', () => { const pending = !!running; running?.cancel(); return pending; }));

  /** 默认 JSON 报告保留检查状态，Markdown 文件名不带日期。 */
  resources.push(vscode.commands.registerCommand('miniprogramlab.miniapp.exportCheckReport', async (target?: vscode.Uri) => {
    const report = filtered();
    if (!report || !state) { void vscode.window.showInformationMessage('请先执行 miniapp 工作区检查。'); return undefined; }
    const selected = state;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const destination = target ?? await vscode.window.showSaveDialog({ title: '导出工作区检查结果', ...(folder ? { defaultUri: vscode.Uri.joinPath(folder.uri, 'miniapp-check-report.json') } : {}), filters: { JSON: ['json'], Markdown: ['md'] } });
    if (!destination) return undefined;
    const stale = selected.stale || !!reader.revision && selected.result.dependencies.some((item) => reader.revision!(item.uri) !== item.revision);
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(formatCheckReport(report, stale, destination.path.endsWith('.md'), selected.filter)));
    return destination.toString();
  }));

  resources.push(vscode.workspace.onDidOpenTextDocument((document) => collection.delete(document.uri)));
  if (reader.onDidChange) resources.push(reader.onDidChange((uri, kind) => {
    if (!state || kind === 'open' || kind === 'close') return;
    if (uri && !observed.has(uri) && !(kind === 'structure' && reader.revision && state.result.dependencies.some((item) => reader.revision!(item.uri) !== item.revision))) return;
    state.stale = true; collection.clear(); status.text = '$(warning) miniapp 检查需更新'; status.tooltip = '源码或依赖已变化，请重新检查；导出仍保留旧快照标记。';
  }));
  return { dispose() { active = false; running?.cancel(); running?.dispose(); state = undefined; observed.clear(); for (const resource of resources.reverse()) resource.dispose(); } };
}
