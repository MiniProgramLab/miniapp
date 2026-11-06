import ts from 'typescript';
import type { LanguageRequest, WorkspaceDependency, WorkspaceReader } from '../../api';

/** 声明索引保留同名模块的全部文件，合并声明不能遗漏来源。 */
export interface AmbientIndex {
  readonly modules: ReadonlyMap<string, readonly string[]>;
  readonly dependencies: readonly WorkspaceDependency[];
  readonly complete: boolean;
}

/** 文件条目只保存模块名称，不长期持有声明语法树。 */
interface AmbientFile { readonly revision: string; readonly names: readonly string[]; readonly complete: boolean; readonly bytes: number; readonly weight: number }
/** 目录枚举与文件内容分别核对修订，编辑一个声明无需重扫全部内容。 */
interface IndexEntry extends AmbientIndex { readonly key: string }
const indexes = new WeakMap<NonNullable<WorkspaceReader['revision']>, IndexEntry[]>();
const files = new WeakMap<NonNullable<WorkspaceReader['revision']>, { entries: Map<string, AmbientFile>; weight: number }>();
const catalogs = new WeakMap<NonNullable<WorkspaceReader['revision']>, Map<string, { revision: string; uris: readonly string[]; truncated: boolean }>>();

/** 词法筛选跳过注释和普通命名空间，复杂词法仍交给完整解析。 */
function mayDeclareModule(text: string): boolean {
  if (!text.includes('\\u') && !/\b(?:module|namespace)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*['"`]/.test(text)) return false;
  let invalid = false, previous = false;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text, () => { invalid = true; });
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (invalid || token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken || token === ts.SyntaxKind.Unknown) return true;
    if (previous && (token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NoSubstitutionTemplateLiteral)) return true;
    previous = token === ts.SyntaxKind.ModuleKeyword || token === ts.SyntaxKind.NamespaceKeyword || token === ts.SyntaxKind.Identifier && ['module', 'namespace'].includes(scanner.getTokenValue());
  }
  return invalid;
}

/** 名称与语法有效性仍由 TypeScript 确认，词法筛选只排除无模块声明的文件。 */
function moduleNames(text: string, uri: string): { names: readonly string[]; complete: boolean } {
  if (!text.includes('module') && !text.includes('namespace') && !text.includes('\\u')) return { names: [], complete: true };
  if (!mayDeclareModule(text)) return { names: [], complete: true };
  // 名称索引不读取文档注释或父节点；实际类型图仍按原规则解析完整声明。
  const source = ts.createSourceFile(uri, text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseForTypeErrors }, false);
  const names = source.statements.flatMap((statement) => ts.isModuleDeclaration(statement) && ts.isStringLiteralLike(statement.name) ? [statement.name.text] : []);
  const errors = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return { names: names.slice(0, 4096), complete: names.length <= 4096 && !errors?.length };
}

