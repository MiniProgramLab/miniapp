import type { TextRange, WorkspaceText } from '../../api';
import { tokenize } from './lexer';
import { dialectOf } from './uri';
import type { Dialect, ImportEdge, Scope, StyleIndex, StyleSymbol, SymbolKind, SymbolReference, Token } from './types';

/** 语法索引按文件与方言隔离；命中时仍使用本次读取的文本和版本。 */
const styleCache = new Map<string, StyleIndex>();
/** 同时限制文本量、词法单元与文件数量，避免索引长期占用内存。 */
let cachedCharacters = 0;
let cachedTokens = 0;

/** 模块卸载时释放文本、词法单元和作用域图，不保留已关闭的请求快照。 */
export function clearStylesheetCache(): void {
  styleCache.clear();
  cachedCharacters = 0;
  cachedTokens = 0;
}

/** Sass 将标识符中的下划线和连字符视为等价；CSS 和 Less 保持原样。 */
export function symbolName(name: string, dialect: Dialect): string {
  return dialect === 'scss' ? name.replace(/_/g, '-') : name;
}

/** 从语句开头解析导入路径，不误读媒体条件中的字符串。 */
function imports(tokens: readonly Token[], text: string, scope: Scope, dialect: Dialect): ImportEdge[] {
  const directive = tokens[0]?.value;
  if (!['@import', '@use', '@forward'].includes(directive ?? '')) return [];
  if (directive !== '@import' && dialect !== 'scss') return [];
  const kind = directive!.slice(1) as ImportEdge['kind'];
  const result: ImportEdge[] = [];
  let cursor = 1;
  if (dialect === 'less' && tokens[cursor]?.value === '(') {
    const end = tokens.findIndex((token, index) => index > cursor && token.value === ')');
    if (end < 0 || tokens.slice(cursor, end).some((token) => token.value === 'inline')) return [];
    cursor = end + 1;
  }
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token) break;
    let reference: string;
    let range: TextRange;
    if (token.kind === 'string') {
      reference = token.value;
      range = { start: token.start + 1, end: token.start + 1 + reference.length };
      cursor++;
    } else if (token.value.toLowerCase() === 'url' && tokens[cursor + 1]?.value === '(') {
      const end = tokens.findIndex((item, index) => index > cursor + 1 && item.value === ')');
      const first = tokens[cursor + 2];
      const last = tokens[end - 1];
      if (end < 0 || !first || !last) break;
      range = { start: first.start + (first.kind === 'string' ? 1 : 0), end: last.end - (last.kind === 'string' ? 1 : 0) };
      reference = text.slice(range.start, range.end);
      cursor = end + 1;
    } else break;
    const tail = tokens.slice(cursor);
    const aliasAt = tail.findIndex((item) => item.value === 'as');
    const alias = aliasAt < 0 ? undefined : tail[aliasAt + 1]?.value;
    /** 保留变量前缀，避免 show/hide 将同名变量与混入混为一谈。 */
    const filter = (keyword: string): readonly string[] | undefined => {
      const at = tail.findIndex((item) => item.value === keyword);
      if (at < 0) return undefined;
      const end = tail.findIndex((item, index) => index > at && ['with', 'show', 'hide'].includes(item.value));
      return tail.slice(at + 1, end < 0 ? undefined : end).filter((item) => item.kind === 'word').map((item) => symbolName(item.value, dialect));
    };
    const show = filter('show');
    const hide = filter('hide');
    const namespace = reference.split('/').pop()!.replace(/^_/, '').replace(/\.[^.]+$/, '');
    result.push({ kind, reference, range, scope,
      namespace: symbolName(kind === 'use' ? alias ?? namespace : '*', dialect),
      prefix: kind === 'forward' && alias && alias !== '*' ? alias : '',
      ...(show ? { show } : {}), ...(hide ? { hide } : {}),
    });
    if (kind !== 'import' || tokens[cursor]?.value !== ',') break;
    cursor++;
  }
  return result;
}

