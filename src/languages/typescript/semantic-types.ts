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

/** 类型按有限深度投影为普通数据，避免跨程序使用失效的编译器对象。 */
export function semanticType(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, depth = 0): SemanticType {
  const display = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
  if (depth > 5 || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return { display, kind: 'unknown' };
  if (type.isUnion()) return { display, kind: 'unknown', alternatives: type.types.map((part) => semanticType(checker, part, node, depth + 1)) };
  if (type.flags & ts.TypeFlags.StringLike) return { display, kind: 'string', ...(type.isStringLiteral() ? { literal: type.value } : {}) };
  if (type.flags & ts.TypeFlags.NumberLike) return { display, kind: 'number', ...(type.isNumberLiteral() ? { literal: type.value } : {}) };
  if (type.flags & ts.TypeFlags.BooleanLike) return { display, kind: 'boolean', ...(type.flags & ts.TypeFlags.BooleanLiteral ? { literal: display === 'true' } : {}) };
  if (type.flags & ts.TypeFlags.Null) return { display, kind: 'null' };
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { display, kind: 'undefined' };
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return { display, kind: 'function' };
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (element) return { display, kind: 'array', element: semanticType(checker, element, node, depth + 1) };
  if (!(type.flags & ts.TypeFlags.Object)) return { display, kind: 'unknown' };
  const properties: Record<string, SemanticType> = {};
  for (const member of checker.getPropertiesOfType(type).slice(0, 100)) {
    properties[member.name] = { ...semanticType(checker, checker.getTypeOfSymbolAtLocation(member, node), node, depth + 1), optional: !!(member.flags & ts.SymbolFlags.Optional) };
  }
  return { display, kind: 'object', properties };
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