/** 工作区声明按修订共享，缺失、截断和取消始终保留不完整状态。 */
export async function ambientIndex(reader: WorkspaceReader, request: LanguageRequest, maxFiles: number, roots?: readonly string[]): Promise<AmbientIndex> {
  if (request.cancellation.isCancellationRequested) return { modules: new Map(), dependencies: [], complete: false };
  const root = reader.root(request.document.uri) ?? new URL('./', request.document.uri).href;
  const selectedRoots = [...new Set(roots?.length ? roots : [root])];
  const key = JSON.stringify([selectedRoots, maxFiles]);
  const revision = reader.revision;
  const previous = revision && indexes.get(revision)?.find((item) => item.key === key);
  if (previous && previous.dependencies.every((item) => revision!(item.uri) === item.revision)) return previous;
  const dependencies = new Map<string, string>();
  for (const uri of selectedRoots) if (revision) dependencies.set(uri, revision(uri));
  const own = JSON.stringify([...dependencies]);
  const catalog = revision && catalogs.get(revision)?.get(key);
  const uris: string[] = catalog && catalog.revision === own ? [...catalog.uris] : [];
  let truncated = catalog?.revision === own && catalog.truncated || false;
  if (!catalog || catalog.revision !== own) for (const source of selectedRoots) {
    const found = /\.d\.[cm]?ts$/i.test(source) ? [source] : await reader.findFiles?.(request.document.uri, '**/*.d.ts', maxFiles + 1, { root: source }) ?? [];
    for (const uri of found) {
      const relative = uri.slice(source.replace(/\/$/, '').length + 1);
      if (!/\.d\.[cm]?ts$/i.test(source) && (!uri.startsWith(source.replace(/\/$/, '') + '/') || /(?:^|\/)(?:\.claude\/worktrees|\.codex\/worktrees|\.worktrees)(?:\/|$)/.test(relative))) continue;
      if (!uris.includes(uri)) uris.push(uri);
    }
    truncated ||= found.length > maxFiles;
    if (uris.length > maxFiles) break;
  }
  if (revision && [...dependencies].every(([uri, version]) => revision(uri) === version)) {
    const entries = catalogs.get(revision) ?? new Map();
    entries.delete(key); entries.set(key, { revision: own, uris, truncated });
    while (entries.size > 8) entries.delete(entries.keys().next().value!);
    catalogs.set(revision, entries);
  }
  const modules = new Map<string, string[]>();
  let complete = !truncated && uris.length <= maxFiles, bytes = 0;
  const selected = uris.slice(0, maxFiles);
  for (let offset = 0; offset < selected.length; offset += 16) {
    if (request.cancellation.isCancellationRequested) { complete = false; break; }
    // 文件读取有界并发，处理顺序仍保持目录顺序和原有预算规则。
    const batch = await Promise.all(selected.slice(offset, offset + 16).map(async (uri) => {
      const version = revision?.(uri);
      if (version !== undefined) dependencies.set(uri, version);
      const cached = revision && files.get(revision)?.entries.get(uri);
      const current = cached && cached.revision === version ? cached : undefined;
      return { uri, version, cached: current, document: current ? undefined : await reader.read(uri) };
    }));
    for (const item of batch) {
      if (request.cancellation.isCancellationRequested || request.checkpoint && !await request.checkpoint(request.cancellation)) { complete = false; break; }
      const { uri, version, document } = item;
      let cached = item.cached;
      if (!cached) {
        if (!document) { complete = false; continue; }
        if (document.text.length > 2_000_000 || bytes + document.text.length > 16_000_000) { complete = false; continue; }
        // 另一查询可能已经完成相同修订的名称提取。
        cached = revision && files.get(revision)?.entries.get(uri);
        if (!cached || cached.revision !== version) {
          const names = moduleNames(document.text, uri);
          cached = { revision: version ?? '', ...names, bytes: document.text.length, weight: uri.length + names.names.reduce((total, name) => total + name.length + 8, 0) };
          if (revision && version !== undefined && revision(uri) === version && !request.cancellation.isCancellationRequested) {
            const state = files.get(revision) ?? { entries: new Map<string, AmbientFile>(), weight: 0 };
            state.weight += cached.weight - (state.entries.get(uri)?.weight ?? 0);
            state.entries.delete(uri); state.entries.set(uri, cached);
            while (state.entries.size > 4096 || state.weight > 2_000_000) {
              const oldest = state.entries.keys().next().value!;
              state.weight -= state.entries.get(oldest)!.weight; state.entries.delete(oldest);
            }
            files.set(revision, state);
          }
        }
      }
      if (bytes + cached.bytes > 16_000_000) { complete = false; continue; }
      bytes += cached.bytes;
      complete &&= cached.complete;
      for (const name of cached.names) {
        const targets = modules.get(name) ?? [];
        if (!targets.includes(uri)) targets.push(uri);
        modules.set(name, targets);
      }
    }
  }

  if (revision && [...dependencies].some(([uri, version]) => revision(uri) !== version)) complete = false;
  const result: IndexEntry = { key, modules, complete, dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })) };
  if (revision && complete && !request.cancellation.isCancellationRequested && [...dependencies].every(([uri, version]) => revision(uri) === version)) {
    const entries = (indexes.get(revision) ?? []).filter((item) => item.key !== key);
    entries.push(result);
    while (entries.length > 8) entries.shift();
    indexes.set(revision, entries);
  }
  return result;
}
