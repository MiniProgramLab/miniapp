import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

/** 将构建后的实际编译器与同版本原版对照，避免源码测试绕过交付文件。 */
const require = createRequire(import.meta.url);
const original = require('typescript');
const delivered = require('../dist/typescript.cjs');

test('交付编译器保留全部导出、公开函数名称及参数数量', () => {
  assert.deepEqual(Object.keys(delivered).sort(), Object.keys(original).sort());
  for (const key of Object.keys(original)) {
    const expected = original[key];
    const actual = delivered[key];
    assert.equal(typeof actual, typeof expected, key);
    if (typeof expected === 'function') {
      assert.equal(actual.name, expected.name, `${key} 的函数名称`);
      assert.equal(actual.length, expected.length, `${key} 的参数数量`);
    } else if (expected === null || typeof expected !== 'object') {
      assert.equal(actual, expected, key);
    }
  }
});

/** 对照跨文件泛型、重导出、语法位置及编译输出，检查压缩后的真实语义行为。 */
function inspect(compiler) {
  const files = new Map([
    ['/model.ts', 'export class Box<T> { constructor(public value: T) {} }'],
    ['/page.ts', 'import { Box } from "./model"; export const record = new Box({title: "标题", enabled: true}); export const title = record.value.title; export { Box as DataBox } from "./model";'],
  ]);
  const options = { noLib: true, declaration: true, target: compiler.ScriptTarget.ES2019, module: compiler.ModuleKind.CommonJS };
  const host = compiler.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) => files.has(name) ? compiler.createSourceFile(name, files.get(name), languageVersion, true) : undefined;
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => files.get(name);
  host.getCurrentDirectory = () => '/';
  host.directoryExists = (name) => name === '/';
  const output = new Map();
  host.writeFile = (name, text) => output.set(name, text);
  const program = compiler.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const page = program.getSourceFile('/page.ts');
  const nodes = [];
  /** 记录语法类型与原始字符位置，导航结果依赖这些字段。 */
  function visit(node) {
    nodes.push([node.kind, node.pos, node.end]);
    compiler.forEachChild(node, visit);
  }
  visit(page);
  const symbols = checker.getExportsOfModule(checker.getSymbolAtLocation(page)).map((symbol) => {
    const target = symbol.flags & compiler.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return [symbol.name, target.name, checker.typeToString(checker.getTypeOfSymbolAtLocation(target, page)), target.declarations?.map((node) => [node.getSourceFile().fileName, node.kind, node.getStart(), node.end])];
  });
  program.emit();
  return { nodes, symbols, output: [...output] };
}

test('交付编译器保持公共枚举、跨文件类型推断及语法位置', () => {
  for (const key of ['SyntaxKind', 'ScriptTarget', 'ModuleKind', 'ModuleResolutionKind', 'ScriptKind', 'NodeFlags', 'TypeFlags', 'SymbolFlags', 'ScriptElementKind', 'LanguageVariant']) {
    assert.deepEqual(delivered[key], original[key], key);
  }
  assert.deepEqual(inspect(delivered), inspect(original));
});

test('交付编译器保留单字节源码、许可声明及原始基础库', async () => {
  const source = await readFile(new URL('../dist/typescript.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[^\x00-\x7f]/, '大文件源码应保持单字节存储，避免额外常驻内存');
  assert.match(source, /Copyright \(c\) Microsoft Corporation/);
  assert.match(source, /Apache License, Version 2\.0/);
  for (const file of ['lib.es5.d.ts', 'lib.decorators.d.ts', 'lib.decorators.legacy.d.ts']) {
    assert.deepEqual(await readFile(new URL(`../dist/typescript-lib/${file}`, import.meta.url)), await readFile(new URL(`../node_modules/typescript/lib/${file}`, import.meta.url)), file);
  }
});
