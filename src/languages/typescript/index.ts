import type { ComponentScriptResolver, LanguageFeatures, LanguagePlugin, LanguageRequest, ScriptDefinitionResolver, WorkspaceReader } from '../../api';
import type { ScriptOptions } from './project';

/** 注册时仅建立轻量端口，首次有效脚本查询才加载编译器与语义模块。 */
export function createScriptResolver(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({})): ScriptDefinitionResolver {
  /** 编译器按需加载，完整 Program 通过宿主修订标识进行有界复用。 */
  let service: ScriptDefinitionResolver | undefined;
  /** 导航与注释悬浮共用延迟初始化，加载前后核对取消信号。 */
  async function load(request: LanguageRequest): Promise<ScriptDefinitionResolver | undefined> {
    if (request.cancellation.isCancellationRequested) return undefined;
    if (!service) {
      const module = await import('./script-resolver');
      if (request.cancellation.isCancellationRequested) return undefined;
      service ??= module.createScriptResolver(reader, options);
    }
    return service;
  }
  return {
    /** 页面 URL 按需初始化，不在扩展激活时读取应用配置。 */
    async routeQueries(request, all) { return await (await load(request))?.routeQueries?.(request, all) ?? []; },
    /** 配置参数追踪使用同一静态服务及取消信号。 */
    async routeManifest(request, uri) { return (await load(request))?.routeManifest?.(request, uri); },
    /** 目标页面声明类型携带读取依赖，用于查询提示的缓存校验。 */
    async pageQuery(request, uri) { return (await load(request))?.pageQuery?.(request, uri); },
    /** 组件实例来源仍由脚本符号和语法树确认。 */
    async instanceAccess(request) { return (await load(request))?.instanceAccess?.(request); },
    /** 全文件检查使用相同的延迟加载和取消信号。 */
    async instanceQueries(request, members) { return await (await load(request))?.instanceQueries?.(request, members) ?? []; },
    /** 模板反查限定当前工作区并保留扫描预算。 */
    async instanceTemplates(request, owner) { return await (await load(request))?.instanceTemplates?.(request, owner) ?? []; },
    /** dataset 语义沿用同一按需初始化的脚本端口。 */
    async datasetAccess(request) { return (await load(request))?.datasetAccess?.(request); },
    /** 引用查询保留处理函数的声明身份。 */
    async datasetUses(request, handler) { return await (await load(request))?.datasetUses?.(request, handler) ?? []; },
    /** 加载前后核对取消信号，并发请求共用一次模块初始化。 */
    async resolve(request, expression) {
      return await (await load(request))?.resolve(request, expression) ?? [];
    },
    /** 注释查询仍由脚本模块处理，模板模块无需加载编译器。 */
    async hover(request, expression) {
      return (await load(request))?.hover?.(request, expression);
    },
    /** 新能力保持延迟初始化及请求取消行为。 */
    async symbols(request, expression) { return await (await load(request))?.symbols?.(request, expression) ?? []; },
    /** WXS 成员补全复用按需加载的编译器。 */
    async complete(request, expression) { return await (await load(request))?.complete?.(request, expression) ?? []; },
    /** 自定义事件参数检查只读取实际页面方法。 */
    async signature(request, expression) { return await (await load(request))?.signature?.(request, expression) ?? []; },
    /** 参数提示与内联诊断同样保持编译器按需加载。 */
    async callSignature(request, expression) { return (await load(request))?.callSignature?.(request, expression); },
    /** 没有内联模块时不加载编译器，普通模板编辑保持轻量。 */
    async wxsDiagnostics(request, modules) { return modules.some((module) => module.inline) ? await (await load(request))?.wxsDiagnostics?.(request, modules) ?? [] : []; },
    /** 脚本起点同样受取消信号保护。 */
    async scriptSymbols(request) { return await (await load(request))?.scriptSymbols?.(request) ?? []; },
    /** 生成编辑前加载已有语义实现，不执行工程代码。 */
    async rename(request, targets, newName) { return await (await load(request))?.rename?.(request, targets, newName) ?? []; },
    /** 引用与重命名共用声明身份及静态字段解析。 */
    async references(request, targets, includeDeclaration) { return await (await load(request))?.references?.(request, targets, includeDeclaration) ?? []; },
    /** 表达式检查复用页面上下文，不提前加载编译器。 */
    async analyze(request, expression) { return (await load(request))?.analyze?.(request, expression); },
    /** 组件注册按需加载，创建与修改均由工作区编辑应用。 */
    async registerComponent(request, name, reference) { return await (await load(request))?.registerComponent?.(request, name, reference) ?? []; },
    /** 事件转发编辑沿用脚本图及配置适配，不在普通查询中加载。 */
    async extractComponentParent(request, name, reference, handlers) { return (await load(request))?.extractComponentParent?.(request, name, reference, handlers); },
    /** 组件边界复用延迟初始化和取消信号。 */
    async componentExtractionScope(request) { return (await load(request))?.componentExtractionScope?.(request); },
    /** 名称扫描只在明确选中的提取请求中初始化。 */
    async expressionNames(request, expression) { return await (await load(request))?.expressionNames?.(request, expression) ?? { names: [], complete: false }; },
  };
}

