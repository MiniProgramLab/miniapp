import ts from 'typescript';
import type { TextRange } from '../../api';

/** 静态路径的剩余部分保留原引号语法，转义不会变成新的字符串边界。 */
export function quotedContent(text: string, quote: string): string {
  const encoded = JSON.stringify(text).slice(1, -1);
  return quote === "'" ? encoded.replaceAll("'", "\\'") : quote === '`' ? encoded.replaceAll('`', '\\`').replaceAll('${', '\\${') : encoded;
}

/** 路径键只接受实际字面量，普通计算表达式不会被猜测成字段。 */
export function dataPathKey(node: ts.PropertyName): ts.Identifier | ts.StringLiteralLike | undefined {
  const key = ts.isComputedPropertyName(node) ? node.expression : node;
  return ts.isIdentifier(key) && !ts.isComputedPropertyName(node) || ts.isStringLiteralLike(key) ? key as ts.Identifier | ts.StringLiteralLike : undefined;
}

/** 精确根字段尽量只改名称；转义原文需改整段内容并保留解码后的路径后缀。 */
export function dataPathReference(node: ts.PropertyName, field: string, source: ts.SourceFile): { range: TextRange; suffix?: string } | undefined {
  const key = dataPathKey(node);
  if (!key || !(key.text === field || key.text.startsWith(field + '.') || key.text.startsWith(field + '['))) return undefined;
  const quote = Number(ts.isStringLiteralLike(key)), start = key.getStart(source) + quote, end = key.end - quote;
  if (source.text.slice(start, start + field.length) === field) return { range: { start, end: start + field.length } };
  return { range: { start, end }, suffix: quotedContent(key.text.slice(field.length), source.text[start - 1] ?? '"') };
}
