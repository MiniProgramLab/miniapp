import type { CodeAction, Completion, ComponentLocation, ComponentProperty, ComponentResolver, ComponentScriptInfo, ComponentScriptResolver, ComponentUsages, Definition, Diagnostic, Hover, LanguageRequest, ProjectFileResolver, ScriptDefinitionResolver, TextRange, WorkspaceReader, WorkspaceText } from '../../api';
import { scanTags, tagAt } from './parser';
import type { TagToken } from './parser';
import { componentContexts } from './template-project';
import { provideCompletions } from './service';
import { accepts, eventAttribute, eventDescription } from './events';
import { scriptExpression } from './wxs';
import { nativeTags } from './catalog';
import { readTemplateTree } from './template-tree';

/** 静态组件路径的搜索设置，独立于编辑器配置格式。 */
export interface ComponentOptions {
  readonly sourceRoot?: string;
  readonly includePaths?: readonly string[];
  readonly maxFiles?: number;
  readonly maxTemplateFiles?: number;
}

/** 插槽实现保留 WXML 中的实际声明及注释。 */
interface SlotInfo {
  readonly name: string;
  readonly description: string;
  readonly definition: ComponentLocation;
}

/** 已解析的组件实现及其模板插槽。 */
interface ComponentInfo extends ComponentScriptInfo {
  readonly slots: readonly SlotInfo[];
}

/** 使用处的说明和定义共用同一个命中结果。 */
interface ComponentTarget {
  readonly title: string;
  readonly description: string;
  readonly range: TextRange;
  readonly definitions: readonly ComponentLocation[];
}

/** 将文件 URI 转为其目录，保留远程工作区的协议。 */
function directory(uri: string): string { return new URL('./', uri).toString(); }

/** 光标只命中真实字符，避免属性间隙产生错误跳转。 */
function contains(range: TextRange, offset: number): boolean { return offset >= range.start && offset < range.end; }

/** 属性支持小程序常用的驼峰声明与连字符使用方式。 */
function camel(name: string): string { return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); }

/** 悬浮和补全共用源码说明，省略重复的参数名。 */
function propertyDescription(property: ComponentProperty): string {
  return [property.description, `类型：${property.type}`, `默认值：${property.defaultValue}`, property.required ? '必填参数' : ''].filter(Boolean).join('\n');
}

/** 插槽声明前紧邻的模板注释，避免读取上一兄弟节点的说明。 */
function leadingComment(text: string, start: number): string {
  const match = text.slice(0, start).match(/<!--((?:(?!-->).)*)-->\s*$/s);
  return match?.[1]?.trim() ?? '';
}

/** 根据真实标签构造父节点栈；注释、CDATA 和 WXS 自动排除。 */
function ancestors(text: string, offset: number): TagToken[] {
  const stack: TagToken[] = [];
  for (const tag of scanTags(text)) {
    if (tag.start >= offset) break;
    if (tag.closing) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index]!.name !== tag.name) index--;
      if (index >= 0) stack.splice(index);
    } else if (!tag.selfClosing) stack.push(tag);
  }
  return stack;
}

/** 单次查询内共享读缓存和预算，未保存内容无需长期缓存失效。 */
class ComponentProject {
  private readonly documents = new Map<string, Promise<WorkspaceText | undefined>>();
  private readonly metadata = new Map<string, Promise<ComponentScriptInfo | undefined>>();
  private readonly revisions = new Map<string, string>();
  private readonly components = new Map<string, Promise<ComponentInfo | undefined>>();
  private readonly root: string;
  private readonly reader: WorkspaceReader;
  private readonly scripts: ComponentScriptResolver;
  private readonly maxReads: number;
  private readonly files: ProjectFileResolver | undefined;
  private bytes = 0;
  private environment?: Promise<{ roots: readonly string[]; global: Readonly<Record<string, string>>; from: string; open: boolean }>;