/** 为后续跨文件分析建立无编辑器依赖的静态索引。 */
export function parseStylesheet(uri: string, content: WorkspaceText, dialect: Dialect = dialectOf(uri)): StyleIndex {
  const key = `${uri}\0${dialect}`;
  const cached = styleCache.get(key);
  if (cached) {
    styleCache.delete(key);
    if (cached.text === content.text) {
      styleCache.set(key, cached);
      return { ...content, uri, dialect, tokens: cached.tokens, symbols: cached.symbols, imports: cached.imports, selectors: cached.selectors };
    }
    cachedCharacters -= cached.text.length;
    cachedTokens -= cached.tokens.length;
  }
  const tokens = tokenize(content.text, dialect);
  const symbols: StyleSymbol[] = [];
  const edges: ImportEdge[] = [];
  const selectorRanges: TextRange[] = [];
  const root: Scope = { start: 0, end: content.text.length, selectors: [] };
  const stack = [root];
  let boundary = 0;
  let parentheses = 0;
  let brackets = 0;

  /** 注册声明并沿用原始范围，标准化仅影响名称比较。 */
  const add = (token: Token, kind: SymbolKind, scope: Scope, name = token.value, range: TextRange = token): void => {
    symbols.push({ name: kind === 'class' || kind === 'custom-property' ? name : symbolName(name, dialect), kind, scope, range: { start: range.start, end: range.end } });
  };

  /** 分号或块末尾封闭语句时，收集变量与导入边。 */
  const statement = (items: readonly Token[], scope: Scope): void => {
    edges.push(...imports(items, content.text, scope, dialect));
    const first = items[0];
    if (first && items[1]?.value === ':') {
      if (first.value.startsWith('--')) add(first, 'custom-property', scope);
      else if (dialect === 'scss' && first.value.startsWith('$') || dialect === 'less' && first.value.startsWith('@')) {
        add(first, 'variable', dialect === 'scss' && items.some((item) => item.value === 'global') ? root : scope, first.value.slice(1));
      }
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.value === '(') parentheses++;
    if (token.value === ')') parentheses = Math.max(0, parentheses - 1);
    if (token.value === '[') brackets++;
    if (token.value === ']') brackets = Math.max(0, brackets - 1);
    if (parentheses || brackets || token.kind === 'string') continue;
    const parent = stack.at(-1)!;
    if (token.value === ';' || token.value === '}') {
      statement(tokens.slice(boundary, index), parent);
      boundary = index + 1;
      if (token.value === '}' && stack.length > 1) stack.pop()!.end = token.end;
      continue;
    }
    if (token.value !== '{') continue;
    const header = tokens.slice(boundary, index);
    const first = header[0];
    const scope: Scope = { start: token.start, end: content.text.length, parent, selectors: parent.selectors };
    if (first && ['@mixin', '@function'].includes(first.value) && dialect === 'scss') {
      const name = header[1];
      if (name) add(name, first.value === '@mixin' ? 'mixin' : 'function', parent);
      // 参数属于函数或混入自身，不能错误跳到外部同名变量。
      for (let item = 2; item < header.length; item++) {
        const parameter = header[item]!;
        if (parameter.value.startsWith('$') && ['(', ','].includes(header[item - 1]?.value ?? '')) add(parameter, 'variable', scope, parameter.value.slice(1));
      }
    } else if (first?.value === '@property' && header[1]?.value.startsWith('--')) {
      add(header[1], 'custom-property', parent);
    } else if (first && !first.value.startsWith('@') && !first.value.startsWith('$') && !first.value.startsWith('--')) {
      selectorRanges.push({ start: first.start, end: token.start });
      const raw = content.text.slice(first.start, token.start).trim();
      // 展开常见嵌套和 & 后缀，定义位置仍指向当前文件的原始选择器。
      const selectors = raw.split(',').flatMap((own) => parent.selectors.length
        ? parent.selectors.map((ancestor) => own.includes('&') ? own.replaceAll('&', ancestor) : `${ancestor} ${own}`)
        : [own]);
      Object.assign(scope, { selectors });
      for (let item = 0; item < header.length - 1; item++) {
        const marker = header[item]!;
        const name = header[item + 1]!;
        if (marker.value === '.' && name.kind === 'word' && marker.end === name.start) add(name, 'class', parent, name.value, { start: marker.start, end: name.end });
        if (marker.value === '&' && name.kind === 'word' && marker.end === name.start) {
          const names = new Set(selectors.flatMap((selector) => [...selector.matchAll(/\.([\w\-\u0080-\uffff]+)/g)].map((match) => match[1]!).filter((value) => value.endsWith(name.value))));
          for (const value of names) add(name, 'class', parent, value, { start: marker.start, end: name.end });
        }
      }
      if (dialect === 'less' && ['.', '#'].includes(first.value) && header[1]?.kind === 'word' && (header.length === 2 || header[2]?.value === '(')) {
        add(header[1], 'mixin', parent);
        for (let item = 3; item < header.length; item++) {
          const parameter = header[item]!;
          if (parameter.value.startsWith('@') && ['(', ',', ';'].includes(header[item - 1]?.value ?? '')) add(parameter, 'variable', scope, parameter.value.slice(1));
        }
      }
    }
    stack.push(scope);
    boundary = index + 1;
  }
  statement(tokens.slice(boundary), stack.at(-1)!);
  const result = { ...content, uri, dialect, tokens, symbols, imports: edges, selectors: selectorRanges };
  if (content.text.length <= 250_000 && tokens.length <= 20_000) {
    styleCache.set(key, result);
    cachedCharacters += content.text.length;
    cachedTokens += tokens.length;
    while (styleCache.size > 16 || cachedCharacters > 1_000_000 || cachedTokens > 40_000) {
      const oldest = styleCache.keys().next().value!;
      const previous = styleCache.get(oldest)!;
      cachedCharacters -= previous.text.length;
      cachedTokens -= previous.tokens.length;
      styleCache.delete(oldest);
    }
  }
  return result;
}

