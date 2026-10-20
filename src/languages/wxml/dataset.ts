import type { DatasetAccess, Definition, LanguageFeatures, LanguageRequest, SemanticType, ScriptDefinitionResolver, TextEdit, WorkspaceReader } from '../../api';
import { eventAttribute } from './events';
import { scanTags, tagAt } from './parser';
import type { AttributeToken, TagToken } from './parser';
import { scriptExpression } from './wxs';

/** 实际事件节点保留草稿内容，data 字段不会与同名但不同方法的节点混合。 */
interface EventNode {
  readonly request: LanguageRequest;
  readonly tag: TagToken;
  readonly version?: number;
}

/** 连字符转驼峰前先转小写，符合模板 data 属性的事件字段规则。 */
function key(name: string): string { return name.slice(5).toLowerCase().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); }

/** 位置身份在脚本及模板解析器之间保持稳定。 */
function identity(item: Pick<Definition, 'uri' | 'range'>): string { return `${item.uri}:${item.range.start}:${item.range.end}`; }

/** 联合类型展开后保留全部属性分支，嵌套补全不能被最后一个节点覆盖。 */
function properties(types: readonly SemanticType[]): Map<string, SemanticType[]> {
  const result = new Map<string, SemanticType[]>();
  for (const type of types) {
    const fields = type.alternatives ? properties(type.alternatives) : new Map(Object.entries(type.properties ?? {}).map(([name, type]) => [name, [type]]));
    for (const [name, members] of fields) result.set(name, [...result.get(name) ?? [], ...members]);
  }
  return result;
}

/** dataset 值可来自循环项及模板传参，复用已有表达式类型和作用域。 */
async function attributeType(node: EventNode, attribute: AttributeToken, scripts: ScriptDefinitionResolver): Promise<SemanticType> {
  const range = attribute.valueRange;
  if (!range) return { kind: 'unknown', display: 'unknown' };
  const text = node.request.document.text.slice(range.start, range.end);
  if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(text)) {
    const request = { ...node.request, offset: range.start + text.indexOf('{{') + 2 };
    const expression = scriptExpression(request);
    const result = expression && await scripts.analyze?.(request, expression);
    if (result) return result.type;
  }
  return { kind: 'string', display: 'string', literal: text };
}

/** target 可能来自子节点，候选包含同一模板内的后代，不把捕获节点当成事件源。 */
function descendants(node: EventNode): EventNode[] {
  if (node.tag.selfClosing) return [node];
  const result = [node];
  let depth = 0;
  for (const tag of scanTags(node.request.document.text)) {
    if (tag.start < node.tag.start) continue;
    if (tag.closing) { if (--depth <= 0) break; }
    else {
      if (tag.start > node.tag.start) result.push({ ...node, tag });
      if (!tag.selfClosing) depth++;
    }
  }
  return result;
}

