import ts from 'typescript';
import type { Completion, Definition, Diagnostic, LanguageFeatures, LanguageRequest, SemanticType, TextRange, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { Values } from './values';
import type { Value } from './values';
import { componentFunctions } from './events';
import { declarationDocumentation } from './documentation';
import { accepts, semanticType } from './semantic-types';

/** 路径中的名称和数字下标保留原始字符串范围。 */
interface Part { readonly key: string; readonly range: TextRange; readonly index: boolean }

/** 真实注册作用域保留数据和函数身份，不借用同名对象的方法。 */
interface Scope { readonly data: ReadonlyMap<string, readonly Value[]>; readonly functions: ReadonlySet<ts.Node> }

/** 更新字段与观察字段共享查询，观察字段不会携带赋值表达式。 */
interface Site { readonly node: ts.Node; readonly text: string; readonly range: TextRange; readonly scopes: readonly Scope[]; readonly value?: ts.Expression; readonly observer: boolean }

/** 数据路径只解释点号、数字下标和观察通配符，不把动态表达式当作静态成员。 */
function parts(text: string): readonly Part[] | undefined {
  const result: Part[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (text[offset] === '.') { offset++; continue; }
    if (text[offset] === '[') {
      const match = text.slice(offset).match(/^\[(\d+)\]/);
      if (!match) return undefined;
      result.push({ key: match[1]!, range: { start: offset + 1, end: offset + match[0].length - 1 }, index: true });
      offset += match[0].length;
    } else {
      const match = text.slice(offset).match(/^[^.[\]\s]+/);
      if (!match) return undefined;
      result.push({ key: match[0], range: { start: offset, end: offset + match[0].length }, index: false });
      offset += match[0].length;
    }
  }
  return result;
}

/** 静态 this 别名保留最初的词法绑定，普通函数中的自身 this 不属于外层组件。 */
function receiver(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Node>()): ts.Node | undefined {
  if (seen.has(node) || seen.size >= 32) return undefined;
  const visited = new Set(seen).add(node);
  if (node.kind === ts.SyntaxKind.ThisKeyword) return node;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return receiver(node.expression, checker, visited);
  if (!ts.isIdentifier(node)) return undefined;
  for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) if (ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const) {
    const anchor = receiver(declaration.initializer, checker, visited);
    if (anchor) return anchor;
  }
  return undefined;
}

/** 实例绑定跳过箭头回调，并在普通嵌套函数处建立边界。 */
function owner(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) return parent;
  return undefined;
}

/** 使用声明类型展示可赋值字段，避免将初始化字面量误当作唯一允许值。 */
function type(values: Values, items: readonly Value[]): SemanticType {
  const candidates = items.flatMap((item) => values.resolve(item)).map((item) => {
    const declaration = item.declaration?.parent;
    const node = declaration && ts.isPropertyAssignment(declaration) ? declaration : item.node;
    return semanticType(values.checker, item.runtimeType ?? item.type ?? values.checker.getTypeAtLocation(node), node);
  });
  const alternatives = [...new Map(candidates.map((item) => [item.display, item])).values()];
  return alternatives.length === 1 ? alternatives[0]! : { kind: 'unknown', display: alternatives.map((item) => item.display).join(' | ') || 'unknown', alternatives };
}

/** 数组下标按元素类型投影，越界更新仍可创建新元素。 */
function lookup(values: Values, scope: Scope, path: readonly Part[]): readonly Value[] {
  let items: readonly Value[] = path.length ? scope.data.get(path[0]!.key) ?? [] : [];
  for (const part of path.slice(1)) items = part.index ? items.flatMap((item) => values.elements(item)) : items.flatMap((item) => values.access(item, [part.key]));
  return items;
}