  /** 为脚本解析器注入同一读快照，确保配置、属性和插槽来自一致的缓冲区。 */
  constructor(reader: WorkspaceReader, scripts: (reader: WorkspaceReader) => ComponentScriptResolver, private readonly request: LanguageRequest, private readonly options: ComponentOptions) {
    this.files = reader.fileResolver?.(request.document.uri, request.cancellation);
    this.root = (reader.root(request.document.uri) ?? directory(request.document.uri)).replace(/\/?$/, '/');
    this.maxReads = Math.max(1, Math.min(1000, options.maxFiles ?? 400)) * 24 + 128;
    this.reader = { ...reader, ...(this.files ? { fileResolver: () => this.files! } : {}), root: (uri) => reader.root(uri), ...(reader.findFiles ? { findFiles: (uri: string, pattern: string, limit: number) => reader.findFiles!(uri, pattern, limit) } : {}), read: async (uri) => {
      if (request.cancellation.isCancellationRequested) return undefined;
      let pending = this.documents.get(uri);
      if (!pending) {
        if (this.documents.size >= this.maxReads) { reader.navigation?.record({ code: 'budget', message: '组件配置与路径探测达到上限，后续组件来源可能不完整。', uri }); return undefined; }
        pending = (async () => {
          if (reader.revision) this.revisions.set(uri, reader.revision(uri));
          const value = uri === request.document.uri ? request.document : await reader.read(uri);
          if (!value || request.cancellation.isCancellationRequested) return undefined;
          if (value.text.length > 2_000_000 || this.bytes + value.text.length > 16_000_000) { reader.navigation?.record({ code: 'budget', message: '组件文本超过单文件或总量上限，后续来源未读取。', uri }); return undefined; }
          this.bytes += value.text.length;
          return value;
        })();
        this.documents.set(uri, pending);
      }
      return pending;
    } };
    this.scripts = scripts(this.reader);
  }

  /** 元数据解析以文件为键，循环引用不会重复创建语义图。 */
  private inspect(uri: string, includeInstance = false): Promise<ComponentScriptInfo | undefined> {
    const key = `${uri}:${includeInstance}`;
    let pending = this.metadata.get(key);
    if (!pending) {
      pending = this.reader.read(uri).then((document) => document ? this.scripts.inspect(this.request, uri, includeInstance) : undefined);
      this.metadata.set(key, pending);
    }
    return pending;
  }

  /** JSON 注册优先；没有 JSON 时才读取同名脚本和配置宏。 */
  private async config(base: string): Promise<Readonly<Record<string, string>>> {
    const json = await this.inspect(base + '.json');
    if (json) return json.registrations;
    for (const suffix of ['.config.ts', '.config.js', '.ts', '.js']) {
      const info = await this.inspect(base + suffix);
      if (info) return info.registrations;
    }
    return {};
  }

  /** 查找最近应用源码根和项目目录，覆盖静态复制到构建目录的 libs。 */
  private settings(): Promise<{ roots: readonly string[]; global: Readonly<Record<string, string>>; from: string; open: boolean }> {
    return this.environment ??= (async () => {
      let current = directory(this.request.document.uri);
      let sourceRoot = this.options.sourceRoot ? new URL(this.options.sourceRoot.replace(/\/?$/, '/'), this.root).toString() : undefined;
      let projectRoot: string | undefined;
      for (let depth = 0; depth < 40 && !this.request.cancellation.isCancellationRequested; depth++) {
        if (!sourceRoot) for (const file of ['app.json', 'app.config.ts', 'app.config.js']) {
          if (await this.reader.read(new URL(file, current).toString())) { sourceRoot = current; break; }
        }
        if (!projectRoot && (await this.reader.read(new URL('package.json', current).toString()))) projectRoot = current;
        if (sourceRoot && projectRoot) break;
        if (current.replace(/\/$/, '') === this.root.replace(/\/$/, '')) break;
        const parent = new URL('../', current).toString();
        if (parent === current) break;
        current = parent;
      }
      sourceRoot ??= this.root.endsWith('/') ? this.root : this.root + '/';
      const roots = [...new Set([sourceRoot, projectRoot ?? directory(sourceRoot.replace(/\/$/, '')), ...this.options.includePaths?.map((path) => new URL(path.replace(/\/?$/, '/'), this.root).toString()) ?? []])];
      const base = new URL('app', sourceRoot).toString();
      let open = false;
      for (const suffix of ['.json', '.config.ts', '.config.js', '.ts', '.js']) {
        const info = await this.inspect(base + suffix);
        if (info) { open = info.registrationComplete !== true; break; }
      }
      return { roots, global: await this.config(base), from: new URL('app.json', sourceRoot).toString(), open };
    })();
  }