/** 通用 dataset 语义由模板节点和脚本参数身份组成，不依赖任何工程路径。 */
export function createDatasetFeatures(reader: WorkspaceReader, scripts: ScriptDefinitionResolver, references: NonNullable<LanguageFeatures['references']>): LanguageFeatures {
  /** 事件绑定图最多保留四份，模板及所有扫描脚本的修订用于防止草稿变化后误命中。 */
  const cache = new Map<string, { input: string; revisions: ReadonlyMap<string, string>; nodes: readonly EventNode[]; weight: number }>();
  /** 通过真实处理方法引用查找事件节点，预算不足沿用引用功能的完整性保护。 */
  async function nodes(request: LanguageRequest, handler: Definition): Promise<EventNode[]> {
    const root = reader.root(request.document.uri);
    const cacheKey = `${root ?? ''}:${identity(handler)}`;
    const input = `${request.document.uri}:${request.document.text}`;
    const previous = cache.get(cacheKey);
    const current = (nodes: readonly EventNode[]) => nodes.map((node) => ({ ...node, request: { ...node.request, cancellation: request.cancellation } }));
    if (reader.revision && previous?.input === input && [...previous.revisions].every(([uri, stamp]) => reader.revision!(uri) === stamp)) {
      cache.delete(cacheKey); cache.set(cacheKey, previous);
      return current(previous.nodes);
    }
    cache.delete(cacheKey);
    const revisions = new Map<string, string>();
    if (reader.revision) {
      if (root) revisions.set(root, reader.revision(root));
      // 引用图会检查暴露别名，所有扫描文件参与失效，不能仅记录已命中的模板。
      const files = await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,wxs,wxml}', 5001) ?? [];
      const configs = await reader.findFiles?.(request.document.uri, '**/*.json', 2001) ?? [];
      if (files.length <= 5000 && configs.length <= 2000) for (const uri of new Set([handler.uri, ...files, ...configs])) revisions.set(uri, reader.revision(uri));
      else revisions.clear();
    }
    const source = handler.uri === request.document.uri ? request.document : await reader.read(handler.uri);
    if (!source || request.cancellation.isCancellationRequested) return [];
    const origin: LanguageRequest = { document: { uri: handler.uri, text: source.text, version: source.version ?? 0, languageId: /\.[cm]?jsx?$/.test(handler.uri) ? 'javascript' : 'typescript' }, offset: handler.range.start, cancellation: request.cancellation };
    const result = new Map<string, EventNode>();
    const documents = new Map<string, LanguageRequest>();
    const versions = new Map<string, number | undefined>();
    for (const reference of await references.provide(origin, false)) {
      if (!reference.uri.endsWith('.wxml') || request.cancellation.isCancellationRequested) continue;
      let candidate = documents.get(reference.uri);
      if (!candidate) {
        const snapshot = reference.uri === request.document.uri ? request.document : await reader.read(reference.uri);
        if (!snapshot) continue;
        candidate = { document: { uri: reference.uri, text: snapshot.text, version: snapshot.version ?? 0, languageId: 'wxml' }, offset: reference.range.start, cancellation: request.cancellation };
        documents.set(reference.uri, candidate);
        versions.set(reference.uri, snapshot.version);
      }
      const tag = tagAt(candidate.document.text, reference.range.start);
      if (!tag || tag.closing || !tag.attributes.some((attribute) => eventAttribute(attribute.name) && attribute.valueRange
        && reference.range.start >= attribute.valueRange.start && reference.range.end <= attribute.valueRange.end)) continue;
      const version = versions.get(reference.uri);
      result.set(`${reference.uri}:${tag.start}`, { request: candidate, tag, ...(version === undefined ? {} : { version }) });
    }
    const resolved = [...result.values()];
    const weight = [...documents.values()].reduce((count, document) => count + document.document.text.length, 0) + input.length;
    if (reader.revision && revisions.size && weight <= 4_000_000 && !request.cancellation.isCancellationRequested && [...revisions].every(([uri, stamp]) => reader.revision!(uri) === stamp)) {
      cache.set(cacheKey, { input, revisions, nodes: resolved, weight });
      while (cache.size > 4 || [...cache.values()].reduce((total, entry) => total + entry.weight, 0) > 4_000_000) cache.delete(cache.keys().next().value!);
    }
    return resolved;
  }

  /** 模板属性只绑定当前节点的方法，脚本访问由参数身份确认来源。 */
  async function context(request: LanguageRequest): Promise<{ access: DatasetAccess; nodes: EventNode[] } | undefined> {
    if (request.document.languageId !== 'wxml') {
      const access = await scripts.datasetAccess?.(request);
      return access ? { access, nodes: await nodes(request, access.handler) } : undefined;
    }
    const tag = tagAt(request.document.text, request.offset);
    const attribute = tag?.attributes.find((item) => item.name.startsWith('data-') && request.offset >= item.range.start + 5 && request.offset <= item.range.end);
    if (!tag || !attribute) return undefined;
    for (const event of tag.attributes) {
      if (!eventAttribute(event.name) || !event.valueRange) continue;
      const candidate = { ...request, offset: event.valueRange.start };
      const expression = scriptExpression(candidate);
      if (!expression?.event) continue;
      for (const handler of await scripts.resolve(candidate, expression)) {
        const uses = await scripts.datasetUses?.(request, handler) ?? [];
        const use = uses.find((item) => item.path[0] === key(attribute.name));
        if (!use) continue;
        return { access: { ...use, range: { start: attribute.range.start + 5, end: attribute.range.end } }, nodes: await nodes(request, handler) };
      }
    }
    return undefined;
  }

  /** 值类型按路径投影，多处绑定保留全部可能类型。 */
  async function members(context: { access: DatasetAccess; nodes: EventNode[] }): Promise<Map<string, { types: SemanticType[]; definitions: Definition[] }>> {
    const result = new Map<string, { types: SemanticType[]; definitions: Definition[] }>();
    const candidates = context.access.source === 'target' ? context.nodes.flatMap(descendants) : context.nodes;
    for (const node of candidates) for (const attribute of node.tag.attributes) {
      if (!attribute.name.startsWith('data-')) continue;
      const name = key(attribute.name);
      const previous = result.get(name) ?? { types: [], definitions: [] };
      previous.types.push(await attributeType(node, attribute, scripts));
      previous.definitions.push({ uri: node.request.document.uri, range: { start: attribute.range.start + 5, end: attribute.range.end }, originRange: context.access.range, ...(node.version === undefined ? {} : { version: node.version }) });
      result.set(name, previous);
    }
    return result;
  }

  /** F2 只修改确定的节点契约，冒泡 target 和多个来源的歧义使用拒绝猜测。 */
  async function prepare(request: LanguageRequest) {
    const found = await context(request);
    if (!found || found.access.dynamic || found.access.source !== 'currentTarget' || found.access.path.length !== 1 || !found.nodes.length) return undefined;
    const declarations = (await members(found)).get(found.access.path[0]!);
    if (!declarations?.definitions.length) return undefined;
    return { range: found.access.range, name: request.document.text.slice(found.access.range.start, found.access.range.end), definitions: declarations.definitions };
  }

  return {
    completion: { triggerCharacters: ['.', '"', "'"],
      /** 对象值继续补全嵌套成员，事件字段来自所有真实消费节点。 */
      async provide(request) {
        if (request.document.languageId === 'wxml') return [];
        const found = await context(request);
        if (!found || found.access.dynamic || !found.nodes.length) return [];
        const fields = await members(found);
        const path = found.access.path;
        const prefix = request.document.text.slice(found.access.range.start, request.offset);
        let candidates = new Map([...fields].map(([name, value]) => [name, value.types]));
        for (const part of path.slice(0, -1)) candidates = properties(candidates.get(part) ?? []);
        return [...candidates].filter(([name]) => name.startsWith(prefix)).map(([name, types]) => ({ label: name, kind: 'value' as const, detail: [...new Set(types.map((type) => type.display))].join(' | '), documentation: `来自事件绑定节点的 ${found.access.source}.dataset。`, insertText: name, range: found.access.range }));
      },
    },
    definition: {
      /** 脚本成员跳到 data 属性，模板属性跳到处理函数里的对应参数访问。 */
      async provide(request) {
        const found = await context(request);
        if (!found || found.access.dynamic || !found.access.path.length) return [];
        if (request.document.languageId === 'wxml') return (await scripts.datasetUses?.(request, found.access.handler) ?? []).filter((item) => item.path[0] === found.access.path[0]).map((item) => ({ uri: item.handler.uri, range: item.range, originRange: found.access.range, ...(item.handler.version === undefined ? {} : { version: item.handler.version }) }));
        return (await members(found)).get(found.access.path[0]!)?.definitions ?? [];
      },
    },
    references: {
      /** dataset 引用限定实际处理函数和绑定节点，普通同名字段继续由原生语言服务处理。 */
      async provide(request, includeDeclaration) {
        const found = await context(request);
        if (!found || found.access.dynamic || found.access.path.length !== 1) return [];
        const name = found.access.path[0]!;
        const declarations = includeDeclaration ? (await members(found)).get(name)?.definitions ?? [] : [];
        const uses = (await scripts.datasetUses?.(request, found.access.handler) ?? []).filter((item) => !item.dynamic && item.path[0] === name).map((item) => ({ uri: item.handler.uri, range: item.range, ...(item.handler.version === undefined ? {} : { version: item.handler.version }) }));
        return [...new Map([...declarations, ...uses].map((item) => [identity(item), item])).values()];
      },
    },
    hover: {
      /** 多节点来源保留联合类型，target 来源明确提示可能由后代节点提供。 */
      async provide(request) {
        const found = await context(request);
        if (!found) return undefined;
        let fields = new Map([...(await members(found))].map(([name, item]) => [name, item.types]));
        for (const part of found.access.path.slice(0, -1)) fields = properties(fields.get(part) ?? []);
        const types = fields.get(found.access.path.at(-1) ?? '') ?? [];
        if (!types.length) return undefined;
        return { title: `dataset.${found.access.path.join('.')}`, description: `类型：${[...new Set(types.map((type) => type.display))].join(' | ')}\n来源：${found.access.source === 'target' ? '事件源节点及其冒泡候选' : '事件绑定的当前节点'}。`, range: found.access.range };
      },
    },
    rename: { prepare,
      /** 同一方法的所有节点同步修改，任何其他处理方法共享该字段时停止编辑。 */
      async provide(request, newName) {
        const found = await context(request);
        if (!found || !await prepare(request)) throw new Error('dataset 来源无法静态确认，未生成重命名编辑。');
        const template = request.document.languageId === 'wxml';
        if (!(template ? /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ : /^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u).test(newName)) throw new Error(template ? '模板 dataset 名称请使用小写字母和连字符。' : '请输入有效的 dataset 字段名称。');
        const targetName = template ? key('data-' + newName) : newName;
        const attributeName = template ? newName : newName.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
        const oldName = found.access.path[0]!;
        if (oldName === targetName) return [];
        const all = await members(found);
        if (all.has(targetName)) throw new Error(`事件节点已经声明 dataset.${targetName}。`);
        const edits = new Map<string, TextEdit>();
        const declarations = all.get(oldName)?.definitions ?? [];
        for (const node of found.nodes) {
          if (!node.tag.attributes.some((attribute) => attribute.name.startsWith('data-') && key(attribute.name) === oldName)) continue;
          for (const event of node.tag.attributes) {
            if (!eventAttribute(event.name) || !event.valueRange) continue;
            const candidate = { ...node.request, offset: event.valueRange.start };
            const expression = scriptExpression(candidate);
            if (!expression) continue;
            const handlers = await scripts.resolve(candidate, expression);
            if (handlers.some((handler) => identity(handler) !== identity(found.access.handler)
              || handlers.length > 1)) throw new Error('同一 dataset 节点还绑定其他处理方法，无法保证所有消费路径一致，未生成编辑。');
          }
        }
        for (const definition of declarations) {
          const document = definition.uri === request.document.uri ? request.document : await reader.read(definition.uri);
          if (document) edits.set(identity(definition), { ...definition, newText: attributeName, oldText: document.text.slice(definition.range.start, definition.range.end), expectedText: document.text });
        }
        const uses = await scripts.datasetUses?.(request, found.access.handler) ?? [];
        if (uses.some((item) => item.dynamic)) throw new Error('处理函数包含动态 dataset 下标，无法保证完整改名，未生成编辑。');
        if (uses.some((item) => item.source === 'target' && item.path[0] === oldName)) throw new Error('该字段同时用于冒泡 target，无法确定事件源节点，未生成编辑。');
        for (const item of uses.filter((item) => item.path[0] === oldName)) {
          const document = item.handler.uri === request.document.uri ? request.document : await reader.read(item.handler.uri);
          if (!document) continue;
          let replacement = targetName;
          const text = document.text.slice(item.range.start, item.range.end);
          // 解构简写保留局部变量，避免修改无关的变量引用。
          if (item.shorthand) replacement += ': ' + text;
          const edit: TextEdit = { uri: item.handler.uri, range: item.range, newText: replacement, oldText: text, expectedText: document.text, ...(item.handler.version === undefined ? {} : { version: item.handler.version }) };
          edits.set(identity(edit), edit);
        }
        return request.cancellation.isCancellationRequested ? [] : [...edits.values()];
      },
    },
  };
}
