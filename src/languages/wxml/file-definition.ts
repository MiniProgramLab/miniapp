import type { Definition, Diagnostic, FileReference, LanguageRequest, ProjectFileResolver, TextRange, WorkspaceReader, WorkspaceText } from '../../api';
import { scanTags, tagAt } from './parser';
import type { TagToken } from './parser';

/** 路径范围和文件类型只从真实标签读取，诊断无需按每个偏移重新扫描全文。 */
function tagReference(tag: TagToken, text: string): FileReference | undefined {
  if (tag.closing || !['import', 'include', 'wxs'].includes(tag.name)) return undefined;
  const range = tag.attributes.find((attribute) => attribute.name === 'src')?.valueRange;
  return range ? { reference: text.slice(range.start, range.end), range, kind: 'component', extensions: tag.name === 'wxs' ? ['.wxs', '/index.wxs'] : ['.wxml', '/index.wxml'] } : undefined;
}

/** 文件操作复用真实标签扫描，注释、动态插值及 WXS 正文不作为路径引用。 */
export function templateFileReferences(request: LanguageRequest): readonly FileReference[] {
  return [...scanTags(request.document.text)].flatMap((tag) => {
    const item = tagReference(tag, request.document.text);
    return !item || item.reference.includes('{{') ? [] : [item];
  });
}

/** 资源检查复用真实跳转规则，同次查询合并重复读取并保留草稿与缺失文件依赖。 */
export async function templateFileDiagnostics(request: LanguageRequest, reader: WorkspaceReader): Promise<readonly Diagnostic[]> {
  if (request.cancellation.isCancellationRequested) return [];
  const references = templateFileReferences(request).filter((item) => !/^(?:[a-z][\w+.-]*:|\/\/)/i.test(item.reference));
  if (!references.length) return [];
  try { new URL('./', request.document.uri); } catch { return []; }
  const reads = new Map<string, ReturnType<WorkspaceReader['read']>>();
  const files = reader.fileResolver?.(request.document.uri, request.cancellation);
  const snapshot: WorkspaceReader = { ...reader,
    /** 相同路径的正向和负向结果只读取一次，新的检查请求会重新核验。 */
    read: (uri) => {
      if (!reads.has(uri)) reads.set(uri, reader.read(uri));
      return reads.get(uri)!;
    },
  };
  const result: Diagnostic[] = [];
  if (references.length > 2000) reader.navigation?.record({ code: 'budget', message: '模板资源超过两千处检查上限，未完成全部路径检查。', uri: request.document.uri });
  for (const item of references.slice(0, 2000)) {
    if (request.cancellation.isCancellationRequested) return [];
    const definitions = item.reference ? await resolveReference(request, snapshot, item, files) : [];
    if (request.cancellation.isCancellationRequested) return [];
    if (!definitions.length) result.push({ range: item.range, severity: 'warning', code: 'template-resource', message: item.reference
      ? `未找到模板或 WXS 资源 ${item.reference}，请检查路径或源码映射。` : '模板或 WXS 的 src 路径不能为空。' });
  }
  return result;
}

/** 静态模板与 WXS 引用共用项目路径规则，目标为真实文件起始位置。 */
export async function provideFileDefinition(request: LanguageRequest, reader: WorkspaceReader): Promise<readonly Definition[]> {
  if (request.cancellation.isCancellationRequested) return [];
  const tag = tagAt(request.document.text, request.offset);
  const item = tag && tagReference(tag, request.document.text);
  if (!item || request.offset < item.range.start || request.offset >= item.range.end) return [];
  return resolveReference(request, reader, item, reader.fileResolver?.(request.document.uri, request.cancellation));
}

