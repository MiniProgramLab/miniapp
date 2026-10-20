import assert from 'node:assert/strict';
import test from 'node:test';
import type { Definition, FileReferenceKind, LanguageFeatures, LanguageRequest, WorkspaceReader } from '../src/api';
import { createFileNavigationPlugin, createProjectFileResolver } from '../src/resolution';
import { createComponentScriptResolver, createScriptNavigationPlugin, createScriptResolver } from '../src/languages/typescript';
import { createComponentResolver, createWxmlPlugin } from '../src/languages/wxml';
import { createCssModule } from '../src/languages/css';
import { buildConfigSource, inspectBuildConfig } from '../src/resolution/config';

/** 为真实提供器建立多种项目结构，所有文件均保留可检查的原始位置。 */
function fixture(files: Record<string, string>, entry = 'src/pages/index.wxml') {
  const root = 'file:///workspace/';
  const documents = new Map(Object.entries({ 'package.json': '{}', 'src/app.json': '{}', ...files }).map(([file, text]) => [new URL(file, root).href, text.replace('|', '')]));
  const reads: string[] = [];
  const raw: WorkspaceReader = {
    root: () => root,
    read: async (uri) => { reads.push(uri); const text = documents.get(uri); return text === undefined ? undefined : { text, version: 7 }; },
    /** 仅枚举声明的工作区模式，避免通过同名包借用无关项目。 */
    findFiles: async (_uri, pattern, limit) => {
      const expression = new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      return [...documents.keys()].filter((uri) => expression.test(uri.slice(root.length))).slice(0, limit);
    },
  };
  const reader: WorkspaceReader = { ...raw, fileResolver: (uri, cancellation) => createProjectFileResolver(raw, uri, cancellation) };
  const text = files[entry] ?? '';
  const request: LanguageRequest = { document: { uri: new URL(entry, root).href, text: text.replace('|', ''), languageId: entry.endsWith('.wxml') ? 'wxml' : entry.endsWith('.json') ? 'json' : entry.split('.').pop()!, version: 1 }, offset: text.indexOf('|'), cancellation: { isCancellationRequested: false } };
  /** 构建内置语言模块，通过统一端口执行完整源码导航。 */
  const features = (type: 'component' | 'style' | 'script' | 'file'): LanguageFeatures => {
    const plugin = type === 'component' ? createWxmlPlugin(undefined, createScriptResolver(reader), undefined, createComponentResolver(reader, (snapshot) => createComponentScriptResolver(snapshot)), reader) : type === 'style' ? createCssModule(reader).plugin : type === 'script' ? createScriptNavigationPlugin(reader) : createFileNavigationPlugin(reader);
    return plugin.setup({ logger: { info() {}, error() {} }, subscriptions: { add: (resource) => resource } });
  };
  /** 同时核对真实文件与声明选择区，不只验证内部候选列表。 */
  const definitions = async (type: 'component' | 'style' | 'script' | 'file') => (await features(type).definition!.provide(request)).map((definition: Definition) => ({ file: definition.uri.slice(root.length), text: documents.get(definition.uri)?.slice(definition.range.start, definition.range.end) }));
  const candidates = (reference: string, kind: FileReferenceKind = 'component') => reader.fileResolver!(request.document.uri, request.cancellation).candidates(reference, request.document.uri, kind);
  return { reader, documents, reads, request, definitions, candidates };
}

/** 自定义复制目的地与源码位置不同，用于防止退回目录名称猜测。 */
const copiedComponent = {
  'src/pages/index.json': '{"usingComponents":{"ui-popup":"/external/ui/popup/index"}}',
  'src/pages/index.wxml': '<ui-popup ro|und="true"/>',
  'vendor/widgets/popup/index.js': 'Component({properties:{round:Boolean}})',
};

test('Webpack 自定义复制目录无需 dist 即可定位组件参数', async () => {
  const graph = fixture({ ...copiedComponent, 'webpack.config.js': `const path=require('path');const Copy=require('copy-webpack-plugin');module.exports={output:{path:path.resolve(__dirname,'output')},plugins:[new Copy({patterns:[{from:'vendor/widgets',to:'external/ui'}]})]}` });
  assert.deepEqual(await graph.definitions('component'), [{ file: 'vendor/widgets/popup/index.js', text: 'round' }]);
  assert.ok(!graph.documents.has('file:///workspace/output/external/ui/popup/index.js'));
});

