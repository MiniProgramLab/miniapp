const assert = require('node:assert/strict');
const vscode = require('vscode');

/** 原生命令异步更新选区，等待实际编辑器结果。 */
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), message);
}

/** 验证大纲、折叠及原生扩大选区，不读取关联脚本或手工构造宿主结果。 */
exports.run = async function run() {
  const text = '<view id="main" class="page">\n  <template name="card">\n    <text>中文内容</text>\n  </template>\n  <wxs module="utils" src="./unused.wxs"/>\n  <!-- 注释\n  <fake/> -->\n  <card\n    value="bar"\n  />\n</view>';
  const document = await vscode.workspace.openTextDocument({ language: 'wxml', content: text });
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
  const root = symbols.find((symbol) => symbol.name === 'view#main .page');
  assert.ok(root && root.children.some((symbol) => symbol.name === 'template card' && symbol.kind === vscode.SymbolKind.Function));
  assert.ok(root.children.some((symbol) => symbol.name === 'wxs utils' && symbol.kind === vscode.SymbolKind.Module));
  assert.ok(root.children.every((symbol) => !symbol.name.includes('fake')));
  assert.equal(document.getText(root.selectionRange), 'view');
  const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri);
  assert.ok(folds.some((fold) => fold.start === 0 && fold.end === text.split('\n').length - 2));
  assert.ok(folds.some((fold) => fold.kind === vscode.FoldingRangeKind.Comment));
  const position = document.positionAt(text.indexOf('bar') + 1);
  const selections = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', document.uri, [position, document.positionAt(text.indexOf('中文') + 1)]);
  assert.equal(selections.length, 2);
  const chain = [];
  for (let current = selections[0]; current; current = current.parent) chain.push(document.getText(current.range));
  assert.ok(chain.includes('bar') && chain.includes('"bar"') && chain.includes('value="bar"'));
  editor.selection = new vscode.Selection(position, position);
  await vscode.commands.executeCommand('editor.action.smartSelect.expand');
  await until(() => document.getText(editor.selection) === 'bar', '原生扩大选区应首先选择属性单词');
  await vscode.commands.executeCommand('editor.action.smartSelect.expand');
  await until(() => document.getText(editor.selection) === '"bar"', '第二次扩大选区应保留成对引号');
  const edit = new vscode.WorkspaceEdit(), start = document.getText().indexOf('name="card"') + 'name="'.length;
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + 4)), 'updated');
  await vscode.workspace.applyEdit(edit);
  const updated = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
  assert.ok(updated.some((symbol) => symbol.children?.some((child) => child.name === 'template updated')));
  console.log('结构宿主验证通过：模板大纲、模块层级、语义折叠、多光标与原生扩大选区、未保存更新。');
};

/** 含数据表达式的结构灯泡在语义模块已按需加载后验证，不混入基础编辑的启动检查。 */
exports.checkDiagnostics = async function checkDiagnostics() {
  const invalid = '<view wx:else/><view class="first" class="second" wx:for="{{items}}" wx:key="{{item.id}}"/><view><text>内容</view>';
  const draft = await vscode.workspace.openTextDocument({ language: 'wxml', content: invalid });
  await vscode.window.showTextDocument(draft, { preview: false, preserveFocus: false });
  /** 只读取真实问题面板的数据，等待防抖和草稿版本刷新。 */
  const problems = () => vscode.languages.getDiagnostics(draft.uri).filter((item) => String(item.code).startsWith('wxml-'));
  await until(() => problems().length === 4, '结构诊断应覆盖错配、重复属性、孤立分支与列表键').catch((error) => {
    console.error('结构诊断实际结果：', JSON.stringify(vscode.languages.getDiagnostics(draft.uri)));
    throw error;
  });
  assert.deepEqual(new Set(problems().map((item) => item.code)), new Set(['wxml-mismatched-tag', 'wxml-duplicate-attribute', 'wxml-orphan-conditional', 'wxml-invalid-key']));
  for (const [code, title, expected] of [
    ['wxml-duplicate-attribute', '删除重复属性 class（保留首个）', invalid.replace(' class="second"', '')],
    ['wxml-mismatched-tag', '补齐此处缺失的结束标签', invalid.replace('</view>', '</text></view>')],
    ['wxml-invalid-key', '将 wx:key 改为静态属性 id', invalid.replace('wx:key="{{item.id}}"', 'wx:key="id"')],
  ]) {
    const issue = problems().find((item) => item.code === code);
    const fixes = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', draft.uri, issue.range, vscode.CodeActionKind.QuickFix.value);
    const fix = fixes.find((item) => item.title === title);
    assert.ok(fix?.edit, `真实灯泡应提供 ${title}`);
    assert.equal(await vscode.workspace.applyEdit(fix.edit), true);
    assert.equal(draft.getText(), expected);
    await until(() => !problems().some((item) => item.code === code), '应用修复后对应结构诊断应清除');
    await vscode.commands.executeCommand('undo');
    await until(() => draft.getText() === invalid && problems().length === 4, '一次撤销应恢复原草稿及结构诊断');
  }
  console.log('结构宿主验证通过：大纲、折叠、选区及结构问题面板、原生灯泡应用、诊断清除与一次撤销。');
};
