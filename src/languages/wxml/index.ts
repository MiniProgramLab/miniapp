import type { ComponentResolver, LanguageFeatures, LanguagePlugin, LanguageRequest, ScriptDefinitionResolver, StyleClassResolver, WorkspaceReader } from '../../api';
export { templateFileReferences } from './file-definition';
export { navigatorAccesses } from './routes';
import { provideClassDefinition } from './definition';
import { provideClassCompletions } from './class-completion';
import { provideFileDefinition, templateFileDiagnostics } from './file-definition';
import { scriptExpression, scriptModules } from './wxs';
import { clearStructureCache, provideSymbols, provideFolding, provideSelections } from './structure';
import { componentRefactors, templateRefactors } from './refactor';
import { provideCompletions, provideHover } from './service';
import { provideAutoClosingTag, provideLinkedTags } from './tag-editing';
import { clearTagCache, tagAt } from './parser';
import { templateCodeActions, templateDiagnostics } from './checks';
import { structureChecks } from './structure-checks';
import { createMetadataResolver, metadataDiagnostics } from './metadata';
import type { MetadataOptions } from './metadata';
import { eventAttribute } from './events';
import { attributesFor, nativeTags } from './catalog';

/** 可由组合入口按文档注入编辑偏好，语言模块不直接读取编辑器配置。 */
export interface WxmlOptions extends MetadataOptions {
  readonly autoClosingTags?: boolean;
}

/** 无目录的未保存文档仅分析当前文本，不能让跨文件解析异常吞掉结构结果。 */
function hasSourceDirectory(uri: string): boolean {
  try { new URL('./', uri); return true; } catch { return false; }
}

/** 组合入口通过此导出连接工作区、模板调用图和脚本语义端口。 */
export { createTemplateResolver } from './template-project';
/** 组件注册、参数和插槽结构统一由模板模块解析。 */
export { createComponentResolver } from './components';
/** 重命名由组合入口同时注入模板和脚本提供器。 */
export { createRenameFeatures } from './rename';
/** dataset 事件契约与普通模板语义共享组合入口。 */
export { createDatasetFeatures } from './dataset';
/** 实例语义通过选择器和公开成员连接脚本与模板。 */
export { createInstanceFeatures } from './instances';
/** navigator 通过独立提供器连接通用页面路由解析。 */
export { createNavigatorPlugin } from './routes';
/** 相对路由通过实际模板节点和组件注册反查消费页面。 */
export { createRouteContextResolver } from './route-contexts';