  /** 本文件的组件注册覆盖应用全局注册。 */
  private async registration(name: string): Promise<readonly { path: string; from: string }[]> {
    const local = await this.config(this.request.document.uri.replace(/\.wxml$/i, ''));
    if (name in local) return [{ path: local[name]!, from: this.request.document.uri }];
    const environment = await this.settings();
    // 已有独立页面配置时，无需为普通未注册标签枚举整个工作区。
    const base = this.request.document.uri.replace(/\.wxml$/i, '');
    const standalone = !(await this.reader.read(base + '.json')) && !(await this.reader.read(base + '.ts')) && !(await this.reader.read(base + '.js'));
    const registrations: { path: string; from: string }[] = [];
    if (standalone && this.reader.findFiles) {
      const contexts = await componentContexts(this.reader, this.request, { maxFiles: this.options.maxTemplateFiles ?? 500 });
      for (const uri of new Set(contexts.map((context) => context.uri).filter((uri) => uri !== this.request.document.uri))) {
        const config = await this.config(uri.replace(/\.wxml$/i, ''));
        if (name in config) registrations.push({ path: config[name]!, from: uri });
        else if (environment.global[name]) registrations.push({ path: environment.global[name]!, from: environment.from });
      }
    }
    if (!registrations.length && environment.global[name]) registrations.push({ path: environment.global[name]!, from: environment.from });
    return registrations;
  }

  /** 组件入口只探测运行时代码和模板，绝不选中 .d.ts。 */
  private async entry(base: string): Promise<string | undefined> {
    if (/\.d\.[cm]?ts$/i.test(base)) return undefined;
    if (/\.(?:[cm]?[jt]sx?|wxml)$/i.test(base)) return await this.reader.read(base) ? base : undefined;
    for (const suffix of ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.wxml', '/index.ts', '/index.js', '/index.wxml']) {
      const uri = base.replace(/\/$/, '') + suffix;
      if (await this.reader.read(uri)) return uri;
    }
    return undefined;
  }