/** 更新与观察器仅在真实注册对象内提取，外部对象上的 setData 保持编辑器原有行为。 */
async function graph(reader: WorkspaceReader, request: LanguageRequest, options: ScriptOptions) {
  if (!/setData|observers/.test(request.document.text) || request.cancellation.isCancellationRequested) return undefined;
  const project = new ScriptProject(reader, request, options);
  const created = await project.create(request.document.uri);
  if (!created || project.cancelled) return undefined;
  const values = new Values(created.program.getTypeChecker(), () => project.cancelled, (name, from) => project.module(name, from), options.adapters);
  const scopes = values.registration(created.entry, true).map((registered) => ({ registered, data: values.dataContext(registered), functions: new Set(componentFunctions(values, registered)) }));
  const sites: Site[] = [];
  /** 对象字段范围来自实际属性名称，const 更新对象保留原始声明位置。 */
  const add = (node: ts.Node, scope: readonly Scope[], observer: boolean, value?: ts.Expression): void => {
    if (!(ts.isStringLiteralLike(node) || ts.isIdentifier(node)) || node.getSourceFile() !== created.entry) return;
    const quote = ts.isStringLiteralLike(node) ? 1 : 0;
    const range = { start: node.getStart() + quote, end: node.end - quote };
    sites.push({ node, text: node.text, range, scopes: scope, observer, ...(value ? { value } : {}) });
  };
  /** setData 只采用 this 原始绑定所属的注册函数，别名不会绕过函数边界。 */
  const visit = (node: ts.Node): void => {
    if (project.cancelled) return;
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : values.keys(values.value(node.expression.argumentExpression))[0];
      const anchor = name === 'setData' && receiver(node.expression.expression, values.checker);
      const callback = anchor && owner(anchor);
      const targets = callback && scopes.filter((scope) => scope.functions.has(callback));
      if (targets && targets.length && node.arguments[0]) for (const object of values.resolve(values.value(node.arguments[0]))) {
        if (!ts.isObjectLiteralExpression(object.node)) continue;
        for (const property of object.node.properties) if (ts.isPropertyAssignment(property)) add(property.name, targets, false, property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) add(property.name, targets, false, property.name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(created.entry);
  /** 继承观察器的键也可使用当前注册状态；源码起点必须在当前文件。 */
  const observers = (value: Value, scope: Scope, seen = new Set<ts.Node>()): void => {
    for (const resolved of values.resolve(value)) {
      if (seen.has(resolved.node) || seen.size > 80) continue;
      const visited = new Set(seen).add(resolved.node);
      for (const group of ['behaviors', 'mixins']) for (const list of values.access(resolved, [group])) for (const inherited of values.elements(list)) observers(inherited, scope, visited);
      for (const section of values.access(resolved, ['observers'])) for (const items of values.fields(section).values()) for (const item of items) {
        const name = item.declaration ?? ('name' in item.node ? item.node.name as ts.Node : undefined);
        if (name) add(name, [scope], true);
      }
    }
  };
  for (const scope of scopes) observers(scope.registered, scope);
  return { project, values, sites: [...new Map(sites.map((site) => [site.range.start + ':' + site.range.end + ':' + site.observer, site])).values()] };
}

/** 多字段观察器只替换光标所在的一条路径，逗号和其他观察字段保持原文。 */
function selected(site: Site, offset: number) {
  const relative = offset - site.range.start;
  if (relative < 0 || relative > site.text.length) return undefined;
  const start = site.observer ? site.text.lastIndexOf(',', relative - 1) + 1 : 0;
  const end = site.observer && site.text.indexOf(',', relative) >= 0 ? site.text.indexOf(',', relative) : site.text.length;
  const segment = site.text.slice(start, end);
  const leading = segment.length - segment.trimStart().length;
  const text = segment.trim();
  const range = { start: site.range.start + start + leading, end: site.range.start + start + leading + text.length };
  return { text, range, offset: offset - range.start };
}

/** 数据路径服务复用脚本图，导航、类型提示和诊断使用同一套声明。 */
export function createDataPathFeatures(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({})): LanguageFeatures {
  /** 光标位于字符串内部时才选择路径，普通赋值表达式不触发路径补全。 */
  async function query(request: LanguageRequest) {
    const state = await graph(reader, request, options(request.document.uri));
    const site = state?.sites.find((item) => request.offset >= item.range.start && request.offset <= item.range.end);
    const path = site && selected(site, request.offset);
    return state && site && path ? { ...state, site, path } : undefined;
  }
  return {
    completion: { triggerCharacters: ['.', '[', ','],
      /** 补全只替换当前路径成员；数字下标保留原值。 */
      async provide(request) {
        const state = await query(request);
        if (!state) return [];
        const { values, site, path } = state;
        const before = path.text.slice(0, Math.max(0, path.offset));
        const prefix = before.match(/[^.[\]\s]*$/)?.[0] ?? '';
        const after = path.text.slice(Math.max(0, path.offset)).match(/^[^.[\]\s]*/)?.[0] ?? '';
        const start = path.offset - prefix.length;
        const parentText = path.text.slice(0, start).replace(/\.$/, '');
        const parents = parts(parentText);
        if (!parents || before.endsWith('[')) return [];
        const result = new Map<string, Completion>();
        for (const scope of site.scopes) {
          const members = parents.length ? lookup(values, scope, parents).flatMap((item) => [...values.fields(item)]) : [...scope.data];
          for (const [name, items] of members) {
            if (!name.startsWith(prefix) || /^\d+$/.test(name) || ['length', 'prototype'].includes(name) && parents.at(-1)?.index) continue;
            const info = type(values, items);
            result.set(name, { label: name, kind: 'value', detail: info.display, documentation: items.map((item) => declarationDocumentation(item.declaration ?? item.node)).filter(Boolean).join('\n'), insertText: name, range: { start: path.range.start + start, end: path.range.start + path.offset + after.length } });
          }
        }
        if (site.observer && '**'.startsWith(prefix)) result.set('**', { label: '**', kind: 'value', detail: '观察全部子字段', documentation: '观察当前字段及其任意子字段的数据变化。', insertText: '**', range: { start: path.range.start + start, end: path.range.start + path.offset + after.length } });
        return state.project.cancelled ? [] : [...result.values()];
      },
    },
    definition: {
      /** 当前成员导航到原始 data 或 properties 声明，继承字段保留来源文件。 */
      async provide(request) {
        const state = await query(request);
        if (!state) return [];
        const path = parts(state.path.text);
        const index = path?.findIndex((part) => state.path.offset >= part.range.start && state.path.offset <= part.range.end);
        if (!path || index === undefined || index < 0) return [];
        const targets = state.site.scopes.flatMap((scope) => lookup(state.values, scope, path.slice(0, index + 1)));
        const originRange = { start: state.path.range.start + path[index]!.range.start, end: state.path.range.start + path[index]!.range.end };
        const definitions: Definition[] = targets.flatMap((item) => {
          const node = item.declaration ?? item.node;
          const source = node.getSourceFile();
          if (source.isDeclarationFile) return [];
          const quote = ts.isStringLiteralLike(node) ? 1 : 0;
          const version = state.project.documents.get(source.fileName)?.version;
          return [{ uri: source.fileName, range: { start: node.getStart() + quote, end: node.end - quote }, originRange, ...(version === undefined ? {} : { version }) }];
        });
        return [...new Map(definitions.map((item) => [item.uri + ':' + item.range.start, item])).values()];
      },
    },
    hover: {
      /** 悬浮说明使用完整路径类型，未知或新建字段不伪造声明。 */
      async provide(request) {
        const state = await query(request);
        if (!state) return undefined;
        const path = parts(state.path.text.replace(/(?:\.\*\*|^\*\*)$/, ''));
        if (!path?.length) return undefined;
        const items = state.site.scopes.flatMap((scope) => lookup(state.values, scope, path));
        if (!items.length) return undefined;
        return { title: state.path.text, description: [type(state.values, items).display, ...items.map((item) => declarationDocumentation(item.declaration ?? item.node)).filter(Boolean)].join('\n'), range: state.path.range };
      },
    },
    diagnostics: { dependencyLanguages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      /** 平台允许创建新路径，只检查已有声明的确定赋值类型。 */
      async provide(request) {
        const state = await graph(reader, request, options(request.document.uri));
        if (!state || state.project.exhausted) return [];
        const result: Diagnostic[] = [];
        for (const site of state.sites) {
          if (!site.value || site.observer) continue;
          const path = parts(site.text);
          if (!path?.length) continue;
          const actual = semanticType(state.values.checker, state.values.checker.getTypeAtLocation(site.value), site.value);
          const expected = site.scopes.map((scope) => lookup(state.values, scope, path));
          if (expected.every((items) => items.length && !accepts(actual, type(state.values, items)))) result.push({ range: { start: site.value.getStart(), end: site.value.end }, severity: 'warning', code: 'data-path-type', message: `数据路径 ${site.text} 需要 ${[...new Set(expected.map((items) => type(state.values, items).display))].join(' | ')}，实际为 ${actual.display}。` });
        }
        return state.project.cancelled ? [] : result;
      },
    },
  };
}
