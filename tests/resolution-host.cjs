const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 在真实编辑器宿主验证配置驱动的组件、文件、函数和样式跳转。 */
exports.run = async function run() {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const directory = await fs.mkdtemp(path.join(workspace, '.resolution-'));
  const files = {
    'package.json': '{}',
    'webpack.config.js': "const Copy=require('copy-webpack-plugin');module.exports={output:{path:'dist'},resolve:{alias:{'@logic':'domain','@theme':'styles'}},plugins:[new Copy([{from:'vendor/widgets',to:'external/ui'}])]}",
    'src/app.json': '{}',
    'src/page.json': '{"usingComponents":{"ui-popup":"/external/ui/popup/index"}}',
    'src/page.wxml': '<ui-popup round="true"/><import src="@theme/card.wxml"/><van-action-sheet bindselect="selectSpeed"/>',
    'src/page.ts': "import {run} from '@logic/model';import {build as local} from '@logic/behaviors';run();Component({behaviors:[local()]});",
    'src/page.scss': '@use "@theme/palette" as ui;view{color:ui.$brand}',
    'domain/model.ts': 'export function run(){return 1}',
    'domain/behaviors.ts': "export {create as build} from './factory';",
    'domain/factory.ts': "import nested from './nested';export function create(){return Behavior({behaviors:[nested]})}",
    'domain/nested.ts': "import {SpeedBehavior} from './speed';export default Behavior({behaviors:[SpeedBehavior]})",
    'domain/speed.ts': 'export const SpeedBehavior=Behavior({methods:{/** 选择倍速 */ selectSpeed(){}}})',
    'styles/_palette.scss': '$brand:red;',
    'styles/card.wxml': '<template name="card"/>',
    'vendor/widgets/popup/index.js': 'Component({properties:{round:Boolean}})',
  };
  try {
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, file), text);
    }
    /** 通过公开命令查询，兼顾方法内部及完整选中后的末尾位置。 */
    async function definition(file, token, expected, selection = '', atEnd = false) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, file)));
      const offset = document.getText().lastIndexOf(token);
      assert.ok(offset >= 0);
      const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, document.positionAt(offset + (atEnd ? token.length : 1)));
      const target = locations.find((item) => (item.targetUri ?? item.uri).fsPath === path.join(directory, expected));
      assert.ok(target, `${file} 中 ${token} 应跳转到 ${expected}，实际：${JSON.stringify(locations)}`);
      const content = await vscode.workspace.openTextDocument(target.targetUri ?? target.uri);
      assert.equal(content.getText(target.targetSelectionRange ?? target.range), selection);
    }
    await definition('src/page.wxml', 'round', 'vendor/widgets/popup/index.js', 'round');
    await definition('src/page.json', '/external/ui/popup/index', 'vendor/widgets/popup/index.js');
    await definition('src/page.wxml', '@theme/card.wxml', 'styles/card.wxml');
    await definition('src/page.ts', 'run', 'domain/model.ts', 'run');
    // 方法内部与完整选中后的 F12 均穿过三层 Behavior、工厂和重导出。
    for (const atEnd of [false, true]) await definition('src/page.wxml', 'selectSpeed', 'domain/speed.ts', 'selectSpeed', atEnd);
    await definition('src/page.scss', '$brand', 'styles/_palette.scss', '$brand');
    assert.equal(await fs.stat(path.join(directory, 'dist')).catch(() => undefined), undefined);
    console.log('智能解析宿主验证通过：组件参数、配置、函数及样式导航正常，完整选中的事件方法可穿透多层 Behavior、工厂和重导出。');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};
