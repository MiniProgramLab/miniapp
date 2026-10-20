import type { Diagnostic, LanguageRequest, SemanticType, WorkspaceReader } from '../../api';
import type { AttributeData, DocumentationData, TagData } from './catalog';
import { tags as builtinTags } from './catalog';
import { eventAttribute } from './events';
import { scanTags } from './parser';

/** 外部文件使用 Custom Data 结构，基础库版本可显式指定。 */
export interface MetadataOptions {
  readonly customData?: readonly string[];
  readonly sdkVersion?: string;
}

/** 一份元数据快照包含组件、全局属性及已确定的基础库版本。 */
export interface MetadataCatalog {
  readonly tags: readonly TagData[];
  readonly globalAttributes: readonly AttributeData[];
  readonly sdkVersion?: string;
  readonly issues?: readonly string[];
}

/** JSON 只作为声明数据读取，不执行脚本或远程引用。 */
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 文档声明的 Markdown 仍作为普通文本交给宿主渲染。 */
function description(value: unknown): string {
  return typeof value === 'string' ? value : typeof object(value).value === 'string' ? object(value).value as string : '';
}

/** 只接收稳定的三段版本，latest 和运行时版本不会用于诊断。 */
function version(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}

/** 基础库按数字段比较，避免 2.10 被当作小于 2.9。 */
function older(actual: string, required: string): boolean {
  const first = actual.split('.').map(Number), second = required.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (first[index] !== second[index]) return first[index]! < second[index]!;
  return false;
}

/** 版本、弃用和 HTTP 文档引用兼容字符串或标准描述对象。 */
function documentData(value: Record<string, unknown>): DocumentationData {
  const references = (Array.isArray(value.references) ? value.references : []).flatMap((item) => {
    const reference = object(item);
    return typeof reference.name === 'string' && typeof reference.url === 'string' && /^https?:\/\//i.test(reference.url) ? [{ name: reference.name, url: reference.url }] : [];
  });
  return { description: description(value.description), ...(typeof value.since === 'string' ? { since: value.since } : {}),
    ...(value.deprecated === true || typeof value.deprecated === 'string' ? { deprecated: value.deprecated === true ? '此声明已标记弃用。' : value.deprecated } : {}), ...(references.length ? { references } : {}) };
}

