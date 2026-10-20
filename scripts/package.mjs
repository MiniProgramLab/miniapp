import { createVSIX, listFiles, PackageManager } from '@vscode/vsce';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 在临时交付目录打包，避免 npm 遍历 pnpm 链接中的开发依赖。 */
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = await realpath(await mkdtemp(path.join(tmpdir(), 'miniapp-package-')));
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
  // VSCE 无依赖模式会忽略 node_modules，因此显式复制内置的原生 TS 适配器。
  const pluginFiles = ['node_modules/@miniprogramlab/style-imports/package.json', 'node_modules/@miniprogramlab/style-imports/index.cjs'];
  for (const file of [...files, ...pluginFiles, '.vscodeignore']) {
    const destination = path.join(staging, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(root, file), destination);
  }

  // 暂存目录只声明已复制的适配器，依赖枚举无需访问工程的 pnpm 链接或下载包。
  manifest.dependencies = { '@miniprogramlab/style-imports': '0.0.1' };
  delete manifest.devDependencies;
  delete manifest.scripts;
  await writeFile(path.join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // 市场不接受自托管 SVG 图片；仅在安装包简介中改为架构图链接，仓库仍展示原图。
  const readmePath = path.join(staging, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  await writeFile(readmePath, readme.replace(/!\[([^\]]*)\]\((media\/architecture\.svg)\)/g, '[$1]($2)'));

  // 提前检查市场的 PNG 图标尺寸限制，避免安装包上传后才被拒绝。
  const icon = await readFile(path.join(staging, manifest.icon));
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (icon.length >= 24 && icon.subarray(0, 8).equals(pngSignature)
    && (icon.readUInt32BE(16) > 1024 || icon.readUInt32BE(20) > 1024)) {
    throw new Error('插件图标尺寸不能超过 1024×1024 像素。');
  }

  // 在创建安装包前校验实际枚举结果，阻止交付缺少适配器的扩展。
  const packagedFiles = await listFiles({ cwd: staging, packageManager: PackageManager.Npm });
  if (pluginFiles.some((file) => !packagedFiles.includes(file))) throw new Error('安装包缺少原生 TypeScript 样式导入适配器。');

  await createVSIX({
    cwd: staging, packagePath: path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`),
    useYarn: false, githubBranch: 'main', rewriteRelativeLinks: true,
  });
} finally {
  // 无论成功或失败，只清理本次创建的临时交付目录。
  await rm(staging, { recursive: true, force: true });
}
