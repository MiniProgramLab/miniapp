import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** 测试实际交付入口，并允许额外验证用户编辑器使用的编译器版本。 */
const require = createRequire(import.meta.url);
const initialize = require('@miniprogramlab/style-imports');
const compilers = [require('typescript')];
if (process.env.MINIAPP_TEST_TYPESCRIPT) compilers.push(require(process.env.MINIAPP_TEST_TYPESCRIPT));

/** 使用真实文件及原生语言服务，保留文件增删和未保存脚本的行为。 */
async function fixture(context, ts, content, styles = {}, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'miniapp-style-imports-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'index.ts');
  let text = content;
  let version = 0;
  for (const [name, value] of Object.entries({ 'index.ts': content, ...styles })) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const host = {
    ...ts.sys,
    // 语言服务宿主要求方法；系统宿主的同名布尔值在 Linux 上会被误调用。
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCompilationSettings: () => ({ noLib: true, noUncheckedSideEffectImports: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, ...options }),
    getCurrentDirectory: () => root,
    getScriptFileNames: () => [filename],
    getScriptVersion: () => String(version),
    getScriptSnapshot: (file) => {
      const value = file === filename ? text : ts.sys.readFile(file);
      return value === undefined ? undefined : ts.ScriptSnapshot.fromString(value);
    },
    getDefaultLibFileName: () => 'lib.d.ts',
  };
  const original = ts.createLanguageService(host);
  context.after(() => original.dispose());
  const service = initialize({ typescript: ts }).create({ languageService: original, languageServiceHost: host, serverHost: ts.sys });
  return {
    root, filename, original, service,
    diagnostics: () => service.getSemanticDiagnostics(filename),
    /** 模拟尚未保存的编辑，原生 Program 必须读取最新快照。 */
    edit(value) { text = value; version++; },
  };
}

for (const ts of compilers) {
  test(`TS ${ts.version}：已存在的四种样式及路径别名消除导入误报`, async (context) => {
    const graph = await fixture(context, ts, ['css', 'wxss', 'scss', 'less'].map((ext) => `import './index.${ext}';`).join('\n') + "\nimport '@styles/theme.scss';", {
      'index.css': '', 'index.wxss': '', 'index.scss': '', 'index.less': '', 'styles/theme.scss': '',
    }, { paths: { '@styles/*': ['./styles/*'] } });
    assert.equal(graph.original.getSemanticDiagnostics(graph.filename).length, 5, '原生服务应复现副作用导入错误');
    assert.deepEqual(graph.diagnostics(), []);
    assert.equal(graph.service.getProgram(), graph.original.getProgram(), '保留原生 Program 和语义能力');
  });

  test(`TS ${ts.version}：缺失文件、脚本导入和值导入保留报错`, async (context) => {
    const graph = await fixture(context, ts, "import './missing.scss';\nimport './missing.js';\nimport styles from './index.scss';\nexport * from './index.scss';\nconst count: number = '错误';", { 'index.scss': '' });
    assert.deepEqual(graph.diagnostics(), graph.original.getSemanticDiagnostics(graph.filename));
    assert.equal(graph.diagnostics().filter((item) => item.code === 2307 || item.code === 2882).length, 4);
    assert.ok(graph.diagnostics().some((item) => item.code === 2322));
  });

  test(`TS ${ts.version}：删除、恢复样式和未保存脚本及时更新诊断`, async (context) => {
    const graph = await fixture(context, ts, "import './index.scss';", { 'index.scss': '' });
    assert.deepEqual(graph.diagnostics(), []);
    await rm(path.join(graph.root, 'index.scss'));
    assert.equal(graph.diagnostics().length, 1);
    await writeFile(path.join(graph.root, 'index.scss'), '');
    assert.deepEqual(graph.diagnostics(), []);
    graph.edit("import './missing.scss';");
    assert.equal(graph.diagnostics().length, 1);
    graph.edit("import './index.scss';");
    assert.deepEqual(graph.diagnostics(), []);
  });
}
