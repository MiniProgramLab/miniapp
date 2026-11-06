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
      'model.ts': `export const colors={/** 标题说明。 */ label:'标题'};`, 'page.wxml': '{{label}}<include src="./missing.wxml"/>' };
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(directory, name), text);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'page.wxml')));
    const coldHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, document.positionAt(5));
    assert.ok(coldHover.some((item) => item.contents.some((content) => content.value.includes('标题说明'))), '首次悬浮应找到展开字段的原始说明');
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
    console.log('性能专项宿主验证通过：首次展开字段悬浮、可见诊断、资源刷新、并发补全/悬浮/跳转及草稿坐标同步。');
    if (process.env.MINIAPP_HOST_COMPLETION) await fs.writeFile(process.env.MINIAPP_HOST_COMPLETION, 'passed\n');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
};
