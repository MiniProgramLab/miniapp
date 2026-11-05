const assert = require('node:assert/strict');
const vscode = require('vscode');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

/** 使用真实文件和原生命令检查注释格式及再次切换后的还原结果。 */
async function checkComment(directory, index, sample) {
  const file = path.join(directory, `sample-${index}.${sample.extension}`);
  await writeFile(file, sample.content);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  assert.equal(document.languageId, sample.language, `${sample.extension} 应识别为对应语言`);
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  // 先完成真实语法着色，确保插值语言判断参与注释命令。
  await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', document.uri);
  const start = sample.selection ? sample.content.indexOf(sample.selection) : 0;
  assert.ok(start >= 0, '注释选区必须存在');
  editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(start + (sample.selection?.length ?? 0)));
  const command = sample.block ? 'editor.action.blockComment' : 'editor.action.commentLine';
  try {
    await vscode.commands.executeCommand(command);
    assert.equal(document.getText(), sample.expected, `${sample.extension} 的${sample.block ? '块' : '行'}注释格式错误`);
    await vscode.commands.executeCommand(command);
    assert.equal(document.getText(), sample.content, `${sample.extension} 再次切换应完整还原源码`);
  } finally {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

/** 验证模板、样式与脚本切换时不混用各自的注释语法。 */
exports.run = async function run() {
  const directory = await mkdtemp(path.join(tmpdir(), 'miniapp-comments-'));
  const samples = [
    { extension: 'wxml', language: 'wxml', content: '<view>{{ title }}</view>', expected: '<!-- <view>{{ title }}</view> -->' },
    { extension: 'wxml', language: 'wxml', content: '<view title="{{ formatTitle(title) }}" />', selection: 'formatTitle(title)', block: true,
      expected: '<view title="{{ <!-- formatTitle(title) --> }}" />' },
    { extension: 'wxml', language: 'wxml', content: '<view>{{\nformatTitle(title)\n}}</view>', selection: 'formatTitle(title)',
      expected: '<view>{{\n<!-- formatTitle(title) -->\n}}</view>' },
    { extension: 'wxml', language: 'wxml', content: '<view\n  title="{{ title }}"\n  bindtap="onTap"\n/>', selection: 'title="{{ title }}"\n  bindtap="onTap"', block: true,
      expected: '<view\n  <!-- title="{{ title }}"\n  bindtap="onTap" -->\n/>' },
  ];
  // WXSS/CSS 使用块注释，SCSS/Less 的行注释及所有样式块注释沿用所属语言。
  for (const language of ['wxss', 'css', 'scss', 'less']) {
    const content = '.page { color: red; }';
    samples.push({ extension: language, language, content, expected: ['scss', 'less'].includes(language) ? `// ${content}` : `/* ${content} */` });
    samples.push({ extension: language, language, content, selection: content, block: true, expected: `/* ${content} */` });
  }
  for (const [extension, language] of [['ts', 'typescript'], ['js', 'javascript']]) {
    const content = 'const title = "示例";';
    samples.push({ extension, language, content, expected: `// ${content}` });
    samples.push({ extension, language, content, selection: content, block: true, expected: `/* ${content} */` });
  }
  // 从脚本切回模板，确认前一文件的注释规则不会残留。
  samples.push({ extension: 'wxml', language: 'wxml', content: '<view>{{ title }}</view>', selection: 'title', block: true,
    expected: '<view>{{ <!-- title --> }}</view>' });
  try {
    for (const [index, sample] of samples.entries()) await checkComment(directory, index, sample);
    console.log(`注释宿主验证通过：${samples.length} 组 WXML、WXSS/CSS/SCSS/Less、TS/JS 原生行注释、块注释及切换还原。`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
