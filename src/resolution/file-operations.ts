import { posix as path } from 'node:path';
import type { FileReference, LanguageRequest, ProjectFileResolver, TextEdit, WorkspaceReader } from '../api';

/** 文件操作只产生编辑与候选，不直接写入工程。 */
export interface FileMove { readonly oldUri: string; readonly newUri: string }

/** 同一页面或组件的文件分组用于原生快速选择。 */
export interface RelatedFile { readonly uri: string; readonly kind: 'template' | 'script' | 'style' | 'configuration' }

/** 语言模块提供语法引用，路径解析统一复用项目端口。 */
export type FileReferences = (request: LanguageRequest) => readonly FileReference[];

/** 脚本语法在实际查询时加载，关联命令注册不初始化 TypeScript。 */
async function scriptReferences(request: LanguageRequest): Promise<readonly FileReference[]> {
  if (!/\.(?:[cm]?[jt]sx?|wxs|jsonc?)$/i.test(request.document.uri)) return [];
  const { scriptFileReferences } = await import('./file-references');
  return scriptFileReferences(request);
}

/** 文件夹移动仅匹配完整路径段，避免 card 同时改到 card-extra。 */
export function moved(uri: string, moves: readonly FileMove[]): string {
  const match = [...moves].sort((left, right) => right.oldUri.length - left.oldUri.length).find((move) => uri === move.oldUri || uri.startsWith(move.oldUri.replace(/\/$/, '') + '/'));
  return match ? match.newUri.replace(/\/$/, '') + uri.slice(match.oldUri.replace(/\/$/, '').length) : uri;
}

/** URI 的路径计算不依赖本地文件系统，可用于远程工作区。 */
function pathname(uri: string): string { return decodeURIComponent(new URL(uri).pathname); }

