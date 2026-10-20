import ts from 'typescript';
import type { FileReference, LanguageRequest } from '../api';

/** 原生脚本导入由编辑器处理，这里补充小程序注册、样式和 WXS 模块路径。 */
export function scriptFileReferences(request: LanguageRequest): readonly FileReference[] {
  if (!/\.(?:[cm]?[jt]sx?|wxs|jsonc?)$/i.test(request.document.uri)) return [];
  const source = ts.createSourceFile(request.document.uri, request.document.text, ts.ScriptTarget.Latest, true, /\.jsonc?$/i.test(request.document.uri) ? ts.ScriptKind.JSON : /\.(?:js|wxs)$/i.test(request.document.uri) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const result: FileReference[] = [];
  /** 只接受字符串原文一致的位置，转义和动态计算不生成错误坐标。 */
  const add = (node: ts.StringLiteralLike, kind: FileReference['kind'], extensions: readonly string[]): void => {
    const range = { start: node.getStart(source) + 1, end: node.end - 1 };
    if (source.text.slice(range.start, range.end) === node.text) result.push({ reference: node.text, range, kind, extensions });
  };
  /** 注册路径按祖先字段识别，普通同名字符串不参与。 */
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
        for (let owner: ts.Node | undefined = parent; owner; owner = owner.parent) if (ts.isPropertyAssignment(owner) && (ts.isIdentifier(owner.name) || ts.isStringLiteralLike(owner.name)) && ['usingComponents', 'componentGenerics'].includes(owner.name.text)) {
          add(node, 'component', ['.ts', '.js', '.wxml', '/index.ts', '/index.js', '/index.wxml']); break;
        }
      }
      const module = ts.isImportDeclaration(parent) && parent.moduleSpecifier === node || ts.isExportDeclaration(parent) && parent.moduleSpecifier === node
        || ts.isCallExpression(parent) && parent.arguments[0] === node && ts.isIdentifier(parent.expression) && parent.expression.text === 'require';
      if (module && /\.(?:scss|less|css|wxss)(?:[?#].*)?$/.test(node.text)) add(node, 'style', ['.scss', '.less', '.css', '.wxss']);
      else if (module && (/\.wxs$/i.test(request.document.uri) || /\.wxs$/.test(node.text))) add(node, 'script', ['.wxs', '/index.wxs']);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

