import ts from 'typescript';
import type { LanguageRequest, TextEdit, WorkspaceReader, WorkspaceText } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { Values } from './values';

/** 在对象末尾插入成员，保留注释、尾逗号、缩进和原换行格式。 */
export function insertObjectMembers(object: ts.ObjectLiteralExpression, members: string, uri: string, snapshot: WorkspaceText): TextEdit[] {
  const text = snapshot.text;
  const close = object.end - 1;
  const line = text.lastIndexOf('\n', close - 1) + 1;
  const ownLine = /^[\t ]*$/.test(text.slice(line, close));
  const indent = ownLine ? text.slice(line, close) : text.slice(text.lastIndexOf('\n', object.getStart()) + 1, object.getStart()).match(/^[\t ]*/)?.[0] ?? '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const position = ownLine ? line : close;
  let content = (ownLine ? '' : newline) + members.split(/\r?\n/).map((part) => indent + '  ' + part).join(newline) + newline + (ownLine ? '' : indent);
  const edits: TextEdit[] = [];
  const edit = (start: number, newText: string): TextEdit => ({ uri, range: { start, end: start }, oldText: '', newText, expectedText: text, ...(snapshot.version === undefined ? {} : { version: snapshot.version }) });
  const last = object.properties.at(-1);
  if (last && !object.properties.hasTrailingComma) {
    if (last.end === position) content = ',' + content;
    else edits.push(edit(last.end, ','));
  }
  edits.push(edit(position, content));
  return edits;
}

/** 普通配置字段复用成员插入，避免注册与提取分别处理逗号。 */
export function insertObjectField(object: ts.ObjectLiteralExpression, key: string, value: string, uri: string, snapshot: WorkspaceText): TextEdit[] {
  return insertObjectMembers(object, `${JSON.stringify(key)}: ${value}`, uri, snapshot);
}

/** 已有注册表只追加新标签，动态或重复字段不覆盖。 */
function registration(object: ts.ObjectLiteralExpression, name: string, reference: string, uri: string, snapshot: WorkspaceText): TextEdit[] {
  const property = object.properties.find((property) => 'name' in property && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === 'usingComponents');
  if (property) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) return [];
    if (property.initializer.properties.some((item) => 'name' in item && (ts.isStringLiteralLike(item.name) || ts.isIdentifier(item.name)) && item.name.text === name)) return [];
    return insertObjectField(property.initializer, name, JSON.stringify(reference), uri, snapshot);
  }
  return insertObjectField(object, 'usingComponents', JSON.stringify({ [name]: reference }), uri, snapshot);
}

/** 为静态 JSON、配置宏或明确配置的框架入口生成组件注册编辑。 */
export async function registerComponent(reader: WorkspaceReader, request: LanguageRequest, name: string, reference: string, options: ScriptOptions): Promise<readonly TextEdit[]> {
  if (request.cancellation.isCancellationRequested) return [];
  const base = request.document.uri.replace(/\.wxml$/i, '');
  const json = await reader.read(base + '.json');
  if (json) {
    const source = ts.createSourceFile(base + '.json', json.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON);
    if (ts.parseConfigFileTextToJson(base + '.json', json.text).error) return [];
    const statement = source.statements[0];
    return statement && ts.isExpressionStatement(statement) && ts.isObjectLiteralExpression(statement.expression) ? registration(statement.expression, name, reference, source.fileName, json) : [];
  }
  for (const suffix of ['.config.ts', '.config.js']) {
    const uri = base + suffix;
    const snapshot = await reader.read(uri);
    if (!snapshot) continue;
    const project = new ScriptProject(reader, request, options);
    const created = await project.create(uri);
    if (!created || project.exhausted) return [];
    const values = new Values(created.program.getTypeChecker(), () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
    for (const statement of created.entry.statements) {
      const expression = ts.isExportAssignment(statement) ? statement.expression : ts.isExpressionStatement(statement) ? statement.expression : undefined;
      const object = expression && ts.isCallExpression(expression) && ['definePageConfig', 'defineComponentConfig'].includes(values.callName(expression)) ? expression.arguments[0] : expression;
      if (object && ts.isObjectLiteralExpression(object)) return registration(object, name, reference, uri, snapshot);
    }
    return [];
  }
  const project = new ScriptProject(reader, request, options);
  const created = await project.create();
  if (!created || project.cancelled || project.exhausted) return [];
  const values = new Values(created.program.getTypeChecker(), () => project.cancelled, (name, from) => project.module(name, from), project.adapters);
  for (const registered of values.registration(created.entry)) {
    if (!ts.isCallExpression(registered.node)) continue;
    const adapter = values.adapter(registered.node);
    if (adapter) {
      const argument = registered.node.arguments[adapter.argument ?? 0];
      const path = adapter.config ?? 'config';
      if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
      const [first, ...rest] = path.split('.');
      const targets = values.section(values.value(argument), path).flatMap((item) => values.resolve(item));
      const target = targets.find((item) => ts.isObjectLiteralExpression(item.node) && item.node.getSourceFile() === created.entry);
      const snapshot = project.documents.get(created.entry.fileName)!;
      if (target) return registration(target.node as ts.ObjectLiteralExpression, name, reference, created.entry.fileName, snapshot);
      if (!rest.length && first && !values.fields(values.value(argument)).has(first)) return insertObjectField(argument, first, JSON.stringify({ usingComponents: { [name]: reference } }), created.entry.fileName, snapshot);
      return [];
    }
    if (['Page', 'Component', 'VantComponent'].includes(values.callName(registered.node))) return [{ uri: base + '.json', range: { start: 0, end: 0 }, newText: JSON.stringify({ usingComponents: { [name]: reference } }, null, 2) + '\n', create: true }];
  }
  return [];
}
