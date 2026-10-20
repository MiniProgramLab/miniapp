import ts from 'typescript';
import type { ComponentEvent, SemanticType } from '../../api';
import type { ScriptProject } from './project';
import type { Values, Value } from './values';
import { declarationDocumentation } from './documentation';
import { semanticType } from './semantic-types';

/** 当前方法覆盖继承方法；生命周期和观察器另行读取，不暴露给模板上下文。 */
export function componentFunctions(values: Values, registered: Value): ts.Node[] {
  const result = new Set<ts.Node>();
  for (const members of values.context(registered).values()) for (const member of members) {
    for (const resolved of values.resolve(member)) if (ts.isFunctionLike(resolved.node)) result.add(resolved.node);
  }
  /** 循环 Behavior 只检查一次，继承生命周期仍保留各自的发出位置。 */
  function hooks(value: Value, seen = new Set<ts.Node>()): void {
    for (const resolved of values.resolve(value)) {
      if (seen.has(resolved.node) || seen.size > 80) continue;
      const fields = values.fields(resolved);
      const visited = new Set(seen).add(resolved.node);
      for (const name of ['behaviors', 'mixins']) for (const list of fields.get(name) ?? []) for (const inherited of values.elements(list)) hooks(inherited, visited);
      for (const name of ['lifetimes', 'pageLifetimes', 'observers']) for (const section of fields.get(name) ?? []) {
        for (const members of values.fields(section).values()) for (const member of members) {
          for (const callback of values.resolve(member)) if (ts.isFunctionLike(callback.node)) result.add(callback.node);
        }
      }
    }
  }
  hooks(registered);
  return [...result];
}

/** 只检查实际暴露的方法及其回调，继承和覆盖顺序沿用现有上下文解析。 */
export function componentEvents(values: Values, project: ScriptProject, registered: Value): ComponentEvent[] {
  const events = new Map<string, ComponentEvent>();
  const visited = new Set<ts.Node>();
  const context = values.context(registered);
  /** 事件对象中的 this.data 字段优先读取页面声明类型，未知属性保持 unknown。 */
  function detailType(node: ts.Expression, depth = 0): SemanticType {
    if (depth > 5) return { display: 'unknown', kind: 'unknown' };
    if (ts.isObjectLiteralExpression(node)) {
      const properties: Record<string, SemanticType> = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) return semanticType(values.checker, values.checker.getTypeAtLocation(node), node);
        const name = values.name(property.name);
        if (name && ts.isPropertyAssignment(property)) properties[name] = detailType(property.initializer, depth + 1);
        else if (name && ts.isShorthandPropertyAssignment(property)) properties[name] = detailType(property.name, depth + 1);
      }
      return { kind: 'object', display: `{ ${Object.entries(properties).map(([name, type]) => `${name}: ${type.display}`).join('; ')} }`, properties };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && ['data', 'properties'].includes(node.expression.name.text)) {
      const member = context.get(node.name.text)?.[0];
      if (!member) return { display: 'unknown', kind: 'unknown' };
      const declaration = member.declaration?.parent;
      const spec = declaration && ts.isPropertyAssignment(declaration) ? values.fields(values.value(declaration.initializer)) : new Map<string, Value[]>();
      const constructor = spec.get('type')?.[0]?.node;
      const type = constructor && ts.isPropertyAssignment(constructor) ? constructor.initializer.getText() : constructor?.getText();
      if (type && ['String', 'Number', 'Boolean'].includes(type)) {
        const kind = ({ String: 'string', Number: 'number', Boolean: 'boolean' } as const)[type as 'String' | 'Number' | 'Boolean'];
        return { display: kind, kind };
      }
      if (type === 'Object' || type === 'Array') return { display: 'unknown', kind: 'unknown' };
      return semanticType(values.checker, member.type ?? values.checker.getTypeAtLocation(member.node), member.node);
    }
    const location = ts.isPropertyAssignment(node.parent) && node.parent.initializer === node ? node.parent : node;
    const type = semanticType(values.checker, values.checker.getTypeAtLocation(location), location);
    const literal = semanticType(values.checker, values.checker.getTypeAtLocation(node), node).literal;
    return literal === undefined ? type : { ...type, literal };
  }
  /** 静态事件名和 detail 类型来自源码，不执行用户函数。 */
  function visit(node: ts.Node, root: ts.Node): void {
    if (project.cancelled || visited.has(node)) return;
    if (node !== root && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
    visited.add(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === 'triggerEvent' && node.arguments[0]) {
      const name = values.keys(values.value(node.arguments[0]))[0];
      if (name) {
        const argument = values.resolve(values.value(node.arguments[0])).find((item) => ts.isStringLiteralLike(item.node))?.node ?? node.arguments[0];
        const literal = ts.isStringLiteralLike(argument);
        const source = argument.getSourceFile();
        const previous = events.get(name);
        const detail = node.arguments[1];
        const version = project.documents.get(source.fileName)?.version;
        const location = { uri: source.fileName, range: { start: argument.getStart(source) + (literal ? 1 : 0), end: argument.end - (literal ? 1 : 0) }, symbolKind: 'event' as const, ...(version === undefined ? {} : { version }) };
        const description = declarationDocumentation(node.parent);
        events.set(name, { name, description: [previous?.description, description].filter(Boolean).join('\n'),
          definitions: [...previous?.definitions ?? [], location],
          details: [...previous?.details ?? [], detail ? detailType(detail) : { display: 'undefined', kind: 'undefined' }],
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, root));
  }
  for (const callback of componentFunctions(values, registered)) visit(callback, callback);
  return [...events.values()];
}