test('旧版 CopyPlugin 的 context、路径辅助函数与 glob 保留输出层级', async () => {
  const graph = fixture({ 'src/pages/index.wxml': '<ui-po|pup/>', 'src/pages/index.json': '{"usingComponents":{"ui-popup":"/libs/widgets/popup/index"}}', 'libs/widgets/popup/index.js': 'Component({})', 'webpack/webpack.config.js': `const path=require('path'); const Copy=require('copy-webpack-plugin'); const relative=p=>path.join(__dirname,'../',p); module.exports={context:relative('.'), output:{path:relative('dist')}, plugins:[new Copy([{from:relative('./libs')+'/**/*.@(js|wxml)',to:relative('./dist')}])].filter(Boolean)}` });
  assert.deepEqual(await graph.definitions('component'), [{ file: 'libs/widgets/popup/index.js', text: 'Component' }]);
});

test('源码映射优先于过期构建产物，并穿透组件继承和导入', async () => {
  const graph = fixture({ ...copiedComponent, 'vendor/widgets/popup/index.js': `const {shared}=require('./shared');Component({behaviors:[shared]})`, 'vendor/widgets/popup/shared.js': `exports.shared=Behavior({properties:{round:Boolean}})`, 'dist/external/ui/popup/index.js': 'Component({properties:{round:Number}})', 'webpack.config.js': `const Copy=require('copy-webpack-plugin');module.exports={output:{path:'dist'},plugins:[new Copy([{from:'vendor/widgets',to:'external/ui'}])]}` });
  assert.deepEqual(await graph.definitions('component'), [{ file: 'vendor/widgets/popup/shared.js', text: 'round' }]);
});

test('组件注册 JSON 可以直接跳到复制后的原始组件文件', async () => {
  const graph = fixture({ ...copiedComponent, 'src/pages/index.json': '{"usingComponents":{"ui-popup":"/external/ui/popu|p/index"}}', 'webpack.config.js': `const Copy=require('copy-webpack-plugin');module.exports={output:{path:'dist'},plugins:[new Copy([{from:'vendor/widgets',to:'external/ui'}])]}` }, 'src/pages/index.json');
  assert.deepEqual(await graph.definitions('file'), [{ file: 'vendor/widgets/popup/index.js', text: '' }]);
});

test('Vite 配置工厂、fileURLToPath 和数组别名可以导航函数及导入文件', async () => {
  const files = { 'vite.config.ts': `import {defineConfig} from 'vite';import {fileURLToPath} from 'node:url';export default defineConfig(()=>({resolve:{alias:[{find:'@logic',replacement:fileURLToPath(new URL('./domain',import.meta.url))}]}}))`, 'domain/model.ts': 'export function fetchTitle(){return "标题"}', 'src/pages/index.ts': `import {fetchTitle} from '@logic/model';fetchTi|tle();` };
  assert.deepEqual(await fixture(files, 'src/pages/index.ts').definitions('script'), [{ file: 'domain/model.ts', text: 'fetchTitle' }]);
  assert.deepEqual(await fixture({ ...files, 'src/pages/index.ts': `import {fetchTitle} from '@logic/mo|del';` }, 'src/pages/index.ts').definitions('script'), [{ file: 'domain/model.ts', text: '' }]);
});

test('本地共享配置、对象展开和 merge 不丢失别名或复制规则', async () => {
  const graph = fixture({ ...copiedComponent, 'webpack.config.js': `import common from './build/common';import {merge} from 'webpack-merge';export default merge(common,{mode:'development'})`, 'build/common.js': `const path=require('path');const Copy=require('copy-webpack-plugin'); const aliases={'@domain':path.resolve(__dirname,'../domain')}; module.exports={resolve:{alias:{...aliases}},output:{path:path.resolve(__dirname,'../dist')},plugins:[new Copy([{from:'vendor/widgets',to:'external/ui'}])]}` });
  assert.deepEqual(await graph.definitions('component'), [{ file: 'vendor/widgets/popup/index.js', text: 'round' }]);
  assert.ok((await graph.candidates('@domain/model', 'script')).includes('file:///workspace/domain/model'));
});

