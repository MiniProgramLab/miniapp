import ts from 'typescript';
import type { HandlerSignature, SemanticType } from '../../api';

/** 只拒绝已证明的类型冲突，未知类型和开放对象保持兼容。 */
export function accepts(actual: SemanticType, expected: SemanticType): boolean {
  if (actual.alternatives?.length) return actual.alternatives.every((item) => accepts(item, expected));
  if (expected.alternatives?.length) return expected.alternatives.some((item) => accepts(actual, item));
  if (actual.kind === 'unknown' || expected.kind === 'unknown') return true;
  if (actual.kind !== expected.kind) return false;
  if (expected.literal !== undefined) return actual.literal === expected.literal;
  if (actual.kind === 'array' && actual.element && expected.element) return accepts(actual.element, expected.element);
  if (actual.kind === 'object') return Object.entries(expected.properties ?? {}).every(([name, item]) => actual.properties?.[name] ? accepts(actual.properties[name]!, item) : item.optional === true);
  return true;
}

/** 类型投影同时限制层数和节点总量，循环或大联合保守视为未知。 */
export function semanticType(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, depth = 0): SemanticType {
  let remaining = 512, exhausted = false;
  /** 分支各自记录循环，所有分支共用总预算，避免宽类型指数展开。 */
  const visit = (type: ts.Type, depth: number, seen: ReadonlySet<ts.Type>): SemanticType => {
    if (--remaining < 0) { exhausted = true; return { display: 'unknown', kind: 'unknown' }; }
    const display = checker.typeToString(type, node);
    if (depth > 5 || seen.has(type) || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return { display, kind: 'unknown' };
    const visited = new Set(seen).add(type);
    if (type.isUnion()) return type.types.length > 64 ? { display, kind: 'unknown' } : { display, kind: 'unknown', alternatives: type.types.map((part) => visit(part, depth + 1, visited)) };
    if (type.flags & ts.TypeFlags.StringLike) return { display, kind: 'string', ...(type.isStringLiteral() ? { literal: type.value } : {}) };
    if (type.flags & ts.TypeFlags.NumberLike) return { display, kind: 'number', ...(type.isNumberLiteral() ? { literal: type.value } : {}) };
    if (type.flags & ts.TypeFlags.BooleanLike) return { display, kind: 'boolean', ...(type.flags & ts.TypeFlags.BooleanLiteral ? { literal: display === 'true' } : {}) };
    if (type.flags & ts.TypeFlags.Null) return { display, kind: 'null' };
    if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { display, kind: 'undefined' };
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return { display, kind: 'function' };
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (element) return { display, kind: 'array', element: visit(element, depth + 1, visited) };
    if (!(type.flags & ts.TypeFlags.Object)) return { display, kind: 'unknown' };
    const members = checker.getPropertiesOfType(type);
    if (members.length > 100) return { display, kind: 'unknown' };
    const properties: Record<string, SemanticType> = {};
    for (const member of members) {
      if (remaining <= 0) { exhausted = true; break; }
      properties[member.name] = { ...visit(checker.getTypeOfSymbolAtLocation(member, node), depth + 1, visited), optional: !!(member.flags & ts.SymbolFlags.Optional) };
    }
    return { display, kind: 'object', properties };
  };
  const result = visit(type, depth, new Set());
  return exhausted ? { display: result.display, kind: 'unknown' } : result;
}

/** 只读取函数实现的参数签名，不执行事件处理函数。 */
export function signature(checker: ts.TypeChecker, node: ts.Node): HandlerSignature | undefined {
  if (!(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return undefined;
  return { parameters: node.parameters.filter((parameter) => parameter.name.getText() !== 'this').map((parameter) => {
    let type = semanticType(checker, checker.getTypeAtLocation(parameter), parameter);
    const annotation = parameter.type;
    // 项目类型以编译器结果为准；只有缺失的微信平台类型才按公开泛型契约补充 detail。
    if (type.kind === 'unknown' && annotation && ts.isTypeReferenceNode(annotation)
      && /^(?:WechatMiniprogram|WeChatMiniprogram)\.CustomEvent$/.test(annotation.typeName.getText()) && annotation.typeArguments?.[0]) {
      const detail = annotation.typeArguments[0];
      type = { display: annotation.getText(), kind: 'object', properties: { detail: semanticType(checker, checker.getTypeFromTypeNode(detail), detail) } };
    }
    return { optional: !!(parameter.questionToken || parameter.initializer || parameter.dotDotDotToken), type };
  }) };
}
