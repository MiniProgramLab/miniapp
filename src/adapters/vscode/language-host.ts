import * as vscode from 'vscode';
import type { CheckProvider, CodeAction, Completion, Definition, LanguageHost, LanguageRequest, LanguageResult, Logger, NavigationReport, OutlineSymbol, TextEdit, TextRange, WorkspaceDependency, WorkspaceReader } from '../../api';
import { DisposableStore } from '../../core/disposable-store';
import { registerAutoInsertion } from './auto-insertion';

/** 将偏移区间转换为编辑器范围。 */
function toRange(document: vscode.TextDocument, range: TextRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}

/** 大纲只含普通文本和原文坐标，子节点保持所属模板层级。 */
function toSymbol(document: vscode.TextDocument, symbol: OutlineSymbol): vscode.DocumentSymbol {
  const kinds = { element: vscode.SymbolKind.Object, template: vscode.SymbolKind.Function, module: vscode.SymbolKind.Module, file: vscode.SymbolKind.File };
  const result = new vscode.DocumentSymbol(symbol.name, symbol.detail ?? '', kinds[symbol.kind], toRange(document, symbol.range), toRange(document, symbol.selectionRange));
  result.children = symbol.children?.map((child) => toSymbol(document, child)) ?? [];
  return result;
}

/** 普通文本统一转义，语言插件不能注入命令链接或 HTML。 */
function toMarkdown(text: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  markdown.appendText(text);
  return markdown;
}

/** 从当前缓冲区建立请求，支持未保存文档和虚拟工作区。 */
function toRequest(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): LanguageRequest {
  return {
    document: { uri: document.uri.toString(), languageId: document.languageId, version: document.version, text: document.getText() },
    offset: document.offsetAt(position),
    cancellation: token,
  };
}

/** 转换补全项，保留精确替换范围和显式片段格式。 */
function toCompletion(document: vscode.TextDocument, suggestion: Completion): vscode.CompletionItem {
  const kinds = { tag: vscode.CompletionItemKind.Class, attribute: vscode.CompletionItemKind.Property, value: vscode.CompletionItemKind.Value };
  const item = new vscode.CompletionItem(suggestion.label, kinds[suggestion.kind]);
  item.detail = suggestion.detail;
  item.documentation = toMarkdown(suggestion.documentation);
  item.insertText = suggestion.insertTextFormat === 'snippet' ? new vscode.SnippetString(suggestion.insertText) : suggestion.insertText;
  item.range = toRange(document, suggestion.range);
  return item;
}

/** 打开真实目标缓冲区，返回包含精确来源范围的定义链接。 */
async function toDefinition(document: vscode.TextDocument, definition: Definition): Promise<vscode.DefinitionLink | undefined> {
  try {
    const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(definition.uri));
    if (definition.version !== undefined && target.version !== definition.version) return undefined;
    const range = toRange(target, definition.range);
    return { originSelectionRange: toRange(document, definition.originRange), targetUri: target.uri, targetRange: range, targetSelectionRange: range };
  } catch {
    // 目标文件可能在请求过程中被删除，其余候选仍可使用。
    return undefined;
  }
}