test('Webpack 精确别名与最长别名前缀不会命中相似名称', async () => {
  const graph = fixture({ 'webpack.config.js': `module.exports={resolve:{alias:{'entry$':'src/single.ts','@':'src','@ui':'packages/ui'}}}` });
  assert.ok((await graph.candidates('entry', 'script')).includes('file:///workspace/src/single.ts'));
  assert.deepEqual(await graph.candidates('entry/child', 'script'), []);
  assert.ok((await graph.candidates('@ui/button', 'script')).includes('file:///workspace/packages/ui/button'));
  assert.deepEqual(await graph.candidates('@uix/button', 'script'), []);
});

test('tsconfig 的 extends、baseUrl 和 paths 也能用于样式导航', async () => {
  const graph = fixture({ 'tsconfig.json': '{"extends":"./configs/base.json"}', 'configs/base.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@theme/*":["theme/*"]}}}', 'src/pages/index.scss': '@use "@theme/palette" as ui; view{color:ui.$br|and}', 'theme/_palette.scss': '$brand:red;' }, 'src/pages/index.scss');
  assert.deepEqual(await graph.definitions('style'), [{ file: 'theme/_palette.scss', text: '$brand' }]);
});

test('微信源码根和编译输出扩展名映射还原 TS 与 SCSS', async () => {
  const files = { 'project.config.json': '{"miniprogramRoot":"dist/","srcMiniprogramRoot":"source/"}', 'source/theme.scss': '$brand:red;', 'source/model.ts': 'export function render(){return 1}', 'src/pages/index.scss': '@import "../../dist/theme.wxss";view{color:$br|and}', 'src/pages/index.ts': `import {render} from '../../dist/model.js';ren|der()` };
  assert.deepEqual(await fixture(files, 'src/pages/index.scss').definitions('style'), [{ file: 'source/theme.scss', text: '$brand' }]);
  assert.deepEqual(await fixture(files, 'src/pages/index.ts').definitions('script'), [{ file: 'source/model.ts', text: 'render' }]);
});

test('Vite Sass 搜索目录与 npm sass 入口沿原始文件解析', async () => {
  const files = { 'vite.config.ts': `export default {css:{preprocessorOptions:{scss:{loadPaths:['tokens']}}}}`, 'tokens/_theme.scss': '$brand:red;', 'node_modules/@kit/styles/package.json': '{"sass":"main.scss"}', 'node_modules/@kit/styles/main.scss': '$brand:blue;', 'src/pages/index.scss': '@use "theme" as ui;view{color:ui.$br|and}' };
  assert.deepEqual(await fixture(files, 'src/pages/index.scss').definitions('style'), [{ file: 'tokens/_theme.scss', text: '$brand' }]);
  assert.deepEqual(await fixture({ ...files, 'src/pages/index.scss': '@use "~@kit/styles" as ui;view{color:ui.$br|and}' }, 'src/pages/index.scss').definitions('style'), [{ file: 'node_modules/@kit/styles/main.scss', text: '$brand' }]);
});

test('npm miniprogram 与包 exports 子路径支持真实组件实现', async () => {
  const files = { 'src/pages/index.wxml': '<ui-ca|rd/>', 'src/pages/index.json': '{"usingComponents":{"ui-card":"@kit/ui/card/index"}}', 'node_modules/@kit/ui/package.json': '{"miniprogram":"mini"}', 'node_modules/@kit/ui/mini/card/index.js': 'Component({})' };
  assert.deepEqual(await fixture(files).definitions('component'), [{ file: 'node_modules/@kit/ui/mini/card/index.js', text: 'Component' }]);
  const exported = { ...files, 'src/pages/index.json': '{"usingComponents":{"ui-card":"@kit/ui/card"}}', 'node_modules/@kit/ui/package.json': '{"exports":{"./*":{"import":"./mini/*/index.js"}}}' };
  assert.deepEqual(await fixture(exported).definitions('component'), [{ file: 'node_modules/@kit/ui/mini/card/index.js', text: 'Component' }]);
});

