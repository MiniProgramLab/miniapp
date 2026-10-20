import type { ComponentMember, ComponentResolver, ComponentScriptInfo, ComponentScriptResolver, Definition, InstanceAccess, LanguageFeatures, LanguageRequest, SemanticType, ScriptDefinitionResolver, WorkspaceDependency, WorkspaceReader } from '../../api';
import { readTemplateTree, templateAttribute as attribute } from './template-tree';
import type { TemplateNode as SelectorNode } from './template-tree';
import { nativeTags } from './catalog';

/** 同一 this 所属函数共用模板和组件语义，成员查询不再次读取配置与源码。 */
interface InstanceModel {
  readonly input: string;
  readonly nodes: readonly SelectorNode[];
  readonly dependencies: Map<string, string>;
  readonly components: Map<string, ComponentScriptInfo | undefined>;
  readonly complete: boolean;
  readonly owned: boolean;
  reusable: boolean;
  weight: number;
}

/** 支持标签、id、复合 class 以及子级和后代关系，复杂动态语法保持未知。 */
function selectorParts(selector: string): readonly { value: string; direct: boolean }[] | undefined {
  const tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const parts: { value: string; direct: boolean }[] = [];
  let direct = false;
  for (const token of tokens) {
    if (token === '>') { if (direct || !parts.length) return undefined; direct = true; continue; }
    if (!token || !/^(?:[\p{L}_][\p{L}\p{N}_:-]*|\*)?(?:[.#][\p{L}\p{N}_-]+)*$/u.test(token)) return undefined;
    parts.push({ value: token, direct }); direct = false;
  }
  return direct || !parts.length ? undefined : parts;
}

/** 单段选择器仅匹配可确定的属性，动态值使缺失诊断保持开放。 */
function segment(node: SelectorNode, value: string): boolean {
  const tag = value.match(/^[^.#]+/)?.[0];
  if (tag && tag !== '*' && tag !== node.tag.name) return false;
  if (![...value.matchAll(/#([^.#]+)/g)].every((match) => attribute(node, 'id') === match[1])) return false;
  const classes = new Set((attribute(node, 'class') ?? '').split(/\s+/));
  return [...value.matchAll(/\.([^.#]+)/g)].every((match) => classes.has(match[1]!));
}

/** 父节点链排除逻辑标签，普通选择器不会越过自定义组件内部边界。 */
function matches(node: SelectorNode, selector: string): boolean {
  const parts = selectorParts(selector);
  if (!parts || !segment(node, parts.at(-1)!.value)) return false;
  let parent = node.parents.length - 1;
  for (let index = parts.length - 2; index >= 0; index--) {
    const part = parts[index]!;
    const direct = parts[index + 1]!.direct;
    if (!direct) while (parent >= 0 && !segment(node.parents[parent]!, part.value)) parent--;
    if (parent < 0 || !segment(node.parents[parent]!, part.value)) return false;
    parent--;
  }
  return true;
}

/** 联合数据类型保留每个分支的成员，公开方法本身不展开为配置字段。 */
function typeMembers(type: SemanticType): Map<string, SemanticType[]> {
  const result = new Map<string, SemanticType[]>();
  for (const candidate of type.alternatives ?? [type]) for (const [name, member] of Object.entries(candidate.properties ?? {})) result.set(name, [...result.get(name) ?? [], member]);
  return result;
}

/** 组件实例语义通过脚本和组件端口组合，模板模块不依赖 TypeScript。 */
export function createInstanceFeatures(reader: WorkspaceReader, scripts: ScriptDefinitionResolver, inspector: ComponentScriptResolver, components: ComponentResolver): LanguageFeatures & {
  /** 字段改名使用声明身份，引用查询可额外追踪具名实现。 */
  symbols(request: LanguageRequest, followAliases?: boolean): Promise<readonly Definition[]>;
  /** 一个脚本只解析一次成员访问，再按真实组件契约确认声明。 */
  usages(request: LanguageRequest, names: readonly string[], followAliases?: boolean): Promise<readonly { range: InstanceAccess['range']; definitions: readonly Definition[]; renameSuffix?: string }[]>;
} {
  /** 模型和组件元数据总量有界，关闭扩展后随提供器一起释放。 */
  const models = new Map<string, InstanceModel>();
  /** 冲突或读取过程中发生变化的依赖不能进入可复用缓存。 */
  const retain = (model: InstanceModel, dependencies: readonly WorkspaceDependency[]): void => {
    for (const { uri, revision } of dependencies) {
      const previous = model.dependencies.get(uri);
      if (previous !== undefined && previous !== revision) model.reusable = false;
      model.dependencies.set(uri, revision);
    }
  };
  /** 仅稳定且有修订端口的完整模型参与复用，取消结果不保留。 */
  const valid = (model: InstanceModel): boolean => !!reader.revision && model.reusable && [...model.dependencies].every(([uri, revision]) => reader.revision!(uri) === revision);
  /** 过大的公开类型保持请求内使用，不让缓存无限增长。 */
  const trim = (): void => {
    while (models.size > 8 || [...models.values()].reduce((total, model) => total + model.weight, 0) > 4_000_000) models.delete(models.keys().next().value!);
  };
  /** 实例选择器与路由使用同一套实际模板展开规则。 */
  const nodes = (request: LanguageRequest, uri: string, parents: readonly SelectorNode[] = [], seen = new Set<string>(), templateName?: string, dependencies = new Map<string, string>()) => readTemplateTree(reader, request, uri, parents, seen, templateName, dependencies);

  /** 消费模板的已注册函数必须对应 this 所属函数，不能按文件名或方法名猜测。 */
  async function query(request: LanguageRequest, supplied?: InstanceAccess) {
    const access = supplied ?? await scripts.instanceAccess?.(request);
    if (!access || request.cancellation.isCancellationRequested) return undefined;
    if (!supplied && access.intent !== 'selector' && !access.selectors.length) return undefined;
    const key = `${reader.root(request.document.uri) ?? ''}:${access.owner.uri}:${access.owner.range.start}:${access.owner.range.end}`;
    const input = `${request.document.uri}:${request.document.version}:${request.document.text}`;
    const previous = models.get(key);
    if (previous?.input === input && valid(previous)) {
      models.delete(key); models.set(key, previous);
      return { access, nodes: previous.nodes, complete: previous.complete, model: previous };
    }
    models.delete(key);
    const result: SelectorNode[] = [];
    const dependencies = new Map<string, string>();
    const root = reader.root(request.document.uri);
    if (root && reader.revision) dependencies.set(root, reader.revision(root));
    let reusable = true;
    if (access.shared !== false && reader.revision) {
      const files = await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,wxs,wxml}', 10001) ?? [];
      if (files.length > 10000) reusable = false;
      else for (const uri of files) dependencies.set(uri, reader.revision(uri));
    }
    let complete = true;
    let owners = 0;
    for (const uri of await scripts.instanceTemplates?.(request, access) ?? []) {
      const base = uri.replace(/\.wxml$/i, '');
      let info;
      for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
        if (reader.revision) dependencies.set(base + suffix, reader.revision(base + suffix));
        if (!await reader.read(base + suffix)) continue;
        info = await inspector.inspect(request, base + suffix, true); break;
      }
      for (const dependency of info?.dependencies ?? []) {
        const previous = dependencies.get(dependency.uri);
        if (previous !== undefined && previous !== dependency.revision) reusable = false;
        dependencies.set(dependency.uri, dependency.revision);
      }
      if (info?.complete === false) reusable = false;
      if (!info?.instanceOwners?.some((owner) => owner.uri === access.owner.uri && owner.range.start === access.owner.range.start && owner.range.end === access.owner.range.end)) continue;
      const tree = await nodes(request, uri, [], new Set(), undefined, dependencies);
      reusable &&= tree.complete;
      result.push(...tree.nodes); complete &&= tree.complete; owners++;
    }
    const model: InstanceModel = { input, nodes: result, complete: complete && owners > 0, owned: owners > 0, reusable, components: new Map(), dependencies,
      weight: input.length + [...dependencies].reduce((total, [uri, revision]) => total + uri.length + revision.length, 0)
        + [...new Set(result.map((node) => node.request.document.text))].reduce((total, text) => total + text.length, 0) };
    if (valid(model) && !request.cancellation.isCancellationRequested) { models.set(key, model); trim(); }
    return { access, nodes: result, complete: model.complete, model };
  }

  /** 组件元数据按实际标签节点缓存，并合并源码、配置及缺失路径的依赖快照。 */
  async function component(request: LanguageRequest, node: SelectorNode, model: InstanceModel): Promise<ComponentScriptInfo | undefined> {
    const key = `${node.request.document.uri}:${node.tag.start}`;
    if (model.components.has(key)) return model.components.get(key);
    const info = await components.instance?.({ ...node.request, cancellation: request.cancellation, offset: node.tag.nameRange.start });
    if (request.cancellation.isCancellationRequested) return undefined;
    model.components.set(key, info);
    retain(model, info?.dependencies ?? []);
    if (info?.complete === false) model.reusable = false;
    model.weight += JSON.stringify(info ?? {}).length;
    trim();
    return info;
  }

  /** 实例类型只来自实际匹配的已注册组件，纯原生标签不冒充组件实例。 */
  async function members(request: LanguageRequest, access: InstanceAccess, nodes: readonly SelectorNode[], model: InstanceModel): Promise<ComponentMember[]> {
    const result: ComponentMember[] = [];
    for (const node of nodes) {
      if (!access.selectors.some((selector) => matches(node, selector))) continue;
      const info = await component(request, node, model);
      result.push(...info?.members ?? []);
    }
    return request.cancellation.isCancellationRequested ? [] : result;
  }

  /** 路径补全在声明成员或其静态类型中逐层展开，保留所有候选类型。 */
  function projectMembers(members: readonly ComponentMember[], path: readonly string[]): Map<string, { types: SemanticType[]; description: string }> {
    const result = new Map<string, { types: SemanticType[]; description: string }>();
    for (const member of members) {
      if (path.slice(0, Math.min(path.length, member.path.length)).some((part, index) => part !== member.path[index])) continue;
      if (path.length < member.path.length) {
        const name = member.path[path.length]!;
        const previous = result.get(name) ?? { types: [], description: '' };
        previous.types.push(path.length === member.path.length - 1 ? member.type : { kind: 'object', display: 'object' });
        previous.description ||= member.description; result.set(name, previous);
      } else {
        let fields = typeMembers(member.type);
        for (const part of path.slice(member.path.length)) fields = new Map([...fields.get(part) ?? []].flatMap((type) => [...typeMembers(type)]));
        for (const [name, types] of fields) result.set(name, { types, description: member.description });
      }
    }
    return result;
  }

  /** 只接收精确成员路径；动态匹配和不完整消费图不能用于部分改名。 */
  async function symbols(request: LanguageRequest, supplied?: InstanceAccess, followAliases = false): Promise<readonly Definition[]> {
    const access = supplied ?? await scripts.instanceAccess?.(request);
    if (!access || access.intent !== 'member' || request.cancellation.isCancellationRequested) return [];
    const found = await query(request, access);
    if (!found || !found.model.owned && found.model.reusable) return [];
    if (!found.complete) throw new Error('组件实例消费图不完整，不能生成部分引用或改名。');
    if (!access.selectors.length || access.selectors.some((selector) => !selectorParts(selector))
      || found.nodes.some((node) => access.selectors.some((selector) => selector.includes('#') && attribute(node, 'id')?.includes('{{') || selector.includes('.') && attribute(node, 'class')?.includes('{{')))) throw new Error('组件实例选择器或匹配节点包含动态来源，不能完整确认改名范围。');
    const definitions: Definition[] = [];
    for (const node of found.nodes.filter((node) => access.selectors.some((selector) => matches(node, selector)))) {
      if (nativeTags.has(node.tag.name)) continue;
      const info = await component(request, node, found.model);
      if (!info || info.complete === false) throw new Error('组件实例的源码契约不完整，不能生成部分引用或改名。');
      for (const member of info.members ?? []) if (member.path.join('.') === access.path.join('.')) {
        for (const definition of [...member.declarations ?? member.definitions, ...followAliases ? member.definitions : []]) definitions.push({ ...definition, originRange: access.range, originName: access.path.at(-1)! });
      }
    }
    return [...new Map(definitions.map((item) => [`${item.uri}:${item.range.start}:${item.range.end}`, item])).values()];
  }

  return {
    symbols: (request, followAliases) => symbols(request, undefined, followAliases),
    /** 所有实例访问共用文件级语法枚举和当前请求的消费模型。 */
    async usages(request, names, followAliases = false) {
      const result: { range: InstanceAccess['range']; definitions: readonly Definition[]; renameSuffix?: string }[] = [];
      for (const access of await scripts.instanceQueries?.(request, names) ?? []) {
        if (request.cancellation.isCancellationRequested) return [];
        try { result.push({ range: access.range, definitions: await symbols(request, access, followAliases), ...(access.renameSuffix === undefined ? {} : { renameSuffix: access.renameSuffix }) }); }
        catch (error) {
          if (!followAliases) throw error;
          const message = error instanceof Error ? error.message : '组件实例来源无法完整确认。';
          reader.navigation?.record({ code: /预算|上限/.test(message) ? 'budget' : 'dynamic', message, uri: request.document.uri });
        }
      }
      return result;
    },
    diagnostics: { dependencyLanguages: ['wxml', 'typescript', 'javascript', 'json', 'jsonc'],
      /** 仅完整静态模板诊断缺失或原生节点，动态 id/class 和 slot 保持开放。 */
      async provide(request) {
        const result: import('../../api').Diagnostic[] = [];
        for (const access of await scripts.instanceQueries?.(request) ?? []) {
          if (request.cancellation.isCancellationRequested) return [];
          const found = await query(request, access);
          if (!found?.complete || !access.selectors.length) continue;
          const valid = access.selectors.every((selector) => !!selectorParts(selector));
          if (!valid || found.nodes.some((node) => access.selectors.some((selector) => selector.includes('#') && attribute(node, 'id')?.includes('{{') || selector.includes('.') && attribute(node, 'class')?.includes('{{')))) continue;
          const targets = found.nodes.filter((node) => access.selectors.some((selector) => matches(node, selector)));
          if (!targets.length) result.push({ range: access.range, code: 'unknown-selector', severity: 'warning', message: `当前模板中没有匹配 ${access.selectors.join(' | ')} 的组件节点。` });
          else if (targets.every((node) => nativeTags.has(node.tag.name))) result.push({ range: access.range, code: 'native-selector', severity: 'warning', message: `选择器 ${access.selectors.join(' | ')} 只匹配原生节点，无法取得自定义组件实例。` });
        }
        return result;
      },
    },
    completion: { triggerCharacters: ['.', '#', '"', "'"],
      /** 选择器补全来自实际模板，成员补全来自对应组件公开契约。 */
      async provide(request) {
        const found = await query(request);
        if (!found) return [];
        const prefix = request.document.text.slice(found.access.range.start, request.offset);
        if (found.access.intent === 'selector') {
          const choices = new Set(found.nodes.flatMap((node) => {
            const id = attribute(node, 'id'), classes = attribute(node, 'class');
            return [node.tag.name, ...id && !id.includes('{{') ? ['#' + id] : [], ...classes && !classes.includes('{{') ? classes.split(/\s+/).filter(Boolean).map((name) => '.' + name) : []];
          }));
          return [...choices].filter((item) => item.startsWith(prefix)).map((item) => ({ label: item, kind: 'value' as const, insertText: item, detail: '模板节点选择器', documentation: '', range: found.access.range }));
        }
        if (found.access.intent !== 'member') return [];
        const candidates = projectMembers(await members(request, found.access, found.nodes, found.model), found.access.path.slice(0, -1));
        return [...candidates].filter(([name]) => name.startsWith(prefix)).map(([name, member]) => ({ label: name, kind: 'value' as const, insertText: name, detail: [...new Set(member.types.map((type) => type.display))].join(' | '), documentation: member.description, range: found.access.range }));
      },
    },
    definition: {
      /** 选择器导航同时列出节点与组件实现，成员导航落到真实实现声明。 */
      async provide(request) {
        const found = await query(request);
        if (!found) return [];
        const definitions: Definition[] = [];
        for (const node of found.nodes.filter((node) => found.access.selectors.some((selector) => matches(node, selector)))) {
          if (found.access.intent === 'selector') {
            const range = node.tag.attributes.find((attribute) => attribute.name === 'id')?.valueRange ?? node.tag.nameRange;
            const info = await component(request, node, found.model);
            definitions.push({ uri: node.request.document.uri, range, originRange: found.access.range, ...(node.version === undefined ? {} : { version: node.version }) }, ...info?.definitions.map((definition) => ({ ...definition, originRange: found.access.range })) ?? []);
          } else {
            const info = await component(request, node, found.model);
            for (const member of info?.members ?? []) if (member.path.every((part, index) => part === found.access.path[index])) definitions.push(...member.definitions.map((definition) => ({ ...definition, originRange: found.access.range })));
          }
        }
        return [...new Map(definitions.map((definition) => [`${definition.uri}:${definition.range.start}:${definition.range.end}`, { ...definition, originRange: found.access.range }])).values()];
      },
    },
    hover: {
      /** 函数类型直接包含公开参数及返回值，注释来自实现源码。 */
      async provide(request) {
        const found = await query(request);
        if (!found || found.access.intent === 'selector') return undefined;
        const fields = projectMembers(await members(request, found.access, found.nodes, found.model), found.access.path.slice(0, -1));
        const member = fields.get(found.access.path.at(-1)!);
        return member ? { title: found.access.path.join('.'), description: [member.description, ...new Set(member.types.map((type) => type.display))].filter(Boolean).join('\n'), range: found.access.range } : undefined;
      },
    },
    signatureHelp: { triggerCharacters: ['(', ','],
      /** 参数序号使用脚本语法树，嵌套调用中的逗号不会被误计数。 */
      async provide(request) {
        const found = await query(request);
        if (!found || found.access.intent !== 'call') return undefined;
        const signatures = (await members(request, found.access, found.nodes, found.model)).filter((member) => member.path.join('.') === found.access.path.join('.')).flatMap((member) => member.signatures ?? []);
        return signatures.length ? { signatures, activeParameter: found.access.argument ?? 0 } : undefined;
      },
    },
  };
}
