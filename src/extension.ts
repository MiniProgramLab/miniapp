import * as vscode from 'vscode';
import type { LanguageFeatures, Logger, MiniAppApi, ScriptAdapter, WorkspaceReader } from './api';
import { createComputeServices } from './compute-services';
import { createLanguageHost } from './adapters/vscode/language-host';
import { createWorkspaceReader } from './adapters/vscode/workspace-reader';
import { registerFileOperations } from './adapters/vscode/file-operations';
import { registerNavigationExplanation } from './adapters/vscode/navigation-report';
import { registerWorkspaceCheck } from './adapters/vscode/workspace-check';
import { PluginRuntime } from './core/plugin-runtime';
import { createCssModule } from './languages/css';
import { createComponentResolver, createDatasetFeatures, createInstanceFeatures, createNavigatorPlugin, createRenameFeatures, createRouteContextResolver, createTemplateResolver, createWxmlPlugin, navigatorAccesses, templateFileReferences } from './languages/wxml';
import { createDataPathPlugin, createScriptNavigationPlugin, createWxsPlugin } from './languages/typescript';
import { createFileNavigationPlugin, createFileOperations, createProjectFileResolver, createRoutePlugin, createRouteResolver } from './resolution';

/** 唯一组合入口：组装宿主、底座与内置插件，并返回外部注册 API。 */
export function activate(context: vscode.ExtensionContext): MiniAppApi {
  const output = vscode.window.createOutputChannel('miniapp', { log: true });
  const logger: Logger = {
    info: (message) => output.info(message),
    error: (message, error) => output.error(message, error instanceof Error ? error : String(error ?? '')),
  };
  let cleanupRuntime: PluginRuntime | undefined;
  try {
    const workspace = createWorkspaceReader(context.subscriptions);
    const host = createLanguageHost(logger, workspace);
    const runtime = cleanupRuntime = new PluginRuntime(host, logger);
    context.subscriptions.push(registerNavigationExplanation(host, output));
    context.subscriptions.push(registerWorkspaceCheck(host, workspace, output));
    const compute = createComputeServices({ reader: { ...workspace, fileResolver: (uri, cancellation) => createProjectFileResolver(workspace, uri, cancellation) }, logger,
      filename: vscode.Uri.joinPath(context.extensionUri, 'dist', 'compute-worker.cjs').fsPath,
      roots: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()) ?? [],
      settings: (uri) => {
        const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri));
        const base = { maxFiles: settings.get<number>('maxScriptFiles', 400), maxDepth: settings.get<number>('maxScriptDepth', 12), adapters: settings.get<ScriptAdapter[]>('adapters', []) };
        const libraryUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'typescript-lib', 'lib.es5.d.ts').toString();
        return { script: { ...base, maxRenameFiles: settings.get<number>('maxRenameFiles', 5000), libraryUri }, component: base,
          dataPath: { ...base, libraryUri }, wxs: { maxFiles: base.maxFiles, maxDepth: base.maxDepth }, navigation: { maxDepth: base.maxDepth } };
      },
    });
    context.subscriptions.push(compute);
    /** 只为可见 WXML/WXS 准备编译器，不在激活阶段扫描工作区。 */
    const prepare = (): void => { if (vscode.window.visibleTextEditors.some((editor) => ['wxml', 'wxs'].includes(editor.document.languageId))) compute.prepare(); };
    const preparation = setImmediate(prepare);
    preparation.unref();
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(prepare), { dispose: () => clearImmediate(preparation) });
    const reader: WorkspaceReader = { ...workspace, fileResolver: compute.fileResolver };
    const css = createCssModule(reader, (uri) => {
      const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.css', vscode.Uri.parse(uri));
      return { sourceRoot: settings.get<string>('sourceRoot', ''), includePaths: settings.get<string[]>('includePaths', []), maxFiles: settings.get<number>('maxFiles', 300), maxDepth: settings.get<number>('maxDepth', 12) };
    });
    runtime.register(css.plugin);
    runtime.register(compute.plugin(createFileNavigationPlugin(reader), 'fileNavigation', ['definition']));
    const scripts = compute.scripts;
    const templates = createTemplateResolver(reader, scripts, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxTemplateFiles', 500),
    }));
    runtime.register(compute.plugin(createDataPathPlugin(reader, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptFiles', 400),
      maxDepth: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptDepth', 12),
      adapters: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<ScriptAdapter[]>('adapters', []),
      libraryUri: vscode.Uri.joinPath(context.extensionUri, 'dist', 'typescript-lib', 'lib.es5.d.ts').toString(),
    })), 'dataPath', ['completion', 'definition', 'hover', 'diagnostics']));
    /** 消费图与既有组件提示共用解析设置，草稿快照通过读取端口注入。 */
    const componentScripts = (snapshot: WorkspaceReader) => compute.components(snapshot);
    /** 不同请求可注入独立快照，源码根与框架适配保持同一规则。 */
    const componentFactory = (snapshot: WorkspaceReader) => createComponentResolver(snapshot, componentScripts, (uri) => {
      const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri));
      return { sourceRoot: settings.get<string>('sourceRoot', ''), includePaths: settings.get<string[]>('includePaths', []), maxFiles: settings.get<number>('maxScriptFiles', 400), maxTemplateFiles: settings.get<number>('maxTemplateFiles', 500) };
    });
    const components = componentFactory(reader);
    const routeContexts = createRouteContextResolver(reader, componentFactory, componentScripts, scripts, (uri) => ({ maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxTemplateFiles', 500) }));
    const routes = createRouteResolver(reader, scripts, routeContexts, compute.routeDocuments);
    context.subscriptions.push(registerFileOperations(reader, createFileOperations(reader, (request) => request.document.languageId === 'wxml' ? templateFileReferences(request) : ['css', 'wxss', 'scss', 'less'].includes(request.document.languageId) ? css.references(request) : [], (uri) => ({ maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxRenameFiles', 5000) }), async (request, files, moves) => {
      const { routeFileEdits } = await import('./resolution/route-file-edits');
      return routeFileEdits(reader, scripts, routes, navigatorAccesses, request, files, moves);
    }), logger));
    runtime.register(createRoutePlugin(scripts, routes, compute.routeDocuments));
    runtime.register(createNavigatorPlugin(routes));
    const instances = createInstanceFeatures(reader, templates, compute.components(reader), components);
    const rename = createRenameFeatures(reader, templates, components, (uri) => ({ maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxRenameFiles', 5000) }), instances);
    const dataset = createDatasetFeatures(reader, templates, rename.references);
    runtime.register({ id: 'miniprogramlab.component-instances', displayName: '组件实例语义', languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      /** 实例功能沿用公开语言端口，不替换编辑器原生 TS/JS 提供器。 */
      setup: () => instances,
    });
    /** dataset 先确认事件字段，其他符号继续沿用既有重命名规则。 */
    const semanticRename: NonNullable<LanguageFeatures['rename']> = {
      prepare: async (request) => await dataset.rename?.prepare(request) ?? rename.prepare(request),
      provide: async (request, name) => await dataset.rename?.prepare(request) ? dataset.rename!.provide(request, name) : rename.provide(request, name),
    };
    runtime.register({ id: 'miniprogramlab.dataset', displayName: '事件节点 dataset 语义', languages: ['wxml', 'typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      /** 提供器沿用原生交互，重命名与脚本和模板的既有提供器组合。 */
      setup: () => { const { rename: _rename, ...features } = dataset; return features; },
    });
    runtime.register(compute.plugin(createScriptNavigationPlugin(reader, semanticRename, rename.references, (uri) => ({
      maxDepth: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptDepth', 12),
    })), 'navigation', ['definition']));
    runtime.register(compute.plugin(createWxsPlugin(reader, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptFiles', 400),
      maxDepth: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptDepth', 12),
    }), rename, rename.references), 'wxs', ['definition', 'hover', 'completion', 'signatureHelp', 'diagnostics', 'highlights']));
    runtime.register(createWxmlPlugin(css.classes, templates, (uri) => ({
      autoClosingTags: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<boolean>('autoClosingTags', true),
      customData: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<string[]>('customData', []),
      sdkVersion: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<string>('sdkVersion', ''),
    }), components, reader, semanticRename, rename.references, rename.highlights));
    const command = vscode.commands.registerCommand('miniprogramlab.miniapp.showPlugins', () => {
      const rows = runtime.getPlugins().map((plugin) => `${plugin.displayName} · ${plugin.id} · ${plugin.languages.join(', ')}`);
      output.info(`已注册语言插件（${rows.length}）：\n${rows.join('\n')}`);
      output.show(true);
    });
    // 先释放插件和命令，最后关闭日志，保留清理过程中的错误信息。
    context.subscriptions.push({ dispose: () => {
      command.dispose(); runtime.dispose(); output.dispose();
    } });
    return runtime.createApi();
  } catch (error) {
    cleanupRuntime?.dispose();
    output.dispose();
    throw error;
  }
}