/** WXML 的唯一运行时入口，所有语言细节都封装在本模块内。 */
export function createWxmlPlugin(styles?: StyleClassResolver, scripts?: ScriptDefinitionResolver, options: (uri: string) => WxmlOptions = () => ({}), components?: ComponentResolver, reader?: WorkspaceReader, rename?: LanguageFeatures['rename'], references?: LanguageFeatures['references'], highlights?: LanguageFeatures['highlights']): LanguagePlugin {
  const metadata = reader && createMetadataResolver(reader, options);
  /** 元数据绑定沿用光标当前前缀，catch 与捕获事件不会变成 bind。 */
  const attributes = (request: LanguageRequest, data: import('./metadata').MetadataCatalog): import('./catalog').AttributeData[] => {
    const tag = tagAt(request.document.text, request.offset);
    const current = tag?.attributes.find((item) => request.offset >= item.range.start && request.offset <= item.range.end);
    const prefix = eventAttribute(current?.name ?? '')?.prefix;
    return [...attributesFor(tag?.name ?? ''), ...data.tags.find((item) => item.name === tag?.name)?.attributes ?? [], ...data.globalAttributes].map((item) => {
      const event = eventAttribute(item.name);
      return event && prefix ? { ...item, name: prefix + event.name } : item;
    });
  };
  return {
    id: 'miniprogramlab.wxml',
    displayName: 'WXML 基础语言支持',
    languages: ['wxml'],
    /** 声明本模块具备的能力，无需了解 VS Code 的注册方式。 */
    setup({ subscriptions }) {
      subscriptions.add({ dispose: clearTagCache });
      subscriptions.add({ dispose: clearStructureCache });
      return {
        documentSymbols: { provide: provideSymbols },
        foldingRanges: { provide: provideFolding },
        selectionRanges: { provide: provideSelections },
        ...(rename ? { rename } : {}),
        ...(references ? { references } : {}),
        ...(highlights ? { highlights } : {}),
        ...(scripts?.callSignature ? { signatureHelp: { triggerCharacters: ['(', ','], provide: (request: LanguageRequest) => {
          const expression = scriptExpression(request);
          return expression?.modules?.length ? scripts.callSignature!(request, expression) : undefined;
        } } } : {}),
        diagnostics: { dependencyLanguages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'json', 'jsonc', 'wxs', 'wxml'],
          /** 名称和组件事件检查共用未保存快照，错误范围按位置去重。 */
          provide: async (request: LanguageRequest) => {
            const structural = structureChecks(request, undefined, reader?.navigation).diagnostics;
            if (!hasSourceDirectory(request.document.uri)) return structural;
            const names = scripts?.analyze ? await templateDiagnostics(request, scripts) : [];
            const events = await components?.diagnostics?.(request, scripts) ?? [];
            const data = metadata && await metadata.load(request);
            const versions = data ? metadataDiagnostics(request, data) : [];
            const wxs = await scripts?.wxsDiagnostics?.(request, scriptModules(request)) ?? [];
            const resources = reader ? await templateFileDiagnostics(request, reader) : [];
            return [...new Map([...structural, ...names, ...events, ...versions, ...wxs, ...resources].map((item) => [`${item.range.start}:${item.code ?? item.message}`, item])).values()];
          },
        },
        codeActions: {
          /** 原生快速修复只生成可审核的工作区编辑。 */
          provide: async (request: LanguageRequest, range: import('../../api').TextRange, kind?: 'quickfix' | 'refactor.extract') => {
            const structural = kind !== 'refactor.extract' ? structureChecks(request, range, reader?.navigation).actions : [];
            if (!hasSourceDirectory(request.document.uri)) return structural;
            return [
              ...structural,
              ...kind !== 'refactor.extract' && scripts?.analyze ? await templateCodeActions(request, range, scripts) : [],
              ...kind !== 'refactor.extract' ? await components?.codeActions?.(request, range, scripts) ?? [] : [],
              ...kind !== 'quickfix' ? templateRefactors(request, range, scripts, reader) : [],
              ...kind !== 'quickfix' ? componentRefactors(request, range, scripts, styles, reader, components) : [],
            ];
          },
        },
        linkedEditing: { provide: provideLinkedTags },
        autoInsertion: {
          triggerCharacters: ['>'],
          /** 关闭自动闭合时，不产生任何自动文本修改。 */
          provide: (request: LanguageRequest) => options(request.document.uri).autoClosingTags === false ? undefined : provideAutoClosingTag(request),
        },
        ...(styles || scripts || components || reader ? { definition: {
          /** 先识别类名字符串，再将条件变量和其他表达式交给脚本端口。 */
          provide: async (request: LanguageRequest) => {
            if (request.cancellation.isCancellationRequested) return [];
            const files = reader && await provideFileDefinition(request, reader);
            if (files?.length) return files;
            const classes = styles && await provideClassDefinition(request, styles);
            if (classes?.length) return classes;
            const expression = scripts && scriptExpression(request);
            if (expression && scripts) return scripts.resolve(request, expression);
            const definitions = await components?.definition(request);
            if (definitions?.length) return definitions;
            return [];
          },
        } } : {}),
        completion: {
          triggerCharacters: ['<', '/', ' ', ':', '"', "'", '=', '-', '.'],
          /** 类名先读取样式引用链，组件参数、标签及通用属性沿用原有补全。 */
          provide: async (request: LanguageRequest) => {
            if (request.cancellation.isCancellationRequested) return [];
            const expression = scripts?.complete && scriptExpression(request);
            if (expression) {
              const completions = await scripts!.complete!(request, expression);
              if (completions.length) return completions;
            }
            const classes = styles && await provideClassCompletions(request, styles);
            if (classes?.length) return classes;
            const tag = tagAt(request.document.text, request.offset);
            const value = tag?.attributes.find((item) => item.valueRange && request.offset >= item.valueRange.start && request.offset <= item.valueRange.end);
            /** 显式源码枚举优先于文档，未匹配前缀也不能补回过期元数据值。 */
            if (value?.valueRange && tag && !nativeTags.has(tag.name) && !eventAttribute(value.name) && !request.document.text.slice(value.valueRange.start, value.valueRange.end).includes('{{')) {
              const info = await components?.instance?.(request, false);
              const fields = info?.properties.filter((property) => property.name === value.name || property.name === value.name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())) ?? [];
              const types = fields.flatMap((field) => field.valueType?.alternatives ?? (field.valueType ? [field.valueType] : []));
              if (fields.every((field) => field.valueType) && types.length && types.length < 256 && types.every((type) => type.literal !== undefined)) {
                const values = [...new Set(types.map((type) => type.kind === 'string' ? String(type.literal) : `{{${String(type.literal)}}}`))];
                return provideCompletions(request, false, [{ name: value.name, type: fields.map((field) => field.type).join(' | '), description: fields.map((field) => field.description).filter(Boolean).join('\n'), values }]);
              }
            }
            const completions = await components?.completion?.(request);
            const data = await metadata?.load(request);
            const basic = provideCompletions(request, options(request.document.uri).autoClosingTags !== false, data ? attributes(request, data) : [], data?.tags ?? []);
            return [...new Map([...basic, ...completions ?? []].map((item) => [`${item.kind}:${item.label}`, item])).values()];
          },
        },
        hover: {
          /** 变量与事件读取声明注释，组件和内置属性继续使用原有说明。 */
          provide: async (request: LanguageRequest) => {
            if (request.cancellation.isCancellationRequested) return undefined;
            const expression = scripts?.hover && scriptExpression(request);
            if (expression) return scripts!.hover!(request, expression);
            const component = await components?.hover(request);
            const data = await metadata?.load(request);
            const basic = provideHover(request, data ? attributes(request, data) : [], data?.tags ?? []);
            return component && basic ? { ...component, description: [component.description, basic.description && basic.description !== component.description ? '元数据补充：\n' + basic.description : ''].filter(Boolean).join('\n\n') } : component ?? basic;
          },
        },
      };
    },
  };
}

/** 独立使用时仍提供基础能力，样式桥接由组合入口选择注入。 */
export const wxmlPlugin: LanguagePlugin = createWxmlPlugin();