/** 静态模板调用只查当前文件和直接导入，不沿 include 或二次 import 扩大作用域。 */
export async function provideTemplateDefinition(request: LanguageRequest, reader: WorkspaceReader): Promise<readonly Definition[]> {
  if (request.cancellation.isCancellationRequested) return [];
  const tag = tagAt(request.document.text, request.offset);
  const range = tag?.attributes.find((attribute) => attribute.name === 'is')?.valueRange;
  if (!tag || tag.closing || tag.name !== 'template' || !range || request.offset < range.start || request.offset > range.end) return [];
  const name = request.document.text.slice(range.start, range.end);
  if (!name || name.includes('{{')) return [];
  const result = templateDeclarations(request.document.uri, request.document, name, range);
  const imports = [...scanTags(request.document.text)].filter((item) => !item.closing && item.name === 'import');
  if (!imports.length) return result;
  try { new URL('./', request.document.uri); } catch { return result; }
  const reads = new Map<string, ReturnType<WorkspaceReader['read']>>();
  const visited = new Set([request.document.uri]);
  const files = reader.fileResolver?.(request.document.uri, request.cancellation);
  const snapshot: WorkspaceReader = { ...reader,
    /** 路径解析与声明扫描共用草稿快照，重复导入不重复读取。 */
    read: (uri) => {
      if (!reads.has(uri)) reads.set(uri, uri === request.document.uri ? Promise.resolve(request.document) : reader.read(uri));
      return reads.get(uri)!;
    },
  };
  if (imports.length > 2000) reader.navigation?.record({ code: 'budget', message: '模板导入超过两千处查找上限，未完成全部声明查找。', uri: request.document.uri });
  for (const imported of imports.slice(0, 2000)) {
    if (request.cancellation.isCancellationRequested) return [];
    const reference = tagReference(imported, request.document.text);
    if (!reference || reference.reference.includes('{{')) continue;
    for (const target of await resolveReference(request, snapshot, reference, files)) {
      if (visited.has(target.uri)) continue;
      visited.add(target.uri);
      const document = await snapshot.read(target.uri);
      if (document) result.push(...templateDeclarations(target.uri, document, name, range));
    }
  }
  return request.cancellation.isCancellationRequested ? [] : result;
}

/** 定义链接选中 name 原始值，保留目标版本以排除过期草稿。 */
function templateDeclarations(uri: string, document: WorkspaceText, name: string, originRange: TextRange): Definition[] {
  return [...scanTags(document.text)].flatMap((tag) => {
    if (tag.closing || tag.name !== 'template') return [];
    const range = tag.attributes.find((attribute) => attribute.name === 'name')?.valueRange;
    return range && document.text.slice(range.start, range.end) === name
      ? [{ uri, range, originRange, ...(document.version !== undefined ? { version: document.version } : {}) }] : [];
  });
}

/** 跳转与诊断共享同一候选遍历，目录入口、别名及源码映射不能产生两套结果。 */
async function resolveReference(request: LanguageRequest, reader: WorkspaceReader, item: FileReference, files: ProjectFileResolver | undefined): Promise<readonly Definition[]> {
  const { reference, range } = item;
  if (!reference) return [];
  if (reference.includes('{{')) { reader.navigation?.record({ code: 'dynamic', message: '模板或 WXS 的 src 包含运行时表达式，无法静态确定文件。', uri: request.document.uri }); return []; }
  if (/^(?:plugin|dynamicLib|https?|data):|^\/\//i.test(reference)) { reader.navigation?.record({ code: 'unsupported', message: '外部 src 地址不属于本地源码导航。', uri: request.document.uri }); return []; }
  const candidates = [...await files?.candidates(reference, request.document.uri, 'component') ?? []];
  try { candidates.push(new URL(reference, request.document.uri).href); } catch { return []; }
  const extension = item.extensions[0]!;
  for (const uri of [...new Set(candidates)]) for (const target of uri.endsWith(extension) ? [uri] : [uri + extension, uri + '/index' + extension]) {
    if (request.cancellation.isCancellationRequested) return [];
    const document = await reader.read(target);
    if (document) return [{ uri: target, range: { start: 0, end: 0 }, originRange: range, ...(document.version !== undefined ? { version: document.version } : {}) }];
  }
  reader.navigation?.record({ code: 'missing', message: `模板或 WXS 路径 ${reference} 的候选均未找到对应文件；请检查路径、别名及源码根。`, uri: request.document.uri });
  return [];
}
