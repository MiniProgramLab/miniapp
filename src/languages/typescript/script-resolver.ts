import type { LanguageRequest, ScriptDefinitionResolver, TemplateExpression, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { query, queryContext } from './query';
import type { ScriptDefinition } from './query';
import { queryWxs } from './wxs';
import { renameScript, scriptSymbols } from './rename';
import { completeTemplate } from './completion';
import { analyzeTemplate, valueType } from './analysis';
import { evaluate } from './template-values';
import { signatureWxs, checkWxsCalls } from './wxs-calls';
import { diagnoseWxs } from './wxs-checks';
import { registerComponent } from './config-edits';
import { expressionNames } from './expression-names';
import { componentExtractionScope, extractComponentParent } from './refactor';
import { datasetAccess, datasetUses } from './dataset';
import { instanceAccess, instanceQueries, instanceTemplates } from './instances';
import { routeQueries, routeManifest, pageQuery } from './routes';

/** 提供独立脚本语义端口，语言消费者无需依赖 TypeScript 或 VS Code。 */
export function createScriptResolver(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({})): ScriptDefinitionResolver {
  /** 导航和悬浮共用声明链；同一请求的多个模板调用点共享页面 Program。 */
  async function definitions(request: LanguageRequest, expression: TemplateExpression, hover = false, rename = false): Promise<readonly ScriptDefinition[]> {
    const wxs = await queryWxs(reader, request, expression, options(request.document.uri), rename);
    if (wxs) return wxs.definitions;
    const projects = new Map<string, ScriptProject>();
    const result = new Map<string, ScriptDefinition>();
    const contexts = expression.contexts?.length ? expression.contexts : [{ uri: request.document.uri, scopes: undefined }];
    for (const context of contexts) {
      if (request.cancellation.isCancellationRequested) return [];
      let project = projects.get(context.uri);
      if (!project) {
        const source = { ...request, document: { ...request.document, uri: context.uri } };
        project = new ScriptProject(reader, source, options(context.uri));
        projects.set(context.uri, project);
      }
      for (const definition of await query(project, request, expression, context.scopes, hover, rename)) {
        result.set(`${definition.uri}:${definition.range.start}:${definition.range.end}`, definition);
      }
    }
    return [...result.values()];
  }
  return {
    /** 依赖名称仅做语法解析，不为提取模板建立整个页面类型图。 */
    expressionNames,
    /** 调用提示只解析实际 WXS 模块及其导出链。 */
    callSignature: (request, expression) => signatureWxs(reader, request, expression, options(request.document.uri)),
    /** 内联诊断仍落在当前 WXML 的原始坐标。 */
    wxsDiagnostics: (request, modules) => diagnoseWxs(reader, request, modules, options(request.document.uri)),
    /** 路由静态求值共享已有脚本图和配置适配。 */
    routeQueries: (request, all) => routeQueries(reader, request, options(request.document.uri), all),
    /** 配置与页面查询各自使用目标文件所属的解析设置。 */
    routeManifest: (request, uri) => routeManifest(reader, request, uri, options(uri)),
    /** 参数声明只输出完整图中可确认的静态字段。 */
    pageQuery: (request, uri) => pageQuery(reader, request, uri, options(uri)),
    /** 组件实例不执行页面代码，静态选择器由脚本端口提供。 */
    instanceAccess: (request) => instanceAccess(reader, request, options(request.document.uri)),
    /** 诊断共享当前 Program，不按选择器重复解析脚本。 */
    instanceQueries: (request, members) => instanceQueries(reader, request, options(request.document.uri), members),
    /** 消费模板先按模块链筛选，再由实例提供器核对函数身份。 */
    instanceTemplates: (request, owner) => instanceTemplates(reader, request, owner, options(request.document.uri)),
    /** dataset 查询只解析脚本，事件节点和模板值由模板模块确认。 */
    datasetAccess: (request) => datasetAccess(reader, request, options(request.document.uri)),
    /** 静态使用扫描限定真实处理函数及其捕获事件参数的回调。 */
    datasetUses: (request, handler) => datasetUses(reader, request, handler, options(request.document.uri)),
    /** 注册修改使用与补全相同的静态配置和框架规则。 */
    registerComponent: (request, name, reference) => registerComponent(reader, request, name, reference, options(request.document.uri)),
    /** 组件提取只在用户确认名称后分析父级方法表。 */
    extractComponentParent: (request, name, reference, handlers) => extractComponentParent(reader, request, name, reference, handlers, options(request.document.uri)),
    /** 提取上下文只在生成组件时读取，不增加普通模板查询成本。 */
    componentExtractionScope: (request) => componentExtractionScope(reader, request, options(request.document.uri)),
    /** 多个调用页面只报告共同可证明的名称错误，参数类型保留全部分支。 */
    async analyze(request, expression) {
      const contexts = expression.contexts ?? [{ uri: request.document.uri, scopes: undefined }];
      const results: import('../../api').ExpressionInfo[] = [];
      for (const context of contexts) {
        const project = new ScriptProject(reader, { ...request, document: { ...request.document, uri: context.uri } }, options(context.uri));
        const scope = await queryContext(project, request, expression, context.scopes);
        const result = await analyzeTemplate(project, request, expression, context.scopes, scope);
        const calls = expression.modules?.length ? await checkWxsCalls(reader, request, expression, options(request.document.uri), scope ? (argument) => valueType(scope.values, evaluate(argument, scope.roots, scope.values, { uri: request.document.uri, offset: expression.range.start, prefix: expression.objectLiteral ? 2 : 1 })) : undefined) : [];
        if (request.cancellation.isCancellationRequested) return undefined;
        if (!result && !calls.length) return undefined;
        results.push(result ? { ...result, diagnostics: [...result.diagnostics, ...calls] } : { type: { kind: 'unknown', display: 'unknown' }, diagnostics: calls, actions: [] });
      }
      if (!results.length) return undefined;
      const diagnostics = results[0]!.diagnostics.filter((item) => results.every((result) => result.diagnostics.some((other) => other.range.start === item.range.start && other.code === item.code)));
      const actions = results.flatMap((result) => result.actions).filter((action) => diagnostics.some((item) => item.range.start === action.range.start));
      const types = [...new Map(results.map((result) => [result.type.display, result.type])).values()];
      return { type: types.length === 1 ? types[0]! : { kind: 'unknown' as const, display: types.map((type) => type.display).join(' | '), alternatives: types }, diagnostics, actions };
    },
    /** 导航不泄露仅供参数校验使用的签名数据。 */
    async resolve(request, expression) {
      return (await definitions(request, expression)).map(({ signature: _signature, ...definition }) => definition);
    },
    /** 重命名使用暴露字段，保留方法别名背后函数的原始名称。 */
    symbols: (request, expression) => definitions(request, expression, false, true),
    /** 模块成员优先处理，普通字段沿真实调用上下文合并候选。 */
    async complete(request, expression) {
      const wxs = await queryWxs(reader, request, expression, options(request.document.uri));
      if (wxs) return wxs.completions;
      const result = new Map<string, import('../../api').Completion>();
      const contexts = expression.contexts ?? [{ uri: request.document.uri, scopes: undefined }];
      for (const context of contexts) {
        if (request.cancellation.isCancellationRequested) return [];
        const project = new ScriptProject(reader, { ...request, document: { ...request.document, uri: context.uri } }, options(context.uri));
        for (const item of await completeTemplate(project, request, expression, context.scopes)) {
          const previous = result.get(item.label);
          result.set(item.label, previous ? { ...previous, detail: [...new Set([previous.detail, item.detail])].join(' | '), documentation: [...new Set([previous.documentation, item.documentation])].filter(Boolean).join('\n') } : item);
        }
      }
      return [...result.values()];
    },
    /** 只返回已解析的函数实现签名。 */
    async signature(request, expression) { return (await definitions(request, expression)).flatMap((item) => item.signature ? [item.signature] : []); },
    /** 脚本中的普通名称及静态事件名均可作为重命名起点。 */
    scriptSymbols: (request) => scriptSymbols(reader, request, options(request.document.uri)),
    /** 原生脚本重命名与小程序静态字段使用同一读取快照。 */
    rename: (request, targets, newName) => renameScript(reader, request, targets, newName, options(request.document.uri)),
    /** 引用查找沿用现有字段遍历，并通过原生语言服务保持别名关系。 */
    async references(request, targets, includeDeclaration) {
      return (await renameScript(reader, request, targets, '', options(request.document.uri), includeDeclaration)).map(({ uri, range, version }) => ({ uri, range, ...(version === undefined ? {} : { version }) }));
    },
    /** 无注释时不生成空提示；多个实际调用页面的说明按文本去重。 */
    async hover(request, expression) {
      const wxs = await queryWxs(reader, request, expression, options(request.document.uri));
      if (wxs) return wxs.hover;
      const result = await definitions(request, expression, true);
      const descriptions = [...new Set(result.map((definition) => definition.description).filter((description): description is string => !!description))];
      const range = result[0]?.originRange;
      return descriptions.length && range && !request.cancellation.isCancellationRequested
        ? { title: request.document.text.slice(range.start, range.end), description: descriptions.join('\n\n'), range } : undefined;
    },
  };
}
