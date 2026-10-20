import { posix as path } from 'node:path';
import type { LanguageRequest, RouteAccess, RouteResolver, ScriptDefinitionResolver, StaticString, TextEdit, WorkspaceReader, WorkspaceText } from '../api';
import { moved } from './file-operations';
import type { FileMove } from './file-operations';
import type { RegistrationMove } from './registration-edits';

/** 页面源码扩展名与既有路由目录保持一致，运行路径不携带扩展名。 */
const extensions = ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.wxml'];

/** 移动联动只接受原始字面量来源，不修改常量名称或动态表达式。 */
export async function routeFileEdits(reader: WorkspaceReader, scripts: ScriptDefinitionResolver, routes: RouteResolver, templates: (request: LanguageRequest) => readonly RouteAccess[], request: LanguageRequest, files: readonly string[], moves: readonly FileMove[]): Promise<readonly TextEdit[]> {
  const documents = new Map<string, WorkspaceText | undefined>([[request.document.uri, request.document]]);
  const proposals = new Map<string, TextEdit>();
  const migrations: RegistrationMove[] = [];
  /** 整次操作读取同一份草稿快照，真实编辑仍由宿主核验版本。 */
  const read = async (uri: string) => {
    if (!documents.has(uri)) documents.set(uri, await reader.read(uri));
    return documents.get(uri);
  };
  /** 同一声明被多个页面消费时，所有推导必须给出相同新值。 */
  const propose = (edit: TextEdit): void => {
    const key = `${edit.uri}:${edit.range.start}:${edit.range.end}`;
    const previous = proposals.get(key);
    if (previous && previous.newText !== edit.newText) throw new Error('同一路由声明的消费位置需要不同新路径，未生成部分联动。');
    proposals.set(key, edit);
  };
  /** 改动覆盖完整静态片段后逐段分配，动态间隙及共享声明冲突不能生成编辑。 */
  const rewrite = async (value: StaticString, next: string): Promise<void> => {
    let start = 0, end = value.text.length, nextEnd = next.length;
    while (start < Math.min(end, nextEnd) && value.text[start] === next[start]) start++;
    while (end > start && nextEnd > start && value.text[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    const changed = next !== value.text;
    const sources = [...value.sources ?? []].sort((left, right) => left.offset - right.offset);
    const owner = [...sources].reverse().find((source) => start >= source.offset && start < source.offset + source.range.end - source.range.start) ?? sources.find((source) => start === source.offset + source.range.end - source.range.start);
    if (changed) {
      let covered = start;
      for (const source of sources) if (source.offset <= covered) covered = Math.max(covered, source.offset + source.range.end - source.range.start);
      if (!owner || covered < end) throw new Error('路由改动跨越动态或没有来源的字符串片段，未生成猜测性联动。');
    }
    for (const source of value.sources ?? []) {
      const document = await read(source.uri);
      if (!document) throw new Error('路由声明源码已不可读取，请重新发起移动。');
      const oldText = document.text.slice(source.range.start, source.range.end);
      if (oldText !== value.text.slice(source.offset, source.offset + oldText.length)) throw new Error('路由字符串来源与草稿不一致，请重新发起移动。');
      const localStart = Math.max(0, Math.min(oldText.length, start - source.offset));
      const localEnd = Math.max(localStart, Math.min(oldText.length, end - source.offset));
      const affected = changed && (localEnd > localStart || source.uri === owner?.uri && source.range.start === owner.range.start && source.offset === owner.offset);
      const first = source.uri === owner?.uri && source.range.start === owner.range.start && source.offset === owner.offset;
      const inserted = first ? next.slice(start, nextEnd) : '';
      const newText = affected ? oldText.slice(0, localStart) + inserted + oldText.slice(localEnd) : oldText;
      if (/['"`\\\r\n]/.test(inserted) && changed) throw new Error('新路由包含需要转义的字符，未生成不安全的字符串编辑。');
      propose({ uri: source.uri, range: source.range, oldText, newText, ...(document.version === undefined ? {} : { version: document.version }) });
    }
  };
  /** 运行路径投影必须通过项目正向解析核验，复制目录不能只按名称猜测。 */
  const relocate = async (current: LanguageRequest, root: string, runtime: string, uri: string, directory = false): Promise<string> => {
    const next = moved(uri, moves);
    if (next === uri) return runtime;
    const original = decodeURIComponent(new URL(uri).pathname).replace(directory ? /\/$/ : /\.[^/.]+$/, '').split('/').filter(Boolean);
    const names = runtime.replace(/^\//, '').split('/');
    let shared = 0;
    while (shared < Math.min(original.length, names.length) && original.at(-1 - shared) === names.at(-1 - shared)) shared++;
    if (!shared) throw new Error('无法还原移动页面的运行路径，未生成部分联动。');
    const base = '/' + original.slice(0, original.length - shared).join('/');
    const physical = decodeURIComponent(new URL(next).pathname).replace(directory ? /\/$/ : /\.[^/.]+$/, '');
    const relative = path.relative(base, physical);
    if (relative === '..' || relative.startsWith('../')) throw new Error('移动页面超出原应用源码映射，需要调整应用或构建配置。');
    const rendered = [...names.slice(0, names.length - shared), relative].join('/');
    const resolver = reader.fileResolver?.(current.document.uri, current.cancellation);
    const candidates = [...await resolver?.candidates('/' + rendered, current.document.uri, 'component') ?? [], new URL(rendered, moved(root, moves)).href];
    const suffixes = directory ? [''] : extensions;
    const valid = candidates.some((candidate) => suffixes.some((extension) => {
      const target = candidate + extension;
      return target === next || target.startsWith(root) && moved(target, moves) === next;
    }));
    if (!valid) throw new Error('新运行路径未通过源码映射核验，需要同步构建配置。');
    return rendered;
  };
  /** 注册及目录探测使用实际项目候选，未来文件不要求提前存在。 */
  const directory = async (current: LanguageRequest, root: string, runtime: string): Promise<string | undefined> => {
    const resolver = reader.fileResolver?.(current.document.uri, current.cancellation);
    for (const uri of [...await resolver?.candidates('/' + runtime, current.document.uri, 'component') ?? [], new URL(runtime, root).href]) if (await reader.directory?.(uri)) return uri;
    return undefined;
  };
  for (const uri of files) {
    if (request.cancellation.isCancellationRequested) return [];
    const document = await read(uri);
    if (!document) continue;
    const current: LanguageRequest = { ...request, document: { uri, text: document.text, version: document.version ?? 0, languageId: /\.wxml$/i.test(uri) ? 'wxml' : /\.jsonc?$/i.test(uri) ? 'json' : /\.js$/i.test(uri) ? 'javascript' : 'typescript' }, offset: -1 };
    if (/\/app(?:\.jsonc?|\.config\.[cm]?[jt]s)$/i.test(uri)) {
      const catalog = await routes.catalog?.(current);
      if (!catalog) continue;
      const roots = new Map<string, string>();
      for (const registration of catalog.manifest.registrations ?? []) if (registration.kind === 'package') {
        const source = await directory(current, catalog.root, registration.path);
        const next = source ? await relocate(current, catalog.root, registration.path, source, true) : registration.path;
        roots.set(registration.path, next);
        await rewrite(registration.value, next);
      }
      for (const registration of catalog.manifest.registrations ?? []) if (registration.kind !== 'package') {
        const access: RouteAccess = { range: { start: 0, end: 0 }, base: 'page', method: 'reLaunch', urls: [{ text: '/' + registration.path, complete: true }] };
        const result = await routes.query(current, access);
        const link = result.targets?.[0];
        if (!link) continue;
        const next = await relocate(current, catalog.root, registration.path, link.uri);
        const currentPackage = registration.package ? roots.get(registration.package) ?? registration.package : '';
        const destination = [...roots.values()].filter((root) => next.startsWith(root.replace(/\/$/, '') + '/')).sort((left, right) => right.length - left.length)[0] ?? '';
        const prefix = registration.kind === 'tab' ? '' : destination;
        const local = prefix ? next.slice(prefix.replace(/\/$/, '').length + 1) : next;
        if (registration.kind === 'tab' && destination) throw new Error('TabBar 页面不能迁入分包，需要调整导航配置。');
        if (local !== registration.value.text && result.complete !== true) throw new Error('应用目录或源码图不完整，未生成部分路由联动。');
        if (registration.kind === 'page' && currentPackage !== destination) {
          const destinations = catalog.manifest.collections?.filter((collection) => (collection.package ? roots.get(collection.package) ?? collection.package : '') === destination) ?? [];
          if (!registration.collection || destinations.length !== 1) throw new Error('没有唯一可编辑的目标页面注册数组，未生成部分迁移。');
          migrations.push({ from: registration.collection, to: destinations[0]!, value: local });
          continue;
        }
        await rewrite(registration.value, registration.value.text.startsWith('/') ? '/' + local : local);
      }
    }
    const accesses = current.document.languageId === 'wxml' ? templates(current) : /\.(?:[cm]?[jt]sx?)$/i.test(uri) ? await scripts.routeQueries?.(current, true) ?? [] : [];
    for (const access of accesses) {
      const result = await routes.query(current, access);
      for (const value of access.urls) for (const link of result.targets?.filter((link) => link.url === value.text) ?? []) {
        const target = await relocate(current, link.root, link.path, link.uri);
        const from = link.from ? await relocate(current, link.root, link.from.path, link.from.uri) : undefined;
        const oldPath = value.text.split(/[?#]/, 1)[0]!;
        let next = oldPath.startsWith('/') ? '/' + target : from === undefined ? oldPath : path.relative(path.dirname(from), target);
        if (oldPath.startsWith('./') && !next.startsWith('.')) next = './' + next;
        next += value.text.slice(oldPath.length);
        if (next !== value.text && result.complete !== true) throw new Error('路由消费关系不完整，未生成部分移动联动。');
        await rewrite(value, next);
      }
    }
  }
  if (request.cancellation.isCancellationRequested) return [];
  const edits = [...proposals.values()].filter((edit) => edit.newText !== edit.oldText);
  return migrations.length ? (await import('./registration-edits')).registrationEdits(read, migrations, edits) : edits;
}