/** WXS 文件使用内置 JS 语义，保持与 WXML 内联模块相同的行为。 */
export function createWxsPlugin(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({}), rename?: LanguageFeatures['rename'], references?: LanguageFeatures['references']): LanguagePlugin {
  /** 按需查询，扩展激活不会提前加载编译器。 */
  async function query(request: LanguageRequest) {
    if (request.cancellation.isCancellationRequested) return undefined;
    const module = await import('./wxs');
    return module.queryWxs(reader, request, undefined, options(request.document.uri));
  }
  return { id: 'miniprogramlab.wxs', displayName: 'WXS 脚本语义', languages: ['wxs'],
    /** 文件补全、导航和注释共享现有 CommonJS 静态解析。 */
    setup() { return {
      ...(rename ? { rename } : {}),
      ...(references ? { references } : {}),
      highlights: {
        /** 编译器按需加载，WXS 光标移动只运行文件内查询。 */
        provide: async (request) => (await import('./navigation')).provideScriptHighlights(reader, request, options(request.document.uri)),
      },
      definition: { provide: async (request) => (await query(request))?.definitions ?? [] },
      hover: { provide: async (request) => (await query(request))?.hover },
      completion: { triggerCharacters: ['.'], provide: async (request) => (await query(request))?.completions ?? [] },
      signatureHelp: { triggerCharacters: ['(', ','], provide: async (request) => (await import('./wxs-calls')).signatureWxs(reader, request, undefined, options(request.document.uri)) },
      diagnostics: { dependencyLanguages: ['wxs'], provide: async (request) => (await import('./wxs-checks')).diagnoseWxs(reader, request, undefined, options(request.document.uri)) },
    }; },
  };
}

/** 组件注册和参数说明按需加载，与脚本导航共用同一编译器实例。 */
export function createComponentScriptResolver(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({})): ComponentScriptResolver {
  /** 同一端口复用工厂，组件语义图保持原有请求隔离。 */
  let service: ComponentScriptResolver | undefined;
  return {
    /** 已取消的组件查询不初始化编译器或读取后续文件。 */
    async inspect(request, uri, includeInstance) {
      if (request.cancellation.isCancellationRequested) return undefined;
      if (!service) {
        const module = await import('./components');
        if (request.cancellation.isCancellationRequested) return undefined;
        service ??= module.createComponentScriptResolver(reader, options);
      }
      return service.inspect(request, uri, includeInstance);
    },
  };
}

/** 提供器同步注册，定义查询异步加载语义实现，不影响原生 TS/JS 编辑。 */
export function createScriptNavigationPlugin(reader: WorkspaceReader, rename?: LanguageFeatures['rename'], references?: LanguageFeatures['references']): LanguagePlugin {
  return {
    id: 'miniprogramlab.script-navigation', displayName: '智能脚本源码导航', languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    /** 无文件解析端口或无效 URI 时沿用原有空结果。 */
    setup() {
      return { ...(rename ? { rename } : {}), ...(references ? { references } : {}), definition: { provide: async (request) => {
        if (request.cancellation.isCancellationRequested || !reader.fileResolver) return [];
        try { new URL('./', request.document.uri); } catch { return []; }
        const module = await import('./navigation');
        return request.cancellation.isCancellationRequested ? [] : module.provideScriptDefinition(reader, request);
      } } };
    },
  };
}

/** 数据路径按需加载 TypeScript，实现与原生脚本编辑器保持独立。 */
export function createDataPathPlugin(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({})): LanguagePlugin {
  let features: LanguageFeatures | undefined;
  /** 没有目标语法或已取消时不加载编译器。 */
  async function load(request: LanguageRequest) {
    if (request.cancellation.isCancellationRequested || !/setData|observers/.test(request.document.text)) return undefined;
    features ??= (await import('./data-paths')).createDataPathFeatures(reader, options);
    return features;
  }
  return { id: 'miniprogramlab.data-paths', displayName: '数据更新与观察路径', languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    /** 复用原生补全、悬浮、定义和问题面板，不替代 TS 的普通类型检查。 */
    setup: () => ({
      completion: { triggerCharacters: ['.', '[', ','], provide: async (request) => await (await load(request))?.completion?.provide(request) ?? [] },
      definition: { provide: async (request) => await (await load(request))?.definition?.provide(request) ?? [] },
      hover: { provide: async (request) => (await load(request))?.hover?.provide(request) },
      diagnostics: { dependencyLanguages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'], provide: async (request) => await (await load(request))?.diagnostics?.provide(request) ?? [] },
    }),
  };
}