/** 重命名和灯泡修复共用草稿版本、原始文本及插入快照校验。 */
export async function toWorkspaceEdit(edits: readonly TextEdit[], token: vscode.CancellationToken, preview?: string, atomicFiles = false): Promise<vscode.WorkspaceEdit | undefined> {
  const result = new vscode.WorkspaceEdit();
  const metadata = preview ? { needsConfirmation: true, label: preview } : undefined;
  const targets = new Map<vscode.TextDocument, number>();
  for (const edit of edits) {
    if (token.isCancellationRequested) return undefined;
    if (edit.create) {
      const uri = vscode.Uri.parse(edit.uri);
      let exists = false;
      try { await vscode.workspace.fs.stat(uri); exists = true; } catch { /* 创建操作只接受尚不存在的文件。 */ }
      if (exists || vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString())) throw new Error('目标文件已经存在，请重新生成修改。');
      // 直接应用的提取一次创建完整文件；原生提供器往返未还原初始内容编码，保留文本编辑兼容。
      result.createFile(uri, { overwrite: false, ...(atomicFiles ? { contents: new TextEncoder().encode(edit.newText) } : {}) }, metadata);
      if (!atomicFiles) result.insert(uri, new vscode.Position(0, 0), edit.newText, metadata);
      continue;
    }
    const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(edit.uri));
    const range = toRange(target, edit.range);
    if (edit.version !== undefined && target.version !== edit.version || edit.oldText !== undefined && target.getText(range) !== edit.oldText || edit.expectedText !== undefined && target.getText() !== edit.expectedText) throw new Error('修改目标在解析后发生变化，请重新发起操作。');
    result.replace(target.uri, range, edit.newText, metadata);
    targets.set(target, target.version);
  }
  if ([...targets].some(([target, version]) => target.version !== version)) throw new Error('解析期间目标草稿发生变化，请重新发起操作。');
  return token.isCancellationRequested ? undefined : result;
}

/** 原生预览期间持续核对只读依赖，源码变化时放弃旧预览；编辑目标另由原生版本保护。 */
export async function applyRefactorEdit(edits: readonly TextEdit[], source: vscode.CancellationTokenSource, title: string, reader?: WorkspaceReader, dependencies: readonly WorkspaceDependency[] = []): Promise<boolean | undefined> {
  const destinations = edits.map((edit) => edit.uri.replace(/\/$/, ''));
  // 排除本次会修改的文件及其目录，创建组件不能使自身预览失效。
  const readonly = dependencies.filter((item) => !destinations.some((uri) => uri === item.uri || uri.startsWith(item.uri.replace(/\/$/, '') + '/')));
  const stale = (): boolean => !!reader?.revision && readonly.some((item) => reader.revision!(item.uri) !== item.revision);
  let invalid = stale(), presenting = false;
  /** 取消和卸载使用同一原生命令，不在预览放弃后再应用旧编辑。 */
  const discard = (): void => { if (presenting) void vscode.commands.executeCommand('refactorPreview.discard').then(undefined, () => undefined); };
  const cancelled = source.token.onCancellationRequested(discard);
  const changed = reader?.onDidChange?.((uri) => {
    if (invalid || uri && !stale()) return;
    invalid = true; source.cancel();
  });
  try {
    if (invalid) throw new Error('提取依赖在生成期间发生变化，请重新发起操作。');
    const edit = await toWorkspaceEdit(edits, source.token, title, true);
    if (invalid || stale()) throw new Error('提取依赖在生成期间发生变化，请重新发起操作。');
    if (!edit || source.token.isCancellationRequested) return undefined;
    presenting = true;
    const applied = await vscode.workspace.applyEdit(edit);
    if (invalid && !applied) throw new Error('提取依赖已变化，旧预览已取消，请重新发起操作。');
    return applied;
  } finally { presenting = false; changed?.dispose(); cancelled.dispose(); }
}

/** 隔离插件请求错误，并丢弃已取消、过期或已卸载的异步结果。 */
async function invoke<T>(
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
  isActive: () => boolean,
  logger: Logger,
  label: string,
  provide: () => LanguageResult<T>,
): Promise<T | undefined> {
  if (token.isCancellationRequested || !isActive()) return undefined;
  const version = document.version;
  try {
    const result = await provide();
    if (token.isCancellationRequested || !isActive() || document.isClosed || document.version !== version) return undefined;
    return result;
  } catch (error) {
    logger.error(`${label}失败。`, error);
    return undefined;
  }
}

