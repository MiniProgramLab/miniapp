import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { queryWxs } from '../src/languages/typescript/wxs';
import { ScriptProject } from '../src/languages/typescript/project';
import ts from 'typescript';

/** 同一模块快照用于比较独立能力和组合查询的结果。 */
test('WXS 按能力查询保留相同定义与说明，补全详情仅在选中后生成', async () => {
  const root = 'file:///wxs-modes/';
  const module = `/** 转换说明。\n * @param {number} value 输入值。\n */function format(value){return value+1;}module.exports={format:format,title:'标题'};`;
  const text = `var tools=require('./lib.wxs');tools.format`;
  const reader: WorkspaceReader = { root: () => root, revision: () => '0', read: async (uri) => uri === root + 'page.wxs' ? { text } : uri === root + 'lib.wxs' ? { text: module } : undefined };
  const request: LanguageRequest = { document: { uri: root + 'page.wxs', text, version: 1, languageId: 'wxs' }, offset: text.lastIndexOf('format') + 3, cancellation: { isCancellationRequested: false } };
  const all = await queryWxs(reader, request);
  const definition = await queryWxs(reader, request, undefined, {}, false, 'definition');
  assert.deepEqual(definition?.definitions, all?.definitions);
  assert.deepEqual(definition?.completions, []); assert.equal(definition?.hover, undefined);
  const hover = await queryWxs(reader, request, undefined, {}, false, 'hover');
  assert.deepEqual(hover?.hover, all?.hover); assert.deepEqual(hover?.completions, []);
  const deferred = await queryWxs(reader, { ...request, deferCompletionDetails: true }, undefined, {}, false, 'completion');
  assert.deepEqual(deferred?.definitions, []); assert.equal(deferred?.hover, undefined);
  const selected = deferred!.completions.find((item) => item.label === 'format')!;
  const original = all!.completions.find((item) => item.label === 'format')!;
  assert.deepEqual(await selected.resolve!({ isCancellationRequested: false }), { detail: original.detail, documentation: original.documentation });
  assert.equal(await selected.resolve!({ isCancellationRequested: true }), undefined);
});

test('模型精简注释仍保留类型和链接，TS 参数与 JS 类型注解保持完整', async () => {
  const root = 'file:///comment-modes/';
  const text = `/** 模型说明。 */export interface Model {/** 字段说明。 {@link Model} */label:string}`;
  const fn = `/** 函数说明。\n * @param value 参数说明。\n */export function save(value:string){return value}`;
  const js = `/** @param {number} value 参数说明。 */function save(value){return value}module.exports={save};`;
  const reader: WorkspaceReader = { root: () => root, read: async () => undefined };
  for (const [name, source, kind] of [['model.ts', text, 'typescript'], ['fn.ts', fn, 'typescript'], ['fn.js', js, 'javascript']] as const) {
    const request: LanguageRequest = { document: { uri: root + name, text: source, version: 1, languageId: kind }, offset: 0, cancellation: { isCancellationRequested: false } };
    const graph = await new ScriptProject(reader, request, {}).create(request.document.uri);
    const checker = graph!.program.getTypeChecker();
    if (name === 'model.ts') {
      const model = graph!.entry.statements.find(ts.isInterfaceDeclaration)!;
      assert.equal(checker.typeToString(checker.getTypeAtLocation(model.members[0]!)), 'string');
      assert.equal((graph!.entry as ts.SourceFile & { jsDocParsingMode: ts.JSDocParsingMode }).jsDocParsingMode, ts.JSDocParsingMode.ParseForTypeErrors);
    } else {
      const declaration = graph!.entry.statements.find(ts.isFunctionDeclaration)!;
      const parameter = declaration.parameters[0]!;
      assert.equal(checker.typeToString(checker.getTypeAtLocation(parameter)), name === 'fn.js' ? 'number' : 'string');
      const symbol = checker.getSymbolAtLocation(parameter.name)!;
      assert.match(ts.displayPartsToString(symbol.getDocumentationComment(checker)), /参数说明/);
    }
  }
});
