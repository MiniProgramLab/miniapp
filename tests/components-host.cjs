const assert = require('node:assert/strict');
const vscode = require('vscode');

/** 在真实 Cursor 宿主验证组件、继承参数和插槽的悬浮及实现跳转。 */
exports.run = async function run(extension) {
  const root = vscode.Uri.joinPath(extension.extensionUri, 'examples', 'wxml');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'component-demo.wxml'));
  /** 通过编辑器的公开命令查询使用处，避免直接调用语言模块绕过适配层。 */
  async function query(token, occurrence = 0) {
    let offset = -1;
    for (let index = 0; index <= occurrence; index++) offset = document.getText().indexOf(token, offset + 1);
    assert.ok(offset >= 0, `应存在 ${token}`);
    const position = document.positionAt(offset + 1);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position);
    const text = hover.flatMap((item) => item.contents.map((content) => content.value)).join('\n');
    assert.ok(hover.every((item) => item.contents.every((content) => content.isTrusted !== true)));
    const targets = [];
    for (const item of definitions) {
      const uri = item.targetUri ?? item.uri;
      const range = item.targetSelectionRange ?? item.range;
      const target = await vscode.workspace.openTextDocument(uri);
      targets.push({ path: uri.path, text: target.getText(range) });
      assert.ok(!/\.d\.[cm]?ts$/.test(uri.path), '目标必须是实现源码');
    }
    return { text, targets };
  }
  const component = await query('demo-card');
  assert.match(component.text, /展示信息并提供头部和操作插槽/);
  assert.ok(component.targets.some((item) => item.path.endsWith('/components/card/index.ts') && item.text === 'Component'));
  const prop = await query('title-text');
  assert.match(prop.text, /展示在卡片顶部的标题/);
  assert.match(prop.text, /类型：string/);
  assert.match(prop.text, /默认值：/);
  assert.ok(prop.targets.some((item) => item.path.endsWith('/components/card/index.ts') && item.text === 'titleText'));
  // 真实宿主的参数补全必须包含源码说明，并保留已经填写的值。
  const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(document.getText().indexOf('title-text') + 3));
  const title = completions.items.find((item) => item.label === 'title-text');
  assert.ok(title);
  assert.equal(title.insertText, 'title-text');
  assert.match(title.documentation.value, /展示在卡片顶部的标题/);
  assert.match(title.documentation.value, /默认值：/);
  const inherited = await query('has-power');
  assert.match(inherited.text, /是否允许编辑卡片/);
  assert.match(inherited.text, /类型：boolean/);
  assert.ok(inherited.targets.some((item) => item.path.endsWith('/components/card/shared.ts') && item.text === 'hasPower'));
  const slot = await query('header');
  assert.match(slot.text, /自定义卡片的头部内容/);
  assert.ok(slot.targets.some((item) => item.path.endsWith('/components/card/index.wxml') && item.text === 'header'));
  const actions = await query('actions');
  assert.match(actions.text, /自定义卡片的操作区域/);
  assert.ok(actions.targets.some((item) => item.path.endsWith('/components/card/index.wxml') && item.text === 'actions'));

  // 未保存的组件注释与默认值必须立即反映到页面悬浮说明。
  const source = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'components/card/index.ts'));
  const original = source.getText();
  const range = new vscode.Range(source.positionAt(0), source.positionAt(original.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(source.uri, range, original.replace('展示在卡片顶部的标题。', '未保存的新标题说明。').replace("'默认标题'", "'草稿标题'"));
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  try {
    const draft = await query('title-text');
    assert.match(draft.text, /未保存的新标题说明/);
    assert.match(draft.text, /草稿标题/);
  } finally {
    const restore = new vscode.WorkspaceEdit();
    restore.replace(source.uri, new vscode.Range(source.positionAt(0), source.positionAt(source.getText().length)), original);
    await vscode.workspace.applyEdit(restore);
  }
  console.log('组件宿主验证通过：组件注释、参数类型与默认值、继承字段、插槽实现和未保存更新。');
};
