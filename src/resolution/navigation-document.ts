import ts from 'typescript';
import type { LanguageRequest } from '../api';

/** 只接受组件注册中的路径值，普通 JSON 字符串不会触发文件搜索。 */
export function componentPath(request: LanguageRequest): ts.StringLiteral | undefined {
  const source = ts.createSourceFile(request.document.uri, request.document.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON);
  let result: ts.StringLiteral | undefined;
  /** 在 usingComponents 或 componentGenerics 的静态注册值中定位光标。 */
  const visit = (node: ts.Node): void => {
    if (request.offset < node.getStart(source) || request.offset >= node.end) return;
    if (ts.isStringLiteral(node) && ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) && (parent.name.text === 'usingComponents' || parent.name.text === 'componentGenerics')) { result = node; break; }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

