import * as vscode from 'vscode';
import type { LanguageFeatures, Logger, MiniAppApi, ScriptAdapter, WorkspaceReader } from './api';
import { createLanguageHost } from './adapters/vscode/language-host';
import { createWorkspaceReader } from './adapters/vscode/workspace-reader';
import { registerFileOperations } from './adapters/vscode/file-operations';
import { registerNavigationExplanation } from './adapters/vscode/navigation-report';
import { registerWorkspaceCheck } from './adapters/vscode/workspace-check';
import { PluginRuntime } from './core/plugin-runtime';
import { createCssModule } from './languages/css';
import { createComponentResolver, createDatasetFeatures, createInstanceFeatures, createNavigatorPlugin, createRenameFeatures, createRouteContextResolver, createTemplateResolver, createWxmlPlugin, navigatorAccesses, templateFileReferences } from './languages/wxml';
import { createComponentScriptResolver, createDataPathPlugin, createScriptResolver, createScriptNavigationPlugin, createWxsPlugin } from './languages/typescript';
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
    const reader: WorkspaceReader = { ...workspace, fileResolver: (uri, cancellation) => createProjectFileResolver(workspace, uri, cancellation) };
    const css = createCssModule(reader, (uri) => {
      const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.css', vscode.Uri.parse(uri));
      return { sourceRoot: settings.get<string>('sourceRoot', ''), includePaths: settings.get<string[]>('includePaths', []), maxFiles: settings.get<number>('maxFiles', 300) };
    });
    runtime.register(css.plugin);
    runtime.register(createFileNavigationPlugin(reader));
    const scripts = createScriptResolver(reader, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptFiles', 400),
      maxRenameFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxRenameFiles', 5000),
      adapters: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<ScriptAdapter[]>('adapters', []),
      libraryUri: vscode.Uri.joinPath(context.extensionUri, 'dist', 'typescript-lib', 'lib.es5.d.ts').toString(),
    }));
    const templates = createTemplateResolver(reader, scripts, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxTemplateFiles', 500),
    }));
    runtime.register(createDataPathPlugin(reader, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptFiles', 400),
      adapters: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<ScriptAdapter[]>('adapters', []),
      libraryUri: vscode.Uri.joinPath(context.extensionUri, 'dist', 'typescript-lib', 'lib.es5.d.ts').toString(),
    })));
    /** 消费图与既有组件提示共用解析设置，草稿快照通过读取端口注入。 */
    const componentScripts = (snapshot: WorkspaceReader) => createComponentScriptResolver(snapshot, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptFiles', 400),
      adapters: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<ScriptAdapter[]>('adapters', []),
    }));
    /** 不同请求可注入独立快照，源码根与框架适配保持同一规则。 */
    const componentFactory = (snapshot: WorkspaceReader) => createComponentResolver(snapshot, componentScripts, (uri) => {
      const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri));
      return { sourceRoot: settings.get<string>('sourceRoot', ''), includePaths: settings.get<string[]>('includePaths', []), maxFiles: settings.get<number>('maxScriptFiles', 400), maxTemplateFiles: settings.get<number>('maxTemplateFiles', 500) };
    });
    const components = componentFactory(reader);
    const routeContexts = createRouteContextResolver(reader, componentFactory, componentScripts, scripts, (uri) => ({ maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxTemplateFiles', 500) }));
    const routes = createRouteResolver(reader, scripts, routeContexts);
    context.subscriptions.push(registerFileOperations(reader, createFileOperations(reader, (request) => request.document.languageId === 'wxml' ? templateFileReferences(request) : ['css', 'wxss', 'scss', 'less'].includes(request.document.languageId) ? css.references(request) : [], (uri) => ({ maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxRenameFiles', 5000) }), async (request, files, moves) => {
      const { routeFileEdits } = await import('./resolution/route-file-edits');
      return routeFileEdits(reader, scripts, routes, navigatorAccesses, request, files, moves);
    }), logger));
    runtime.register(createRoutePlugin(scripts, routes));
    runtime.register(createNavigatorPlugin(routes));
    const instances = createInstanceFeatures(reader, templates, createComponentScriptResolver(reader, (uri) => ({
      maxFiles: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<number>('maxScriptFiles', 400),
      adapters: vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', vscode.Uri.parse(uri)).get<ScriptAdapter[]>('adapters', []),
    })), components);
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
    runtime.register(createScriptNavigationPlugin(reader, semanticRename, rename.references));
    runtime.register(createWxsPlugin(reader, () => ({}), rename, rename.references));
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