/** 引用风格保留显式扩展名、目录入口、省略扩展名及查询后缀。 */
function replacement(reference: string, from: string, nextFrom: string, target: string, nextTarget: string): string | undefined {
  const clean = reference.replace(/[?#].*$/, '');
  const suffix = reference.slice(clean.length);
  const oldPath = pathname(target);
  let nextPath = pathname(nextTarget);
  const explicit = path.extname(clean);
  if (!explicit) nextPath = nextPath.replace(/\.[^/.]+$/, '');
  else if (explicit !== path.extname(oldPath)) nextPath = nextPath.replace(/\.[^/.]+$/, explicit);
  const oldStem = oldPath.replace(/\.[^/.]+$/, '');
  if (!explicit && path.basename(oldStem) === 'index' && path.basename(clean) !== 'index' && path.basename(nextPath) === 'index') nextPath = path.dirname(nextPath);
  if (!path.basename(clean).startsWith('_') && path.basename(oldStem).startsWith('_') && path.basename(nextPath).startsWith('_')) nextPath = path.join(path.dirname(nextPath), path.basename(nextPath).slice(1));
  let value: string;
  let relative = clean.startsWith('.');
  if (relative) value = path.relative(path.dirname(pathname(nextFrom)), nextPath);
  else {
    // 根路径及别名按共同后缀反推根，跨越原根时退回有效相对路径。
    const source = clean.replace(/^~/, '').split('/').filter(Boolean), original = oldStem.split('/').filter(Boolean);
    if (explicit) source[source.length - 1] = source.at(-1)!.replace(/\.[^/.]+$/, '');
    if (original.at(-1) === 'index' && source.at(-1) !== 'index') original.pop();
    if (!source.at(-1)?.startsWith('_') && original.at(-1)?.startsWith('_')) original[original.length - 1] = original.at(-1)!.slice(1);
    let shared = 0;
    while (shared < Math.min(source.length, original.length) && source.at(-1 - shared) === original.at(-1 - shared)) shared++;
    const base = '/' + original.slice(0, original.length - shared).join('/');
    const within = path.relative(base, nextPath);
    if (shared && !within.startsWith('../') && within !== '..') value = (clean.startsWith('/') ? '/' : clean.startsWith('~') ? '~' : '') + [...source.slice(0, source.length - shared), within].filter(Boolean).join('/');
    else { value = path.relative(path.dirname(pathname(nextFrom)), nextPath); relative = true; }
  }
  if (!value) value = './';
  if (!value.startsWith('.') && relative) value = './' + value;
  if (from === nextFrom && target === nextTarget) return reference;
  return value + suffix;
}

/** 关联切换与移动联动沿用原有配置规则，草稿优先且支持取消。 */
export function createFileOperations(reader: WorkspaceReader, references: FileReferences = () => [], options: (uri: string) => { maxFiles?: number } = () => ({}), routeEdits?: (request: LanguageRequest, files: readonly string[], moves: readonly FileMove[]) => Promise<readonly TextEdit[]>) {
  /** 同一操作复用路径解析器与磁盘快照，避免每个字符串重读构建配置。 */
  function context(request: LanguageRequest) {
    const snapshots = new Map<string, Awaited<ReturnType<WorkspaceReader['read']>>>([[request.document.uri, request.document]]);
    const resolvers = new Map<string, ProjectFileResolver | undefined>();
    /** 未保存内容和磁盘读取使用一致的快照。 */
    const read = async (uri: string) => {
      if (!snapshots.has(uri)) snapshots.set(uri, await reader.read(uri));
      return snapshots.get(uri);
    };
    /** 每种语言声明后缀，Sass 的部分文件与目录入口也保留。 */
    const target = async (reference: FileReference, from: string): Promise<string | undefined> => {
      if (!reference.reference || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(reference.reference) || reference.reference.includes('{{')) return undefined;
      const clean = reference.reference.replace(/[?#].*$/, '');
      // 各消费文件采用自己的最近项目配置，不能借用被移动文件的别名。
      if (!resolvers.has(from)) resolvers.set(from, reader.fileResolver?.(from, request.cancellation));
      const candidates = [...await resolvers.get(from)?.candidates(clean, from, reference.kind) ?? []];
      if (clean.startsWith('.')) candidates.push(new URL(clean, from).href);
      for (const base of [...new Set(candidates)]) {
        const choices = [base, ...reference.extensions.map((extension) => base + extension)];
        if (reference.kind === 'style') choices.push(...choices.map((uri) => new URL('_' + new URL(uri).pathname.split('/').at(-1), new URL('./', uri)).href));
        for (const uri of [...new Set(choices)]) {
          if (request.cancellation.isCancellationRequested) return undefined;
          if (await read(uri)) return uri;
        }
      }
      return undefined;
    };
    return { read, target };
  }
  return {
    /** 相同基名文件与真实样式导入同时列出，当前文件不重复出现。 */
    async related(request: LanguageRequest): Promise<readonly RelatedFile[]> {
      if (request.cancellation.isCancellationRequested) return [];
      const state = context(request);
      const base = request.document.uri.replace(/\.(?:[cm]?[jt]sx?|wxml|wxs|wxss|scss|less|css|jsonc?)$/i, '');
      const groups = { template: ['.wxml'], script: ['.ts', '.js', '.tsx', '.jsx', '.mts', '.mjs', '.cts', '.cjs'], style: ['.scss', '.less', '.wxss', '.css'], configuration: ['.json', '.jsonc'] } as const;
      const result: RelatedFile[] = [];
      for (const [kind, extensions] of Object.entries(groups)) for (const extension of extensions) {
        const uri = base + extension;
        const document = await state.read(uri);
        if (!document) continue;
        if (uri !== request.document.uri) result.push({ uri, kind: kind as RelatedFile['kind'] });
        if (kind === 'script') for (const reference of (await scriptReferences({ ...request, document: { ...request.document, uri, text: document.text } })).filter((reference) => reference.kind === 'style')) {
          // 关联切换先采用脚本实际相对导入，存在时无需扫描整套构建配置。
          const direct = reference.reference.startsWith('.') ? new URL(reference.reference.replace(/[?#].*$/, ''), uri).href : undefined;
          const style = direct && await state.read(direct) ? direct : await state.target(reference, uri);
          if (style && style !== request.document.uri) result.push({ uri: style, kind: 'style' });
        }
      }
      return request.cancellation.isCancellationRequested ? [] : [...new Map(result.map((item) => [item.uri, item])).values()];
    },
    /** 先收集完整静态编辑，超过文件预算时拒绝返回部分联动。 */
    async rename(request: LanguageRequest, moves: readonly FileMove[]): Promise<readonly TextEdit[]> {
      if (request.cancellation.isCancellationRequested || !moves.length) return [];
      const limit = options(request.document.uri).maxFiles ?? 5000;
      const files = await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,wxs,wxml,wxss,scss,less,css,json,jsonc}', limit + 1);
      if (!files) throw new Error('当前工作区不支持完整文件发现，未生成路径联动。');
      if (files.length > limit) throw new Error(`文件数量超过路径联动预算 ${limit}，未生成部分编辑。`);
      const state = context(request);
      const result = new Map<string, TextEdit>();
      for (const uri of files) {
        if (request.cancellation.isCancellationRequested) return [];
        const document = await state.read(uri);
        if (!document) continue;
        const current = { ...request, document: { uri, text: document.text, version: document.version ?? 0, languageId: /\.wxml$/i.test(uri) ? 'wxml' : /\.(?:wxss|scss|less|css)$/i.test(uri) ? path.extname(uri).slice(1) : /\.jsonc?$/i.test(uri) ? 'json' : 'typescript' } };
        for (const reference of [...await scriptReferences(current), ...references(current)]) {
          const target = await state.target(reference, uri);
          if (!target) continue;
          const nextFrom = moved(uri, moves), nextTarget = moved(target, moves);
          if (nextFrom === uri && nextTarget === target) continue;
          const value = replacement(reference.reference, uri, nextFrom, target, nextTarget);
          if (!value || value === reference.reference) continue;
          // 文件移动事件在改名之前应用编辑，文档地址保留旧 URI。
          result.set(uri + ':' + reference.range.start, { uri, range: reference.range, newText: value, oldText: reference.reference, ...(document.version === undefined ? {} : { version: document.version }) });
          if (reference.implicitNamespace && path.basename(pathname(target)) !== path.basename(pathname(nextTarget))) {
            const offset = reference.range.end + 1;
            result.set(uri + ':' + offset, { uri, range: { start: offset, end: offset }, newText: ' as ' + reference.implicitNamespace, oldText: '', ...(document.version === undefined ? {} : { version: document.version }) });
          }
        }
      }
      for (const edit of await routeEdits?.(request, files, moves) ?? []) {
        const key = edit.uri + ':' + edit.range.start;
        if (result.has(key) && result.get(key)!.newText !== edit.newText) throw new Error('路径联动产生冲突编辑，未返回部分修改。');
        result.set(key, edit);
      }
      return request.cancellation.isCancellationRequested ? [] : [...result.values()];
    },
  };
}
