import ts from 'typescript';
import type { LanguageRequest, WorkspaceDependency, WorkspaceReader } from '../../api';

/** 导入记录保留文本修订与路径配置依赖，普通改动只重建对应记录。 */
interface ImportRecord { readonly revision?: string; readonly input?: string; readonly characters: number; readonly targets: readonly string[]; readonly dependencies: readonly WorkspaceDependency[]; readonly fallback: boolean }

/** 同一宿主的导入索引按工作区隔离，只保存有界的完整记录。 */
interface ImportIndex { readonly key: string; readonly records: ReadonlyMap<string, ImportRecord>; readonly weight: number; readonly sources: readonly string[] }

/** 弱键随读取器释放，最多保留两份索引及一千六百万字符。 */
const caches = new WeakMap<NonNullable<WorkspaceReader['revision']>, ImportIndex[]>();

/** 导入候选按模块基名筛选，扩展名差异由后续真实符号核验排除。 */
export function importKey(uri: string): string { return uri.replace(/\.(?:[cm]?[jt]sx?|wxs)$/i, ''); }

/** 反向导入关系只筛选候选，实际成员身份仍由已有语义端口核验。 */
export async function importIndex(reader: WorkspaceReader, request: LanguageRequest, limit = 5000): Promise<{ readonly files: readonly string[]; readonly reverse: ReadonlyMap<string, ReadonlySet<string>> } | undefined> {
  if (request.cancellation.isCancellationRequested) return undefined;
  const files = await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,wxs,wxml}', limit + 1) ?? [];
  if (files.length > limit) throw new Error(`导入索引超过扫描上限 ${limit}，未返回部分结果。`);
  const sources = files.filter((uri) => /\.(?:[cm]?[jt]sx?|wxs)$/i.test(uri));
  const existing = new Set(sources.map(importKey));
  const revision = reader.revision;
  const observed = new Map<string, string>();
  /** 同次查询的共享配置修订只检查一次，结束时仍核验实际最新修订。 */
  const stamp = (uri: string): string | undefined => {
    if (!revision) return undefined;
    if (!observed.has(uri)) observed.set(uri, revision(uri));
    return observed.get(uri);
  };
  const key = JSON.stringify([reader.root(request.document.uri), limit]);
  const previous = revision && caches.get(revision)?.find((item) => item.key === key);
  const sourceSet = new Set(sources);
  const sameFiles = previous && previous.sources.length === sources.length && previous.sources.every((uri) => sourceSet.has(uri));
  const records = new Map<string, ImportRecord>();
  const reverse = new Map<string, Set<string>>();
  const resolvers = new Map<string, ReturnType<NonNullable<WorkspaceReader['fileResolver']>>>();
  const pathsByDirectory = new Map<string, Promise<readonly string[]>>();
  const fallbackTargets = new Map<string, readonly string[]>();
  const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.wxs', '/index.ts', '/index.js', '/index.wxs'];
  let weight = 0, characters = 0;
  /** 同目录共用最近配置，其他项目目录不能借用查询入口的别名。 */
  const resolver = (uri: string) => {
    const directory = new URL('./', uri).href;
    if (!resolvers.has(directory) && reader.fileResolver) resolvers.set(directory, reader.fileResolver(uri, request.cancellation));
    return resolvers.get(directory);
  };
  for (let index = 0; index < sources.length; index += 16) {
    if (request.cancellation.isCancellationRequested) return undefined;
    const batch = await Promise.all(sources.slice(index, index + 16).map(async (uri): Promise<[string, ImportRecord] | undefined> => {
      const own = stamp(uri);
      const cached = previous?.records.get(uri);
      const draft = uri === request.document.uri ? request.document.text : undefined;
      if (cached && revision && cached.revision === own && (!cached.fallback || sameFiles) && (draft === undefined || cached.input === draft) && cached.dependencies.every((dependency) => stamp(dependency.uri) === dependency.revision)) return [uri, cached];
      const document = uri === request.document.uri ? request.document : await reader.read(uri);
      if (!document) return undefined;
      const targets = new Set<string>();
      let fallback = false;
      let paths: ReturnType<typeof resolver>;
      for (const imported of ts.preProcessFile(document.text, true, true).importedFiles) {
        const reference = imported.fileName;
        if (!reference.startsWith('.')) paths = resolver(uri);
        const pathKey = new URL('./', uri).href + ':' + reference;
        if (!reference.startsWith('.') && !pathsByDirectory.has(pathKey)) pathsByDirectory.set(pathKey, paths?.candidates(reference, uri, 'script') ?? Promise.resolve([]));
        const candidates = reference.startsWith('.') ? [new URL(reference, uri).href] : await pathsByDirectory.get(pathKey)!;
        const importedTargets = new Set<string>();
        for (const candidate of candidates) {
          const target = importKey(candidate.replace(/\/$/, ''));
          importedTargets.add(target);
          if (target === candidate.replace(/\/$/, '')) importedTargets.add(target + '/index');
        }
        // 未知别名保留同尾源码候选，后续核验不会仅按相同方法名称返回结果。
        if (![...importedTargets].some((target) => existing.has(target)) && !reference.startsWith('.')) {
          fallback = true;
          if (!fallbackTargets.has(reference)) fallbackTargets.set(reference, sources.filter((candidate) => extensions.some((suffix) => candidate.endsWith('/' + reference.replace(/^[@#][^/]*\//, '') + suffix))).map(importKey));
          for (const candidate of fallbackTargets.get(reference)!) importedTargets.add(candidate);
        }
        for (const target of importedTargets) targets.add(target);
      }
      return [uri, { characters: document.text.length, targets: [...targets], dependencies: paths?.dependencies ?? [], fallback, ...(draft === undefined ? {} : { input: draft }), ...(own === undefined ? {} : { revision: own }) }];
    }));
    for (const entry of batch) {
      if (!entry) continue;
      const [uri, record] = entry;
      weight += (record.input?.length ?? 0) + record.targets.reduce((sum, target) => sum + target.length, 0) + record.dependencies.reduce((sum, dependency) => sum + dependency.uri.length + dependency.revision.length, 0);
      characters += record.characters;
      // 扫描不保留整份源码文本，缓存预算与一次完整扫描的输入预算分开限制。
      if (characters > 64_000_000) throw new Error('导入索引源码超过扫描文本预算，未返回部分结果。');
      records.set(uri, record);
      for (const target of record.targets) {
        const consumers = reverse.get(target) ?? new Set<string>();
        consumers.add(uri); reverse.set(target, consumers);
      }
    }
  }
  if (request.cancellation.isCancellationRequested) return undefined;
  if (revision && weight <= 16_000_000 && [...records].every(([uri, record]) => revision(uri) === record.revision && record.dependencies.every((dependency) => revision(dependency.uri) === dependency.revision))) {
    const next = [...(caches.get(revision) ?? []).filter((item) => item.key !== key), { key, records, weight, sources }];
    while (next.length > 2 || next.reduce((sum, item) => sum + item.weight, 0) > 16_000_000) next.shift();
    caches.set(revision, next);
  }
  return { files, reverse };
}
