import { transform } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** 压缩固定版本的完整编译器，保留公开函数名称、属性及原始许可声明。 */
export async function buildTypeScript(root, destination) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const source = await readFile(path.join(root, 'lib', 'typescript.js'), 'utf8');
  // 仅在构建时提取名称，交付文件一次性恢复公开名称，避免反复包装内部解析闭包。
  const compiler = createRequire(import.meta.url)(path.join(root, 'lib', 'typescript.js'));
  const names = Object.entries(compiler).filter(([, value]) => typeof value === 'function').map(([key, value]) => [key, value.name]);
  const restoreNames = `\nfor (const [key, name] of ${JSON.stringify(names)}) Object.defineProperty(module.exports[key], 'name', { value: name, configurable: true });`;
  const result = await transform(source + restoreNames, {
    loader: 'js', target: 'node20', minify: true, legalComments: 'eof',
    sourcefile: 'typescript.cjs',
    // 标记仅含版本和构建参数，避免非 ASCII 字符让整个大文件占用双字节内存。
    banner: `// TypeScript ${metadata.version} | esbuild(minify=true) | names=exports | NOTICE`,
  });
  await writeFile(destination, result.code);
  console.info(`[内置 TypeScript] ${metadata.version}，交付源码由 ${(Buffer.byteLength(source) / 1_048_576).toFixed(2)} MiB 压缩至 ${(Buffer.byteLength(result.code) / 1_048_576).toFixed(2)} MiB。`);
}

/** 主扩展和产物回归测试共用按需加载规则，所有语义模块只持有一个编译器对象。 */
export function createCompilerPlugin(specifier = './typescript.cjs') {
  return {
    name: '按需加载内置编译器',
    /** 共享默认导出，避免各语义文件分别复制 CommonJS 导出包装。 */
    setup(compiler) {
      compiler.onResolve({ filter: /^typescript$/ }, () => ({ path: 'typescript', namespace: 'miniapp-compiler' }));
      compiler.onResolve({ filter: /^\.\/typescript\.cjs$/, namespace: 'miniapp-compiler' }, () => ({ path: specifier, external: true }));
      compiler.onLoad({ filter: /^typescript$/, namespace: 'miniapp-compiler' }, () => ({
        contents: "// 首次语义查询加载固定版本编译器，全部解析模块复用同一对象。\nexport default require('./typescript.cjs');",
        loader: 'js',
      }));
    },
  };
}
