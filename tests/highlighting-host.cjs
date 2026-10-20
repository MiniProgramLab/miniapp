const assert = require('node:assert/strict');
const vscode = require('vscode');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

/** 使用真实 TextMate 引擎对比 WXML、HTML 属性分隔符与 TS 表达式样式。 */
exports.run = async function run() {
  const directory = await mkdtemp(path.join(tmpdir(), 'miniapp-highlighting-'));
  try {
    const script = path.join(directory, 'reference.ts');
    const markup = path.join(directory, 'reference.html');
    const template = path.join(directory, 'sample.wxml');
    await writeFile(script, 'function referenceHandler() {}\nreferenceHandler();\nconst ready = count === 1 && status !== 2;\n');
    await writeFile(markup, '<div id="camera" onclick="referenceHandler()" style="height:1px" />');
    await writeFile(template, [
      '<view bindtap="onTap" catch:tap=\'onCatch\' capture-bind:tap="onCapture" mut-bindtap="onMut" worklet:tap="onWorklet" />',
      '<view bindtap="controller.onSave" bindchange=onChange data-label="plainText" title="literalCall()" />',
      '<view title="{{ formatValue(title) }}" bindtap="{{ createHandler() }}" />',
      '<view bindtap="',
      '  multilineHandler',
      '" bindchange=\'处理变化\'>',
      '  {{ formatTitle(title) }} {{ formatter.render(title) }}',
      '  {{ "literalExpression()" }} {{ count + 1 }}',
      '  {{ count === 1 && status !== 2 }}',
      '</view>',
      '<camera wx:if="{{showCamera}}" bind:error="cameraError" bind:initdone=\'calculateCameraZoomList\' id="camera" flash="{{cameraConfig.flash}}" resolution="high" style="height:{{cameraConfig.height}}px" device-position="{{cameraConfig.devicePosition}}" />',
      '<!-- <view bindtap="commentHandler" /> -->',
    ].join('\n'));
    const scriptTokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', vscode.Uri.file(script));
    const markupTokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', vscode.Uri.file(markup));
    const tokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', vscode.Uri.file(template));
    const reference = scriptTokens.find((token) => token.c === 'referenceHandler' && token.t.endsWith('entity.name.function.ts'));
    assert.ok(reference, 'TypeScript 函数必须使用预期的内置作用域');
    for (const name of ['onTap', 'onCatch', 'onCapture', 'onMut', 'onWorklet', 'onSave', 'onChange', 'multilineHandler', '处理变化', 'formatTitle', 'render', 'formatValue', 'createHandler']) {
      const token = tokens.find((item) => item.c === name);
      assert.ok(token?.t.endsWith('entity.name.function.ts'), `${name} 必须沿用 TS 函数作用域：${JSON.stringify(token)}`);
      for (const theme of Object.keys(reference.r)) {
        assert.equal(token.r[theme]?.split(': ').at(-1), reference.r[theme]?.split(': ').at(-1), `${name} 在 ${theme} 中的颜色应与 TS 函数一致`);
      }
    }
    for (const name of ['plainText', 'literalCall', 'literalExpression', 'commentHandler', 'count']) {
      assert.ok(tokens.some((token) => token.c.includes(name)), `必须真实解析 ${name}`);
      assert.ok(!tokens.some((token) => token.c.includes(name) && token.t.includes('entity.name.function')), `${name} 不应误用函数高亮`);
    }
    // 普通、事件及插值属性的等号与 HTML 分隔符一致，避免被运算符规则染色。
    const separator = markupTokens.find((token) => token.c === '=' && token.t.endsWith('punctuation.separator.key-value.html'));
    assert.ok(separator, '必须取得内置 HTML 属性等号的真实高亮');
    const assignments = tokens.filter((token) => token.c === '=' && !token.t.includes('source.ts.embedded.wxml'));
    assert.ok(assignments.length > 15, '需要覆盖普通属性和多种事件属性');
    for (const token of assignments) {
      assert.ok(token.t.endsWith('punctuation.separator.key-value.html'), `属性等号必须使用 HTML 分隔符作用域：${JSON.stringify(token)}`);
      for (const theme of Object.keys(separator.r)) {
        assert.equal(token.r[theme]?.split(': ').at(-1), separator.r[theme]?.split(': ').at(-1), `属性等号在 ${theme} 中应与 HTML 一致`);
      }
    }
    // 插值里的比较运算符仍复用 TS 规则，不受属性等号调整影响。
    for (const operator of ['===', '!==']) {
      const expected = scriptTokens.find((token) => token.c === operator);
      const actual = tokens.find((token) => token.c === operator);
      assert.ok(expected && actual?.t.endsWith(expected.t.split(' ').at(-1)), `${operator} 应保持 TS 运算符作用域`);
      for (const theme of Object.keys(expected.r)) {
        assert.equal(actual.r[theme]?.split(': ').at(-1), expected.r[theme]?.split(': ').at(-1), `${operator} 在 ${theme} 中应保持 TS 配色`);
      }
    }
    console.log('高亮宿主验证通过：WXML 属性等号与 HTML 分隔符配色一致，事件方法及插值运算符保持 TS 样式。');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