/** 事件 detail 读取有限的 JSON Schema；循环和未知引用保持开放类型。 */
function schemaType(input: unknown, root: Record<string, unknown>, depth = 0, seen = new Set<unknown>(), budget = { left: 2048 }): SemanticType {
  const value = object(input);
  const unknown: SemanticType = { kind: 'unknown', display: 'unknown' };
  if (--budget.left < 0 || depth >= 12 || seen.has(input)) return unknown;
  const visited = new Set(seen).add(input);
  if (typeof value.$ref === 'string') {
    if (!value.$ref.startsWith('#/')) return unknown;
    let target: unknown = root;
    for (const part of value.$ref.slice(2).split('/')) target = object(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return schemaType(target, root, depth + 1, visited, budget);
  }
  const alternatives = value.anyOf ?? value.oneOf ?? (Array.isArray(value.enum) ? value.enum.map((item) => ({ const: item })) : Array.isArray(value.type) ? value.type.map((type) => ({ ...value, type })) : undefined);
  if (Array.isArray(alternatives)) {
    if (alternatives.length > 32) return unknown;
    const types = alternatives.map((part) => schemaType(part, root, depth + 1, visited, budget));
    return { kind: 'unknown', display: types.map((type) => type.display).join(' | '), alternatives: types };
  }
  if ('const' in value && ['string', 'number', 'boolean'].includes(typeof value.const)) return { kind: typeof value.const as 'string' | 'number' | 'boolean', display: JSON.stringify(value.const), literal: value.const as string | number | boolean };
  if ('const' in value && value.const === null) return { kind: 'null', display: 'null' };
  if (value.type === 'null') return { kind: 'null', display: 'null' };
  if (value.type === 'array') { const element = schemaType(value.items, root, depth + 1, visited, budget); return { kind: 'array', display: `${element.display}[]`, element }; }
  if (value.type === 'object' || value.properties) {
    const entries = Object.entries(object(value.properties));
    if (entries.length > 256) return unknown;
    const required = new Set(Array.isArray(value.required) ? value.required : []);
    const properties = Object.fromEntries(entries.map(([name, property]) => [name, { ...schemaType(property, root, depth + 1, visited, budget), optional: !required.has(name) }]));
    return { kind: 'object', display: `{ ${Object.entries(properties).map(([name, type]) => `${name}${type.optional ? '?' : ''}: ${type.display}`).join('; ')} }`, properties };
  }
  const kind = value.type === 'integer' ? 'number' : value.type;
  return kind === 'string' || kind === 'number' || kind === 'boolean' ? { kind, display: kind } : unknown;
}

/** 兼容标准值集合与单属性值说明，事件也可作为绑定属性声明。 */
function attributes(input: unknown, sets: ReadonlyMap<string, unknown>, root: Record<string, unknown>, budget: { attributes: number; values: number; schema: { left: number } }): AttributeData[] {
  return (Array.isArray(input) ? input.slice(0, 2000) : []).flatMap((item) => {
    const value = object(item);
    if (typeof value.name !== 'string' || !value.name || value.name.length > 200) return [];
    if (++budget.attributes > 10000) throw new Error('元数据属性超过一万条解析上限。');
    const rawValues = value.values ?? (typeof value.valueSet === 'string' ? sets.get(value.valueSet) : undefined);
    const values = (Array.isArray(rawValues) ? rawValues.slice(0, 2000) : []).flatMap((item) => typeof item === 'string' ? [{ name: item, description: '' }] : typeof object(item).name === 'string' ? [{ name: object(item).name as string, description: description(object(item).description) }] : []);
    if ((budget.values += values.length) > 20000) throw new Error('元数据枚举值超过两万条展开上限。');
    const event = eventAttribute(value.name);
    return [{ name: value.name, type: event ? 'event' : typeof value.type === 'string' ? value.type : 'string', ...documentData(value),
      ...(values.length ? { values: values.map((item) => item.name), valueDescriptions: Object.fromEntries(values.map((item) => [item.name, item.description])) } : {}),
      ...(value.boolean === true ? { boolean: true } : {}), ...(value.required === true ? { required: true } : {}),
      ...('defaultValue' in value ? { defaultValue: typeof value.defaultValue === 'string' ? value.defaultValue : JSON.stringify(value.defaultValue) } : {}),
      ...(value.detail ? { detail: schemaType(value.detail, root, 0, new Set(), budget.schema) } : {}) }];
  });
}

/** 只解析明确版本的 Custom Data，额外事件声明转成通用绑定属性。 */
export function parseMetadata(text: string): MetadataCatalog {
  const root = object(JSON.parse(text));
  if (root.version !== 1 && root.version !== 1.1) throw new Error('组件元数据需要 Custom Data version 1 或 1.1。');
  const sets = new Map((Array.isArray(root.valueSets) ? root.valueSets : []).map((item) => [String(object(item).name), object(item).values]));
  const budget = { attributes: 0, values: 0, schema: { left: 20000 } };
  const tags = (Array.isArray(root.tags) ? root.tags.slice(0, 5000) : []).flatMap((item): TagData[] => {
    const value = object(item);
    if (typeof value.name !== 'string' || !value.name || value.name.length > 200) return [];
    const events = (Array.isArray(value.events) ? value.events : []).flatMap((event) => { const name = object(event).name; return typeof name === 'string' && /^[\w-]+$/.test(name) ? [{ ...object(event), name: 'bind:' + name }] : []; });
    return [{ name: value.name, ...documentData(value), attributes: attributes([...(Array.isArray(value.attributes) ? value.attributes : []), ...events], sets, root, budget) }];
  });
  return { tags, globalAttributes: attributes(root.globalAttributes, sets, root, budget) };
}

/** 配置与元数据只按实际依赖修订复用，未提供修订端口时保持请求内读取。 */
export function createMetadataResolver(reader: WorkspaceReader, options: (uri: string) => MetadataOptions) {
  const cache = new Map<string, { catalog: MetadataCatalog; dependencies: Map<string, string>; weight: number }>();
  /** 工作区相对文件、草稿与项目私有配置共用同一读取快照。 */
  async function load(request: LanguageRequest): Promise<MetadataCatalog> {
    if (request.cancellation.isCancellationRequested) return { tags: [], globalAttributes: [] };
    const settings = options(request.document.uri);
    const key = JSON.stringify([request.document.uri, settings.customData, settings.sdkVersion]);
    const previous = cache.get(key);
    if (previous && reader.revision && [...previous.dependencies].every(([uri, revision]) => reader.revision!(uri) === revision)) { cache.delete(key); cache.set(key, previous); return previous.catalog; }
    const dependencies = new Map<string, string>();
    const documents = new Map<string, Promise<string | undefined>>();
    let weight = 0, complete = (settings.customData?.length ?? 0) <= 32;
    if (!complete) reader.navigation?.record({ code: 'budget', message: '组件元数据文件超过三十二份上限，未读取全部声明。' });
    /** 超过文本预算后不保留部分元数据缓存。 */
    async function read(uri: string): Promise<string | undefined> {
      if (request.cancellation.isCancellationRequested) return undefined;
      const previous = documents.get(uri);
      if (previous) return previous;
      if (reader.revision) dependencies.set(uri, reader.revision(uri));
      const pending = (async () => {
        const text = (uri === request.document.uri ? request.document : await reader.read(uri))?.text;
        if (text && (text.length > 1_000_000 || weight + text.length > 4_000_000)) { complete = false; reader.navigation?.record({ code: 'budget', message: '组件元数据超过单文件或总量上限，未继续读取。', uri }); return undefined; }
        weight += text?.length ?? 0;
        return text;
      })();
      documents.set(uri, pending); return pending;
    }
    const tags = new Map<string, TagData>(builtinTags.map((tag) => [tag.name, tag])), global = new Map<string, AttributeData>();
    const issues: string[] = [];
    const root = reader.root(request.document.uri);
    for (const reference of settings.customData?.slice(0, 32) ?? []) {
      if (request.cancellation.isCancellationRequested) return { tags: [], globalAttributes: [] };
      try {
        const uri = new URL(reference, root?.replace(/\/?$/, '/') ?? request.document.uri).href;
        if (/^https?:|^data:/i.test(uri)) { issues.push(`组件元数据只读取本地或工作区文件：${reference}`); continue; }
        const text = await read(uri);
        if (text === undefined) { issues.push(`没有找到或无法完整读取组件元数据：${reference}`); reader.navigation?.record({ code: 'missing', message: '没有找到配置的组件元数据。', uri }); continue; }
        const data = parseMetadata(text);
        let source: string | undefined;
        /** 元数据所属包提供实际安装版本，不按标签前缀猜测组件库。 */
        for (let directory = new URL('./', uri).href, depth = 0; depth < 16 && directory !== root?.replace(/\/?$/, '/'); depth++) {
          const manifest = await read(new URL('package.json', directory).href);
          if (manifest) {
            try { const value = object(JSON.parse(manifest)); if (typeof value.name === 'string') source = value.name + (typeof value.version === 'string' ? '@' + value.version : ''); }
            catch { reader.navigation?.record({ code: 'config', message: '元数据所属包清单无法解析；继续使用元数据，版本来源保持未知。', uri: new URL('package.json', directory).href }); }
            break;
          }
          const parent = new URL('../', directory).href; if (parent === directory) break; directory = parent;
        }
        for (const tag of data.tags) { const before = tags.get(tag.name); tags.set(tag.name, { ...before, ...tag, ...(source ? { source } : {}), description: tag.description || before?.description || '', attributes: [...new Map([...before?.attributes ?? [], ...tag.attributes.map((attribute) => ({ ...attribute, ...(source ? { source } : {}) }))].map((attribute) => [attribute.name, attribute])).values()] }); }
        for (const attribute of data.globalAttributes) global.set(attribute.name, { ...attribute, ...(source ? { source } : {}) });
      } catch (error) { const message = `组件元数据无法解析：${reference}；${error instanceof Error ? error.message : String(error)}`; issues.push(message); reader.navigation?.record({ code: 'config', message }); }
    }
    let sdkVersion = version(settings.sdkVersion);
    if (!sdkVersion && !settings.sdkVersion && root) {
      try {
        let directory = new URL('./', request.document.uri).href;
        const boundary = root.replace(/\/?$/, '/');
        let selected = false;
        for (let depth = 0; depth < 40 && (directory === boundary || directory.startsWith(boundary)); depth++) {
          for (const file of ['project.private.config.json', 'project.config.json']) {
            const text = await read(new URL(file, directory).href);
            if (text) try { const libVersion = object(JSON.parse(text)).libVersion; selected = typeof libVersion === 'string' && !!libVersion; sdkVersion = version(libVersion); } catch { /* 损坏配置不推断基础库版本。 */ }
            if (selected) break;
          }
          if (selected || directory === boundary) break;
          directory = new URL('../', directory).href;
        }
      } catch { /* 未命名缓冲区只使用已配置的元数据。 */ }
    }
    const catalog: MetadataCatalog = { tags: [...tags.values()], globalAttributes: [...global.values()], ...(sdkVersion ? { sdkVersion } : {}), ...(issues.length ? { issues } : {}) };
    weight += JSON.stringify(catalog).length;
    if (complete && weight <= 4_000_000 && !request.cancellation.isCancellationRequested && reader.revision && [...dependencies].every(([uri, revision]) => reader.revision!(uri) === revision)) {
      cache.delete(key); cache.set(key, { catalog, dependencies, weight });
      while (cache.size > 8 || [...cache.values()].reduce((total, item) => total + item.weight, 0) > 4_000_000) cache.delete(cache.keys().next().value!);
    }
    return catalog;
  }
  return { load };
}

/** 版本与弃用检查只使用明确元数据，未知 SDK 不猜测兼容性。 */
export function metadataDiagnostics(request: LanguageRequest, catalog: MetadataCatalog): readonly Diagnostic[] {
  const result: Diagnostic[] = (catalog.issues ?? []).map((message) => ({ range: { start: 0, end: 0 }, severity: 'warning', code: 'component-metadata-config', message }));
  const inspect = (data: DocumentationData, range: import('../../api').TextRange, label: string): void => {
    const since = version(data.since);
    if (since && catalog.sdkVersion && older(catalog.sdkVersion, since)) result.push({ range, severity: 'warning', code: 'component-sdk-version', message: `${label} 需要基础库 ${since}，当前目标为 ${catalog.sdkVersion}。` });
    if (data.deprecated) result.push({ range, severity: 'warning', code: 'deprecated-component-api', message: `${label} 已弃用：${data.deprecated}` });
  };
  for (const tag of scanTags(request.document.text)) {
    if (request.cancellation.isCancellationRequested) return [];
    if (tag.closing) continue;
    const data = catalog.tags.find((item) => item.name === tag.name);
    if (data) inspect(data, tag.nameRange, `<${tag.name}>`);
    for (const attribute of tag.attributes) {
      const event = eventAttribute(attribute.name);
      const field = [...data?.attributes ?? [], ...catalog.globalAttributes].find((item) => item.name === attribute.name || event && eventAttribute(item.name)?.name === event.name);
      if (field) inspect(field, attribute.range, `<${tag.name}> 的 ${attribute.name}`);
    }
  }
  return result;
}
