import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { generateArchitecture, watchArchitecture } from './architecture.mjs';
import { buildTypeScript, createCompilerPlugin } from './build-typescript.mjs';

// 清理已移除的框架服务产物，保留其他开发输出和本地配置。
for (const name of ['language-server', 'api/framework.d.ts', 'api/typechecking.d.ts', 'licenses/languageclient-THIRD-PARTY-NOTICES.txt']) {
  await rm(new URL(`../dist/${name}`, import.meta.url), { recursive: true, force: true });
}

/** 同步交付类型基础库与第三方归属文件，运行时无需用户安装编译器。 */
const typescriptRoot = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
const libraryDirectory = new URL('../dist/typescript-lib/', import.meta.url);
const licenseDirectory = new URL('../dist/licenses/', import.meta.url);
await mkdir(libraryDirectory, { recursive: true });
await mkdir(licenseDirectory, { recursive: true });
for (const file of ['lib.es5.d.ts', 'lib.decorators.d.ts', 'lib.decorators.legacy.d.ts']) {
  await copyFile(path.join(typescriptRoot, 'lib', file), new URL(file, libraryDirectory));
}
for (const file of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) {
  await copyFile(path.join(typescriptRoot, file), new URL(`typescript-${file}`, licenseDirectory));
}

// 编译器单独压缩交付，仍在首次语义查询时加载，不增加启动阶段的开销。
await buildTypeScript(typescriptRoot, new URL('../dist/typescript.cjs', import.meta.url));

/** VS Code API 由宿主提供，编译器仅在延迟初始化的语义模块中加载。 */
const options = {
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  plugins: [createCompilerPlugin()],
  sourcemap: true,
  sourcesContent: true,
  logLevel: 'info',
  banner: { js: '// miniapp，遵循 Apache-2.0 许可。' },
};

/** 原生 TS 服务从扩展的 node_modules 加载独立适配器，无需用户安装依赖。 */
const pluginDirectory = new URL('../node_modules/@miniprogramlab/style-imports/', import.meta.url);
await mkdir(pluginDirectory, { recursive: true });
await writeFile(new URL('package.json', pluginDirectory), JSON.stringify({ name: '@miniprogramlab/style-imports', version: '0.0.1', main: './index.cjs', private: true }));
const pluginOptions = {
  ...options,
  entryPoints: ['src/adapters/typescript/style-imports.ts'],
  outfile: 'node_modules/@miniprogramlab/style-imports/index.cjs',
  plugins: [],
  footer: { js: 'module.exports = module.exports.default;' },
};

if (process.argv.includes('--watch')) {
  const diagrams = watchArchitecture();
  const compiler = await context(options);
  const pluginCompiler = await context(pluginOptions);
  await compiler.watch();
  await pluginCompiler.watch();
  // 开发进程退出时一并释放图表监听及编译器。
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await diagrams.close();
    await compiler.dispose();
    await pluginCompiler.dispose();
    process.exit(0);
  });
} else {
  await generateArchitecture();
  await build(options);
  await build(pluginOptions);
}