/** 将光标位置识别为真实代码引用，字符串和注释不产生伪跳转。 */
export function referenceAt(index: StyleIndex, offset: number): SymbolReference | undefined {
  const at = index.tokens.findIndex((token) => token.kind === 'word' && offset >= token.start && offset <= token.end);
  const token = index.tokens[at];
  if (!token) return undefined;
  const before = index.tokens[at - 1];
  const after = index.tokens[at + 1];
  const name = symbolName(token.value.replace(/^[$@]/, ''), index.dialect);
  const range = { start: token.start, end: token.end };
  if (token.value.startsWith('--') && (after?.value === ':' || before?.value === '(' && index.tokens[at - 2]?.value === 'var' || index.tokens[at - 1]?.value === '@property')) {
    return { name: token.value, kind: 'custom-property', range };
  }
  const variable = index.dialect === 'scss' && token.value.startsWith('$') || index.dialect === 'less' && token.value.startsWith('@');
  if (variable) {
    const namespace = index.dialect === 'scss' && before?.value === '.' ? index.tokens[at - 2]?.value : undefined;
    return { name, kind: 'variable', range, ...(namespace ? { namespace: symbolName(namespace, index.dialect) } : {}) };
  }
  if (index.dialect === 'scss' && (after?.value === '(' || before?.value === '@include' || before?.value === '.' && index.tokens[at - 3]?.value === '@include')) {
    const namespace = before?.value === '.' ? index.tokens[at - 2]?.value : undefined;
    const include = (namespace ? index.tokens[at - 3] : before)?.value === '@include';
    return { name, kind: include ? 'mixin' : 'function', range, ...(namespace ? { namespace: symbolName(namespace, index.dialect) } : {}) };
  }
  if (before?.value === '.' || before?.value === '#') {
    const selector = index.selectors.some((value) => token.start >= value.start && token.end <= value.end);
    if (index.dialect === 'less' && !selector) return { name, kind: 'mixin', range };
    if (before.value === '.' && (selector || index.tokens[at - 2]?.value === '@extend')) return { name: token.value, kind: 'class', range };
  }
  return undefined;
}
