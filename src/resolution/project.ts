import { posix as path } from 'node:path';
import ts from 'typescript';
import type { Cancellation, FileReferenceKind, ProjectFileResolver, WorkspaceReader } from '../api';
import { buildConfigSource, inspectBuildConfig } from './config';
import type { PathAlias, PathMapping } from './config';

/** 一份请求内共享的项目路径快照，构建规则不会跨工程混用。 */
interface ProjectPaths {
  readonly root: string;
  readonly sources: readonly string[];
  readonly outputs: readonly string[];
  readonly mappings: readonly PathMapping[];
  readonly aliases: readonly PathAlias[];
  readonly includes: readonly string[];
  readonly workspaces: readonly string[];
}

/** 配置文本在同一宿主内按修订复用，阴性探测与源码映射也受同一校验。 */
const configTexts = new WeakMap<NonNullable<WorkspaceReader['revision']>, { readonly entries: Map<string, { readonly revision: string; readonly text: string | undefined }>; weight: number }>();

/** 在同一 URI 主机上构造路径，空格和中文只编码一次。 */
function uriAt(base: string, pathname: string): string {
  const uri = new URL(base);
  uri.pathname = pathname.split('/').map((part) => encodeURIComponent(part).replace(/%40/gi, '@').replace(/%3A/gi, ':')).join('/');
  return uri.toString();
}

/** 按完整路径段匹配目录，避免 dist-other 等相似目录误命中。 */
function relativeTo(parent: string, file: string): string | undefined {
  parent = parent.replace(/\/$/, '');
  return file === parent ? '' : file.startsWith(parent + '/') ? file.slice(parent.length + 1) : undefined;
}

/** 每次语言查询重新读取配置，配置草稿和修改无需等待缓存失效。 */
class ProjectResolver implements ProjectFileResolver {
  private readonly revisions = new Map<string, string>();
  private readonly documents = new Map<string, Promise<string | undefined>>();
  private profile: Promise<ProjectPaths> | undefined;
  private bytes = 0;

