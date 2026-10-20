import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectArchitecture } from './architecture-source.mjs';
import { layoutArchitecture } from './architecture-layout.mjs';
import { traditionalArchitecture } from './architecture-style.mjs';

/** 渲染器随项目交付，任何机器上都不依赖个人技能目录。 */
const script = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(script), '..');
const vendorRoot = path.join(projectRoot, 'scripts/vendor/archify');
const execute = promisify(execFile);

/** 记录输入文件的元数据；轮询避免原生监听配额及原子保存造成的失效。 */
function inputRevision(root) {
  const entries = [];
  /** 新建目录和已删除文件都通过重新枚举发现，无需维护监听句柄。 */
  function collect(filename) {
    let metadata;
    try { metadata = statSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(filename).sort()) collect(path.join(filename, entry));
    } else entries.push(`${filename}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`);
  }
  for (const input of ['src', 'scripts', 'package.json', 'tsconfig.json']) collect(path.join(root, input));
  return entries.join('\n');
}

/** 从 Archify HTML 提取 SVG 和原始配色，README 默认展示浅色传统架构图。 */
export function standaloneSvg(html) {
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  const dark = style?.match(/:root,\s*\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
  const light = style?.match(/\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
  const font = style?.match(/body\s*\{\s*(font-family:[^;]+;)/)?.[1];
  if (!svg || !dark || !light || !font) throw new Error('Archify 模板结构已变化，请更新 SVG 导出逻辑。');
  const rules = [...style.matchAll(/\.[ctam]-[\w-]+[^{}]*\{[^}]*\}/g)].map((match) => match[0]).join('\n');
  const css = `svg { ${font} }\n${rules}\n:root {${light}}\nsvg[data-theme="light"] {${light}}\nsvg[data-theme="dark"] {${dark}}\n.c-bg-rect { fill: var(--bg); }`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/(<svg[^>]+>)/, `$1\n<style><![CDATA[${css}]]></style>\n<rect width="100%" height="100%" class="c-bg-rect"/>`)}\n`;
}

/** 仅写入变化内容，并原子替换单个文件，避免预览读取半张图片。 */
async function updateArtifact(filename, content, check) {
  let previous;
  try { previous = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous === content) return false;
  if (check) return true;
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

/** 完整渲染及检查成功后才更新产物；检查模式不会改动任何项目文件。 */
export async function generateArchitecture({ root = projectRoot, check = false } = {}) {
  const snapshot = inspectArchitecture(root);
  const diagram = layoutArchitecture(snapshot);
  const temporary = await mkdtemp(path.join(tmpdir(), 'miniapp-architecture-'));
  try {
    const input = path.join(temporary, 'architecture.json');
    const output = path.join(temporary, 'architecture.html');
    await writeFile(input, `${JSON.stringify(diagram, null, 2)}\n`);
    await execute(process.execPath, [path.join(vendorRoot, 'renderers/architecture/render-architecture.mjs'), input, output]);
    const html = traditionalArchitecture(await readFile(output, 'utf8'), diagram);
    await writeFile(output, html);
    await execute(process.execPath, [path.join(vendorRoot, 'scripts/check-render-output.mjs'), output]);
    const artifacts = {
      'docs/architecture.source.json': `${JSON.stringify(snapshot, null, 2)}\n`,
      'docs/architecture.architecture.json': `${JSON.stringify(diagram, null, 2)}\n`,
      'docs/architecture.html': html,
      'media/architecture.svg': standaloneSvg(html),
    };
    const changed = [];
    for (const [name, content] of Object.entries(artifacts)) {
      if (await updateArtifact(path.join(root, name), content, check)) changed.push(name);
    }
    if (check && changed.length) throw new Error(`架构图已过期，请运行 pnpm dev:diagram：\n${changed.join('\n')}`);
    if (changed.length) console.info(`[架构图] 已更新 ${changed.length} 个文件。`);
    else console.info(`[架构图] ${check ? '源码与产物一致。' : '架构未变化。'}`);
    return { snapshot, changed };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** 监听新增、修改和删除；串行执行并合并连续保存，失败后继续等待下一次编辑。 */
export function watchArchitecture({ root = projectRoot, onResult = () => {} } = {}) {
  let timer;
  let pending = false;
  let running;
  let closed = false;
  let revision = inputRevision(root);

  /** 每次使用新进程，使生成脚本本身的修改也能生效。 */
  async function drain() {
    if (running || closed) return;
    running = (async () => {
      while (pending && !closed) {
        pending = false;
        try {
          const result = await execute(process.execPath, [script, '--root', root]);
          process.stdout.write(result.stdout);
          onResult(null);
        } catch (error) {
          console.error(`[架构图] 更新失败，保留上次有效产物：\n${error.stderr || error.message}`);
          onResult(error);
        }
      }
    })();
    try { await running; } finally { running = undefined; }
  }

  /** 源码事件稍作防抖，避免编辑器原子保存过程中的临时缺失。 */
  function schedule() {
    if (closed) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => { void drain(); }, 200);
  }

  const polling = setInterval(() => {
    try {
      const current = inputRevision(root);
      if (current !== revision) { revision = current; schedule(); }
    } catch (error) {
      console.error(`[架构图] 读取监听目录失败：${error.message}`);
      onResult(error);
    }
  }, 500);
  schedule();
  return {
    /** 释放监听并等待当前渲染完成，避免退出后遗留写入。 */
    async close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(polling);
      await running;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex < 0 ? projectRoot : path.resolve(process.argv[rootIndex + 1]);
  try {
    if (process.argv.includes('--watch')) {
      const watcher = watchArchitecture({ root });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await watcher.close(); process.exit(0); });
    } else await generateArchitecture({ root, check: process.argv.includes('--check') });
  } catch (error) {
    console.error(error.stderr || error.message);
    process.exitCode = 1;
  }
}
