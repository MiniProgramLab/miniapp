import type { Definition, FileReference, LanguagePlugin, LanguageRequest, StyleClassResolver, WorkspaceReader } from '../../api';
import { clearStylesheetCache, parseStylesheet, referenceAt } from './parser';
import { StyleProject } from './project';
import type { CssOptions } from './types';

/** CSS 模块对外只暴露插件入口及模板需要的最小类名解析端口。 */
export interface CssModule {
  readonly plugin: LanguagePlugin;
  readonly classes: StyleClassResolver;
  /** 关联文件操作读取同一份样式语法索引。 */
  references(request: LanguageRequest): readonly FileReference[];
}

/** 由组合入口注入文件读取和配置，不依赖其他语言模块。 */
export function createCssModule(reader: WorkspaceReader, options: (uri: string) => CssOptions = () => ({})): CssModule {
  /** 导入路径跳到文件，成员引用则继续穿透至原始声明。 */
  const definition = async (request: LanguageRequest): Promise<readonly Definition[]> => {
    const project = new StyleProject(reader, request, options(request.document.uri));
    const index = await project.index(request.document.uri);
    if (!index) return [];
    const edge = index.imports.find((item) => request.offset >= item.range.start && request.offset <= item.range.end);
    if (edge) return (await project.targets(index, edge)).map((target) => ({ uri: target.uri, range: { start: 0, end: 0 }, originRange: edge.range }));
    const reference = referenceAt(index, request.offset);
    return reference ? project.resolveSymbol(index, reference) : [];
  };
  return {
    references(request) {
      const index = parseStylesheet(request.document.uri, request.document);
      return index.imports.map((edge) => {
        const token = index.tokens.findIndex((token) => token.kind === 'string' && token.start + 1 === edge.range.start);
        return { reference: edge.reference, range: edge.range, kind: 'style', extensions: ['.scss', '.less', '.css', '.wxss', '/index.scss', '/_index.scss'], ...(edge.kind === 'use' && token >= 0 && index.tokens[token + 1]?.value !== 'as' ? { implicitNamespace: edge.namespace } : {}) };
      });
    },
    plugin: {
      id: 'miniprogramlab.css', displayName: 'CSS 引用链语言支持', languages: ['css', 'wxss', 'scss', 'less'],
      /** 标准 CSS 的高亮和基础补全继续由编辑器内置能力提供。 */
      setup({ subscriptions }) {
        subscriptions.add({ dispose: clearStylesheetCache });
        return { definition: { provide: definition } };
      },
    },
    classes: {
      /** 组件提取请求完整图与选择器，不复用可接受部分结果的导航遍历。 */
      extractionStyles: (request, includeGlobal) => new StyleProject(reader, request, options(request.document.uri)).extractionStyles(includeGlobal),
      /** 模板传入完整类名，CSS 模块负责样式根和引用链解析。 */
      async resolveClass(request, name, range) {
        const project = new StyleProject(reader, request, options(request.document.uri));
        return project.collect(await project.templateRoots(), { name, kind: 'class', range });
      },
      /** 补全与定位使用相同文件图，支持嵌套类名和未保存样式。 */
      async completeClass(request, prefix, range) {
        const project = new StyleProject(reader, request, options(request.document.uri));
        return project.completeClasses(prefix, range);
      },
    },
  };
}
