const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 等待实际预览命令完成，命令尚未进入预览时可在限定时间内重试。 */
async function decide(command, pending, selectChanges = false) {
  let settled = false, error;
  pending.then(() => { settled = true; }, (reason) => { error = reason; settled = true; });
  const deadline = Date.now() + 5000;
  while (!settled && Date.now() < deadline) {
    if (selectChanges) {
      const commands = await vscode.commands.getCommands();
      // 按类别显示后，首行代表同一次提取的全部文件，不能只勾选首个文件。
      if (commands.includes('refactorPreview.groupByType')) {
        await vscode.commands.executeCommand('refactorPreview.groupByType');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const focus = commands.find((item) => item === 'refactorPreview.focus');
      if (focus) await vscode.commands.executeCommand(focus);
      await vscode.commands.executeCommand('list.focusFirst');
      // 列表命令的内部焦点更新异步完成，等待后再切换当前行的复选框。
      await new Promise((resolve) => setTimeout(resolve, 50));
      await vscode.commands.executeCommand('refactorPreview.toggleCheckedState');
    }
    await vscode.commands.executeCommand(command);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (error) throw error;
  assert.ok(settled, '原生预览必须实际响应应用或放弃命令');
  return await pending;
}

/** 在临时文件中验证输入校验、原生预览放弃、应用和整体撤销。 */
exports.run = async function run() {
  const directory = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.refactor-'));
  const text = '<view>\n  <block wx:for="{{rows}}"><text>{{item.title}} {{caption}}</text></block>\n</view>';
  const uri = vscode.Uri.file(path.join(directory, 'page.wxml'));
  try {
    await fs.writeFile(uri.fsPath, text);
    await fs.writeFile(path.join(directory, 'page.ts'), "Page({data:{rows:[{title:'甲'}],caption:'说明'}});");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    const start = text.indexOf('<block'), end = text.indexOf('</block>') + '</block>'.length;
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    /** 每次提供器查询获取新的命令参数，不复用已被消费的动作编号。 */
    async function action(target = uri, selection = range) {
      const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', target, selection, vscode.CodeActionKind.RefactorExtract.value);
      const selected = actions.find((item) => item.title === '提取为当前文件的具名模板');
      assert.ok(selected?.command && !selected.disabled);
      return selected.command;
    }
    const commands = await vscode.commands.getCommands();
    assert.ok(commands.includes('refactorPreview.apply') && commands.includes('refactorPreview.discard'));
    let command = await action();
    let pending = vscode.commands.executeCommand(command.command, ...command.arguments, 'row-list');
    let finished = false; pending.then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(finished, false, '动作必须等待真实原生预览确认，不能提前结束');
    assert.equal(document.getText(), text, '预览确认前不能修改源码');
    await decide('refactorPreview.discard', pending);
    assert.equal(document.getText(), text, '放弃预览不能修改源码');
    const dependency = path.join(directory, 'dependency.wxml'), dependentUri = vscode.Uri.file(path.join(directory, 'dependent.wxml'));
    const dependentText = '<include src="./dependency.wxml"/>';
    await fs.writeFile(dependency, '<text>{{caption}}</text>');
    await fs.writeFile(dependentUri.fsPath, dependentText);
    const dependent = await vscode.workspace.openTextDocument(dependentUri);
    command = await action(dependentUri, new vscode.Range(dependent.positionAt(0), dependent.positionAt(dependentText.length)));
    pending = vscode.commands.executeCommand(command.command, ...command.arguments, 'dependency-copy');
    let invalidated = false; pending.then(() => { invalidated = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(invalidated, false, '依赖变更前必须保留待确认的真实预览');
    await fs.writeFile(dependency, '<text>{{caption}}变更</text>');
    const invalidationDeadline = Date.now() + 5000;
    while (!invalidated && Date.now() < invalidationDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(invalidated, '只读 include 依赖变化必须使原生预览自动失效');
    await pending; assert.equal(dependent.getText(), dependentText, '旧预览失效后不能修改调用文件');
    console.log('原生预览依赖失效验证通过：真实磁盘依赖变化触发放弃，调用文件未修改。');
    await vscode.window.showTextDocument(document, { preview: false });
    // 给实际窗口切换留出时间，仍要求真正前台聚焦后才能验收复选框。
    const focusDeadline = Date.now() + 20_000;
    while (!vscode.window.state.focused && Date.now() < focusDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(vscode.window.state.focused, '原生预览复选框需要激活独立 Cursor 验收窗口，当前宿主未聚焦，应用验收未完成。');
    command = await action();
    pending = vscode.commands.executeCommand(command.command, ...command.arguments, 'row-list');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await decide('refactorPreview.apply', pending, true), true, '原生预览必须实际应用已勾选的修改');
    assert.match(document.getText(), /<template is="row-list" data="\{\{rows: rows, caption: caption\}\}"\/>/);
    assert.match(document.getText(), /<template name="row-list">/);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), text, '一次原生撤销还原调用处与模板定义');
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, range, vscode.CodeActionKind.RefactorExtract.value);
    const component = actions.find((item) => item.title === '提取为独立组件');
    assert.ok(component?.command && !component.disabled);
    pending = vscode.commands.executeCommand(component.command.command, ...component.command.arguments, './components/row-card/index');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await decide('refactorPreview.apply', pending, true), true, '组件提取必须通过原生预览实际创建关联文件');
    assert.match(document.getText(), /<row-card/);
    const child = path.join(directory, 'components/row-card/index');
    for (const extension of ['.wxml', '.ts', '.json', '.wxss']) assert.ok((await fs.stat(child + extension)).isFile());
    const registration = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'page.json')));
    assert.equal(JSON.parse(registration.getText()).usingComponents['row-card'], './components/row-card/index');
    // 新文件创建时已携带完整内容，无需另行保存草稿才能使用。
    for (const filename of [path.join(directory, 'page.json'), ...['.wxml', '.ts', '.json', '.wxss'].map((extension) => child + extension)]) {
      const created = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
      assert.ok(created.getText().length > 0);
      assert.equal(await fs.readFile(filename, 'utf8'), created.getText());
    }
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    // 文件操作的撤销异步完成，只发出一次命令并等待源码和新建文件真正还原。
    const createdFiles = [path.join(directory, 'page.json'), ...['.wxml', '.ts', '.json', '.wxss'].map((extension) => child + extension)];
    const undoDeadline = Date.now() + 5000;
    while (Date.now() < undoDeadline) {
      const present = await Promise.all(createdFiles.map((filename) => fs.stat(filename).then(() => true, () => false)));
      if (document.getText() === text && present.every((exists) => !exists)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(document.getText(), text, '一次撤销还原组件调用处');
    for (const filename of createdFiles) await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
    console.log('提取宿主验证通过：模板及组件的原生预览应用、文件创建、注册与一次撤销。');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await fs.rm(directory, { recursive: true, force: true });
  }
};
