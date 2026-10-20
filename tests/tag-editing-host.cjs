const assert = require('node:assert/strict');
const vscode = require('vscode');

/** 等待宿主的异步联动或自动插入完成，超时给出具体行为提示。 */
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), typeof message === 'function' ? message() : message);
}

/** 打开临时 WXML，并把真实编辑器光标放到标记位置。 */
async function show(source) {
  const offset = source.indexOf('|');
  assert.ok(offset >= 0);
  const document = await vscode.workspace.openTextDocument({ language: 'wxml', content: source.replace('|', '') });
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { document, editor };
}

/** 在当前光标仅插入一端文本，由宿主自身完成自动闭合和联动。 */
async function insert(editor, text) {
  const offset = editor.document.offsetAt(editor.selection.active);
  assert.equal(await editor.edit((edit) => edit.insert(editor.selection.active, text), { undoStopBefore: true, undoStopAfter: false }), true);
  const position = editor.document.positionAt(offset + text.length);
  editor.selection = new vscode.Selection(position, position);
}

/** 为原生命令指定文档和编辑器坐标，等待对应联动范围完成初始化。 */
async function startLinkedEditing(editor) {
  const position = editor.selection.active;
  await vscode.commands.executeCommand('editor.action.linkedEditing', [editor.document.uri, { lineNumber: position.line + 1, column: position.character + 1 }]);
}

/** 通过真实编辑器编辑与原生联动验证标签行为，不手动修改另一端文本。 */
exports.run = async function run() {
  const paired = await show('<vi|');
  const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', paired.document.uri, paired.editor.selection.active);
  const view = completions.items.find((item) => item.label === 'view');
  assert.equal(view.insertText.value, 'view>$0</view>');
  await paired.editor.insertSnippet(view.insertText, view.range);
  assert.equal(paired.document.getText(), '<view></view>');
  assert.equal(paired.document.offsetAt(paired.editor.selection.active), 6);

  const automatic = await show('<custom-card|');
  await insert(automatic.editor, '>');
  await until(() => automatic.document.getText() === '<custom-card></custom-card>', '插入 > 必须自动闭合自定义组件');
  await until(() => automatic.document.offsetAt(automatic.editor.selection.active) === '<custom-card>'.length, '自动闭合后光标必须保留在标签内容位置');
  await vscode.commands.executeCommand('undo');
  await until(() => automatic.document.getText() === '<custom-card', () => `撤销应同时移除输入的大于号与自动闭合标签，当前内容：${automatic.document.getText()}`);
  await vscode.commands.executeCommand('redo');
  await until(() => automatic.document.getText() === '<custom-card></custom-card>', '重做不应重复插入结束标签');

  const existing = await show('<view|</view>');
  await insert(existing.editor, '>');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(existing.document.getText(), '<view></view>');
  const selfClosing = await show('<image /|');
  await insert(selfClosing.editor, '>');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(selfClosing.document.getText(), '<image />');

  const nested = await show('<view><custom-card><text></text></custom-card></|');
  const endings = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', nested.document.uri, nested.editor.selection.active);
  assert.ok(endings.items.some((item) => item.label === 'view' && item.insertText === 'view>'));

  const linked = await show('<view><custom-ca|rd>内容</custom-card><custom-card /></view>');
  assert.equal(vscode.workspace.getConfiguration('editor', { uri: linked.document.uri, languageId: 'wxml' }).get('linkedEditing'), true);
  // 等待原生联动命令完成范围初始化，避免固定延时在慢宿主中失效。
  await startLinkedEditing(linked.editor);
  await insert(linked.editor, 'x');
  await until(() => linked.document.getText() === '<view><custom-caxrd>内容</custom-caxrd><custom-card /></view>', `编辑开始标签只能同步当前配对结束标签，当前内容：${linked.document.getText()}`);
  const closingOffset = linked.document.getText().indexOf('</custom-caxrd>') + '</custom-ca'.length;
  linked.editor.selection = new vscode.Selection(linked.document.positionAt(closingOffset), linked.document.positionAt(closingOffset));
  await startLinkedEditing(linked.editor);
  await insert(linked.editor, 'y');
  await until(() => linked.document.getText() === '<view><custom-cayxrd>内容</custom-cayxrd><custom-card /></view>', `编辑结束标签也必须同步开始标签，当前内容：${linked.document.getText()}`);

  // 关闭偏好时保留纯名称补全，并停止输入时的自动修改。
  const settings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml');
  await settings.update('autoClosingTags', false, vscode.ConfigurationTarget.Global);
  try {
    const disabled = await show('<view|');
    const plain = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', disabled.document.uri, disabled.editor.selection.active);
    assert.equal(plain.items.find((item) => item.label === 'view').insertText, 'view');
    await insert(disabled.editor, '>');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(disabled.document.getText(), '<view>');
  } finally {
    await settings.update('autoClosingTags', undefined, vscode.ConfigurationTarget.Global);
  }
  console.log('标签宿主验证通过：成对补全、单字符编辑自动闭合、双向同步改名、自定义标签、撤销重做与关闭配置。');
};
