const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 用真实宿主核对可见诊断、磁盘缓存失效及未保存声明的位置。 */
exports.run = async function run() {
  await vscode.extensions.getExtension('miniprogramlab.miniapp').activate();
  const directory = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.performance-'));
  try {
    const files = { 'app.json': '{}',
      'page.ts': `import base from './base';import environment from './environment';Page({behaviors:[base,environment]});`,
      'base.ts': `import {colors} from './model';export default Behavior({data:{...colors}});`,
      'environment.ts': `const MATRIX={dev:true,prod:true};type Keys=keyof typeof MATRIX;const flags:Record<Keys,boolean>={} as any;export default Behavior({data:{...flags}});`,
      'model.ts': `export const colors={/** 标题说明。 */ label:'标题'};`, 'page.wxml': '{{label}}<include src="./missing.wxml"/>',
      'complex.ts': `import type {Model} from './complex-types';Page({data:{formData:{} as Model}});`,
      'complex-types.ts': 'interface Base {/** 复杂字段说明。 */label:string}type Remap<T>={[K in keyof T as `field_${K & string}`]:T[K]};export type Model=Remap<Base>&{count:number};',
      'complex.wxml': '{{formData.field_label}}' };
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(directory, name), text);
    const archived = path.join(directory, '.claude/worktrees/archived');
    await fs.mkdir(archived, { recursive: true });
    await fs.writeFile(path.join(directory, 'tsconfig.json'), '{"include":["**/*"]}');
    await fs.writeFile(path.join(directory, 'contract.d.ts'), `declare module 'native-contract' {export interface Model {title:string}}`);
    await fs.writeFile(path.join(archived, 'contract.d.ts'), `declare module 'native-contract' {export interface Model {wrong:number}}`);
    await fs.writeFile(path.join(directory, 'ambient.ts'), `import type {Model} from 'native-contract';Page({data:{model:{} as Model}});`);
    await fs.writeFile(path.join(directory, 'ambient.wxml'), '{{model.}}');
    const ambient = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'ambient.wxml')));
    const ambientItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', ambient.uri, ambient.positionAt(8));
    assert.ok(ambientItems.items.some((item) => item.label === 'title'));
    assert.ok(!ambientItems.items.some((item) => item.label === 'wrong'), '嵌套工作树的同名声明不能进入当前页面');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'page.wxml')));
    const coldHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, document.positionAt(5));
    assert.ok(coldHover.some((item) => item.contents.some((content) => content.value.includes('标题说明'))), '首次悬浮应找到展开字段的原始说明');
    // 复杂类型首次并发查询仍核对原字段说明和源码位置。
    const complex = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'complex.wxml')));
    const complexPosition = complex.positionAt(complex.getText().indexOf('field_label') + 3);
    const [typedHover, typedCompletions, typedDefinitions] = await Promise.all([
      vscode.commands.executeCommand('vscode.executeHoverProvider', complex.uri, complexPosition),
      vscode.commands.executeCommand('vscode.executeCompletionItemProvider', complex.uri, complexPosition, undefined, 1),
      vscode.commands.executeCommand('vscode.executeDefinitionProvider', complex.uri, complexPosition),
    ]);
    assert.ok(typedHover.some((item) => item.contents.some((content) => content.value.includes('复杂字段说明'))));
    assert.ok(typedCompletions.items.some((item) => item.label === 'field_label' && item.documentation?.value.includes('复杂字段说明')));
    const typed = typedDefinitions.find((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'complex-types.ts'));
    assert.ok(typed);
    const typedDocument = await vscode.workspace.openTextDocument(typed.targetUri ?? typed.uri);
    assert.equal(typedDocument.getText(typed.targetSelectionRange ?? typed.range), 'label');
    assert.ok(!Object.keys(require.cache).some((filename) => filename.endsWith('/miniprogramlab.vscode/dist/typescript.cjs')), '语义查询必须在线程中加载编译器');
    /** 只观察本插件的问题码，等待明确状态后继续。 */
    async function count(expected) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const items = vscode.languages.getDiagnostics(document.uri).filter((item) => item.code === 'template-resource');
        if (items.length === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`可见文档的资源诊断未更新到 ${expected} 项`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    await count(0);
    await vscode.window.showTextDocument(document, { preview: false });
    await count(1);
    /** 反复跳转仍返回相同声明，草稿插入后必须同步原始坐标。 */
    const locate = () => vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, document.positionAt(4));
    const first = await locate();
    assert.ok(first.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'model.ts')));
    assert.deepEqual(await locate(), first);
    // 已缓存的缺失路径在新模块草稿出现后立即刷新，不等待磁盘监听。
    await fs.mkdir(path.join(directory, 'drafts'));
    await fs.writeFile(path.join(directory, 'draft.ts'), `import type {Model} from './drafts/model';Page({data:{record:{} as Model}});`);
    await fs.writeFile(path.join(directory, 'draft.wxml'), '{{record.}}');
    const draft = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'draft.wxml')));
    const completeDraft = () => vscode.commands.executeCommand('vscode.executeCompletionItemProvider', draft.uri, draft.positionAt(9));
    assert.ok(!(await completeDraft()).items.some((item) => item.label === 'fromDraft'));
    const target = vscode.Uri.file(path.join(directory, 'drafts/model.ts'));
    const create = new vscode.WorkspaceEdit(); create.createFile(target); create.insert(target, new vscode.Position(0, 0), 'export interface Model {/** 草稿模块 */fromDraft:string}');
    assert.equal(await vscode.workspace.applyEdit(create), true);
    assert.ok((await vscode.workspace.openTextDocument(target)).isDirty);
    assert.ok((await completeDraft()).items.some((item) => item.label === 'fromDraft'));
    const position = document.positionAt(5);
    const [hovers, completions, definitions] = await Promise.all([
      vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position),
      vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, undefined, 1),
      locate(),
    ]);
    assert.ok(hovers.some((item) => item.contents.some((content) => content.value.includes('标题说明'))));
    assert.ok(completions.items.some((item) => item.label === 'label' && item.documentation?.value.includes('标题说明')), '选中候选后由真实宿主解析详情');
    assert.deepEqual(definitions, first);
    const model = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'model.ts')));
    const edit = new vscode.WorkspaceEdit(); edit.insert(model.uri, new vscode.Position(0, 0), '\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const updated = await locate();
    assert.ok(updated.some((item) => (item.targetUri ?? item.uri).fsPath === model.uri.fsPath && (item.targetSelectionRange ?? item.range).start.line === 1));
    await vscode.window.showTextDocument(model, { preview: false });
    await count(0);
    await vscode.window.showTextDocument(document, { preview: false });
    await count(1);
    await fs.writeFile(path.join(directory, 'missing.wxml'), '<view/>');
    await count(0);
    console.log('性能专项宿主验证通过：复杂类型首次并发补全/悬浮/跳转、选中详情、可见诊断、资源刷新及草稿坐标同步。');
    if (process.env.MINIAPP_HOST_COMPLETION) await fs.writeFile(process.env.MINIAPP_HOST_COMPLETION, 'passed\n');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
};
