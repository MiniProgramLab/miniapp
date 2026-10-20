import type { ComponentResolver, Definition, LanguageFeatures, LanguageRequest, RenameTarget, ScriptDefinitionResolver, TextEdit, WorkspaceReader, WorkspaceText } from '../../api';
import { eventAttribute } from './events';
import { tagAt } from './parser';
import { scriptExpression, scriptModules } from './wxs';
import type { createInstanceFeatures } from './instances';

/** 位置身份跨解析程序稳定，重命名不依赖相同名称的全文替换。 */
function identity(definition: Pick<Definition, 'uri' | 'range'>): string {
  return `${definition.uri}:${definition.range.start}:${definition.range.end}`;
}

/** 模板与原生脚本共用语义重命名，编辑由 Cursor 提供预览和撤销。 */
export function createRenameFeatures(reader: WorkspaceReader, scripts: ScriptDefinitionResolver, components?: ComponentResolver, options: (uri: string) => { maxFiles?: number } = () => ({}), instances?: Pick<ReturnType<typeof createInstanceFeatures>, 'symbols' | 'usages'>): NonNullable<LanguageFeatures['rename']> & { readonly references: NonNullable<LanguageFeatures['references']>; readonly highlights: NonNullable<LanguageFeatures['highlights']> } {
  /** 准备阶段只接受能确定来源的名称，不能把普通字符串误当作引用。 */
  async function prepare(request: LanguageRequest, followAliases = false): Promise<RenameTarget | undefined> {
    if (request.cancellation.isCancellationRequested) return undefined;
    let definitions: readonly Definition[] = [];
    if (request.document.languageId === 'wxml') {
      const module = scriptModules(request).find((module) => request.offset >= module.nameRange.start && request.offset <= module.nameRange.end);
      if (module) definitions = [{ uri: request.document.uri, range: module.nameRange, originRange: module.nameRange, version: request.document.version, renameConflicts: scriptModules(request).map((item) => item.name) }];
      else {
        const expression = scriptExpression(request);
        if (expression) {
          definitions = await scripts.symbols?.(request, expression) ?? [];
          if (followAliases) definitions = [...definitions, ...await scripts.resolve(request, expression)];
        }
        else {
          const tag = tagAt(request.document.text, request.offset);
          const attribute = tag?.attributes.find((attribute) => eventAttribute(attribute.name) && request.offset >= attribute.range.start && request.offset <= attribute.range.end);
          if (attribute) definitions = await components?.definition(request) ?? [];
        }
      }
    } else definitions = await instances?.symbols(request, followAliases) ?? [];
    if (!definitions.length && request.document.languageId !== 'wxml') definitions = await scripts.scriptSymbols?.(request) ?? [];
    const range = definitions[0]?.originRange;
    if (!range || range.end <= range.start || request.cancellation.isCancellationRequested) return undefined;
    const name = definitions[0]?.originName ?? request.document.text.slice(range.start, range.end);
    if (!/^[$\p{ID_Start}_][$\p{ID_Continue}-]*$/u.test(name)) return undefined;
    return { range, name, definitions: [...new Map(definitions.map((item) => [identity(item), item])).values()] };
  }
  /** 引用和改名共用符号筛选，引用不会检查新名称冲突或生成实际修改。 */
  async function collect(request: LanguageRequest, newName?: string, includeDeclaration = true, onlyDocument = false): Promise<readonly TextEdit[]> {
      const references = newName === undefined;
      const target = await prepare(request, references && !onlyDocument);
      if (request.cancellation.isCancellationRequested) return [];
      if (!target && references) return [];
      if (!target) throw new Error('当前位置没有可静态确认的重命名符号。');
      newName ??= target.name;
      const event = target.definitions.every((definition) => definition.symbolKind === 'event');
      if (!references && !(event ? /^[\w-]+$/ : /^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u).test(newName)) throw new Error('新名称不符合当前符号的命名规则。');
      if (!references && newName === target.name || request.cancellation.isCancellationRequested) return [];
      if (!references && target.definitions.some((definition) => definition.renameConflicts?.includes(newName))) throw new Error(`同一作用域已经声明 ${newName}。`);
      const snapshots = new Map<string, WorkspaceText | undefined>([[request.document.uri, request.document]]);
      /** 每个模板只读取一次草稿，以生成一致的编辑坐标。 */
      const read = async (uri: string): Promise<WorkspaceText | undefined> => {
        if (!snapshots.has(uri)) snapshots.set(uri, await reader.read(uri));
        return snapshots.get(uri);
      };
      const identities = new Set(target.definitions.map(identity));
      const edits = new Map<string, TextEdit>();
      const limit = options(request.document.uri).maxFiles ?? 5000;
      const files = onlyDocument ? [request.document.uri] : await reader.findFiles?.(request.document.uri, '**/*.wxml', limit + 1) ?? [];
      if (files.length > limit) throw new Error(`模板数量超过重命名预算 ${limit}，未生成部分编辑。`);
      if (references && !onlyDocument) {
        for (const item of await scripts.references?.(request, target.definitions, includeDeclaration) ?? []) edits.set(identity(item), { ...item, newText: '', oldText: '' });
      } else if (!references) for (const edit of await scripts.rename?.(request, target.definitions, newName) ?? []) edits.set(identity(edit), edit);
      /** 原生引用给出脚本别名，先筛选这些名称，再进行模板语义确认。 */
      const names = new Set([target.name]);
      if (references) for (const item of edits.values()) {
        const document = await read(item.uri);
        if (!document || item.uri.endsWith('.wxml')) continue;
        const name = document.text.slice(item.range.start, item.range.end);
        if (/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u.test(name)) names.add(name);
        const alias = document.text.slice(Math.max(0, item.range.start - 200), item.range.start).match(/([$\p{ID_Start}_][$\p{ID_Continue}]*)\s*[:=]\s*$/u)?.[1];
        if (alias) names.add(alias);
      }
      if (instances && !onlyDocument) {
        const files = await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', limit + 1) ?? [];
        if (files.length > limit) throw new Error(`组件实例扫描超过重命名预算 ${limit}，未生成部分编辑。`);
        for (const uri of files) {
          if (request.cancellation.isCancellationRequested) return [];
          if (!/\.[cm]?[jt]sx?$/i.test(uri)) continue;
          const document = await read(uri);
          if (!document || !/select(?:All)?Components?\s*[<(]/.test(document.text) || ![...names].some((name) => document.text.includes(name)) && !/\\[ux]/.test(document.text)) continue;
          const candidate: LanguageRequest = { document: { uri, text: document.text, version: document.version ?? 0, languageId: /\.[cm]?jsx?$/i.test(uri) ? 'javascript' : 'typescript' }, offset: 0, cancellation: request.cancellation };
          for (const usage of await instances.usages(candidate, [...names], references)) {
            if (!usage.definitions.some((definition) => identities.has(identity(definition)))) continue;
            if (!references && usage.definitions.some((definition) => !identities.has(identity(definition)))) throw new Error('同一组件实例访问对应多个不同声明，重命名会影响其他组件，已停止生成编辑。');
            edits.set(identity({ uri, range: usage.range }), { uri, range: usage.range, newText: newName + (usage.renameSuffix ?? ''), oldText: document.text.slice(usage.range.start, usage.range.end), ...(document.version === undefined ? {} : { version: document.version }) });
          }
        }
      }
      // 声明自身可能属于循环别名、模板 data 键名或内联 WXS。
      for (const definition of target.definitions) if (definition.uri.endsWith('.wxml') && (!references || includeDeclaration)) {
        const snapshot = await read(definition.uri);
        if (snapshot) {
          const declarationRequest: LanguageRequest = { document: { uri: definition.uri, text: snapshot.text, version: snapshot.version ?? 0, languageId: 'wxml' }, offset: definition.range.start, cancellation: request.cancellation };
          const declared = await prepare(declarationRequest);
          if (!references && declared?.definitions.some((item) => item.renameConflicts?.includes(newName))) throw new Error(`同一作用域已经声明 ${newName}。`);
          edits.set(identity(definition), { uri: definition.uri, range: definition.range, newText: newName + (definition.renameSuffix ?? ''), oldText: snapshot.text.slice(definition.range.start, definition.range.end), ...(snapshot.version === undefined ? {} : { version: snapshot.version }) });
        }
      }
      for (const uri of new Set([...files, ...target.definitions.filter((definition) => definition.uri.endsWith('.wxml')).map((definition) => definition.uri), ...(request.document.languageId === 'wxml' ? [request.document.uri] : [])])) {
        if (request.cancellation.isCancellationRequested) return [];
        const document = await read(uri);
        if (!document || ![...names].some((name) => document.text.includes(name))) continue;
        const pattern = new RegExp([...names].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');
        for (const match of document.text.matchAll(pattern)) {
          const offset = match.index;
          if (/[$\p{ID_Continue}]/u.test(document.text[offset - 1] ?? '') || /[$\p{ID_Continue}]/u.test(document.text[offset + match[0].length] ?? '')) continue;
          const candidateRequest: LanguageRequest = { document: { uri, text: document.text, version: document.version ?? 0, languageId: 'wxml' }, offset, cancellation: request.cancellation };
          const candidate = await prepare(candidateRequest, references && !onlyDocument);
          if (!candidate || !references && candidate.name !== target.name || !candidate.definitions.some((definition) => identities.has(identity(definition)))) continue;
          const shadow = scriptExpression(candidateRequest)?.bindings.find((binding) => binding.name === newName);
          if (!references && shadow && !identities.has(identity({ uri, range: shadow.range }))) throw new Error(`新名称 ${newName} 会被模板中的循环变量遮蔽。`);
          if (!references && candidate.definitions.some((definition) => !identities.has(identity(definition)))) throw new Error('同一模板引用对应多个不同声明，重命名会影响其他页面，已停止生成编辑。');
          if (references && !includeDeclaration && identities.has(identity({ uri, range: candidate.range }))) continue;
          edits.set(identity({ uri, range: candidate.range }), { uri, range: candidate.range, newText: newName, oldText: candidate.name, ...(document.version === undefined ? {} : { version: document.version }) });
        }
      }
      // 相交的不同编辑通常表示简写字段与原生重命名冲突，拒绝交给编辑器猜测。
      const sorted = [...edits.values()].sort((left, right) => left.uri.localeCompare(right.uri) || left.range.start - right.range.start);
      for (let index = 1; index < sorted.length; index++) {
        const left = sorted[index - 1]!, right = sorted[index]!;
        if (!references && left.uri === right.uri && left.range.end > right.range.start) throw new Error('重命名产生重叠编辑，已取消此次修改。');
      }
      return request.cancellation.isCancellationRequested ? [] : sorted;
  }
  return { prepare, provide: (request, newName) => collect(request, newName), highlights: {
    /** 本地高亮复用声明身份，仅扫描当前模板且不运行全工程脚本引用查询。 */
    provide: async (request) => (await collect(request, undefined, true, true)).filter((item) => item.uri === request.document.uri).map((item) => item.range),
  }, references: {
    /** 编辑内容仅供共享收集器使用，引用结果只暴露位置和版本。 */
    provide: async (request, includeDeclaration) => (await collect(request, undefined, includeDeclaration)).map(({ uri, range, version }) => ({ uri, range, ...(version === undefined ? {} : { version }) })),
  } };
}
