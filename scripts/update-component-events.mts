import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { SemanticType } from '../src/api';
import type { TagData } from '../src/languages/wxml/catalog';
import { nativeTags } from '../src/languages/wxml/catalog';

/** 显式读取官方声明文件，更新过程不依赖任何业务目录或执行工程脚本。 */
const filename = process.argv[2];
if (!filename) throw new Error('请指定 miniprogram-api-typings/types/wx/lib.wx.event.d.ts。');
const text = await readFile(resolve(filename), 'utf8');
const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
const aliases = new Map<string, ts.TypeAliasDeclaration>();
/** 官方事件类型位于命名空间内，只收集类型声明。 */
function visit(node: ts.Node): void { if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node); ts.forEachChild(node, visit); }
visit(source);

/** 声明类型保持有界，开放类型及外部名称不猜测其成员。 */
function type(node: ts.TypeNode | undefined, seen = new Set<string>(), depth = 0): SemanticType {
  if (!node || depth >= 12) return { kind: 'unknown', display: 'unknown' };
  const primitive = new Map([[ts.SyntaxKind.StringKeyword, 'string'], [ts.SyntaxKind.NumberKeyword, 'number'], [ts.SyntaxKind.BooleanKeyword, 'boolean']]);
  const kind = primitive.get(node.kind);
  if (kind) return { kind: kind as 'string' | 'number' | 'boolean', display: kind };
  if (ts.isUnionTypeNode(node)) { const alternatives = node.types.map((part) => type(part, seen, depth + 1)); return { kind: 'unknown', display: alternatives.map((item) => item.display).join(' | '), alternatives }; }
  if (ts.isArrayTypeNode(node)) { const element = type(node.elementType, seen, depth + 1); return { kind: 'array', display: element.display + '[]', element }; }
  if (ts.isLiteralTypeNode(node)) {
    const value = node.literal;
    const literal = ts.isStringLiteral(value) ? value.text : ts.isNumericLiteral(value) ? Number(value.text) : value.kind === ts.SyntaxKind.TrueKeyword ? true : value.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
    if (literal !== undefined) return { kind: typeof literal as 'string' | 'number' | 'boolean', display: JSON.stringify(literal), literal };
  }
  if (ts.isTypeLiteralNode(node)) {
    const properties = Object.fromEntries(node.members.flatMap((member) => ts.isPropertySignature(member) && member.name ? [[member.name.getText(source).replace(/^['"]|['"]$/g, ''), { ...type(member.type, seen, depth + 1), ...(member.questionToken ? { optional: true } : {}) }]] : []));
    return { kind: 'object', display: `{ ${Object.entries(properties).map(([name, value]) => `${name}${value.optional ? '?' : ''}: ${value.display}`).join('; ')} }`, properties };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(source);
    if (name === 'CustomEvent') return type(node.typeArguments?.[0], seen, depth + 1);
    const alias = aliases.get(name);
    if (alias && !seen.has(name)) return type(alias.type, new Set(seen).add(name), depth + 1);
  }
  return { kind: 'unknown', display: 'unknown' };
}

/** 平台标签和类型前缀对应；最长前缀避免 picker-view 被当作 picker。 */
const prefixes = [...nativeTags].map((tag) => ({ tag, prefix: tag.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('') })).sort((first, second) => second.prefix.length - first.prefix.length);
prefixes.unshift({ tag: 'functional-page-navigator', prefix: 'FunctionalNavigator' });
const tags = new Map<string, TagData>();
for (const [name, alias] of aliases) {
  const owner = prefixes.find((item) => name.startsWith(item.prefix) && (name.length > item.prefix.length || name === 'Input'));
  if (!owner) continue;
  const event = name === 'Input' ? 'input' : name.slice(owner.prefix.length).toLowerCase();
  const comment = source.text.slice(alias.pos, alias.getStart(source)).replace(/\/\*\*|\*\//g, '').split('\n').map((line) => line.replace(/^\s*\* ?/, '').trim()).join('\n').trim();
  const since = comment.match(/最低基础库[:：]\s*(\d+\.\d+\.\d+)/)?.[1];
  const description = comment.replace(/最低基础库[:：]\s*\d+\.\d+\.\d+/, '').trim() || `${event} 事件。`;
  const detail = type(alias.type);
  const previous = tags.get(owner.tag);
  tags.set(owner.tag, { name: owner.tag, description: '', attributes: [...previous?.attributes ?? [], { name: 'bind' + event, type: 'event', description, ...(since ? { since } : {}), ...(detail.kind !== 'unknown' ? { detail } : {}), references: [{ name: '微信官方事件类型', url: 'https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts' }] }] });
}
/** 生成静态事实快照，运行时无需读取声明包或增加编译器依赖。 */
const destination = new URL('../src/languages/wxml/component-events.ts', import.meta.url);
await writeFile(destination, `import type { TagData } from './catalog';\n\n/** 根据微信官方 miniprogram-api-typings 事件声明生成，更新使用 dev:metadata。 */\nexport const componentEvents: readonly TagData[] = ${JSON.stringify([...tags.values()], null, 2)};\n`);
const license = text.match(/^\/\*![\s\S]*?\*\//)?.[0];
if (license) { const directory = new URL('./vendor/wechat-api-typings/', import.meta.url); await mkdir(directory, { recursive: true }); await writeFile(new URL('LICENSE', directory), license + '\n'); }
console.log(`已更新 ${tags.size} 类组件、${[...tags.values()].reduce((total, tag) => total + tag.attributes.length, 0)} 个官方事件。`);