  /** 本地配置依赖共用缓存和预算，循环导入不会重复读取。 */
  private async configDependencies(filename: string, text: string, files = new Map<string, string>()): Promise<ReadonlyMap<string, string>> {
    if (files.has(filename)) return files;
    if (files.size >= 32) { this.reader.navigation?.record({ code: 'budget', message: '配置导入链达到三十二份文件上限，后续构建规则未解析。', uri: uriAt(this.entry, filename) }); return files; }
    files.set(filename, text);
    const source = buildConfigSource(text, filename);
    const modules = new Set<string>();
    /** 只跟随顶层相对配置导入，插件和函数体内的动态 require 不参与发现。 */
    function visit(node: ts.Node): void {
      if (ts.isFunctionLike(node)) return;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) modules.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('.')) modules.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const module of modules) {
      const base = path.resolve(path.dirname(filename), module);
      for (const target of [base, ...['.ts', '.js', '.cjs', '.mjs', '/index.ts', '/index.js'].map((extension) => base + extension)]) {
        if (files.has(target)) break;
        const content = await this.read(uriAt(this.entry, target));
        if (content !== undefined) { await this.configDependencies(target, content, files); break; }
      }
    }
    return files;
  }

  /** 文件系统和编辑器均通过公共读取端口访问。 */
  constructor(private readonly reader: WorkspaceReader, private readonly entry: string, private readonly cancellation?: Cancellation) {}

  /** 修订保留读取前快照，配置在读取过程中变化时调用方不会复用结果。 */
  get dependencies(): readonly import('../api').WorkspaceDependency[] { return [...this.revisions].map(([uri, revision]) => ({ uri, revision })); }

  /** 限制配置读取数量和体积，损坏配置按未识别规则处理。 */
  private async read(uri: string): Promise<string | undefined> {
    if (this.cancellation?.isCancellationRequested) return undefined;
    if (!this.documents.has(uri)) {
      if (this.documents.size >= 256) { this.reader.navigation?.record({ code: 'budget', message: '配置及包入口探测达到二百五十六份文件上限，路径候选可能不完整。' }); return undefined; }
      const revision = this.reader.revision;
      const own = revision?.(uri);
      if (own !== undefined) this.revisions.set(uri, own);
      const shared = revision && configTexts.get(revision);
      const cached = shared?.entries.get(uri);
      this.documents.set(uri, (async () => {
        const text = cached?.revision === own && cached ? cached.text : (await this.reader.read(uri))?.text;
        if (this.cancellation?.isCancellationRequested) return undefined;
        if ((text?.length ?? 0) > 1_000_000 || this.bytes + (text?.length ?? 0) > 4_000_000) { this.reader.navigation?.record({ code: 'budget', message: '配置文本超过单文件或总量上限，未继续解析该配置。', uri }); return undefined; }
        this.bytes += text?.length ?? 0;
        if (revision && own !== undefined && revision(uri) === own) {
          const state = configTexts.get(revision) ?? { entries: new Map(), weight: 0 };
          state.weight += (text?.length ?? 0) - (state.entries.get(uri)?.text?.length ?? 0);
          state.entries.delete(uri); state.entries.set(uri, { revision: own, text });
          while (state.entries.size > 4096 || state.weight > 4_000_000) {
            const first = state.entries.keys().next().value!;
            state.weight -= state.entries.get(first)?.text?.length ?? 0; state.entries.delete(first);
          }
          configTexts.set(revision, state);
        }
        return text;
      })());
    }
    return this.documents.get(uri);
  }

  /** 从最近 package、应用入口和项目配置识别归属，工作区为搜索边界。 */
  private async discover(): Promise<ProjectPaths> {
    const workspace = new URL(this.reader.root(this.entry) ?? new URL('./', this.entry).href);
    const boundary = decodeURIComponent(workspace.pathname).replace(/\/$/, '') || '/';
    let current = path.dirname(decodeURIComponent(new URL(this.entry).pathname));
    let root = boundary;
    let source: string | undefined;
    let manifest: { scripts?: Record<string, unknown> } | undefined;
    const projects: { uri: string; text: string }[] = [];
    let tsconfig: string | undefined;
    for (let depth = 0; depth < 40 && relativeTo(boundary, current) !== undefined; depth++) {
      for (const name of source ? [] : ['app.json', 'app.config.ts', 'app.config.js']) {
        if (await this.read(uriAt(this.entry, path.join(current, name))) !== undefined) { source = current; break; }
      }
      if (!tsconfig) for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const uri = uriAt(this.entry, path.join(current, name));
        if (await this.read(uri) !== undefined) { tsconfig = uri; break; }
      }
      const projectUri = uriAt(this.entry, path.join(current, 'project.config.json'));
      const project = await this.read(projectUri);
      if (project) projects.push({ uri: projectUri, text: project });
      const packageText = await this.read(uriAt(this.entry, path.join(current, 'package.json')));
      if (packageText) {
        root = current;
        try { manifest = JSON.parse(packageText) as typeof manifest; } catch { /* 无效清单仍保留最近工程边界。 */ }
        break;
      }
      if (current === boundary) break;
      current = path.dirname(current);
    }
    const sources = new Set(source ? [source] : []);
    const outputs = new Set<string>();
    const mappings: PathMapping[] = [];
    const aliases: PathAlias[] = [];
    const includes: string[] = [];
    const workspaces: string[] = [];
    for (let parent = root, depth = 0; depth < 32 && relativeTo(boundary, parent) !== undefined; parent = path.dirname(parent), depth++) {
      if (!tsconfig) for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const uri = uriAt(this.entry, path.join(parent, name));
        if (await this.read(uri) !== undefined) { tsconfig = uri; break; }
      }
      const packageText = await this.read(uriAt(this.entry, path.join(parent, 'package.json')));
      if (packageText) try {
        const workspace = JSON.parse(packageText).workspaces as unknown;
        const patterns = Array.isArray(workspace) ? workspace : workspace && typeof workspace === 'object' && 'packages' in workspace && Array.isArray(workspace.packages) ? workspace.packages : [];
        for (const pattern of patterns) if (typeof pattern === 'string' && !pattern.startsWith('!') && !pattern.includes('..')) workspaces.push(path.join(path.relative(boundary, parent), pattern, 'package.json'));
      } catch { /* 无效工作区清单不会借用另一个工程的配置。 */ }
      const pnpm = await this.read(uriAt(this.entry, path.join(parent, 'pnpm-workspace.yaml')));
      if (pnpm) {
        const section = pnpm.match(/^packages:\s*\n((?:[ \t].*\n?)*)/m)?.[1];
        for (const line of section?.split('\n') ?? []) {
          const pattern = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/)?.[1];
          if (pattern && !pattern.startsWith('!') && !pattern.includes('..')) workspaces.push(path.join(path.relative(boundary, parent), pattern, 'package.json'));
        }
      }
      if (parent === boundary) break;
    }
    for (const project of projects) {
      const parsed = ts.parseConfigFileTextToJson(project.uri, project.text);
      if (parsed.error) this.reader.navigation?.record({ code: 'config', message: '项目配置无法解析：' + ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'), uri: project.uri });
      const miniprogramRoot = parsed.config?.miniprogramRoot as unknown;
      if (typeof miniprogramRoot === 'string' && miniprogramRoot) outputs.add(path.resolve(path.dirname(decodeURIComponent(new URL(project.uri).pathname)), miniprogramRoot));
      const sourceRoot = parsed.config?.srcMiniprogramRoot as unknown;
      if (typeof sourceRoot === 'string' && sourceRoot) sources.add(path.resolve(path.dirname(decodeURIComponent(new URL(project.uri).pathname)), sourceRoot));
    }
    // 配置入口来自项目脚本与常见配置位置，不枚举或执行项目依赖。
    const configs = new Set(['webpack.config.js', 'webpack.config.ts', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack/webpack.config.js', 'webpack/webpack.config.ts', 'build/webpack.config.js', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'rollup.config.js', 'rollup.config.ts', 'rollup.config.mjs', 'esbuild.config.js', 'esbuild.config.ts', 'esbuild.config.mjs', 'config/index.ts', 'config/index.js']);
    for (const command of Object.values(manifest?.scripts ?? {})) {
      if (typeof command !== 'string') continue;
      for (const match of command.matchAll(/(?:--config(?:=|\s+)|\s-c\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
        const config = match[1] ?? match[2] ?? match[3];
        if (config && /\.[cm]?[jt]s$/.test(config) && !config.includes('$')) configs.add(config);
      }
      for (const match of command.matchAll(/\b(?:node|tsx|ts-node|jiti)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
        const script = match[1] ?? match[2] ?? match[3];
        if (script && /\.[cm]?[jt]s$/.test(script) && !script.includes('$')) configs.add(script);
      }
    }
    for (const config of configs) {
      const filename = path.resolve(root, config);
      const text = await this.read(uriAt(this.entry, filename));
      if (!text) continue;
      this.reader.navigation?.record({ code: 'config', message: '读取静态构建配置；函数调用与动态配置不会执行。', uri: uriAt(this.entry, filename) });
      const dependencies = await this.configDependencies(filename, text);
      const versions = new Map<string, string>();
      if ([...dependencies.values()].some((content) => content.includes('vite-plugin-static-copy'))) for (let directory = root, depth = 0; depth < 16; depth++) {
        const installed = await this.read(uriAt(this.entry, path.join(directory, 'node_modules/vite-plugin-static-copy/package.json')));
        if (installed) { try { versions.set('vite-plugin-static-copy', JSON.parse(installed).version); } catch { /* 无效版本不推断复制布局。 */ } break; }
        if (directory === boundary || directory === '/') break;
        directory = path.dirname(directory);
      }
      const build = inspectBuildConfig(text, filename, root, dependencies, versions);
      build.sourceRoots.forEach((value) => sources.add(value));
      build.outputRoots.forEach((value) => outputs.add(value));
      mappings.push(...build.mappings);
      aliases.push(...build.aliases);
      includes.push(...build.includes);
    }
    // TypeScript 官方配置解析保留 extends 和相对 baseUrl 的语义。
    if (tsconfig) {
      const pending = new Set<string>();
      const requested = new Set<string>();
      const textAt = (uri: string): string | undefined => { if (!requested.has(uri)) pending.add(uri); return undefined; };
      const texts = new Map<string, string>();
      const main = await this.read(tsconfig);
      if (main !== undefined) texts.set(tsconfig, main);
      let parsed: ts.ParsedCommandLine | undefined;
      for (let round = 0; round < 16; round++) {
        parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
          useCaseSensitiveFileNames: true, readDirectory: () => [],
          readFile: (uri) => texts.get(uri) ?? textAt(uri), fileExists: (uri) => { if (!texts.has(uri)) textAt(uri); return texts.has(uri); },
          getCurrentDirectory: () => uriAt(this.entry, root), onUnRecoverableConfigFileDiagnostic: (error) => this.reader.navigation?.record({ code: 'config', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), uri: tsconfig }),
        });
        if (!pending.size) break;
        const files = [...pending]; pending.clear();
        for (const uri of files) { requested.add(uri); const text = await this.read(uri); if (text !== undefined) texts.set(uri, text); }
      }
      const inheritedBase = parsed?.options.pathsBasePath;
      for (const error of parsed?.errors ?? []) if (error.code !== 18003) this.reader.navigation?.record({ code: 'config', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), uri: tsconfig });
      const base = parsed?.options.baseUrl ?? (typeof inheritedBase === 'string' ? inheritedBase : tsconfig.replace(/[^/]+$/, ''));
      for (const [name, targets] of Object.entries(parsed?.options.paths ?? {})) aliases.push({ name, exact: !name.includes('*'), targets: targets.map((target) => decodeURIComponent(new URL(target, base.replace(/\/?$/, '/')).pathname)) });
    }
    if (!sources.size) sources.add(root);
    for (const output of outputs) for (const original of sources) if (original !== output) mappings.push({ output, source: original, compiled: true });
    this.reader.navigation?.record({ code: 'context', message: `识别源码根：${[...sources].join('、')}；路径别名 ${aliases.length} 条，源码映射 ${mappings.length} 条。`, uri: uriAt(this.entry, root) });
    return { root, sources: [...sources], outputs: [...outputs], mappings: mappings.sort((a, b) => b.output.length - a.output.length), aliases: aliases.sort((a, b) => b.name.replace('*', '').length - a.name.replace('*', '').length), includes, workspaces };
  }

  /** 从包清单读取组件、样式和源码入口，标准脚本导出仍交由 TypeScript 解析。 */
  private async packages(reference: string, from: string, kind: FileReferenceKind): Promise<readonly string[]> {
    if (!reference || reference.startsWith('.') || reference.startsWith('/') || reference.startsWith('#') || reference.includes(':')) return [];
    const segments = reference.split('/');
    const name = segments.splice(0, reference.startsWith('@') ? 2 : 1).join('/');
    const subpath = segments.join('/');
    let current = path.dirname(decodeURIComponent(new URL(from).pathname));
    const result: string[] = [];
    /** 包入口保留源码条件、组件字段、样式字段以及实际子路径。 */
    const entries = (manifest: Record<string, unknown>, directory: string): void => {
      if (kind === 'component' && typeof manifest.miniprogram === 'string') result.push(path.join(directory, manifest.miniprogram, subpath));
      if (kind === 'style' && !subpath) for (const field of ['sass', 'style', 'less']) if (typeof manifest[field] === 'string') result.push(path.join(directory, manifest[field]));
      const exports = manifest.exports;
      const key = subpath ? './' + subpath : '.';
      let target: unknown = exports;
      let capture = '';
      if (exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'))) {
        target = (exports as Record<string, unknown>)[key];
        if (target === undefined) for (const [pattern, value] of Object.entries(exports)) {
          const star = pattern.indexOf('*');
          if (star < 0 || !key.startsWith(pattern.slice(0, star)) || !key.endsWith(pattern.slice(star + 1))) continue;
          capture = key.slice(star, pattern.length - star - 1 ? -(pattern.length - star - 1) : undefined); target = value; break;
        }
      } else if (subpath) target = undefined;
      if (typeof manifest.source === 'string' && (exports === undefined || target !== undefined && target !== null)) {
        const base = path.join(directory, manifest.source);
        if (!subpath || !/\.[cm]?[jt]sx?$/.test(base)) result.push(subpath ? path.join(base, subpath) : base);
      }
      /** 导出条件仅提供候选，不执行自定义条件表达式。 */
      const exported = (value: unknown, depth = 0): void => {
        if (depth > 8) return;
        if (typeof value === 'string' && value.startsWith('./')) result.push(path.join(directory, value.replace('*', capture)));
        else if (Array.isArray(value)) value.forEach((item) => exported(item, depth + 1));
        else if (value && typeof value === 'object') for (const field of kind === 'script' ? ['source'] : ['source', 'sass', 'style', 'import', 'require', 'default']) exported((value as Record<string, unknown>)[field], depth + 1);
      };
      exported(target);
      if (kind !== 'script') result.push(path.join(directory, subpath || (typeof manifest.module === 'string' ? manifest.module : typeof manifest.main === 'string' ? manifest.main : 'index')));
    };
    for (let depth = 0; depth < 32; depth++) {
      const directory = path.join(current, 'node_modules', name);
      const text = await this.read(uriAt(from, path.join(directory, 'package.json')));
      if (text) {
        try {
          const manifest = JSON.parse(text) as Record<string, unknown>;
          entries(manifest, directory);
          return result;
        } catch { /* 无效包清单不阻断其他祖先目录的依赖解析。 */ }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const profile = await this.profile;
    for (const pattern of profile?.workspaces ?? []) for (const uri of await this.reader.findFiles?.(this.entry, pattern, 128) ?? []) {
      const text = await this.read(uri);
      if (!text) continue;
      try {
        const manifest = JSON.parse(text) as Record<string, unknown>;
        if (manifest.name === name) entries(manifest, path.dirname(decodeURIComponent(new URL(uri).pathname)));
      } catch { /* 损坏或重名清单只影响对应包候选。 */ }
    }
    return result;
  }

  /** 按别名和复制规则还原源码；缺失的候选由具体语言按自身规则探测。 */
  async candidates(reference: string, from: string, kind: FileReferenceKind): Promise<readonly string[]> {
    if (this.cancellation?.isCancellationRequested) return [];
    if (!reference) return [];
    if (/[#$@]\{/.test(reference)) { this.reader.navigation?.record({ code: 'dynamic', message: '路径包含运行时表达式，无法静态确定文件：' + reference }); return []; }
    if (/^(?:plugin|dynamicLib|https?|data):|^\/\//i.test(reference)) { this.reader.navigation?.record({ code: 'unsupported', message: '外部资源或动态插件地址不属于本地源码导航：' + reference }); return []; }
    try { new URL('./', from); } catch { return []; }
    reference = reference.slice(reference.lastIndexOf('!') + 1).replace(/\?.*$|(?<=.)#.*$/, '');
    const profile = await (this.profile ??= this.discover());
    const bases: string[] = [];
    if (/^[a-z][\w+.-]*:\/\//i.test(reference)) {
      const uri = new URL(reference);
      if (uri.protocol !== new URL(from).protocol || uri.host !== new URL(from).host) return [];
      bases.push(decodeURIComponent(uri.pathname));
    } else {
      const normalized = reference.replace(/^~/, '');
      for (const alias of profile.aliases) {
        let suffix: string | undefined;
        const star = alias.name.indexOf('*');
        if (star >= 0) {
          const prefix = alias.name.slice(0, star), end = alias.name.slice(star + 1);
          if (normalized.startsWith(prefix) && normalized.endsWith(end) && normalized.length >= prefix.length + end.length) suffix = normalized.slice(prefix.length, end ? -end.length : undefined);
        } else if (normalized === alias.name || !alias.exact && normalized.startsWith(alias.name + '/')) suffix = normalized.slice(alias.name.length).replace(/^\//, '');
        if (suffix === undefined) continue;
        this.reader.navigation?.record({ code: 'alias', message: `路径 ${reference} 匹配别名 ${alias.name}，按配置目标继续查找。`, uri: from });
        for (const target of alias.targets) bases.push(target.includes('*') ? target.replace('*', suffix) : path.join(target, suffix));
        break;
      }
      if (normalized.startsWith('/')) {
        if (kind === 'component' || kind === 'style') for (const output of profile.outputs) bases.push(path.join(output, normalized.slice(1)));
        bases.push(path.normalize(normalized));
        if (kind !== 'file') for (const source of profile.sources) bases.push(path.join(source, normalized.slice(1)));
      } else if (normalized.startsWith('.')) bases.push(path.resolve(path.dirname(decodeURIComponent(new URL(from).pathname)), normalized));
      else if (kind !== 'script') bases.push(path.resolve(path.dirname(decodeURIComponent(new URL(from).pathname)), normalized));
      if (/^@\//.test(normalized) && !profile.aliases.some((alias) => alias.name === '@' || alias.name.startsWith('@/'))) this.reader.navigation?.record({ code: 'alias', message: '未识别到 @/ 对应的路径别名；请检查当前工程的 tsconfig paths 或静态构建别名。', uri: from });
      if (kind === 'style') for (const include of profile.includes) bases.push(path.resolve(include, normalized));
      if ((!normalized.startsWith('.') && !normalized.startsWith('/') && !bases.length) || kind === 'style' || kind === 'component') bases.push(...await this.packages(normalized, from, kind));
    }
    const result: string[] = [];
    for (const base of bases) {
      // 单文件 source map 可以直接还原原始文件，多源 bundle 不猜测第一个来源。
      if (/\.[cm]?js$/.test(base) && profile.outputs.some((output) => relativeTo(output, base) !== undefined)) {
        const text = await this.read(uriAt(from, base + '.map'));
        if (text) try {
          const map = JSON.parse(text) as { sources?: unknown; sourceRoot?: unknown };
          if (Array.isArray(map.sources) && map.sources.length === 1 && typeof map.sources[0] === 'string' && !/^[a-z][\w+.-]*:|^\/\//i.test(map.sources[0]) && !(typeof map.sourceRoot === 'string' && /^[a-z][\w+.-]*:|^\/\//i.test(map.sourceRoot))) {
            const root = typeof map.sourceRoot === 'string' && !/^[a-z][\w+.-]*:|^\/\//i.test(map.sourceRoot) ? map.sourceRoot : '';
            result.push(uriAt(from, path.resolve(path.dirname(base), root, map.sources[0])));
          }
        } catch { /* 缺失或损坏的 source map 继续使用配置映射。 */ }
      }
      // 同一输出目录可有专用复制规则与普通源码规则，专用规则先探测。
      for (const mapping of profile.mappings) {
        if (mapping.exact && mapping.output !== base) continue;
        const relative = relativeTo(mapping.output, base);
        if (relative !== undefined) {
          const source = path.join(mapping.source, relative);
          this.reader.navigation?.record({ code: 'path', message: `输出路径映射到源码：${base} → ${source}` });
          // 常见构建扩展名还原只应用于已识别的输出目录，不猜测普通 npm 文件。
          const replacements = !mapping.compiled ? [] : /\.wxss$/.test(source) ? ['.scss', '.less', '.css'] : /\.js$/.test(source) ? ['.ts', '.tsx', '.jsx'] : /\.mjs$/.test(source) ? ['.mts'] : /\.cjs$/.test(source) ? ['.cts'] : [];
          for (const extension of replacements) result.push(uriAt(from, source.replace(/\.[^.]+$/, extension)));
          result.push(uriAt(from, source));
        }
      }
      result.push(uriAt(from, base));
    }
    const candidates = [...new Set(result)];
    this.reader.navigation?.record({ code: 'path', message: `路径 ${reference} 生成 ${candidates.length} 个候选；是否存在由所属语言继续检查。`, uri: from });
    return this.cancellation?.isCancellationRequested ? [] : candidates;
  }
}

/** 组合入口统一注入此模块，语言解析器只依赖公共能力端口。 */
export function createProjectFileResolver(reader: WorkspaceReader, uri: string, cancellation?: Cancellation): ProjectFileResolver {
  return new ProjectResolver(reader, uri, cancellation);
}