  /** 支持源码根路径、相对路径、miniprogram_npm 和 npm 包的 miniprogram 入口。 */
  private async path(reference: string, from: string): Promise<string | undefined> {
    if (!reference || /^(?:plugin|dynamicLib):\/\//.test(reference)) return undefined;
    // 显式源码根设置保留原有优先级；自动模式先还原构建配置中的源码路径。
    if (!this.options.sourceRoot) for (const candidate of await this.files?.candidates(reference, from, 'component') ?? []) {
      if (this.request.cancellation.isCancellationRequested) return undefined;
      const target = await this.entry(candidate);
      if (target) return target;
    }
    if (reference.startsWith('.')) return this.entry(new URL(reference, from).toString());
    const environment = await this.settings();
    if (reference.startsWith('/')) {
      for (const root of environment.roots) {
        const target = await this.entry(new URL(reference.slice(1), root).toString());
        if (target) return target;
      }
      return undefined;
    }
    const relative = await this.entry(new URL(reference, from).toString());
    if (relative) return relative;
    const segments = reference.split('/');
    const packageName = segments.splice(0, reference.startsWith('@') ? 2 : 1).join('/');
    const subpath = segments.join('/');
    let current = directory(from);
    for (let depth = 0; depth < 40 && !this.request.cancellation.isCancellationRequested; depth++) {
      const copied = await this.entry(new URL(`miniprogram_npm/${reference}`, current).toString());
      if (copied) return copied;
      const packageRoot = new URL(`node_modules/${packageName}/`, current).toString();
      const document = await this.reader.read(new URL('package.json', packageRoot).toString());
      if (document) {
        try {
          const manifest = JSON.parse(document.text) as { miniprogram?: string; source?: string; main?: string };
          const candidates = manifest.miniprogram ? [`${manifest.miniprogram.replace(/\/$/, '')}/${subpath}`] : [];
          candidates.push(subpath || manifest.source || manifest.main || 'index');
          for (const path of candidates) {
            const target = await this.entry(new URL(path, packageRoot).toString());
            if (target) return target;
          }
        } catch { /* 无效包清单不影响其他组件路径。 */ }
      }
      if (current.replace(/\/$/, '') === this.root.replace(/\/$/, '')) break;
      const parent = new URL('../', current).toString();
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  }

  /** 路由消费图只解析实际节点的注册路径，避免加载无关组件的公开接口。 */
  async usages(): Promise<ComponentUsages> {
    const tree = await readTemplateTree(this.reader, this.request, this.request.document.uri, [], new Set(), undefined, this.revisions);
    const names = [...new Set(tree.nodes.filter((node) => !nativeTags.has(node.tag.name)).map((node) => node.tag.name))];
    const targets: ComponentUsages['targets'][number][] = [];
    let complete = tree.complete;
    if (names.length) complete &&= await this.closedRegistration();
    for (const name of names) {
      const registrations = await this.registration(name);
      if (!registrations.length) complete = false;
      for (const registered of registrations) {
        const uri = await this.path(registered.path, registered.from);
        if (!uri) { complete = false; continue; }
        targets.push({ uri, reference: registered.path, from: registered.from });
      }
    }
    const metadata = await Promise.all(this.metadata.values());
    const dependencies = [...this.revisions].map(([uri, revision]) => ({ uri, revision })).concat(this.files?.dependencies ?? [], metadata.flatMap((item) => item?.dependencies ?? []));
    return { targets: [...new Map(targets.map((item) => [item.uri + ':' + item.reference + ':' + item.from, item])).values()], complete, dependencies };
  }

  /** 完整的消费页面配置才允许检查注册，独立模板和未知宏保持开放。 */
  private async closedRegistration(): Promise<boolean> {
    const base = this.request.document.uri.replace(/\.wxml$/i, '');
    for (const suffix of ['.json', '.config.ts', '.config.js', '.ts', '.js']) {
      const info = await this.inspect(base + suffix);
      if (info) return info.registrationComplete === true && !(await this.settings()).open;
    }
    return false;
  }

  /** 原生灯泡追加必填参数或注册选中的真实组件，操作不会直接写入项目。 */
  async codeActions(range: TextRange, scripts?: ScriptDefinitionResolver): Promise<readonly CodeAction[]> {
    const tag = [...scanTags(this.request.document.text)].find((tag) => !tag.closing && tag.start <= range.end && range.start <= tag.end);
    if (!tag || this.request.cancellation.isCancellationRequested) return [];
    const result: CodeAction[] = [];
    const component = await this.component(tag.name);
    const supplied = new Set(tag.attributes.map((attribute) => camel(attribute.name)));
    const missing = component?.properties.filter((property) => property.required && !supplied.has(property.name)) ?? [];
    if (missing.length) {
      const text = missing.map((property) => {
        const name = property.name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
        const fallback = property.defaultValue === '未设置' ? '{{undefined}}' : property.type === 'string' ? '' : `{{${property.defaultValue}}}`;
        return ` ${name}="${fallback.replace(/"/g, '&quot;')}"`;
      }).join('');
      result.push({ title: '补充组件必填参数', kind: 'quickfix', range: tag.nameRange, edits: [{ uri: this.request.document.uri, range: { start: tag.nameRange.end, end: tag.nameRange.end }, oldText: '', expectedText: this.request.document.text, version: this.request.document.version, newText: text }] });
    }
    if (component || nativeTags.has(tag.name) || !scripts?.registerComponent || !await this.closedRegistration()) return result;
    const files = await this.reader.findFiles?.(this.request.document.uri, '**/*.json', 2000) ?? [];
    const slug = tag.name.toLowerCase().replace(/-/g, '');
    const preferred = files.filter((uri) => {
      const name = decodeURIComponent(new URL(uri).pathname).replace(/(?:\/index)?\.json$/, '').split('/').at(-1)!;
      return name.toLowerCase().replace(/-/g, '') === slug;
    });
    const candidates: string[] = [];
    for (const uri of preferred.length ? preferred : files) {
      if (this.request.cancellation.isCancellationRequested) return [];
      const info = await this.inspect(uri);
      if (info?.kind === 'component') candidates.push(uri);
    }
    /** 任意组件别名都可选择源码，只有名称明确匹配时才直接给出具体修复。 */
    const register = async (uri: string) => {
      const target = uri.slice(0, -5);
      const from = new URL(this.request.document.uri);
      const destination = new URL(target);
      if (from.protocol !== destination.protocol || from.host !== destination.host) return { reference: '', edits: [] };
      const left = from.pathname.split('/').slice(0, -1), right = destination.pathname.split('/');
      while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
      const reference = '../'.repeat(left.length) + (left.length ? '' : './') + decodeURIComponent(right.join('/'));
      return { reference, edits: await scripts.registerComponent!(this.request, tag.name, reference) };
    };
    if (preferred.length) for (const uri of candidates.slice(0, 10)) {
      const { reference, edits } = await register(uri);
      if (edits.length) result.push({ title: `注册 ${tag.name} → ${reference}`, kind: 'quickfix', range: tag.nameRange, edits });
    } else if (candidates.length) {
      result.push({ title: `选择并注册组件 ${tag.name}…`, kind: 'quickfix', range: tag.nameRange, edits: [], choice: {
        title: `选择 ${tag.name} 对应的组件源码`, items: candidates.map((uri) => ({ label: decodeURIComponent(uri.startsWith(this.root) ? uri.slice(this.root.length) : new URL(uri).pathname), value: uri })),
        select: async (uri) => (await register(uri)).edits,
      } });
    }
    return result;
  }

  /** 提取所有具名和默认插槽，并跟随组件模板的静态 include。 */
  private async slots(uri: string, seen = new Set<string>()): Promise<SlotInfo[]> {
    if (seen.has(uri) || seen.size >= 100) return [];
    seen.add(uri);
    const document = await this.reader.read(uri);
    if (!document) return [];
    const result: SlotInfo[] = [];
    for (const tag of scanTags(document.text)) {
      if (tag.closing) continue;
      if (tag.name === 'include') {
        const range = tag.attributes.find((item) => item.name === 'src')?.valueRange;
        const path = range && document.text.slice(range.start, range.end);
        if (path && !path.includes('{{')) {
          const candidates = await this.files?.candidates(path, uri, 'file') ?? [];
          for (const candidate of [...candidates, new URL(path, uri).toString()]) {
            if (await this.reader.read(candidate)) { result.push(...await this.slots(candidate, seen)); break; }
          }
        }
      }
      if (tag.name !== 'slot') continue;
      const range = tag.attributes.find((item) => item.name === 'name')?.valueRange;
      const name = range ? document.text.slice(range.start, range.end) : '';
      if (name.includes('{{')) continue;
      let description = leadingComment(document.text, tag.start);
      // 插槽由包装节点说明时，沿直接父节点向上查找紧邻注释。
      if (!description) for (const parent of ancestors(document.text, tag.start).reverse()) {
        description = leadingComment(document.text, parent.start);
        if (description) break;
      }
      result.push({ name, description, definition: { uri, range: range ?? tag.nameRange, ...(document.version !== undefined ? { version: document.version } : {}) } });
    }
    return result;
  }

  /** 根据标签注册解析组件；同一请求中的重复父节点共用结果。 */
  private component(name: string, includeInstance = false): Promise<ComponentInfo | undefined> {
    const key = `${name}:${includeInstance}`;
    let pending = this.components.get(key);
    if (!pending) {
      pending = (async () => {
        const registrations = await this.registration(name);
        if (!registrations.length) {
          if (!nativeTags.has(name)) this.reader.navigation?.record({ code: 'symbol', message: `没有得到 ${name} 的静态组件注册；请检查本地/全局注册、动态配置及框架适配规则。`, uri: this.request.document.uri });
          return undefined;
        }
        const implementations: ComponentInfo[] = [];
        for (const registered of registrations) {
          const target = await this.path(registered.path, registered.from);
          if (!target) { this.reader.navigation?.record({ code: 'missing', message: `组件 ${name} 已注册为 ${registered.path}，但未找到实现文件。`, uri: registered.from }); continue; }
          this.reader.navigation?.record({ code: 'path', message: `沿组件 ${name} 的注册 ${registered.path} 定位实现。`, uri: target });
          const script = /\.wxml$/i.test(target) ? undefined : await this.inspect(target, includeInstance);
          let template = target.replace(/\.(?:[cm]?[jt]sx?|wxml)$/i, '.wxml');
          let document = await this.reader.read(template);
          // 纯重导出入口可能没有模板，应跟随真实组件实现的同名 WXML。
          if (!document) for (const definition of script?.definitions ?? []) {
            const candidate = definition.uri.replace(/\.[cm]?[jt]sx?$/i, '.wxml');
            const content = await this.reader.read(candidate);
            if (content) { template = candidate; document = content; break; }
          }
          const slots = await this.slots(template);
          const firstTag = document && scanTags(document.text).next().value;
          const fallback: ComponentLocation[] = firstTag ? [{ uri: template, range: firstTag.nameRange, ...(document?.version !== undefined ? { version: document.version } : {}) }] : [];
          implementations.push({ ...script, description: script?.description || (document && firstTag ? leadingComment(document.text, firstTag.start) : ''),
            definitions: script?.definitions.length ? script.definitions : fallback,
            properties: script?.properties ?? [], registrations: script?.registrations ?? {}, events: script?.events ?? [], slots });
        }
        // 已注册但源码不可用的内层组件仍是插槽边界，不能误跳到外层组件。
        return { description: [...new Set(implementations.map((item) => item.description).filter(Boolean))].join('\n'), definitions: implementations.flatMap((item) => item.definitions), properties: implementations.flatMap((item) => item.properties), registrations: {}, events: implementations.flatMap((item) => item.events ?? []), slots: implementations.flatMap((item) => item.slots), members: implementations.flatMap((item) => item.members ?? []),
          complete: implementations.every((item) => item.complete !== false), dependencies: [...this.revisions].map(([uri, revision]) => ({ uri, revision })).concat(implementations.flatMap((item) => item.dependencies ?? [])) };
      })();
      this.components.set(key, pending);
    }
    return pending;
  }

  /** 提取保留原注册路径及其基准，只有实现可定位时才允许迁移。 */
  async extractionRegistration(name: string) {
    const result: { reference: string; from: string; uri: string }[] = [];
    for (const registered of await this.registration(name)) {
      const uri = await this.path(registered.path, registered.from);
      if (!uri) return [];
      result.push({ reference: registered.path, from: registered.from, uri });
    }
    return result;
  }

  /** 实例查询读取光标所在标签的公开成员，避免第二套组件路径规则。 */
  async instance(includeMembers = true): Promise<ComponentScriptInfo | undefined> {
    const tag = tagAt(this.request.document.text, this.request.offset);
    return tag && !tag.closing ? this.component(tag.name, includeMembers) : undefined;
  }

  /** 参数说明直接展示注释、类型、默认值和必填信息，省略重复的参数名。 */
  private propertyTarget(property: ComponentProperty, range: TextRange): ComponentTarget {
    return { title: '', description: propertyDescription(property), range, definitions: property.definitions };
  }

  /** 参数补全沿用基础提供器的替换规则，已使用参数兼容两种命名。 */
  async completion(): Promise<readonly Completion[]> {
    const { document, offset } = this.request;
    const tag = tagAt(document.text, offset);
    if (!tag || tag.closing || offset <= tag.nameRange.end || this.request.cancellation.isCancellationRequested) return [];
    if (tag.attributes.some((attribute) => attribute.valueRange && offset >= attribute.valueRange.start && offset <= attribute.valueRange.end)) return [];
    const current = tag.attributes.find((attribute) => offset >= attribute.range.start && offset <= attribute.range.end);
    const prefix = current ? document.text.slice(current.range.start, offset) : '';
    const used = new Set(tag.attributes.filter((attribute) => attribute !== current).map((attribute) => camel(attribute.name)));
    const component = await this.component(tag.name);
    if (!component || this.request.cancellation.isCancellationRequested) return [];
    const eventPrefix = eventAttribute(current?.name ?? '')?.prefix ?? 'bind:';
    const usedEvents = new Set(tag.attributes.filter((attribute) => attribute !== current).map((attribute) => eventAttribute(attribute.name)?.name));
    const events = (component.events ?? []).filter((event) => !usedEvents.has(event.name)).map((event) => ({ name: eventPrefix + event.name, type: '事件', description: eventDescription(event) }));
    const attributes = component.properties.filter((property) => !used.has(property.name)).map((property) => {
      const name = property.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      // 编辑已有驼峰名称时保留其写法，新参数默认使用连字符形式。
      return { name: current?.name === property.name || prefix && property.name.startsWith(prefix) && !name.startsWith(prefix) ? property.name : name,
        type: property.type, description: propertyDescription(property) };
    });
    return provideCompletions(this.request, true, [...attributes, ...events]);
  }

  /** 标签和参数读取自身组件；slot 属性读取最近的所属组件。 */
  async target(): Promise<ComponentTarget | undefined> {
    const { document, offset } = this.request;
    const tag = tagAt(document.text, offset);
    if (!tag || this.request.cancellation.isCancellationRequested) return undefined;
    if (contains(tag.nameRange, offset)) {
      const component = await this.component(tag.name);
      return component ? { title: `<${tag.name}>`, description: [component.description, component.slots.length ? `插槽：${[...new Set(component.slots.map((slot) => slot.name || '默认'))].join('、')}` : ''].filter(Boolean).join('\n'), range: tag.nameRange, definitions: component.definitions } : undefined;
    }
    if (tag.closing) return undefined;
    const attribute = tag.attributes.find((item) => contains(item.range, offset) || eventAttribute(item.name) && offset === item.range.end || item.valueRange && contains(item.valueRange, offset));
    if (!attribute) return undefined;
    if (attribute.name === 'slot') {
      const name = attribute.valueRange ? document.text.slice(attribute.valueRange.start, attribute.valueRange.end) : '';
      if (name.includes('{{')) return undefined;
      for (const parent of ancestors(document.text, tag.start).reverse()) {
        const component = await this.component(parent.name);
        if (!component) continue;
        const slots = component.slots.filter((slot) => slot.name === name);
        return slots.length ? { title: `插槽 ${name || '默认'} · <${parent.name}>`, description: slots.map((slot) => slot.description).filter(Boolean).join('\n') || '此插槽在组件模板中定义。', range: attribute.valueRange && contains(attribute.valueRange, offset) ? attribute.valueRange : attribute.range, definitions: slots.map((slot) => slot.definition) } : undefined;
      }
      return undefined;
    }
    const component = await this.component(tag.name);
    const event = eventAttribute(attribute.name);
    if (event && offset <= attribute.range.end) {
      const events = component?.events?.filter((item) => item.name === event.name) ?? [];
      return events.length ? { title: `自定义事件 ${event.name}`, description: [...new Set(events.map(eventDescription))].join('\n\n'),
        range: { start: attribute.range.start + event.prefix.length, end: attribute.range.end }, definitions: events.flatMap((item) => item.definitions) } : undefined;
    }
    const properties = component?.properties.filter((item) => item.name === attribute.name || item.name === camel(attribute.name)) ?? [];
    if (!properties.length) return undefined;
    const targets = properties.map((property) => this.propertyTarget(property, attribute.valueRange && contains(attribute.valueRange, offset) ? attribute.valueRange : attribute.range));
    return { ...targets[0]!, description: [...new Set(targets.map((item) => item.description))].join('\n\n'), definitions: targets.flatMap((item) => item.definitions) };
  }

  /** 自定义事件只校验显式参数类型和必需参数数量，any 及动态名称不误报。 */
  async diagnostics(scripts?: ScriptDefinitionResolver): Promise<readonly Diagnostic[]> {
    if (!scripts || this.request.cancellation.isCancellationRequested) return [];
    const result: Diagnostic[] = [];
    const closed = await this.closedRegistration();
    for (const tag of scanTags(this.request.document.text)) {
      if (tag.closing) continue;
      if (closed && !nativeTags.has(tag.name) && !(await this.registration(tag.name)).length) result.push({ range: tag.nameRange, severity: 'warning', code: 'unregistered-component', message: `组件 ${tag.name} 未在当前页面或应用中注册。` });
      let component: ComponentInfo | undefined;
      const supplied = new Set(tag.attributes.map((attribute) => camel(attribute.name)));
      if (scripts.analyze) {
        component = await this.component(tag.name);
        for (const property of component?.properties ?? []) if (property.required && !supplied.has(property.name)) {
          result.push({ range: tag.nameRange, severity: 'warning', code: 'missing-property', message: `组件 ${tag.name} 缺少必填参数 ${property.name}。` });
        }
      }
      for (const attribute of tag.attributes) {
        const property = component?.properties.find((property) => property.name === camel(attribute.name));
        if (property?.valueType && attribute.valueRange && scripts.analyze) {
          const request = { ...this.request, offset: attribute.valueRange.start + 2 };
          const expression = scriptExpression(request);
          const text = this.request.document.text;
          if (expression && text.slice(expression.range.start - 2, expression.range.end + 2).trim() === text.slice(attribute.valueRange.start, attribute.valueRange.end).trim()) {
            const actual = await scripts.analyze(request, expression);
            if (actual && !actual.diagnostics.length && !accepts(actual.type, property.valueType)) result.push({ range: attribute.valueRange, severity: 'warning', code: 'property-type', message: `组件参数 ${property.name} 需要 ${property.type}，实际表达式为 ${actual.type.display}。` });
          }
        }
        const binding = eventAttribute(attribute.name);
        if (!scripts.signature || !binding?.name || !attribute.valueRange || this.request.cancellation.isCancellationRequested) continue;
        component ??= await this.component(tag.name);
        const events = component?.events?.filter((event) => event.name === binding.name) ?? [];
        if (!events.length) continue;
        const request = { ...this.request, offset: attribute.valueRange.start };
        const expression = scriptExpression(request);
        if (!expression?.event) continue;
        for (const signature of await scripts.signature(request, expression)) {
          const expected = signature.parameters[0]?.type;
          const detail = expected?.properties?.detail;
          const count = signature.parameters.filter((parameter) => !parameter.optional).length;
          const incompatible = count > 1 || expected && expected.kind !== 'unknown' && expected.kind !== 'object'
            || detail && events.some((event) => event.details.some((actual) => !accepts(actual, detail)));
          if (incompatible) result.push({ range: attribute.valueRange, severity: 'warning', message: count > 1
            ? `事件 ${binding.name} 只传入一个事件对象，处理函数有 ${count} 个必需参数。`
            : `事件 ${binding.name} 的 detail 为 ${[...new Set(events.flatMap((event) => event.details.map((detail) => detail.display)))].join(' | ')}，与处理函数参数 ${detail?.display ?? expected?.display} 不兼容。` });
        }
      }
    }
    return result;
  }
}

/** 模板通过脚本端口获得实现信息，无需依赖脚本语言模块内部。 */
export function createComponentResolver(reader: WorkspaceReader, scripts: (reader: WorkspaceReader) => ComponentScriptResolver, options: (uri: string) => ComponentOptions = () => ({})): ComponentResolver {
  /** 未命名缓冲区没有相对目录，交给内置提供器处理。 */
  const project = (request: LanguageRequest): ComponentProject | undefined => {
    try { new URL('./', request.document.uri); } catch { return undefined; }
    return new ComponentProject(reader, scripts, request, options(request.document.uri));
  };
  /** 每次提供器请求独立解析，避免引用未保存之前的结果。 */
  const target = (request: LanguageRequest): Promise<ComponentTarget | undefined> => {
    return project(request)?.target() ?? Promise.resolve(undefined);
  };
  return {
    /** 迁移和源码导航共享实际注册表。 */
    registration: (request, name) => project(request)?.extractionRegistration(name) ?? [],
    /** 消费关系与组件导航使用同一套路径和静态配置规则。 */
    usages: async (request) => await project(request)?.usages() ?? { targets: [], complete: false, dependencies: [] },
    /** 组件实例和标签导航共享静态注册、源码映射及草稿快照。 */
    instance: (request, includeMembers) => project(request)?.instance(includeMembers),
    /** 修复使用当前配置快照并保留未保存内容。 */
    codeActions: (request, range, scripts) => project(request)?.codeActions(range, scripts) ?? [],
    /** 同一请求复用组件元数据，检查期间不写入源码。 */
    diagnostics: (request, scripts) => project(request)?.diagnostics(scripts) ?? [],
    /** 补全与悬浮、跳转使用同一组件源码规则及独立快照。 */
    completion(request) {
      return project(request)?.completion() ?? [];
    },
    /** 将目标实现位置补上使用处的原始范围。 */
    async definition(request): Promise<readonly Definition[]> {
      const result = await target(request);
      const definitions = result && !request.cancellation.isCancellationRequested ? result.definitions.map((definition) => ({ ...definition, originRange: result.range })) : [];
      return [...new Map(definitions.map((definition) => [`${definition.uri}:${definition.range.start}:${definition.range.end}`, definition])).values()];
    },
    /** 已取消的请求不返回过期说明。 */
    async hover(request): Promise<Hover | undefined> {
      const result = await target(request);
      return result && !request.cancellation.isCancellationRequested ? { title: result.title, description: result.description, range: result.range } : undefined;
    },
  };
}
