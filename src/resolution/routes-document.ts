import ts from 'typescript';
import type { LanguageRequest, RouteAccess, RouteManifest } from '../api';

/** 仅应用配置的真实页面注册字符串进入路由入口。 */
export function jsonRouteAccesses(request: LanguageRequest): readonly RouteAccess[] {
  if (!/\/app\.jsonc?$/i.test(request.document.uri)) return [];
  return jsonRoutes(request.document.uri, request.document.text).pages.map((page) => ({ range: page.definition.range, urls: [{ text: '/' + page.path, complete: true }], method: 'reLaunch', base: 'page', editable: true, registration: page.package ?? '' }));
}

/** JSON/JSONC 注册无需建立脚本图，语法错误时不作缺失页面结论。 */
export function jsonRoutes(uri: string, text: string): RouteManifest {
  const parsed = ts.parseConfigFileTextToJson(uri, text);
  const source = ts.createSourceFile(uri, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON);
  const statement = source.statements[0];
  const root = statement && ts.isExpressionStatement(statement) && ts.isObjectLiteralExpression(statement.expression) ? statement.expression : undefined;
  const pages: RouteManifest['pages'][number][] = [];
  const tabs: string[] = [];
  const registrations: NonNullable<RouteManifest['registrations']>[number][] = [];
  const collections: NonNullable<RouteManifest['collections']>[number][] = [];
  /** 原文一致的静态配置字符串才能参与移动联动。 */
  const literal = (node: ts.StringLiteralLike) => {
    const range = { start: node.getStart(source) + 1, end: node.end - 1 };
    return { text: node.text, complete: true, ...(text.slice(range.start, range.end) === node.text ? { sources: [{ uri, range, offset: 0 }] } : {}) };
  };
  let complete = !parsed.error && !!root, tabComplete = complete;
  /** 只接受指定配置对象的直接字段，不混入嵌套同名页面清单。 */
  const field = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => object.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === name)?.initializer;
  /** 静态数组保留注册位置，无效元素使当前目录保持开放。 */
  const list = (node: ts.Expression | undefined, visit: (item: ts.Expression) => void): boolean => {
    if (!node) return true;
    if (!ts.isArrayLiteralExpression(node)) return false;
    for (const item of node.elements) visit(item);
    return true;
  };
  /** 分包页面拼接根目录，但编辑位置仍落在原始页面字符串。 */
  const page = (node: ts.Expression, prefix = '', independent = false): void => {
    if (!ts.isStringLiteralLike(node)) { complete = false; return; }
    const range = { start: node.getStart(source) + 1, end: node.end - 1 };
    pages.push({ path: prefix ? prefix.replace(/\/$/, '') + '/' + node.text.replace(/^\//, '') : node.text.replace(/^\//, ''), definition: { uri, range, originRange: range }, ...(prefix ? { package: prefix, independent } : {}) });
    const parent = node.parent;
    registrations.push({ kind: 'page', path: pages.at(-1)!.path, value: literal(node), ...(prefix ? { package: prefix } : {}), ...(ts.isArrayLiteralExpression(parent) ? { collection: { uri, range: { start: parent.getStart(source), end: parent.end }, item: { start: node.getStart(source), end: node.end } } } : {}) });
  };
  /** 页面数组与注册项分别保留，空分包数组也能成为迁移目标。 */
  const pagesIn = (node: ts.Expression | undefined, prefix = '', independent = false): boolean => {
    if (node && ts.isArrayLiteralExpression(node)) collections.push({ uri, range: { start: node.getStart(source), end: node.end }, ...(prefix ? { package: prefix } : {}) });
    return list(node, (item) => page(item, prefix, independent));
  };
  if (root) {
    const main = pagesIn(field(root, 'pages')); complete &&= main;
    for (const name of ['subPackages', 'subpackages']) {
      const packages = list(field(root, name), (item) => {
        if (!ts.isObjectLiteralExpression(item)) { complete = false; return; }
        const prefix = field(item, 'root');
        if (!prefix || !ts.isStringLiteralLike(prefix)) { complete = false; return; }
        registrations.push({ kind: 'package', path: prefix.text, value: literal(prefix) });
        const nested = pagesIn(field(item, 'pages'), prefix.text, field(item, 'independent')?.kind === ts.SyntaxKind.TrueKeyword); complete &&= nested;
      }); complete &&= packages;
    }
    const tab = field(root, 'tabBar');
    if (tab && !ts.isObjectLiteralExpression(tab)) tabComplete = false;
    else if (tab) {
      const entries = list(field(tab, 'list'), (item) => {
        const path = ts.isObjectLiteralExpression(item) ? field(item, 'pagePath') : undefined;
        if (!path || !ts.isStringLiteralLike(path)) tabComplete = false;
        else { tabs.push(path.text.replace(/^\//, '')); registrations.push({ kind: 'tab', path: tabs.at(-1)!, value: literal(path) }); }
      }); tabComplete &&= entries;
    }
  }
  return { pages, tabs, complete, tabComplete, dependencies: [], registrations, collections };
}