/** 将公共契约适配到 VS Code；底座和语言模块都不持有 VS Code 对象。 */
export function createLanguageHost(logger: Logger, reader?: WorkspaceReader): LanguageHost & {
  /** 主动说明复用已注册的定义提供器，返回真实候选及失败步骤。 */
  explainNavigation(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<NavigationReport | undefined>;
  /** 工作区检查只获取当前有效诊断端口，不绑定打开的编辑器文档。 */
  checkProviders(): readonly CheckProvider[];
} {
  /** 仅保留当前有效注册，卸载提供器时同步移除说明入口。 */
  const navigations = new Map<string, { selector: vscode.DocumentSelector; provide: (document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) => Promise<NavigationReport['providers'][number] | undefined> }>();
  const checkers = new Map<string, CheckProvider>();
  return {
    /** 每次开始检查时获取注册快照，执行期间仍核验提供器存活状态。 */
    checkProviders: () => [...checkers.values()],
    /** 每个提供器独立收集追踪，过期草稿与取消请求不展示旧报告。 */
    async explainNavigation(document, position, token) {
      const version = document.version;
      const providers: NavigationReport['providers'][number][] = [];
      for (const item of navigations.values()) {
        if (token.isCancellationRequested || document.isClosed || document.version !== version) return undefined;
        if (!vscode.languages.match(item.selector, document)) continue;
        const result = await item.provide(document, position, token);
        if (result) providers.push(result);
      }
      if (token.isCancellationRequested || document.isClosed || document.version !== version) return undefined;
      const definitions = [...new Map(providers.flatMap((provider) => provider.definitions).map((item) => [`${item.uri}:${item.range.start}:${item.range.end}`, item])).values()];
      const incomplete = providers.some((provider) => provider.steps.some((step) => step.code === 'budget' || step.code === 'error'));
      return { uri: document.uri.toString(), offset: document.offsetAt(position), definitions, providers,
        status: incomplete ? 'incomplete' : definitions.length > 1 ? 'ambiguous' : definitions.length ? 'resolved' : 'unresolved' };
    },
    /** 一次注册的所有提供器共同成功或共同回滚。 */
    register(plugin, features) {
      const resources = new DisposableStore((error) => logger.error(`[${plugin.id}] 释放提供器失败。`, error));
      let active = true;
      // 先使未完成请求失效，再释放已注册的提供器。
      const registration = { dispose: () => { active = false; resources.dispose(); } };
      const selector: vscode.DocumentSelector = plugin.languages.map((language) => ({ language }));
      try {
        const symbols = features.documentSymbols;
        if (symbols) resources.add(vscode.languages.registerDocumentSymbolProvider(selector, {
          /** 大纲使用与其他能力相同的取消、草稿版本及卸载保护。 */
          async provideDocumentSymbols(document, token) {
            const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 文档大纲`, () => symbols.provide(toRequest(document, new vscode.Position(0, 0), token)));
            return result?.map((symbol) => toSymbol(document, symbol));
          },
        }));
        const folding = features.foldingRanges;
        if (folding) resources.add(vscode.languages.registerFoldingRangeProvider(selector, {
          /** 结束偏移为半开区间，独立闭合标签行可保留在折叠区外。 */
          async provideFoldingRanges(document, _context, token) {
            const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 结构折叠`, () => folding.provide(toRequest(document, new vscode.Position(0, 0), token)));
            return result?.flatMap((item) => {
              const start = document.positionAt(item.range.start).line, end = document.positionAt(Math.max(item.range.start, item.range.end - 1)).line;
              return end > start ? [new vscode.FoldingRange(start, end, item.kind === 'comment' ? vscode.FoldingRangeKind.Comment : item.kind === 'region' ? vscode.FoldingRangeKind.Region : undefined)] : [];
            });
          },
        }));
        const selection = features.selectionRanges;
        if (selection) resources.add(vscode.languages.registerSelectionRangeProvider(selector, {
          /** 多光标共用一次结构查询，父范围由外向内构建为原生链。 */
          async provideSelectionRanges(document, positions, token) {
            const offsets = positions.map((position) => document.offsetAt(position));
            const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 结构选区`, () => selection.provide(toRequest(document, positions[0] ?? new vscode.Position(0, 0), token), offsets));
            if (!result || result.length !== positions.length) return undefined;
            return result.map((ranges, index) => {
              let parent: vscode.SelectionRange | undefined;
              for (const range of [...ranges].reverse()) parent = new vscode.SelectionRange(toRange(document, range), parent);
              return parent ?? new vscode.SelectionRange(new vscode.Range(positions[index]!, positions[index]!));
            });
          },
        }));
        const signatureHelp = features.signatureHelp;
        if (signatureHelp) resources.add(vscode.languages.registerSignatureHelpProvider(selector, {
          /** 参数说明采用安全 Markdown，取消或草稿变更后不返回旧签名。 */
          async provideSignatureHelp(document, position, token) {
            const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 参数提示`, () => signatureHelp.provide(toRequest(document, position, token)));
            if (!result) return undefined;
            const help = new vscode.SignatureHelp();
            help.signatures = result.signatures.map((item) => {
              const signature = new vscode.SignatureInformation(item.label, toMarkdown(item.documentation));
              signature.parameters = item.parameters.map((parameter) => new vscode.ParameterInformation(parameter.label, toMarkdown(parameter.documentation)));
              return signature;
            });
            help.activeSignature = 0;
            help.activeParameter = Math.min(result.activeParameter, Math.max(0, (help.signatures[0]?.parameters.length ?? 1) - 1));
            return help;
          },
        }, ...signatureHelp.triggerCharacters));
        const linkedEditing = features.linkedEditing;
        if (linkedEditing) {
          resources.add(vscode.languages.registerLinkedEditingRangeProvider(selector, {
            /** 仅转换有效快照中的关联范围，真实同步编辑和撤销由宿主管理。 */
            async provideLinkedEditingRanges(document, position, token) {
              return invoke(document, token, () => active, logger, `[${plugin.id}] 标签联动`, async () => {
                const result = await linkedEditing.provide(toRequest(document, position, token));
                return result ? new vscode.LinkedEditingRanges(result.ranges.map((range) => toRange(document, range)), result.wordPattern ? new RegExp(result.wordPattern) : undefined) : undefined;
              });
            },
          }));
        }
        if (features.autoInsertion) resources.add(registerAutoInsertion(selector, features.autoInsertion, logger));
        const highlights = features.highlights;
        if (highlights) resources.add(vscode.languages.registerDocumentHighlightProvider(selector, {
          /** 高亮保留精确范围，并丢弃已取消或旧文档版本的结果。 */
          async provideDocumentHighlights(document, position, token) {
            const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 引用高亮`, () => highlights.provide(toRequest(document, position, token)));
            return result?.map((range) => new vscode.DocumentHighlight(toRange(document, range), vscode.DocumentHighlightKind.Read));
          },
        }));
        const actions = features.codeActions;
        const selections = new Map<number, { action: CodeAction; document: vscode.TextDocument; version: number; size: number }>();
        const pendingActions = new Set<vscode.CancellationTokenSource>();
        resources.add({ dispose: () => { selections.clear(); for (const source of pendingActions) source.cancel(); pendingActions.clear(); } });
        let selectionId = 0;
        const selectCommand = `${plugin.id}.selectAction`;
        if (actions) resources.add(vscode.commands.registerCommand(selectCommand, async (id: number, supplied?: string) => {
          const selected = selections.get(id);
          selections.delete(id);
          if (!selected || selected.document.isClosed || selected.document.version !== selected.version) return;
          const input = selected.action.input;
          const choice = selected.action.choice;
          const value = input ? supplied ?? await vscode.window.showInputBox({ title: input.title, value: input.value, ...(input.prompt ? { prompt: input.prompt } : {}), validateInput: (value) => input.validate(value) }) : choice ? (await vscode.window.showQuickPick(choice.items, { title: choice.title, matchOnDescription: true }))?.value : undefined;
          if (value === undefined || !active || selected.document.version !== selected.version) return;
          const source = new vscode.CancellationTokenSource();
          pendingActions.add(source);
          try {
            const problem = input?.validate(value); if (problem) throw new Error(problem);
            const provide = () => input ? input.select(value, source.token) : choice!.select(value);
            const generated = selected.action.preview && reader?.capture ? await reader.capture(provide) : { value: await provide(), dependencies: [] };
            if (!active || selected.document.version !== selected.version) return;
            if (selected.action.preview) return await applyRefactorEdit(generated.value, source, selected.action.title, reader, generated.dependencies);
            const edit = await toWorkspaceEdit(generated.value, source.token);
            if (edit) return await vscode.workspace.applyEdit(edit);
          } catch (error) {
            logger.error('编辑操作生成失败。', error);
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : '编辑操作生成失败，请重新生成操作。');
          } finally { pendingActions.delete(source); source.dispose(); }
        }));
        if (actions) resources.add(vscode.languages.registerCodeActionsProvider(selector, {
          /** 文本和跨文件修改使用原生 CodeAction，编辑器负责应用及撤销。 */
          async provideCodeActions(document, range, context, token) {
            return invoke(document, token, () => active, logger, `[${plugin.id}] 快速修复`, async () => {
              const kind = context.only?.contains(vscode.CodeActionKind.RefactorExtract) && !context.only.contains(vscode.CodeActionKind.QuickFix) ? 'refactor.extract' : context.only?.contains(vscode.CodeActionKind.QuickFix) && !context.only.contains(vscode.CodeActionKind.RefactorExtract) ? 'quickfix' : undefined;
              const result = await actions.provide(toRequest(document, range.start, token), { start: document.offsetAt(range.start), end: document.offsetAt(range.end) }, kind);
              const converted: vscode.CodeAction[] = [];
              for (const item of result) {
                const kind = item.kind === 'quickfix' ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.RefactorExtract;
                if (context.only && !context.only.contains(kind)) continue;
                const action = new vscode.CodeAction(item.title, kind);
                if (item.disabled) { action.disabled = { reason: item.disabled }; converted.push(action); continue; }
                if (item.choice || item.input) {
                  const id = ++selectionId;
                  // 清除过期动作并限制保留文本，避免重构选区积累旧草稿快照。
                  for (const [key, record] of selections) if (record.document.isClosed || record.document.version !== record.version) selections.delete(key);
                  const size = document.getText().length;
                  let retained = [...selections.values()].reduce((sum, record) => sum + record.size, 0);
                  while (selections.size && (selections.size >= 64 || retained + size > 4_000_000)) {
                    const key = selections.keys().next().value!; retained -= selections.get(key)!.size; selections.delete(key);
                  }
                  selections.set(id, { action: item, document, version: document.version, size });
                  action.command = { command: selectCommand, title: item.title, arguments: [id] };
                } else {
                  const edit = await toWorkspaceEdit(item.edits, token, item.preview ? item.title : undefined);
                  if (!edit) return [];
                  action.edit = edit;
                }
                converted.push(action);
              }
              return converted;
            });
          },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorExtract] }));
        const references = features.references;
        if (references) resources.add(vscode.languages.registerReferenceProvider(selector, {
          /** 原生引用面板只接收已确认位置，读取目标后再次核对版本和取消信号。 */
          async provideReferences(document, position, context, token) {
            return invoke(document, token, () => active, logger, `[${plugin.id}] 引用查找`, async () => {
              const result = await references.provide(toRequest(document, position, token), context.includeDeclaration);
              const locations: vscode.Location[] = [];
              for (const item of result) {
                if (token.isCancellationRequested || !active) return [];
                try {
                  const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri));
                  if (item.version !== undefined && target.version !== item.version) continue;
                  locations.push(new vscode.Location(target.uri, toRange(target, item.range)));
                } catch { /* 目标在查询期间被删除时保留其余有效引用。 */ }
              }
              return locations;
            });
          },
        }));
        const rename = features.rename;
        if (rename) resources.add(vscode.languages.registerRenameProvider(selector, {
          /** 准备阶段确认完整名称范围，未解析的普通文本拒绝重命名。 */
          async prepareRename(document, position, token) {
            const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 重命名准备`, () => rename.prepare(toRequest(document, position, token)));
            if (!result) throw new Error('当前位置没有可静态确认的重命名符号。');
            return { range: toRange(document, result.range), placeholder: result.name };
          },
          /** 返回原生工作区编辑，Cursor 自动提供预览和撤销；过期草稿不得修改。 */
          async provideRenameEdits(document, position, newName, token) {
            const version = document.version;
            const edits = await rename.provide(toRequest(document, position, token), newName);
            if (token.isCancellationRequested || !active || document.version !== version) return undefined;
            const result = await toWorkspaceEdit(edits, token);
            return token.isCancellationRequested || !active || document.version !== version ? undefined : result;
          },
        }));
        const diagnostics = features.diagnostics;
        if (diagnostics) {
          checkers.set(plugin.id, { id: plugin.id, name: plugin.displayName, languages: plugin.languages, active: () => active, provide: (request) => diagnostics.provide(request) });
          resources.add({ dispose: () => checkers.delete(plugin.id) });
          const collection = resources.add(vscode.languages.createDiagnosticCollection(plugin.id));
          const pending = new Map<string, { source: vscode.CancellationTokenSource; timer: ReturnType<typeof setTimeout> }>();
          const dependencies = new Map<string, readonly WorkspaceDependency[]>();
          /** 连续编辑合并检查，旧请求取消后不得覆盖新诊断。 */
          const schedule = (document: vscode.TextDocument): void => {
            if (!vscode.languages.match(selector, document)) return;
            const uri = document.uri.toString();
            const previous = pending.get(uri);
            if (previous) { clearTimeout(previous.timer); previous.source.cancel(); previous.source.dispose(); }
            const source = new vscode.CancellationTokenSource();
            const timer = setTimeout(async () => {
              const result = await invoke(document, source.token, () => active, logger, `[${plugin.id}] 语言诊断`, async () => {
                const provide = () => diagnostics.provide(toRequest(document, new vscode.Position(0, 0), source.token));
                return reader?.capture ? reader.capture(provide) : { value: await provide(), dependencies: [] };
              });
              if (pending.get(uri)?.source !== source) return;
              if (result?.dependencies.some((dependency) => reader?.revision?.(dependency.uri) !== dependency.revision)) {
                pending.delete(uri); source.dispose(); schedule(document); return;
              }
              if (result) {
                if (result.dependencies.length) dependencies.set(uri, result.dependencies); else dependencies.delete(uri);
                collection.set(document.uri, result.value.map((item) => {
                const diagnostic = new vscode.Diagnostic(toRange(document, item.range), item.message, item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                if (item.code) diagnostic.code = item.code;
                diagnostic.source = plugin.displayName;
                return diagnostic;
                }));
              }
              pending.delete(uri); source.dispose();
            }, 300);
            pending.set(uri, { source, timer });
          };
          resources.add(vscode.workspace.onDidOpenTextDocument(schedule));
          if (reader?.onDidChange) resources.add(reader.onDidChange((uri) => {
            for (const document of vscode.workspace.textDocuments) {
              const own = dependencies.get(document.uri.toString());
              if (!uri || document.uri.toString() === uri || !own || own.some((dependency) => reader.revision?.(dependency.uri) !== dependency.revision)) schedule(document);
            }
          }));
          resources.add(vscode.workspace.onDidChangeTextDocument((event) => {
            schedule(event.document);
            if (diagnostics.dependencyLanguages?.includes(event.document.languageId)) {
              for (const document of vscode.workspace.textDocuments) {
                if (document === event.document) continue;
                const own = dependencies.get(document.uri.toString());
                if (!own || own.some((dependency) => reader?.revision?.(dependency.uri) !== dependency.revision)) schedule(document);
              }
            }
          }));
          resources.add(vscode.workspace.onDidCloseTextDocument((document) => {
            const uri = document.uri.toString();
            const item = pending.get(uri);
            if (item) { clearTimeout(item.timer); item.source.cancel(); item.source.dispose(); pending.delete(uri); }
            collection.delete(document.uri);
            dependencies.delete(uri);
            if (diagnostics.dependencyLanguages?.includes(document.languageId)) for (const opened of vscode.workspace.textDocuments) {
              const own = dependencies.get(opened.uri.toString());
              if (!own || own.some((dependency) => reader?.revision?.(dependency.uri) !== dependency.revision)) schedule(opened);
            }
          }));
          resources.add({ dispose: () => { for (const item of pending.values()) { clearTimeout(item.timer); item.source.cancel(); item.source.dispose(); } pending.clear(); dependencies.clear(); } });
          for (const document of vscode.workspace.textDocuments) schedule(document);
        }
        const definition = features.definition;
        if (definition) {
          navigations.set(plugin.id, { selector,
            /** 目标检查与原生 F12 使用同一转换，已删除或过期目标不会进入报告。 */
            async provide(document, position, token) {
              const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 导航说明`, async () => {
                const provide = async () => {
                  const valid: Definition[] = [];
                  for (const item of await definition.provide(toRequest(document, position, token))) {
                    if (token.isCancellationRequested || !active) return [];
                    if (await toDefinition(document, item)) valid.push(item);
                    else reader?.navigation?.record({ code: 'missing', message: '定义目标不存在或草稿版本已变化，已排除该候选。', uri: item.uri });
                  }
                  return valid;
                };
                return reader?.navigation ? reader.navigation.capture(provide) : { value: await provide(), steps: [] };
              });
              if (token.isCancellationRequested || !active) return undefined;
              return { name: plugin.displayName, definitions: result?.value ?? [], steps: result?.steps ?? [{ code: 'error', message: '解析器执行失败，请查看 miniapp 输出中的错误信息。' }] };
            },
          });
          resources.add({ dispose: () => navigations.delete(plugin.id) });
          resources.add(vscode.languages.registerDefinitionProvider(selector, {
            /** 解析与异步目标转换共同受取消、版本和卸载保护。 */
            async provideDefinition(document, position, token) {
              return invoke(document, token, () => active, logger, `[${plugin.id}] 定义跳转`, async () => {
                const result = await definition.provide(toRequest(document, position, token));
                if (token.isCancellationRequested || !active) return [];
                const links = await Promise.all(result.map((item) => toDefinition(document, item)));
                return links.filter((item): item is vscode.DefinitionLink => item !== undefined);
              });
            },
          }));
        }
        const completion = features.completion;
        if (completion) {
          resources.add(vscode.languages.registerCompletionItemProvider(selector, {
            /** 仅在请求仍有效时转换语言插件结果。 */
            async provideCompletionItems(document, position, token) {
              const items = await invoke(document, token, () => active, logger, `[${plugin.id}] 补全`,
                () => completion.provide(toRequest(document, position, token)));
              return items?.map((item) => toCompletion(document, item));
            },
          }, ...completion.triggerCharacters));
        }
        const hover = features.hover;
        if (hover) {
          resources.add(vscode.languages.registerHoverProvider(selector, {
            /** 悬浮内容省略空标题，统一使用不受信任的普通文本渲染。 */
            async provideHover(document, position, token) {
              const result = await invoke(document, token, () => active, logger, `[${plugin.id}] 悬浮`,
                () => hover.provide(toRequest(document, position, token)));
              return result ? new vscode.Hover(toMarkdown([result.title, result.description].filter(Boolean).join('\n\n')), toRange(document, result.range)) : undefined;
            },
          }));
        }
        return registration;
      } catch (error) {
        registration.dispose();
        throw error;
      }
    },
  };
}
