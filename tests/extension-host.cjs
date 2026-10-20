const assert = require('node:assert/strict');
const vscode = require('vscode');

/** 通过真实编辑器命令验证注册、转换、外部扩展及卸载。 */
exports.run = async function run() {
  const extension = vscode.extensions.getExtension('miniprogramlab.miniapp');
  assert.ok(extension, '扩展标识符必须保持 miniprogramlab.miniapp');
  const api = await extension.activate();
  const compiler = vscode.Uri.joinPath(extension.extensionUri, 'dist', 'typescript.cjs').fsPath;
  assert.equal(require.cache[compiler], undefined, '激活和注册语言提供器不应加载 TypeScript 编译器');
  assert.equal(api.apiVersion, 1);
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.wxml'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.css'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.file-navigation'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.script-navigation'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.wxs'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.dataset'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.component-instances'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.page-routes'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.navigator-routes'));
  assert.ok(api.getPlugins().some((plugin) => plugin.id === 'miniprogramlab.data-paths'));
  assert.equal(api.getPlugins().length, 10, '仅注册通用小程序语言模块');
  assert.deepEqual(extension.packageJSON.contributes.languages.map((language) => language.id), ['wxml', 'wxss', 'wxs']);
  assert.deepEqual(extension.packageJSON.contributes.typescriptServerPlugins, [{ name: '@miniprogramlab/style-imports', enableForWorkspaceTypeScriptVersions: true }], '原生 TS 适配器只处理样式副作用导入');

  const document = await vscode.workspace.openTextDocument({ language: 'wxml', content: '<view cl\n<image mode="as" />' });
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  // 真实输入、撤销及原生预览依赖前台宿主，不能把程序设置编辑器焦点等同于窗口激活。
  const focusDeadline = Date.now() + 20_000;
  while (!vscode.window.state.focused && Date.now() < focusDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(vscode.window.state.focused, '真实编辑器验收需要激活扩展开发宿主窗口。');
  const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 8));
  const classItem = completions.items.find((item) => item.label === 'class');
  assert.ok(classItem);
  assert.equal(classItem.insertText.value, 'class="${1}"');
  assert.equal(classItem.documentation.isTrusted, false);
  const values = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(1, 15));
  assert.ok(values.items.some((item) => item.label === 'aspectFit'));
  const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(0, 3));
  assert.ok(hover.some((item) => item.contents.some((content) => content.value.includes('视图容器'))));

  await require('./tag-editing-host.cjs').run();
  await require('./highlighting-host.cjs').run();
  await require('./structure-host.cjs').run();
  assert.equal(require.cache[compiler], undefined, '基本 WXML 编辑和高亮不应初始化 TypeScript');
  await require('./components-host.cjs').run(extension);
  assert.ok(require.cache[compiler], '组件源码查询应按需加载内置 TypeScript 编译器');
  await require('./structure-host.cjs').checkDiagnostics();
  assert.equal(Object.keys(require.cache).filter((filename) => filename === compiler).length, 1, '所有解析模块共用同一编译器实例');
  await require('./resolution-host.cjs').run();
  await require('./semantic-host.cjs').run();

  // 外部插件与内置语言共享注册契约，不需要依赖内部底座类。
  let disposed = false;
  const registration = api.registerPlugin({
    id: 'example.plaintext', displayName: '外部语言示例', languages: ['plaintext'],
    /** 注册附属资源及异步悬浮能力。 */
    setup({ subscriptions }) {
      subscriptions.add({ dispose: () => { disposed = true; } });
      return { hover: { provide: async () => ({ title: '外部插件', description: '[示例](command:example.run)', range: { start: 0, end: 1 } }) } };
    },
  });
  const plain = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'hello' });
  const external = await vscode.commands.executeCommand('vscode.executeHoverProvider', plain.uri, new vscode.Position(0, 0));
  assert.equal(external.length, 1);
  assert.equal(external[0].contents[0].isTrusted, false);
  assert.ok(external[0].contents[0].value.includes('\\[示例\\]'));
  registration.dispose();
  assert.equal(disposed, true);
  assert.ok(!api.getPlugins().some((plugin) => plugin.id === 'example.plaintext'));
  assert.deepEqual(await vscode.commands.executeCommand('vscode.executeHoverProvider', plain.uri, new vscode.Position(0, 0)), []);

  // 单个插件请求失败后，其他语言的提供器仍然可用。
  const broken = api.registerPlugin({
    id: 'example.broken', displayName: '错误隔离示例', languages: ['plaintext'],
    setup: () => ({ hover: { provide: () => { throw new Error('预期的提供器异常'); } } }),
  });
  assert.deepEqual(await vscode.commands.executeCommand('vscode.executeHoverProvider', plain.uri, new vscode.Position(0, 0)), []);
  broken.dispose();
  assert.ok((await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(0, 3))).length > 0);
  const example = vscode.Uri.joinPath(extension.extensionUri, 'examples', 'wxml');
  /** 在精确位置发起真实 F12，并保留下一次跳转所需的位置。 */
  async function definitionsAt(source, position) {
    const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', source.uri, position);
    return Promise.all(locations.map(async (item) => {
      const uri = item.targetUri ?? item.uri;
      const range = item.targetSelectionRange ?? item.range;
      const target = await vscode.workspace.openTextDocument(uri);
      return { uri: uri.toString(), text: target.getText(range), line: range.start.line, character: range.start.character };
    }));
  }
  /** 优先选取插值引用，避免 data 键名或 wx:key 抢占测试位置。 */
  async function definitions(file, symbol) {
    const source = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(example, file));
    const expression = source.getText().indexOf('{{' + symbol);
    const offset = expression >= 0 ? expression + 2 : source.getText().lastIndexOf(symbol);
    assert.ok(offset >= 0, `示例中缺少 ${symbol}`);
    return definitionsAt(source, source.positionAt(offset + 1));
  }
  /** 在上一步真实返回的字段位置再次执行 F12，不附加隐藏的查询上下文。 */
  async function follow(definition) {
    assert.ok(definition, '上一跳必须存在');
    const source = await vscode.workspace.openTextDocument(vscode.Uri.parse(definition.uri));
    return definitionsAt(source, new vscode.Position(definition.line, definition.character));
  }
  const tokens = vscode.Uri.joinPath(example, 'styles', '_tokens.scss');
  const variable = await definitions('index.scss', '$brand');
  assert.ok(variable.some((item) => item.uri === tokens.toString() && item.text === '$brand'));
  const mixin = await definitions('index.scss', 'center');
  assert.ok(mixin.some((item) => item.uri === tokens.toString() && item.text === 'center'));
  const css = await definitions('index.css', '--brand');
  assert.ok(css.some((item) => item.uri.endsWith('/styles/palette.css') && item.text === '--brand'));
  const classes = await definitions('index.wxml', 'page');
  assert.ok(classes.some((item) => item.uri.endsWith('/index.scss') && item.text === '.page'));
  const conditionalClass = await definitions('index.wxml', 'img-rotate');
  assert.ok(conditionalClass.some((item) => item.uri.endsWith('/index.scss') && item.text === '&-rotate'), '三元表达式类名应通过真实 F12 定位嵌套声明');
  const classDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(example, 'index.wxml'));
  const classEnd = classDocument.getText().lastIndexOf('img-rotate') + 'img-rotate'.length;
  const selectedClass = await definitionsAt(classDocument, classDocument.positionAt(classEnd));
  assert.ok(selectedClass.some((item) => item.uri.endsWith('/index.scss') && item.text === '&-rotate'), '选中完整类名后的末尾光标也应支持 F12');
  const classStart = classEnd - 'img-rotate'.length;
  const classCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', classDocument.uri, classDocument.positionAt(classStart + 'img-'.length), '-');
  const classCompletion = classCompletions.items.find((item) => item.label === 'img-rotate');
  assert.ok(classCompletion, '三元字符串应通过真实补全命令显示 SCSS 嵌套类名');
  assert.equal(classCompletion.insertText, 'img-rotate');
  assert.equal(classDocument.getText(classCompletion.range), 'img-rotate', '补全应完整替换当前类名，保留引号');
  assert.equal(vscode.workspace.getConfiguration('editor', { uri: classDocument.uri, languageId: classDocument.languageId }).get('quickSuggestions').strings, 'on', 'WXML 字符串默认启用自动补全');

  // 变量、枚举及函数需要跨过两层重导出，类成员沿类型定位。
  for (const [symbol, target] of [['caption', 'pageTitle'], ['Status', 'PageState'], ['Ready', 'Ready'], ['onOpen', 'handleOpen'], ['save', 'save'], ['label', 'label']]) {
    const result = await definitions('index.wxml', symbol);
    assert.ok(result.some((item) => item.uri.endsWith('/scripts/model.ts') && item.text === target), `${symbol} 应穿透到 ${target}：${JSON.stringify(result)}`);
  }
  const local = await definitions('index.wxml', 'onLocalTap');
  assert.ok(local.some((item) => item.uri.endsWith('/index.ts') && item.text === 'onLocalTap'));

  // 真实悬浮命令应显示变量、事件和模板传参的原声明注释。
  for (const [file, symbol, description] of [
    ['index.wxml', 'caption', '经重导出及页面别名向模板暴露的原始变量'],
    ['index.wxml', 'onLocalTap', '页面直接声明的方法'],
    ['templates/card.wxml', 'title', '经重导出及页面别名向模板暴露的原始变量'],
    ['templates/card.wxml', 'onOpen', '模板事件绑定最终定位的原始函数'],
    ['templates/card.wxml', 'save', '模板中可查看声明的实例方法'],
    ['templates/card.wxml', 'label', '列表项的显示名称'],
  ]) {
    const source = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(example, file));
    const expression = source.getText().indexOf('{{' + symbol);
    const offset = expression >= 0 ? expression + 2 : source.getText().lastIndexOf(symbol);
    assert.ok(offset >= 0, `悬浮示例中缺少 ${symbol}`);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', source.uri, source.positionAt(offset + 1));
    assert.ok(hovers.some((item) => item.contents.some((content) => content.value.includes(description))), `${file} 中的 ${symbol} 应显示原声明注释：${JSON.stringify(hovers)}`);
    assert.ok(hovers.every((item) => item.contents.every((content) => content.isTrusted === false)), '源码注释必须作为普通文本显示');
  }

  // 独立模板的首跳必须停在最近一次 data 传参的对应根字段。
  for (const [symbol, target] of [['title', 'title'], ['Status', 'Status'], ['Ready', 'Status'], ['action', 'action'], ['save', 'model'], ['label', 'records']]) {
    const result = await definitions('templates/card.wxml', symbol);
    assert.ok(result.some((item) => item.uri.endsWith('/templates/wrapper.wxml') && item.text === target), `独立模板的 ${symbol} 应先定位 data.${target}：${JSON.stringify(result)}`);
  }
  const firstTitle = (await definitions('templates/card.wxml', 'title'))[0];
  const outerTitle = (await follow(firstTitle))[0];
  assert.ok(outerTitle.uri.endsWith('/index.wxml') && outerTitle.text === 'heading');
  assert.ok((await follow(outerTitle)).some((item) => item.uri.endsWith('/scripts/model.ts') && item.text === 'pageTitle'));
  const event = await definitions('templates/card.wxml', 'onOpen');
  assert.ok(event.some((item) => item.uri.endsWith('/scripts/model.ts') && item.text === 'handleOpen'));

  // 解构、静态键与工厂参数在逐层 data 字段之后继续追踪原始声明。
  const chainField = (await definitions('templates/card.wxml', 'chainTitle'))[0];
  assert.ok(chainField.uri.endsWith('/templates/wrapper.wxml') && chainField.text === 'chainTitle');
  const chainOuter = (await follow(chainField))[0];
  assert.ok(chainOuter.uri.endsWith('/index.wxml') && chainOuter.text === 'chainHeading');
  assert.ok((await follow(chainOuter)).some((item) => item.uri.endsWith('/scripts/data-chain.ts') && item.text === 'title'));
  const included = await definitions('templates/header.wxml', 'caption');
  assert.ok(included.some((item) => item.uri.endsWith('/scripts/model.ts') && item.text === 'pageTitle'));

  // 修改未保存的 data 绑定时，首跳保留字段位置，后续跳转使用新的绑定。
  const callerUri = vscode.Uri.joinPath(example, 'index.wxml');
  const caller = await vscode.workspace.openTextDocument(callerUri);
  const mappingStart = caller.getText().indexOf('heading:caption');
  assert.ok(mappingStart >= 0);
  const remap = new vscode.WorkspaceEdit();
  remap.replace(callerUri, new vscode.Range(caller.positionAt(mappingStart), caller.positionAt(mappingStart + 'heading:caption'.length)), 'heading:Status.Ready');
  await vscode.workspace.applyEdit(remap);
  assert.equal(caller.isDirty, true);
  const remapped = await definitions('templates/card.wxml', 'title');
  assert.deepEqual(remapped, [firstTitle]);
  const remappedOuter = (await follow(remapped[0]))[0];
  assert.ok((await follow(remappedOuter)).some((item) => item.uri.endsWith('/scripts/model.ts') && item.text === 'Ready'));
  const restoreMapping = new vscode.WorkspaceEdit();
  restoreMapping.replace(callerUri, new vscode.Range(caller.positionAt(mappingStart), caller.positionAt(mappingStart + 'heading:Status.Ready'.length)), 'heading:caption');
  await vscode.workspace.applyEdit(restoreMapping);

  // data 字段在未保存缓冲区中移动时，首跳必须跟随它的最新行号。
  const wrapperUri = vscode.Uri.joinPath(example, 'templates', 'wrapper.wxml');
  const wrapper = await vscode.workspace.openTextDocument(wrapperUri);
  const moveData = new vscode.WorkspaceEdit();
  moveData.insert(wrapperUri, new vscode.Position(0, 0), '\n\n');
  await vscode.workspace.applyEdit(moveData);
  assert.equal(wrapper.isDirty, true);
  const movedData = (await definitions('templates/card.wxml', 'title'))[0];
  assert.equal(movedData.line, firstTitle.line + 2);
  assert.ok((await follow(movedData)).some((item) => item.uri.endsWith('/index.wxml') && item.text === 'heading'));
  const restoreData = new vscode.WorkspaceEdit();
  restoreData.delete(wrapperUri, new vscode.Range(0, 0, 2, 0));
  await vscode.workspace.applyEdit(restoreData);

  // 原始脚本声明在未保存的缓冲区移动后，跳转结果必须同步更新。
  const model = vscode.Uri.joinPath(example, 'scripts', 'model.ts');
  const modelDocument = await vscode.workspace.openTextDocument(model);
  const originalTitle = (await definitions('index.wxml', 'caption')).find((item) => item.uri === model.toString());
  const scriptEdit = new vscode.WorkspaceEdit();
  scriptEdit.insert(model, new vscode.Position(0, 0), '\n\n');
  await vscode.workspace.applyEdit(scriptEdit);
  assert.equal(modelDocument.isDirty, true);
  const movedTitle = await definitions('index.wxml', 'caption');
  assert.ok(movedTitle.some((item) => item.uri === model.toString() && item.line === originalTitle.line + 2));
  const movedTemplateTitle = await definitions('templates/card.wxml', 'title');
  assert.deepEqual(movedTemplateTitle, [firstTitle]);
  const movedOuter = (await follow(movedTemplateTitle[0]))[0];
  assert.ok((await follow(movedOuter)).some((item) => item.uri === model.toString() && item.line === originalTitle.line + 2));
  const scriptRestore = new vscode.WorkspaceEdit();
  scriptRestore.delete(model, new vscode.Range(0, 0, 2, 0));
  await vscode.workspace.applyEdit(scriptRestore);

  // 目标缓冲区尚未保存时，F12 必须使用变化后的行号。
  const targetDocument = await vscode.workspace.openTextDocument(tokens);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(tokens, new vscode.Position(0, 0), '\n\n');
  await vscode.workspace.applyEdit(edit);
  assert.equal(targetDocument.isDirty, true);
  const changed = await definitions('index.scss', '$brand');
  assert.ok(changed.some((item) => item.uri === tokens.toString() && item.line === variable.find((item) => item.uri === tokens.toString()).line + 2));
  const restore = new vscode.WorkspaceEdit();
  restore.delete(tokens, new vscode.Range(0, 0, 2, 0));
  await vscode.workspace.applyEdit(restore);
  console.log('既有语言功能宿主检查已完成，开始原生提取预览应用验收。');
  await require('./refactor-host.cjs').run();
  console.log('真实 VS Code 宿主验证通过：WXML 变量与事件原声明注释、独立 WXML 首跳 data 字段、逐层 F12、TS 解构与工厂依赖链、未保存传参及声明同步，以及既有 WXML/CSS 能力。');
  if (process.env.MINIAPP_HOST_COMPLETION) await require('node:fs/promises').writeFile(process.env.MINIAPP_HOST_COMPLETION, 'passed\n');
};
