import ts from 'typescript';
import type { Definition, LanguageRequest, TextEdit, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { Values } from './values';
import type { Value } from './values';
import { nodeAt } from './navigation';
import { componentEvents, componentFunctions } from './events';
import { thisOrigin } from './instances';
import { dataPathKey, dataPathReference, quotedContent } from './data-path-key';
import { importIndex, importKey } from './import-index';

/** 原始声明位置作为跨请求符号身份，不能只比较相同文本。 */
function key(uri: string, start: number, end: number): string { return `${uri}:${start}:${end}`; }

/** 引用和声明统一去除属性字符串的引号。 */
function definition(node: ts.Node, project: ScriptProject, originRange: Definition['range']): Definition {
  const source = node.getSourceFile();
  const quote = ts.isStringLiteralLike(node) ? 1 : 0;
  const version = project.documents.get(source.fileName)?.version;
  return { uri: source.fileName, range: { start: node.getStart(source) + quote, end: node.end - quote }, originRange, ...(version === undefined ? {} : { version }) };
}

/** 静态事件名称允许重命名，普通字符串绝不作为符号起点。 */
function eventName(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) && ts.isCallExpression(node.parent) && node.parent.arguments[0] === node
    && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.parent.expression.name.text === 'triggerEvent';
}

/** 从脚本编辑器起点取得真实声明，保留导入别名自身的重命名语义。 */
export async function scriptSymbols(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions): Promise<readonly Definition[]> {
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(request.document.uri);
  if (!created || project.cancelled) return [];
  const node = nodeAt(created.entry, request.offset);
  const quote = ts.isStringLiteralLike(node) ? 1 : 0;
  const range = { start: node.getStart(created.entry) + quote, end: node.end - quote };
  if (eventName(node)) {
    const values = new Values(created.program.getTypeChecker(), () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
    for (let parent: ts.Node | undefined = node.parent.parent; parent; parent = parent.parent) {
      if (!ts.isCallExpression(parent) || !values.resolve(values.value(parent)).some((value) => value.registrationKind)) continue;
      const event = componentEvents(values, project, values.value(parent)).find((event) => event.name === (node as ts.StringLiteralLike).text);
      if (event) return event.definitions.map((item) => ({ ...item, originRange: range }));
      break;
    }
    return [{ ...definition(node, project, range), symbolKind: 'event' }];
  }
  if (!ts.isIdentifier(node) && !ts.isStringLiteralLike(node)) return [];
  const symbol = created.program.getTypeChecker().getSymbolAtLocation(node);
  return (symbol?.declarations ?? []).map((declaration) => ({ ...definition((declaration as ts.NamedDeclaration).name ?? declaration, project, range), originName: node.text }));
}

/** 原生符号重命名附加已确认页面上下文的 this、setData 与 observers 字段。 */
export async function renameScript(reader: WorkspaceReader, request: LanguageRequest, targets: readonly Definition[], newName: string, options: ScriptOptions, includeDeclaration?: boolean): Promise<readonly TextEdit[]> {
  if (request.cancellation.isCancellationRequested) return [];
  const references = includeDeclaration !== undefined;
  if (!references && !targets.every((target) => target.symbolKind === 'event')) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, newName);
    if (scanner.scan() !== ts.SyntaxKind.Identifier || scanner.scan() !== ts.SyntaxKind.EndOfFileToken) throw new Error('请输入有效且非保留字的脚本标识符。');
  }
  const scriptTargets = targets.filter((target) => /\.(?:[cm]?[jt]sx?|wxs)$/i.test(target.uri));
  if (!scriptTargets.length) return [];
  const documents = new Map<string, Awaited<ReturnType<WorkspaceReader['read']>>>();
  const readerSnapshot: WorkspaceReader = { ...reader, read: async (uri) => {
    if (uri === request.document.uri) return request.document;
    if (!documents.has(uri)) documents.set(uri, await reader.read(uri));
    return documents.get(uri);
  } };
  const first = scriptTargets[0]!;
  const original = await readerSnapshot.read(first.uri);
  const parsed = original && ts.createSourceFile(first.uri, original.text, ts.ScriptTarget.Latest, true);
  const declared = parsed && nodeAt(parsed, first.range.start);
  const oldName = declared && (ts.isIdentifier(declared) || ts.isStringLiteralLike(declared)) ? declared.text : original?.text.slice(first.range.start, first.range.end);
  if (!oldName) return [];
  if (references) newName = oldName;
  /** 引用可以沿多个不同名暴露字段追踪同一实现，扫描必须包含所有真实声明名。 */
  const targetNames = new Set([oldName]);
  if (references) for (const target of scriptTargets) {
    const snapshot = await readerSnapshot.read(target.uri);
    if (snapshot) targetNames.add(snapshot.text.slice(target.range.start, target.range.end));
  }
  const limit = options.maxRenameFiles ?? 5000;
  const indexed = references ? await importIndex(readerSnapshot, request, limit) : undefined;
  if (references && !indexed) return [];
  const files = indexed?.files ?? await reader.findFiles?.(request.document.uri, '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,wxs,wxml}', limit + 1) ?? [];
  if (files.length > limit) throw new Error(`重命名文件数量超过 ${limit}，请缩小工作区或提高 maxRenameFiles。`);
  const roots = new Set(scriptTargets.map((target) => target.uri));
  // 反向导入只扩大候选图，字段与模板仍逐项核验真实声明，不能漏掉不同名重导出。
  if (indexed) for (const uri of roots) for (const consumer of indexed.reverse.get(importKey(uri)) ?? []) roots.add(consumer);
  for (const uri of files) {
    if (request.cancellation.isCancellationRequested) return [];
    const snapshot = await readerSnapshot.read(uri);
    if (!snapshot || ![...targetNames].some((name) => snapshot.text.includes(name))) continue;
    if (!uri.endsWith('.wxml')) roots.add(uri);
    else for (const suffix of ['.ts', '.js']) {
      const candidate = uri.slice(0, -5) + suffix;
      if (await readerSnapshot.read(candidate)) { roots.add(candidate); break; }
    }
  }
  const project = new ScriptProject(readerSnapshot, request, { ...options, maxFiles: 1000 });
  const created = await project.create(first.uri, [...roots]);
  if (!created || project.cancelled) return [];
  if (project.exhausted || [...roots].some((uri) => !project.sources.has(uri))) throw new Error('脚本引用图超出解析预算，未生成不完整的重命名编辑。');
  const identities = new Set(targets.map((target) => key(target.uri, target.range.start, target.range.end)));
  const result = new Map<string, TextEdit>();
  /** 同一位置只保留一次编辑，声明和原生引用的结果允许重合。 */
  const add = (uri: string, start: number, end: number, text = newName): void => {
    const version = project.documents.get(uri)?.version;
    result.set(key(uri, start, end), { uri, range: { start, end }, newText: text, oldText: project.documents.get(uri)?.text.slice(start, end) ?? '', ...(version === undefined ? {} : { version }) });
  };
  const checker = created.program.getTypeChecker();
  const values = new Values(checker, () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
  const service = project.languageService();
  try {
    for (const target of scriptTargets) {
      const source = project.sources.get(target.uri);
      if (!source) continue;
      const token = nodeAt(source, target.range.start);
      const property = token.parent;
      if (!property) throw new Error('重命名声明已经无法解析，请重新发起操作。');
      if (!references && (ts.isVariableDeclaration(property) || ts.isFunctionDeclaration(property) || ts.isParameter(property) || ts.isImportSpecifier(property))) {
        const symbol = checker.getSymbolAtLocation(token);
        if (checker.getSymbolsInScope(token, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace).some((item) => item.name === newName && item !== symbol)) throw new Error(`同一脚本作用域已经声明 ${newName}。`);
      }
      if (!references && ts.isPropertyAccessExpression(property) && /^(?:exports|module\.exports)$/.test(property.expression.getText(source)) && values.fields(values.value(source)).has(newName)) throw new Error(`模块已经导出 ${newName}。`);
      if (!references && ts.isObjectLiteralExpression(property.parent)) {
        if (property.parent.properties.some((item) => 'name' in item && values.name(item.name) === newName && item !== property)) throw new Error(`同一对象已经声明 ${newName}，重命名会覆盖现有字段。`);
      }
      if (references) {
        for (const item of (service.findReferences(target.uri, target.range.start) ?? []).flatMap((group) => group.references)) {
          if (!includeDeclaration && item.isDefinition) continue;
          add(item.fileName, item.textSpan.start, item.textSpan.start + item.textSpan.length);
        }
        if (includeDeclaration || target.symbolKind === 'event') add(target.uri, target.range.start, target.range.end);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        // 字段重命名保持原变量绑定，不能把它变成未声明的新变量。
        add(target.uri, target.range.start, target.range.end, `${newName}: ${oldName}`);
      } else if (eventName(token) || target.symbolKind === 'event') add(target.uri, target.range.start, target.range.end);
      else {
        const info = service.getRenameInfo(target.uri, target.range.start, { allowRenameOfImportPath: false });
        if (!info.canRename) throw new Error(info.localizedErrorMessage);
        for (const item of service.findRenameLocations(target.uri, target.range.start, false, false, true) ?? []) {
          add(item.fileName, item.textSpan.start, item.textSpan.start + item.textSpan.length, (item.prefixText ?? '') + newName + (item.suffixText ?? ''));
        }
        if (ts.isStringLiteralLike(token) && !result.has(key(target.uri, target.range.start, target.range.end))) add(target.uri, target.range.start, target.range.end);
      }
    }
    /** 原生引用中的导入别名也可能成为页面公开字段，不能只按最初名称筛选。 */
    const contextNames = new Set(targetNames);
    if (references) for (const item of result.values()) {
      const source = project.sources.get(item.uri);
      if (source) contextNames.add(source.text.slice(item.range.start, item.range.end));
    }
    /** 判断页面公开字段是否属于此次声明，当前页面覆盖的方法不会被误改。 */
    const matches = (items: readonly Value[] | undefined): boolean => (items ?? []).flatMap((item) => references ? [item, ...values.resolve(item)] : [item]).some((item) => {
      const declaration = item.declaration ?? item.node;
      const target = definition(declaration, project, { start: 0, end: 0 });
      return identities.has(key(target.uri, target.range.start, target.range.end));
    });
    for (const source of created.program.getSourceFiles()) {
      if (source.isDeclarationFile) continue;
      // 无相关名称的依赖不需要展开注册和函数体，转义名称仍保留完整语义检查。
      if (![...contextNames].some((name) => source.text.includes(name)) && !/\\[ux]/.test(source.text)) continue;
      // 工厂内部的 this 仍属于其返回的配置对象，声明改名后也必须同步。
      const contexts = new Values(checker, () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
      for (const registered of contexts.registration(source, true)) {
        const context = contexts.context(registered);
        const matchedNames = references ? [...context].filter(([, items]) => matches(items)).map(([name]) => name) : matches(context.get(oldName)) ? [oldName] : [];
        if (!matchedNames.length) continue;
        // 显式暴露字段本身也是语义引用，模板不能依赖组件内恰好存在同名自调用。
        if (references) for (const name of matchedNames) for (const item of context.get(name) ?? []) {
          if (!item.declaration) continue;
          const location = definition(item.declaration, project, { start: 0, end: 0 });
          add(location.uri, location.range.start, location.range.end);
        }
        if (!references && context.has(newName)) throw new Error(`页面上下文已经包含 ${newName}，重命名会改变继承或覆盖关系。`);
        const functions = new Set(componentFunctions(contexts, registered));
        const observers = new Set((contexts.fields(registered).get('observers') ?? []).flatMap((value) => contexts.resolve(value)).map((value) => value.node));
        /** const 别名按初始化处确认所有者，普通函数中的独立 this 不属于外层组件。 */
        const owned = (node: ts.Node): boolean => {
          const origin = thisOrigin(node, checker); if (!origin) return false;
          for (let parent: ts.Node | undefined = origin.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) {
            if (functions.has(parent)) return true;
            if (!ts.isArrowFunction(parent)) return false;
          }
          return false;
        };
        /** 遍历捕获别名的回调，但只修改已确认注册对象的成员和观察器。 */
        const visit = (node: ts.Node): void => {
          // 继承方法可以来自另一个文件，坐标必须使用节点自己的源码。
          const source = node.getSourceFile();
          if (ts.isPropertyAccessExpression(node) && matchedNames.includes(node.name.text) && (owned(node.expression)
            || ts.isPropertyAccessExpression(node.expression) && owned(node.expression.expression) && ['data', 'properties'].includes(node.expression.name.text))) {
            add(source.fileName, node.name.getStart(source), node.name.end);
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && owned(node.expression.expression) && node.expression.name.text === 'setData') {
            const data = node.arguments[0];
            if (data && ts.isObjectLiteralExpression(data)) for (const property of data.properties) {
              if (!('name' in property)) continue;
              const name = dataPathKey(property.name)?.text;
              const field = matchedNames.find((field) => name === field || name?.startsWith(field + '.') || name?.startsWith(field + '['));
              if (field) {
                const reference = dataPathReference(property.name, field, source);
                if (reference) add(source.fileName, reference.range.start, reference.range.end,
                  ts.isShorthandPropertyAssignment(property) ? `${newName}: ${field}` : newName + (reference.suffix ?? ''));
              }
            }
          }
          if (ts.isObjectLiteralExpression(node) && observers.has(node)) {
            for (const observer of node.properties) if ('name' in observer && ts.isStringLiteralLike(observer.name)) {
              const content = source.text.slice(observer.name.getStart(source) + 1, observer.name.end - 1);
              if (content !== observer.name.text) {
                let matched = false;
                const renamed = observer.name.text.replace(/[^\s,]+/g, (path) => {
                  const field = matchedNames.find((field) => path === field || path.startsWith(field + '.') || path.startsWith(field + '['));
                  if (!field) return path;
                  matched = true; return newName + path.slice(field.length);
                });
                if (matched) add(source.fileName, observer.name.getStart(source) + 1, observer.name.end - 1, quotedContent(renamed, source.text[observer.name.getStart(source)] ?? '"'));
                continue;
              }
              const names = observer.name.text.matchAll(/[^\s,]+/g);
              for (const match of names) {
                const field = matchedNames.find((field) => match[0] === field || match[0].startsWith(field + '.') || match[0].startsWith(field + '['));
                if (!field) continue;
                const start = observer.name.getStart(source) + 1 + match.index;
                add(source.fileName, start, start + field.length);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        for (const resolved of contexts.resolve(registered)) visit(resolved.node);
        for (const callback of functions) visit(callback);
        for (const observer of observers) visit(observer);
      }
    }
  } finally { service.dispose(); }
  return project.cancelled ? [] : [...result.values()].filter((item) => includeDeclaration !== false || !identities.has(key(item.uri, item.range.start, item.range.end)));
}
