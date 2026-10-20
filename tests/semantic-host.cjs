const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 真实 Cursor 命令验证事件、WXS、重命名转换及未保存内容，不改动用户工程。 */
exports.run = async function run() {
  const directory = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.semantic-'));
  const files = {
    'app.json': '{"pages":["route","destination","schema-destination","move-page"],"subPackages":[{"root":"reports","pages":[]}]}',
    'route.ts': `import {pageTarget} from './move-route-path';Page({move(){wx.navigateTo({url:pageTarget})},open(){wx.navigateTo({url:'/destination?recordId=demo'})},schema(){wx.navigateTo({url:'/schema-destination?recordId=demo'})}});`,
    'route.wxml': '<navigator url="/destination"/><navigator url="/move-page"/><shared-router/>',
    'move-route-path.ts': `export const pageTarget='/move-page?recordId=kept';`,
    'move-page.ts': 'Page({});', 'move-page.wxml': '<view/>',
    'route.json': '{"usingComponents":{"shared-router":"./shared-router"}}',
    'destination.ts': 'Page({onLoad(options:{recordId:string;limit?:number}){}});',
    'destination.wxml': '<view/>',
    'schema-destination.ts': `import {screen} from './route-runtime';screen({query:{/** 记录编号 */ recordId:{type:String,required:true},limit:{type:Number,value:5}}});`,
    'schema-destination.wxml': '<view/>',
    'route-runtime.ts': 'export function screen(options:any){const {query,...native}=options;Page(native)}',
    'shared-router.ts': `Component({methods:{open(){this.pageRouter.navigateTo({url:'./destination'})}}});`,
    'shared-router.wxml': '<view/>',
    'data-path.ts': `Component({data:{user:{/** 用户名称 */ name:'甲'},items:[{title:'乙',count:1}]},observers:{'user.name, items[0].title'(name,title){}},methods:{open(){const self=this;self.setData({'user.name':'乙','items[0].count':'错'});return self.data.user}}});`,
    'move-source.wxml': '<include src="./move-body.wxml"/>',
    'move-body.wxml': '<view/>',
    'resource-check.wxml': '<include src="./resource-body.wxml"/><wxs module="math" src="./resource-math.wxs"/>',
    'resource-math.wxs': 'module.exports={};',
    'aliased-handler.ts': 'export function executeNotice(){}',
    'aliased-barrel.ts': 'export {executeNotice as deliver} from "./aliased-handler";',
    'aliased-card.ts': 'import {deliver as local} from "./aliased-barrel";Component({methods:{onNotice:local}});',
    'aliased-card.wxml': '<button bindtap="onNotice"/>',
    'aliased-object.ts': 'export const handlers={executeNotice(){}};',
    'aliased-object-card.ts': 'import {handlers as local} from "./aliased-object";Component({methods:{onObject:local.executeNotice}});',
    'aliased-object-card.wxml': '<button bindtap="onObject"/>',
    'aliased-core.wxs': 'function executeNotice(value){return value};module.exports=executeNotice;',
    'aliased-view.wxs': 'var local=require("./aliased-core.wxs");module.exports={notice:local};',
    'aliased-view.wxml': '<wxs module="tools" src="./aliased-view.wxs"/>{{tools.notice(1)}}',
    'page.json': '{"usingComponents":{"my-card":"./card"}}',
    'page.wxml': '<wxs module="utils" src="./utils.wxs"/><my-card bind:change="onChange"/><view bindtap="selectSpeed">{{utils.format}}</view><view bindtap="missingHandler">{{account.nmae}}</view>',
    'page.ts': `import {shared} from './behavior';Component({behaviors:[shared],data:{account:{name:'甲'}},methods:{onChange(e:{detail:{value:string}}){}}});`,
    'behavior.ts': `export const shared=Behavior({methods:{selectSpeed(){},repeat(){this.selectSpeed()}}});`,
    'card.ts': `Component({methods:{emit(){/** 数值改变 */ this.triggerEvent('change',{value:1})}}});`,
    'utils.wxs': `var source=require('./source.wxs');module.exports={format:source.format};`,
    'source.wxs': `/** 格式化文字 */ function format(value){return value}exports.format=format;`,
    'typed-source.wxs': `/** 格式化金额。\n * @param {number} amount 金额。\n * @param {string} [suffix] 后缀。\n */function format(amount,suffix){return amount+suffix}module.exports={format:format};`,
    'wxs-calls.wxml': '<wxs module="utils" src="./typed-source.wxs"/><view>{{utils.format("错")}}</view><wxs module="inline">var broken=;</wxs>',
    'wxs-calls.wxs': 'var tools=require("./typed-source.wxs");tools.format("错");tools.format(1,"元");wx.request({});',
    'wxs-shadow.wxml': '<wxs module="utils" src="./typed-source.wxs"/><wxs module="utils" src="./source.wxs"/>{{utils.format(1)}}',
    'navigation.wxml': '<include src="{{target}}"/><include src="@/missing.wxml"/>',
    'notice-widget.json': '{"component":true}',
    'notice-widget.ts': 'Component({properties:{count:{type:Number,required:true}}});',
    'register.wxml': '<notice-widget/>', 'register.ts': 'Page({});',
    'wrapped.wxml': '<view bindtap="submit">{{caption}}</view>',
    'wrapped.ts': `import './wrapped-style.scss';import {mount as screen} from './runtime';screen({data:{caption:'甲'},methods:{submit(){},again(){this.submit()}}});`,
    'wrapped-style.scss': '.page{}',
    'runtime.ts': `export function mount(options){const {metadata,...native}=options;Component(native);}`,
    'dataset.ts': 'Page({submit(event:any){const {userId}=event.currentTarget.dataset;return event.currentTarget.dataset.userId+userId}});',
    'dataset.wxml': '<view data-user-id="{{3}}" bindtap="submit"/>',
    'instance.ts': `Page({open(){const panel=this.selectComponent('#panel');panel.show?.(2)}});`,
    'instance.wxml': '<custom-panel id="panel"/>', 'instance.json': '{"usingComponents":{"custom-panel":"./instance-panel"}}',
    'instance-panel.ts': `Component({methods:{/** 打开实例面板 */ show(count:number):string{return String(count)}}});`,
    'metadata.wxml': '<generic-box scale="large" bind:notice="handle"/><input bindinput="handle"/><scroll-view binddragstart="handle"/>',
    'metadata.ts': 'Page({handle(event:any){}});',
    'metadata.json': '{"usingComponents":{"generic-box":"./metadata-box"}}',
    'metadata-box.ts': 'Component({properties:{scale:String}});',
    'metadata-lib/package.json': '{"name":"generic-ui","version":"2.1.0"}',
    'metadata-lib/components.html-data.json': JSON.stringify({ version: 1.1, tags: [{ name: 'generic-box', description: '通用组件元数据', attributes: [{ name: 'scale', defaultValue: 'small', since: '2.10.0', values: [{ name: 'small' }, { name: 'large' }] }], events: [{ name: 'notice', detail: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }] }),
    'check-scope/good.wxml': '<view>{{title}}</view>', 'check-scope/good.ts': "Page({data:{title:'有效'}});",
    'check-scope/bad.wxml': '<view>{{missing}}</view><include src="./missing.wxml"/>', 'check-scope/bad.ts': "Page({data:{title:'有效'}});",
    'check-scope/skip/ignored.wxml': '<view>{{missing}}</view>',
    'check-scope/dist/ignored.wxml': '<view>{{missing}}</view>',
  };
  try {
    for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), text); }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'page.wxml')));
    await vscode.commands.executeCommand('miniprogramlab.miniapp.switchScript', document.uri);
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(directory, 'page.ts'), '关联命令应打开同基名脚本');
    await vscode.commands.executeCommand('miniprogramlab.miniapp.switchTemplate', vscode.window.activeTextEditor.document.uri);
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), document.uri.toString(), '关联命令应切回模板');
    const resource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'resource-check.wxml')));
    /** 资源问题必须进入真实问题面板，磁盘创建后不能保留旧的缺失结果。 */
    async function resourceCount(expected) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const findings = vscode.languages.getDiagnostics(resource.uri).filter((item) => item.code === 'template-resource');
        if (findings.length === expected) return findings;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`资源诊断未更新到 ${expected} 项`);
    }
    const missingResource = await resourceCount(1);
    assert.equal(resource.getText(missingResource[0].range), './resource-body.wxml');
    await fs.writeFile(path.join(directory, 'resource-body.wxml'), '<view/>');
    await resourceCount(0);
    const moveSource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'move-source.wxml')));
    const moveEdit = new vscode.WorkspaceEdit();
    moveEdit.renameFile(vscode.Uri.file(path.join(directory, 'move-body.wxml')), vscode.Uri.file(path.join(directory, 'move-renamed.wxml')));
    assert.equal(await vscode.workspace.applyEdit(moveEdit), true, '原生文件移动应完成');
    assert.match(moveSource.getText(), /src="\.\/move-renamed.wxml"/, '原生移动事件应联动模板路径');
    await vscode.commands.executeCommand('miniprogramlab.miniapp.switchStyle', vscode.Uri.file(path.join(directory, 'wrapped.ts')));
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(directory, 'wrapped-style.scss'), '样式切换应采用实际导入的文件');
    /** 一组真实页面文件一起移动，注册与跨文件常量必须共享同一批编辑。 */
    const movedConfig = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'app.json')));
    const movedConstant = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'move-route-path.ts')));
    const movedNavigator = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'route.wxml')));
    const pageMove = new vscode.WorkspaceEdit();
    for (const extension of ['.ts', '.wxml']) pageMove.renameFile(vscode.Uri.file(path.join(directory, 'move-page' + extension)), vscode.Uri.file(path.join(directory, 'renamed-page' + extension)));
    assert.equal(await vscode.workspace.applyEdit(pageMove), true);
    assert.match(movedConfig.getText(), /"renamed-page"/, '页面注册应随实际页面移动更新');
    assert.match(movedConstant.getText(), /\/renamed-page\?recordId=kept/, '路由常量应保留查询字符串');
    assert.match(movedNavigator.getText(), /url="\/renamed-page"/, 'navigator 应联动同一页面');
    await fs.mkdir(path.join(directory, 'reports'));
    const packageMove = new vscode.WorkspaceEdit();
    for (const extension of ['.ts', '.wxml']) packageMove.renameFile(vscode.Uri.file(path.join(directory, 'renamed-page' + extension)), vscode.Uri.file(path.join(directory, 'reports', 'renamed-page' + extension)));
    assert.equal(await vscode.workspace.applyEdit(packageMove), true);
    const packageConfig = JSON.parse(movedConfig.getText());
    assert.ok(!packageConfig.pages.includes('renamed-page'), '跨分包移动应移除原主包注册');
    assert.deepEqual(packageConfig.subPackages[0].pages, ['renamed-page'], '跨分包移动应插入包内相对注册');
    assert.match(movedConstant.getText(), /\/reports\/renamed-page\?recordId=kept/, '运行 URL 应保留完整分包路径与查询');
    assert.match(movedNavigator.getText(), /url="\/reports\/renamed-page"/);
    const dataPath = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'data-path.ts')));
    const dataPathPosition = dataPath.positionAt(dataPath.getText().lastIndexOf("'user.name'") + "'user.na".length);
    const dataPathItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', dataPath.uri, dataPathPosition, '.');
    assert.ok(dataPathItems.items.some((item) => item.label === 'name' && item.detail?.includes('string')), 'setData 路径应显示实际字段及声明类型');
    const dataPathDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', dataPath.uri, dataPathPosition);
    assert.ok(dataPathDefinitions.some((item) => (item.targetUri ?? item.uri).fsPath === dataPath.uri.fsPath && dataPath.getText(item.targetSelectionRange ?? item.range) === 'name'), 'setData 嵌套成员应导航到原始数据声明');
    const dataObserverPosition = dataPath.positionAt(dataPath.getText().indexOf('items[0].title') + 'items[0].ti'.length);
    const dataObserverItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', dataPath.uri, dataObserverPosition, '.');
    assert.ok(dataObserverItems.items.some((item) => item.label === 'title'), '多字段观察器应补全当前数组元素路径');
    /** 等待原生问题面板收到数据路径诊断，其他提供器的诊断不作为验收证据。 */
    let dataPathDiagnostics = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      dataPathDiagnostics = vscode.languages.getDiagnostics(dataPath.uri).filter((item) => item.code === 'data-path-type');
      if (dataPathDiagnostics.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(dataPathDiagnostics.length, 1, '只有已声明数组成员的不兼容更新应显示数据路径诊断');
    const aliasRename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', dataPath.uri, dataPath.positionAt(dataPath.getText().indexOf('user:') + 1), 'account');
    assert.ok(aliasRename && aliasRename.entries().flatMap(([, edits]) => edits).filter((edit) => edit.newText === 'account').length >= 4, '真实 F2 必须覆盖声明、观察器与 const this 别名的更新和读取');
    const route = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'route.ts')));
    const routePosition = route.positionAt(route.getText().indexOf('/destination') + 4);
    const routeDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', route.uri, routePosition);
    assert.ok(routeDefinitions.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'destination.ts')), '路由字符串应定位到注册页面的源码');
    const routeQueryPosition = route.positionAt(route.getText().indexOf('recordId') + 3);
    const routeQueryItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', route.uri, routeQueryPosition, '?');
    assert.ok(routeQueryItems.items.some((item) => item.label === 'recordId' && item.detail === 'string'), '页面 onLoad 声明应提供 URL 查询参数提示');
    const navigator = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'route.wxml')));
    const navigatorDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', navigator.uri, navigator.positionAt(navigator.getText().indexOf('/destination') + 4));
    assert.ok(navigatorDefinitions.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'destination.ts')), 'navigator 应共享页面源码导航');
    const schemaQueryPosition = route.positionAt(route.getText().lastIndexOf('recordId') + 3);
    const schemaItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', route.uri, schemaQueryPosition, '?');
    const schemaRecord = schemaItems.items.find((item) => item.label === 'recordId' && item.detail === 'string');
    assert.ok(schemaRecord?.documentation?.value.includes('记录编号') && schemaRecord.documentation.value.includes('必填'), '声明式查询参数应显示类型、注释与必填标记');
    const schemaDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', route.uri, schemaQueryPosition);
    assert.ok(schemaDefinitions.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'schema-destination.ts')), 'URL 查询字段应导航到 schema 声明');
    const sharedRouter = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'shared-router.ts')));
    const sharedRoutePosition = sharedRouter.positionAt(sharedRouter.getText().indexOf('./destination') + 4);
    const sharedTargets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', sharedRouter.uri, sharedRoutePosition);
    assert.ok(sharedTargets.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'destination.ts')), '共享组件 pageRouter 应以消费页面作为相对基准');
    const routeConfig = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'app.json')));
    const routeConfigEdit = new vscode.WorkspaceEdit();
    routeConfigEdit.replace(routeConfig.uri, new vscode.Range(routeConfig.positionAt(0), routeConfig.positionAt(routeConfig.getText().length)), '{"pages":["route"]}');
    assert.equal(await vscode.workspace.applyEdit(routeConfigEdit), true);
    const staleRoutes = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', route.uri, routePosition);
    assert.ok(!staleRoutes.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'destination.ts')), '应用配置草稿应使缓存的页面导航失效');
    /** 公开命令返回的源码选择范围必须对应真实名称。 */
    async function definition(symbol, file, name, end = false) {
      const offset = document.getText().lastIndexOf(symbol) + (end ? symbol.length : 1);
      const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, document.positionAt(offset));
      const target = result.find((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, file));
      assert.ok(target, `${symbol} 应定位 ${file}，实际 ${JSON.stringify(result)}`);
      const content = await vscode.workspace.openTextDocument(target.targetUri ?? target.uri);
      assert.equal(content.getText(target.targetSelectionRange ?? target.range), name);
    }
    await definition('format', 'source.wxs', 'format', true);
    await definition('change', 'card.ts', 'change');
    // 编辑器原生引用入口也必须从不同名重导出或 require 实现找到实际模板。
    for (const [filename, template] of [['aliased-handler.ts', 'aliased-card.wxml'], ['aliased-object.ts', 'aliased-object-card.wxml'], ['aliased-core.wxs', 'aliased-view.wxml']]) {
      const implementation = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, filename)));
      const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', implementation.uri, implementation.positionAt(implementation.getText().indexOf('executeNotice') + 2));
      assert.ok(references.some((item) => item.uri.fsPath === path.join(directory, template)), `从 ${filename} 应能查到不同名模板 ${template}`);
    }
    /** 说明命令必须返回真实提供器结果，并区分失败原因及不完整图。 */
    const navigationPosition = document.positionAt(document.getText().indexOf('selectSpeed') + 2);
    const navigationReport = await vscode.commands.executeCommand('miniprogramlab.miniapp.explainNavigation', document.uri, navigationPosition);
    assert.equal(navigationReport.status, 'resolved');
    assert.ok(navigationReport.definitions.some((item) => vscode.Uri.parse(item.uri).fsPath === path.join(directory, 'behavior.ts')));
    assert.ok(navigationReport.providers.some((provider) => provider.steps.some((step) => step.code === 'path' && step.uri?.endsWith('/behavior.ts'))));
    const missingNavigation = await vscode.commands.executeCommand('miniprogramlab.miniapp.explainNavigation', document.uri, document.positionAt(document.getText().indexOf('missingHandler') + 2));
    assert.equal(missingNavigation.status, 'unresolved');
    assert.ok(missingNavigation.providers.some((provider) => provider.steps.some((step) => step.code === 'symbol')));
    const navigationDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'navigation.wxml')));
    for (const [token, code] of [['target', 'dynamic'], ['missing.wxml', 'alias']]) {
      const result = await vscode.commands.executeCommand('miniprogramlab.miniapp.explainNavigation', navigationDocument.uri, navigationDocument.positionAt(navigationDocument.getText().indexOf(token) + 2));
      assert.equal(result.status, 'unresolved');
      assert.ok(result.providers.some((provider) => provider.steps.some((step) => step.code === code)), `说明应包含 ${code}`);
    }
    const navigationSettings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', document.uri);
    const originalBudget = navigationSettings.get('maxScriptFiles');
    try {
      await navigationSettings.update('maxScriptFiles', 1, vscode.ConfigurationTarget.Workspace);
      const limited = await vscode.commands.executeCommand('miniprogramlab.miniapp.explainNavigation', document.uri, navigationPosition);
      assert.equal(limited.status, 'incomplete');
      assert.ok(limited.providers.some((provider) => provider.steps.some((step) => step.code === 'budget')));
    } finally { await navigationSettings.update('maxScriptFiles', originalBudget, vscode.ConfigurationTarget.Workspace); }
    /** 组件元数据须进入原生枚举、悬浮与问题面板，草稿改动即时刷新。 */
    const metadataDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'metadata.wxml')));
    const metadataSettings = vscode.workspace.getConfiguration('miniprogramlab.miniapp.wxml', metadataDocument.uri);
    const originalData = metadataSettings.get('customData'), originalSdk = metadataSettings.get('sdkVersion');
    try {
      const reference = path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, path.join(directory, 'metadata-lib/components.html-data.json')).split(path.sep).join('/');
      await metadataSettings.update('customData', [reference], vscode.ConfigurationTarget.Workspace);
      await metadataSettings.update('sdkVersion', '2.9.0', vscode.ConfigurationTarget.Workspace);
      const metadataPosition = metadataDocument.positionAt(metadataDocument.getText().indexOf('large') + 1);
      const values = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', metadataDocument.uri, metadataPosition);
      assert.ok(values.items.some((item) => item.label === 'large'), '组件库枚举应进入实际补全');
      const metadataHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', metadataDocument.uri, metadataDocument.positionAt(metadataDocument.getText().indexOf('scale') + 1));
      assert.ok(metadataHover.some((item) => item.contents.some((content) => content.value.replace(/\\([\-\.])/g, '$1').includes('generic-ui@2.1.0') && content.value.includes('默认值：small'))), `悬浮应展示来源包及默认值：${JSON.stringify(metadataHover)}`);
      const nativeHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', metadataDocument.uri, metadataDocument.positionAt(metadataDocument.getText().indexOf('bindinput') + 2));
      const nativeDescriptions = nativeHover.flatMap((item) => item.contents.map((content) => content.value));
      assert.ok(nativeDescriptions.some((value) => value.replace(/&nbsp;/g, ' ').includes('value: string')), `原生事件应显示官方 detail 类型：${JSON.stringify(nativeDescriptions)}`);
      let versions = [];
      for (let attempt = 0; attempt < 30; attempt++) { versions = vscode.languages.getDiagnostics(metadataDocument.uri).filter((item) => item.code === 'component-sdk-version'); if (versions.length >= 2) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
      assert.ok(versions.some((item) => item.message.includes('2.10.0')) && versions.some((item) => item.message.includes('2.12.0')), '明确的基础库版本不足应进入问题面板');
      const metadataSource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'metadata-lib/components.html-data.json')));
      const start = metadataSource.getText().indexOf('large');
      const draft = new vscode.WorkspaceEdit(); draft.replace(metadataSource.uri, new vscode.Range(metadataSource.positionAt(start), metadataSource.positionAt(start + 5)), 'larger');
      await vscode.workspace.applyEdit(draft);
      const changedValues = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', metadataDocument.uri, metadataPosition);
      assert.ok(changedValues.items.some((item) => item.label === 'larger') && !changedValues.items.some((item) => item.label === 'large'), '未保存元数据应使枚举缓存失效');
      const invalid = new vscode.WorkspaceEdit(); invalid.replace(metadataSource.uri, new vscode.Range(metadataSource.positionAt(0), metadataSource.positionAt(metadataSource.getText().length)), '{"version":2}');
      await vscode.workspace.applyEdit(invalid);
      let metadataErrors = [];
      for (let attempt = 0; attempt < 30; attempt++) { metadataErrors = vscode.languages.getDiagnostics(metadataDocument.uri).filter((item) => item.code === 'component-metadata-config'); if (metadataErrors.length) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
      assert.ok(metadataErrors.length, '无效元数据应通过问题面板解释失败，原生提示继续可用');
    } finally { await metadataSettings.update('customData', originalData, vscode.ConfigurationTarget.Workspace); await metadataSettings.update('sdkVersion', originalSdk, vscode.ConfigurationTarget.Workspace); }
    /** 未打开文件也必须进入工作区报告与原生问题面板，范围过滤不只过滤展示。 */
    const checkScope = vscode.Uri.file(path.join(directory, 'check-scope'));
    const checkOptions = { include: ['**/*.wxml'], exclude: ['**/skip/**', '**/dist/**'] };
    const checkReport = await vscode.commands.executeCommand('miniprogramlab.miniapp.checkWorkspace', checkScope, checkOptions);
    assert.equal(checkReport.status, 'complete', JSON.stringify(checkReport.issues));
    assert.equal(checkReport.selected, 2); assert.equal(checkReport.checked, 2);
    const badUri = vscode.Uri.file(path.join(directory, 'check-scope/bad.wxml'));
    assert.ok(!vscode.workspace.textDocuments.some((item) => item.uri.toString() === badUri.toString()), '扫描不得为了发布诊断打开全部文件');
    assert.ok(checkReport.findings.some((item) => item.uri === badUri.toString() && item.code === 'unknown-variable' && item.message.includes('missing')), `关闭模板应使用真实名称诊断：${JSON.stringify(checkReport)}`);
    assert.ok(checkReport.findings.some((item) => item.uri === badUri.toString() && item.code === 'template-resource'), '未打开模板的静态资源也必须进入同一检查报告');
    assert.ok(vscode.languages.getDiagnostics(badUri).some((item) => item.source.includes('工作区检查')), '未打开文件应出现在原生问题面板');
    const onlyErrors = await vscode.commands.executeCommand('miniprogramlab.miniapp.filterCheckResults', { severities: ['error'] });
    assert.ok(onlyErrors.findings.every((item) => item.severity === 'error'));
    const warnings = await vscode.commands.executeCommand('miniprogramlab.miniapp.filterCheckResults', { severities: [], file: 'bad.wxml' });
    assert.ok(warnings.findings.length && warnings.findings.every((item) => item.uri.endsWith('/bad.wxml')));
    const reportTarget = vscode.Uri.file(path.join(directory, 'check-report.json'));
    await vscode.commands.executeCommand('miniprogramlab.miniapp.exportCheckReport', reportTarget);
    const exported = JSON.parse(await fs.readFile(reportTarget.fsPath, 'utf8'));
    assert.equal(exported.status, 'complete'); assert.equal(exported.stale, false); assert.equal(exported.checked, 2); assert.ok(exported.findings.length);
    assert.ok(!('dependencies' in exported), '导出不得包含内部修订或源码快照');
    const markdownTarget = vscode.Uri.file(path.join(directory, 'check-report.md'));
    await vscode.commands.executeCommand('miniprogramlab.miniapp.exportCheckReport', markdownTarget);
    assert.match(await fs.readFile(markdownTarget.fsPath, 'utf8'), /miniapp 工作区检查/);
    const checkedSource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'check-scope/bad.ts')));
    const changedSource = new vscode.WorkspaceEdit(); changedSource.insert(checkedSource.uri, new vscode.Position(0, 0), '// 修改已检查依赖\n');
    await vscode.workspace.applyEdit(changedSource);
    await vscode.commands.executeCommand('miniprogramlab.miniapp.exportCheckReport', reportTarget);
    assert.equal(JSON.parse(await fs.readFile(reportTarget.fsPath, 'utf8')).stale, true, '依赖变动后导出应明确标记旧快照');
    assert.ok(!vscode.languages.getDiagnostics(badUri).some((item) => item.source.includes('工作区检查')), '过期关闭文件结果不能继续作为实时问题显示');
    const partial = await vscode.commands.executeCommand('miniprogramlab.miniapp.checkWorkspace', checkScope, { ...checkOptions, maxFiles: 1 });
    assert.equal(partial.status, 'incomplete'); assert.equal(partial.checked, 1);
    const overlapping = await vscode.commands.executeCommand('miniprogramlab.miniapp.checkWorkspace', checkScope, { ...checkOptions, include: ['**/*.wxml', '**/*.{wxml,ts}'], maxFiles: 2 });
    assert.equal(overlapping.status, 'incomplete'); assert.equal(overlapping.selected, 3);
    await vscode.commands.executeCommand('miniprogramlab.miniapp.checkWorkspace', checkScope, checkOptions);
    assert.ok(vscode.languages.getDiagnostics(badUri).some((item) => item.source.includes('工作区检查')));
    await fs.writeFile(path.join(directory, 'check-scope/new.wxml'), '<view/>');
    for (let attempt = 0; attempt < 30 && vscode.languages.getDiagnostics(badUri).some((item) => item.source.includes('工作区检查')); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!vscode.languages.getDiagnostics(badUri).some((item) => item.source.includes('工作区检查')), '新增源码后发现范围快照必须失效');
    const cancelledJob = vscode.commands.executeCommand('miniprogramlab.miniapp.checkWorkspace', checkScope, checkOptions);
    for (let attempt = 0; attempt < 20; attempt++) { if (await vscode.commands.executeCommand('miniprogramlab.miniapp.cancelWorkspaceCheck')) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    const cancelled = await cancelledJob;
    assert.equal(cancelled.status, 'cancelled');
    const member = document.positionAt(document.getText().lastIndexOf('format') + 2);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, member, '.');
    assert.ok(completions.items.some((item) => item.label === 'format'));
    const wxs = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'utils.wxs')));
    assert.equal(wxs.languageId, 'wxs', 'WXS 文件应激活独立脚本语义');
    const wxsHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, member);
    assert.ok(wxsHover.some((item) => item.contents.some((content) => content.value.includes('格式化文字'))));
    /** 原生参数提示、内联坐标及跨模块草稿刷新共同验收 WXS 新能力。 */
    const callTemplate = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'wxs-calls.wxml')));
    const templateHelp = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', callTemplate.uri, callTemplate.positionAt(callTemplate.getText().indexOf('utils.format(') + 'utils.format('.length));
    assert.match(templateHelp.signatures[0].label, /amount: number/);
    assert.ok(templateHelp.signatures[0].documentation.value.includes('格式化金额'));
    const callFile = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'wxs-calls.wxs')));
    const fileHelp = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', callFile.uri, callFile.positionAt(callFile.getText().indexOf('tools.format(1,') + 'tools.format(1,'.length));
    assert.equal(fileHelp.activeParameter, 1);
    let callProblems = [];
    for (let attempt = 0; attempt < 30; attempt++) { callProblems = vscode.languages.getDiagnostics(callTemplate.uri); if (callProblems.some((item) => item.code === 'wxs-call-type') && callProblems.some((item) => item.code === 'wxs-syntax')) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.ok(callProblems.some((item) => item.code === 'wxs-call-type'), JSON.stringify(callProblems));
    const syntaxProblem = callProblems.find((item) => item.code === 'wxs-syntax');
    assert.ok(syntaxProblem && callTemplate.offsetAt(syntaxProblem.range.start) > callTemplate.getText().indexOf('var broken'));
    for (let attempt = 0; attempt < 30 && !vscode.languages.getDiagnostics(callFile.uri).some((item) => item.code === 'wxs-api'); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(vscode.languages.getDiagnostics(callFile.uri).some((item) => item.code === 'wxs-api'));
    const typedSource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'typed-source.wxs')));
    const updatedType = new vscode.WorkspaceEdit();
    const typeStart = typedSource.getText().indexOf('number');
    updatedType.replace(typedSource.uri, new vscode.Range(typedSource.positionAt(typeStart), typedSource.positionAt(typeStart + 'number'.length)), 'string');
    await vscode.workspace.applyEdit(updatedType);
    for (let attempt = 0; attempt < 30 && vscode.languages.getDiagnostics(callTemplate.uri).some((item) => item.code === 'wxs-call-type'); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!vscode.languages.getDiagnostics(callTemplate.uri).some((item) => item.code === 'wxs-call-type'), 'WXS 依赖草稿的类型变化应刷新模板问题');
    const changedHelp = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', callTemplate.uri, callTemplate.positionAt(callTemplate.getText().indexOf('utils.format(') + 'utils.format('.length));
    assert.match(changedHelp.signatures[0].label, /amount: string/);
    const shadowTemplate = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'wxs-shadow.wxml')));
    const shadowHelp = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', shadowTemplate.uri, shadowTemplate.positionAt(shadowTemplate.getText().indexOf('utils.format(') + 'utils.format('.length));
    assert.match(shadowHelp.signatures[0].label, /value: any/, '重复模块名的原生提示使用后声明的实现');
    const wrapped = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'wrapped.wxml')));
    const macro = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', wrapped.uri, wrapped.positionAt(wrapped.getText().indexOf('submit') + 1));
    assert.ok(macro.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'wrapped.ts')), '不同名包装器应跳转到消费页面的真实方法');
    const highlights = await vscode.commands.executeCommand('vscode.executeDocumentHighlights', wrapped.uri, wrapped.positionAt(wrapped.getText().indexOf('submit') + 1));
    assert.equal(highlights.length, 1, '模板本地高亮应使用真实方法身份');
    const registration = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'register.wxml')));
    const tag = registration.positionAt(3);
    const registerActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', registration.uri, new vscode.Range(tag, tag));
    const register = registerActions.find((item) => item.title.startsWith('注册 notice-widget'));
    assert.ok(register?.edit, '未注册标签应返回包含配置创建的原生编辑');
    assert.equal(await vscode.workspace.applyEdit(register.edit), true);
    const config = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'register.json')));
    assert.equal(JSON.parse(config.getText()).usingComponents['notice-widget'], './notice-widget');
    const requiredActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', registration.uri, new vscode.Range(tag, tag));
    const required = requiredActions.find((item) => item.title === '补充组件必填参数');
    assert.ok(required?.edit);
    await vscode.workspace.applyEdit(required.edit);
    assert.match(registration.getText(), /count="\{\{0\}\}"/);
    const dataset = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'dataset.ts')));
    const datasetPosition = dataset.positionAt(dataset.getText().lastIndexOf('dataset.userId') + 'dataset.user'.length);
    const datasetItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', dataset.uri, datasetPosition, '.');
    assert.ok(datasetItems.items.some((item) => item.label === 'userId'), 'dataset 字段应来自事件绑定节点');
    const datasetTargets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', dataset.uri, datasetPosition);
    assert.ok(datasetTargets.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'dataset.wxml')), 'dataset 应导航到模板属性');
    const datasetRefs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', dataset.uri, datasetPosition);
    assert.ok(datasetRefs.some((item) => item.uri.fsPath === path.join(directory, 'dataset.wxml')), 'dataset 引用必须包含节点声明');
    const datasetRename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', dataset.uri, datasetPosition, 'accountId');
    assert.ok(datasetRename?.entries().some(([uri]) => uri.fsPath === path.join(directory, 'dataset.wxml')), 'dataset F2 必须联动模板');
    assert.equal(await vscode.workspace.applyEdit(datasetRename), true);
    assert.match(dataset.getText(), /\{accountId: userId\}/);
    const datasetTemplate = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'dataset.wxml')));
    assert.match(datasetTemplate.getText(), /data-account-id/);
    const instance = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'instance.ts')));
    const instanceMethod = instance.positionAt(instance.getText().indexOf('panel.show') + 'panel.show'.length);
    const instanceCompletion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', instance.uri, instanceMethod, '.');
    assert.ok(instanceCompletion.items.some((item) => item.label === 'show' && item.detail?.includes('number')), '实例补全应显示公开参数和返回值');
    const instanceDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', instance.uri, instanceMethod);
    assert.ok(instanceDefinitions.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'instance-panel.ts')), '实例方法应导航到组件实现');
    const selectorDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', instance.uri, instance.positionAt(instance.getText().indexOf('#panel') + 2));
    assert.ok(selectorDefinitions.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'instance.wxml')), '实例选择器应定位模板节点');
    const signaturePosition = instance.positionAt(instance.getText().indexOf('show?.(2') + 'show?.('.length);
    const signature = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', instance.uri, signaturePosition, '(');
    assert.ok(signature?.signatures.some((item) => item.label.includes('show(count: number): string')), '实例调用应显示原生参数提示');
    const instancePanel = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'instance-panel.ts')));
    const methodAt = instancePanel.getText().indexOf('show(');
    const instanceReferences = await vscode.commands.executeCommand('vscode.executeReferenceProvider', instancePanel.uri, instancePanel.positionAt(methodAt + 1));
    assert.ok(instanceReferences.some((item) => item.uri.fsPath === instance.uri.fsPath && instance.getText(item.range) === 'show'), '真实引用查询必须包含 selectComponent 实例调用');
    const instanceRename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', instance.uri, instanceMethod, 'openPanel');
    assert.ok(instanceRename && instanceRename.entries().some(([uri, edits]) => uri.fsPath === instance.uri.fsPath && edits.some((edit) => edit.newText === 'openPanel')));
    assert.ok(instanceRename.entries().some(([uri, edits]) => uri.fsPath === instancePanel.uri.fsPath && edits.some((edit) => edit.newText === 'openPanel')), '从实例使用处 F2 必须包含组件声明');
    assert.equal(await vscode.workspace.applyEdit(instanceRename), true);
    assert.match(instance.getText(), /panel.openPanel/); assert.match(instancePanel.getText(), /openPanel\(count/);
    await vscode.window.showTextDocument(instance, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(instance.getText(), files['instance.ts']); assert.equal(instancePanel.getText(), files['instance-panel.ts'], '一次撤销必须恢复实例调用和声明');
    const changeInstance = new vscode.WorkspaceEdit();
    changeInstance.replace(instancePanel.uri, new vscode.Range(instancePanel.positionAt(methodAt), instancePanel.positionAt(methodAt + 4)), 'hide');
    await vscode.workspace.applyEdit(changeInstance);
    const changedInstance = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', instance.uri, instanceMethod);
    assert.ok(!changedInstance.some((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, 'instance-panel.ts')), '组件草稿变化必须使实例语义缓存失效');
    const field = document.positionAt(document.getText().indexOf('nmae') + 1);
    const fields = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, field, '.');
    assert.ok(fields.items.some((item) => item.label === 'name'), '普通模板成员应提供类型补全');
    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, document.positionAt(document.getText().indexOf('selectSpeed') + 1));
    assert.ok(refs.some((item) => item.uri.fsPath === path.join(directory, 'behavior.ts')), '原生引用命令必须包含 Behavior');
    assert.ok(refs.some((item) => item.uri.toString() === document.uri.toString()), '原生引用命令必须包含模板');
    const fixes = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(field, field));
    const spelling = fixes.find((item) => item.title === '改为 name');
    assert.ok(spelling?.edit, '拼写修复应提供原生工作区编辑');
    await vscode.workspace.applyEdit(spelling.edit);
    const missing = document.positionAt(document.getText().indexOf('missingHandler') + 1);
    const handlers = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(missing, missing));
    const create = handlers.find((item) => item.title === '创建事件处理方法 missingHandler');
    assert.ok(create?.edit, '缺失处理方法应提供跨文件灯泡修复');
    await vscode.workspace.applyEdit(create.edit);
    const createdPage = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'page.ts')));
    assert.match(createdPage.getText(), /missingHandler\(_event: unknown\)/);

    // 重命名先检查返回编辑，再应用到临时草稿，声明及两个语言的引用都必须同步。
    const position = document.positionAt(document.getText().indexOf('selectSpeed') + 'selectSpeed'.length);
    const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, 'chooseSpeed');
    assert.ok(edit && edit.size >= 2, '原生重命名命令应返回跨文件工作区编辑');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    assert.match(document.getText(), /chooseSpeed/);
    const behavior = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'behavior.ts')));
    assert.match(behavior.getText(), /chooseSpeed\(\).*this.chooseSpeed/s);
    // 从 TS 方法起点反向验证模板联动，不能只覆盖 WXML 起点。
    const fromScript = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', behavior.uri, behavior.positionAt(behavior.getText().indexOf('chooseSpeed') + 1), 'selectSpeed');
    assert.ok(fromScript.entries().some(([uri]) => uri.toString() === document.uri.toString()), 'TS 起点必须包含 WXML 编辑');

    // 事件诊断异步更新；在真实宿主等待明确结果，而不是只检查提供器注册。
    let diagnostics = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      diagnostics = vscode.languages.getDiagnostics(document.uri).filter((item) => item.message.includes('detail'));
      if (diagnostics.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(diagnostics.some((item) => item.message.includes('不兼容')), '事件 detail 参数不兼容应显示诊断');
    const page = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'page.ts')));
    const oldType = page.getText().indexOf('value:string');
    const fix = new vscode.WorkspaceEdit();
    fix.replace(page.uri, new vscode.Range(page.positionAt(oldType), page.positionAt(oldType + 'value:string'.length)), 'value:number');
    await vscode.workspace.applyEdit(fix);
    // 脚本依赖草稿变化应主动刷新模板诊断，无需修改或保存 WXML。
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!vscode.languages.getDiagnostics(document.uri).some((item) => item.message.includes('不兼容'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(!vscode.languages.getDiagnostics(document.uri).some((item) => item.message.includes('不兼容')));
    console.log('语义宿主验证通过：模板补全、引用与灯泡、dataset、组件实例、页面路由、声明式查询参数、共享组件相对路由、数据更新与观察路径、WXS及未保存草稿。');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};