test('未链接的 monorepo 包仅从声明的工作区发现源码入口', async () => {
  const graph = fixture({ 'package.json': '{"workspaces":["packages/*"]}', 'packages/tools/package.json': '{"name":"@repo/tools","source":"src/index.ts"}', 'packages/tools/src/index.ts': 'export function calculate(){return 1}', 'src/pages/index.ts': `import {calculate} from '@repo/tools';calc|ulate()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'packages/tools/src/index.ts', text: 'calculate' }]);
});

test('Taro copy.patterns 和 Rollup 输出目录使用不同规则正确还原', async () => {
  const graph = fixture({ ...copiedComponent, 'config/index.ts': `export default {sourceRoot:'src',outputRoot:'build',copy:{patterns:[{from:'vendor/widgets',to:'build/external/ui'}]}}` });
  assert.deepEqual(await graph.definitions('component'), [{ file: 'vendor/widgets/popup/index.js', text: 'round' }]);
  const rollup = fixture({ 'rollup.config.mjs': `export default {output:{dir:'release'},alias:{'@logic':'domain'}}`, 'domain/model.ts': 'export function render(){return 1}', 'src/pages/index.ts': `import {render} from '@logic/model';ren|der()` }, 'src/pages/index.ts');
  assert.deepEqual(await rollup.definitions('script'), [{ file: 'domain/model.ts', text: 'render' }]);
});

test('单文件 source map 指向原始函数，多源 bundle 不冒选第一个来源', async () => {
  const files = { 'webpack.config.js': `module.exports={output:{path:'dist'}}`, 'dist/internal/model.js.map': '{"sources":["../../domain/model.ts"]}', 'domain/model.ts': 'export function render(){return 1}', 'src/pages/index.ts': `import {render} from '../../dist/internal/model.js';ren|der()` };
  assert.deepEqual(await fixture(files, 'src/pages/index.ts').definitions('script'), [{ file: 'domain/model.ts', text: 'render' }]);
  const graph = fixture({ ...files, 'dist/internal/model.js.map': '{"sources":["../../domain/model.ts","../../domain/other.ts"]}' }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), []);
});

test('复制单个文件并重命名可以从编译路径回到源码', async () => {
  const graph = fixture({ 'webpack.config.js': `const Copy=require('copy-webpack-plugin');module.exports={output:{path:'dist'},plugins:[new Copy([{from:'scripts/runtime.js',to:'assets/engine.js'}])]}`, 'scripts/runtime.js': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '../../dist/assets/engine.js';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'scripts/runtime.js', text: 'run' }]);
});

test('配置草稿、损坏配置、未知动态调用与循环导入都不执行项目代码', async () => {
  const graph = fixture({ 'webpack.config.js': `require('fs').writeFileSync('/unwanted','bad');module.exports={resolve:{alias:{'@logic':unknown()}}}` });
  assert.deepEqual(await graph.candidates('@logic/model', 'script'), []);
  graph.documents.set('file:///workspace/webpack.config.js', `module.exports={resolve:{alias:{'@logic':'domain'}}}`);
  assert.ok((await graph.candidates('@logic/model', 'script')).includes('file:///workspace/domain/model'));
  graph.documents.set('file:///workspace/webpack.config.js', `const common=require('./build/common');module.exports=common`);
  graph.documents.set('file:///workspace/build/common.js', `const root=require('../webpack.config');module.exports=root`);
  assert.deepEqual(await graph.candidates('@logic/model', 'script'), []);
  assert.ok(graph.reads.length < 256);
});

test('普通 TS 定义不会重复交付，取消的查询不读取配置或文件', async () => {
  const graph = fixture({ 'src/pages/index.ts': `import {run} from './model';ru|n()`, 'src/pages/model.ts': 'export function run(){return 1}' }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), []);
  graph.reads.length = 0;
  Object.assign(graph.request.cancellation, { isCancellationRequested: true });
  assert.deepEqual(await graph.candidates('@logic/model', 'script'), []);
  assert.deepEqual(await graph.definitions('script'), []);
  assert.deepEqual(graph.reads, []);
});

test('模板 import、include 和 WXS 静态路径直接跳到映射文件', async () => {
  const files = { 'vite.config.ts': `export default {resolve:{alias:{'@templates':'templates'}}}`, 'templates/card.wxml': '<template name="card"/>', 'templates/tools.wxs': 'module.exports={};', 'src/pages/index.wxml': '<import src="@templates/ca|rd.wxml" />' };
  assert.deepEqual(await fixture(files).definitions('component'), [{ file: 'templates/card.wxml', text: '' }]);
  assert.deepEqual(await fixture({ ...files, 'src/pages/index.wxml': '<include src="@templates/ca|rd.wxml" />' }).definitions('component'), [{ file: 'templates/card.wxml', text: '' }]);
  assert.deepEqual(await fixture({ ...files, 'src/pages/index.wxml': '<wxs module="tools" src="@templates/to|ols.wxs" />' }).definitions('component'), [{ file: 'templates/tools.wxs', text: '' }]);
  assert.deepEqual(await fixture({ ...files, 'src/pages/index.wxml': '<include src="{{pa|th}}" />' }).definitions('component'), []);
});

test('合并配置保留公共别名，新别名覆盖同名旧目标', async () => {
  const graph = fixture({ 'webpack.config.js': `const {merge}=require('webpack-merge');module.exports=merge({resolve:{alias:{'@base':'common','@logic':'wrong'}}},{resolve:{alias:{'@logic':'domain'}}})`, 'domain/model.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '@logic/model';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'domain/model.ts', text: 'run' }]);
  assert.ok((await graph.candidates('@base/index', 'script')).includes('file:///workspace/common/index'));
});

test('配置工厂的局部路径常量不会借用其他函数的同名值', async () => {
  const graph = fixture({ 'vite.config.ts': `import {defineConfig} from 'vite';function unused(){const root='wrong';return root}export default defineConfig(()=>{const root='domain';return {resolve:{alias:{'@logic':root}}}})`, 'domain/model.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '@logic/model';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'domain/model.ts', text: 'run' }]);
});

test('Vite 的 root 和简单正则前缀别名按实际源码目录解析', async () => {
  const graph = fixture({ 'vite.config.ts': String.raw`import path from 'node:path';export default {root:'client',resolve:{alias:[{find:/^@\//,replacement:path.resolve(__dirname,'client/domain')+'/' }]}}`, 'client/domain/model.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '@/model';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'client/domain/model.ts', text: 'run' }]);
});

test('Webpack 嵌套 sass-loader 搜索目录支持 partial 和声明导航', async () => {
  const graph = fixture({ 'webpack.config.js': `module.exports={module:{rules:[{oneOf:[{use:[{loader:'sass-loader',options:{sassOptions:{includePaths:['design/tokens']}}}]}]}]}}`, 'design/tokens/_palette.scss': '$brand:red;', 'src/pages/index.scss': '@use "palette" as ui;view{color:ui.$br|and}' }, 'src/pages/index.scss');
  assert.deepEqual(await graph.definitions('style'), [{ file: 'design/tokens/_palette.scss', text: '$brand' }]);
});

test('esbuild 脚本中的 await build、别名与复制 glob 保持源码结构', async () => {
  const graph = fixture({ 'package.json': '{"scripts":{"dev":"node scripts/build.mjs"}}', 'scripts/build.mjs': `import {build} from 'esbuild';import {copy} from 'esbuild-plugin-copy';await build({outdir:'release',alias:{'@logic':'domain'},plugins:[copy({assets:{from:['vendor/widgets/**/*'],to:['external/ui']}})]})`, ...copiedComponent, 'domain/model.ts': 'export function run(){return 1}' });
  assert.deepEqual(await graph.definitions('component'), [{ file: 'vendor/widgets/popup/index.js', text: 'round' }]);
  assert.deepEqual(await fixture({ 'package.json': '{"scripts":{"dev":"node scripts/build.mjs"}}', 'scripts/build.mjs': `import {build} from 'esbuild';await build({outfile:'release/main.js',alias:{'@logic':'domain'}})`, 'domain/model.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '@logic/model';ru|n()` }, 'src/pages/index.ts').definitions('script'), [{ file: 'domain/model.ts', text: 'run' }]);
});

test('esbuild resolveFrom 与 Rollup 静态重命名遵循各自目标基准', async () => {
  const source = { 'scripts/runtime.js': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '../../public/runtime.js';ru|n()` };
  const esbuild = fixture({ ...source, 'esbuild.config.js': `import {copy} from 'esbuild-plugin-copy';export default {outdir:'dist',plugins:[copy({resolveFrom:'cwd',assets:{from:'scripts/runtime.js',to:'public'}})]}` }, 'src/pages/index.ts');
  assert.deepEqual(await esbuild.definitions('script'), [{ file: 'scripts/runtime.js', text: 'run' }]);
  const rollup = fixture({ ...source, 'src/pages/index.ts': `import {run} from '../../release/assets/engine.js';ru|n()`, 'rollup.config.js': `import copy from 'rollup-plugin-copy';export default {output:{dir:'release'},plugins:[copy({targets:[{src:'scripts/runtime.js',dest:['release/assets'],rename:'engine.js'}]})]}` }, 'src/pages/index.ts');
  assert.deepEqual(await rollup.definitions('script'), [{ file: 'scripts/runtime.js', text: 'run' }]);
});

test('Vite 静态复制第四版保留目录层级，未知版本不猜复制布局', async () => {
  const files = { 'vite.config.ts': `import {viteStaticCopy} from 'vite-plugin-static-copy';export default {build:{outDir:'release'},plugins:[viteStaticCopy({targets:[{src:'vendor/widgets/**/*',dest:'assets'}]})]}`, 'node_modules/vite-plugin-static-copy/package.json': '{"version":"4.1.1"}', 'src/pages/index.json': '{"usingComponents":{"ui-popup":"/assets/vendor/widgets/popup/index"}}', 'src/pages/index.wxml': '<ui-popup ro|und="true"/>', 'vendor/widgets/popup/index.js': 'Component({properties:{round:Boolean}})' };
  assert.deepEqual(await fixture(files).definitions('component'), [{ file: 'vendor/widgets/popup/index.js', text: 'round' }]);
  assert.deepEqual(await fixture({ ...files, 'node_modules/vite-plugin-static-copy/package.json': '{}' }).definitions('component'), []);
});

test('pnpm 工作区与父级 tsconfig 不因应用 package 边界而丢失', async () => {
  const graph = fixture({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "apps/*"\n', 'tsconfig.json': '{"compilerOptions":{"paths":{"@theme/*":["theme/*"]}}}', 'apps/client/package.json': '{}', 'packages/tools/package.json': '{"name":"@repo/tools","source":"src/index.ts"}', 'packages/tools/src/index.ts': 'export function run(){return 1}', 'apps/client/index.ts': `import {run} from '@repo/tools';ru|n()`, 'theme/_palette.scss': '$brand:red;', 'apps/client/index.scss': '@use "@theme/palette" as ui;view{color:ui.$br|and}' }, 'apps/client/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'packages/tools/src/index.ts', text: 'run' }]);
  assert.deepEqual(await fixture({ 'tsconfig.json': '{"compilerOptions":{"paths":{"@theme/*":["theme/*"]}}}', 'apps/client/package.json': '{}', 'theme/_palette.scss': '$brand:red;', 'apps/client/index.scss': '@use "@theme/palette" as ui;view{color:ui.$br|and}' }, 'apps/client/index.scss').definitions('style'), [{ file: 'theme/_palette.scss', text: '$brand' }]);
});

test('包的私有子路径不会绕过 exports 限制借用 source 字段', async () => {
  const graph = fixture({ 'node_modules/tools/package.json': '{"source":"src","exports":{"./secret":null}}', 'node_modules/tools/src/secret.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from 'tools/secret';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), []);
});

test('URI 编码、资源查询与远程主机边界不会改变路径含义', async () => {
  const graph = fixture({ 'webpack.config.js': `module.exports={resolve:{alias:{'@logic':'my domain'}}}`, 'my domain/model.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '@logic/model?raw';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'my%20domain/model.ts', text: 'run' }]);
  assert.deepEqual(await graph.candidates('https://example.com/file.ts', 'script'), []);
  assert.deepEqual(await graph.candidates('vscode-remote://other/home/file.ts', 'script'), []);
  assert.deepEqual(await graph.candidates('plugin://component/index', 'component'), []);
});

test('配置语法损坏与非本地 sourceRoot 不产生看似有效的映射', async () => {
  const graph = fixture({ 'webpack.config.js': `module.exports={resolve:{alias:{'@logic':'domain'}}`, 'domain/model.ts': 'export function run(){return 1}' });
  assert.deepEqual(await graph.candidates('@logic/model', 'script'), []);
  const sourceMap = fixture({ 'webpack.config.js': `module.exports={output:{path:'dist'}}`, 'dist/internal.js.map': '{"sourceRoot":"webpack://bundle","sources":["model.ts"]}', 'dist/model.ts': 'export function run(){return 1}', 'src/pages/index.ts': `import {run} from '../../dist/internal.js';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await sourceMap.definitions('script'), []);
});

test('原样复制的 JS 不误选旁边同名但未被复制的 TS', async () => {
  const graph = fixture({ 'webpack.config.js': `const Copy=require('copy-webpack-plugin');module.exports={output:{path:'dist'},plugins:[new Copy([{from:'scripts/runtime.js',to:'assets/engine.js'}])]}`, 'scripts/runtime.js': 'export function run(){return 1}', 'scripts/runtime.ts': 'export function run(){return 2}', 'src/pages/index.ts': `import {run} from '../../dist/assets/engine.js';ru|n()` }, 'src/pages/index.ts');
  assert.deepEqual(await graph.definitions('script'), [{ file: 'scripts/runtime.js', text: 'run' }]);
});

test('独立路径解析器共享配置文本，草稿与之前缺失的配置创建会使缓存失效', async () => {
  const root = 'file:///config-cache/';
  const files = new Map([[root + 'package.json', '{}'], [root + 'src/app.json', '{}'], [root + 'tsconfig.json', '{"compilerOptions":{"paths":{"@value":["first.ts"]}}}']]);
  const versions = new Map<string, number>();
  let reads = 0;
  const reader: WorkspaceReader = { root: () => root, revision: (uri) => String(versions.get(uri) ?? 0), read: async (uri) => { reads++; const text = files.get(uri); return text === undefined ? undefined : { text }; } };
  const uri = root + 'src/index.ts';
  const first = await createProjectFileResolver(reader, uri).candidates('@value', uri, 'script');
  assert.ok(first.includes(root + 'first.ts'));
  const before = reads;
  await createProjectFileResolver(reader, uri).candidates('@value', uri, 'script');
  assert.equal(reads, before);
  files.set(root + 'tsconfig.json', '{"compilerOptions":{"paths":{"@value":["second.ts"]}}}'); versions.set(root + 'tsconfig.json', 1);
  const changed = await createProjectFileResolver(reader, uri).candidates('@value', uri, 'script');
  assert.ok(changed.includes(root + 'second.ts'));
  files.set(root + 'src/tsconfig.json', '{"compilerOptions":{"paths":{"@value":["local.ts"]}}}'); versions.set(root + 'src/tsconfig.json', 1);
  const local = await createProjectFileResolver(reader, uri).candidates('@value', uri, 'script');
  assert.ok(local.includes(root + 'src/local.ts'));
});

test('共享配置语法树保持各工程求值上下文，草稿损坏与修复不复用旧规则', () => {
  const filename = '/shared/vite.config.ts';
  const text = 'export default {resolve:{alias:{"@app":process.cwd()+"/src"}}};';
  const source = buildConfigSource(text, filename);
  assert.equal(buildConfigSource(text, filename), source, '同名同文的解析节点可复用');
  const first = inspectBuildConfig(text, filename, '/apps/first');
  const second = inspectBuildConfig(text, filename, '/apps/second');
  assert.deepEqual(first.aliases[0]!.targets, ['/apps/first/src']);
  assert.deepEqual(second.aliases[0]!.targets, ['/apps/second/src']);
  const changed = text.replace('/src', '/next');
  assert.notEqual(buildConfigSource(changed, filename), source);
  assert.deepEqual(inspectBuildConfig(changed, filename, '/apps/first').aliases[0]!.targets, ['/apps/first/next']);
  assert.deepEqual(inspectBuildConfig('export default {', filename, '/apps/first').aliases, []);
  assert.deepEqual(inspectBuildConfig(text, filename, '/apps/first').aliases[0]!.targets, ['/apps/first/src']);
});

test('复用构建入口语法树时仍按当前导入配置文本求值', () => {
  const filename = '/configs/vite.config.ts', text = 'import shared from "./shared";export default shared;';
  const shared = '/configs/shared.ts';
  const initial = new Map([[shared, 'export default {resolve:{alias:{"@app":"./one"}}};']]);
  const updated = new Map([[shared, 'export default {resolve:{alias:{"@app":"./two"}}};']]);
  assert.deepEqual(inspectBuildConfig(text, filename, '/app', initial).aliases[0]!.targets, ['/app/one']);
  assert.deepEqual(inspectBuildConfig(text, filename, '/app', updated).aliases[0]!.targets, ['/app/two']);
});
