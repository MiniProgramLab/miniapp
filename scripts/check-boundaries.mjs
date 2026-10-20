import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** 从语法树检查真实导入，避免注释或字符串造成误报。 */
const root = fileURLToPath(new URL('../src/', import.meta.url));
const violations = [];

/** 递归枚举源文件，目录顺序不影响边界判断。 */
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute) : absolute.endsWith('.ts') ? [absolute] : [];
  });
}

/** 语言模块只依赖本模块和公共契约，底座不能反向导入适配器。 */
function allowed(file, specifier) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const target = specifier.startsWith('.') ? path.relative(root, path.resolve(path.dirname(file), specifier)).split(path.sep).join('/') : specifier;
  if (relative.startsWith('api/')) return target === 'api' || target.startsWith('api/');
  if (relative.startsWith('core/')) return target === 'api' || target.startsWith('api/') || target.startsWith('core/');
  if (relative.startsWith('resolution/')) return target === 'api' || target.startsWith('api/') || target.startsWith('resolution/') || target === 'typescript' || target === 'node:path';
  if (relative.startsWith('languages/')) {
    const module = relative.split('/')[1];
    return target === 'api' || target.startsWith('api/') || target.startsWith(`languages/${module}/`) || module === 'typescript' && target === 'typescript';
  }
  if (relative.startsWith('adapters/')) return !target.startsWith('languages/');
  return true;
}

for (const file of files(root)) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  /** 同时约束静态导入、重导出、类型导入以及动态导入。 */
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier) && !allowed(file, specifier.text)) violations.push(`${path.relative(root, file)} -> ${specifier.text}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (violations.length) throw new Error(`发现架构依赖越界：\n${violations.join('\n')}`);
console.log('架构依赖边界检查通过。');
