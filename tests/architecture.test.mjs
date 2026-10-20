import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectArchitecture } from '../scripts/architecture-source.mjs';
import { generateArchitecture, watchArchitecture } from '../scripts/architecture.mjs';

/** 为真实源码扫描和渲染建立隔离工程，不改动插件工作目录。 */
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'miniapp-diagram-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'package.json', JSON.stringify({ publisher: 'test', name: 'miniapp' }));
  await put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true }, include: ['src'] }));
  await put(root, 'src/api/index.ts', `
    export interface LanguageFeatures { hover?: object; definition?: object; completion?: object; }
    export interface LanguagePlugin { setup(): LanguageFeatures; }
    export interface WorkspaceReader { read(): string; }
  `);
  await put(root, 'src/extension.ts', `export { plugin } from './languages/example';`);
  await put(root, 'src/languages/example/index.ts', `
    import type { LanguagePlugin } from '../../api';
    export const plugin: LanguagePlugin = { setup() { return { hover: {} }; } };
  `);
  await mkdir(path.join(root, 'scripts'));
  return root;
}

/** 写入测试文件时同步创建父目录，以覆盖新模块发现路径。 */
async function put(root, name, content) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

test('从条件展开和箭头 setup 提取能力，追踪类型、别名、动态导入与公共导出', async (context) => {
  const root = await fixture(context);
  await put(root, 'src/core/runtime.ts', 'export class Runtime {}');
  await put(root, 'src/languages/example/index.ts', `
    import type { LanguagePlugin, WorkspaceReader as Reader } from '../../api';
    import { Runtime } from '../../core/runtime';
    export type R = import('../../api').WorkspaceReader;
    export const plugin: LanguagePlugin = {
      setup: () => ({ hover: {}, ...(Math.random() ? { definition: {} } : {}) }),
    };
    export const internal = { completion: {} };
    void import('typescript');
  `);
  const snapshot = inspectArchitecture(root);
  const example = snapshot.modules.find((module) => module.name === 'languages/example');
  assert.deepEqual(example.features, ['definition', 'hover']);
  assert.deepEqual(example.ports, ['LanguagePlugin', 'WorkspaceReader']);
  assert.ok(snapshot.dependencies.some((edge) => edge.to === 'api' && edge.typeOnly));
  assert.ok(snapshot.dependencies.some((edge) => edge.to === 'npm:typescript' && !edge.typeOnly));
  assert.deepEqual(snapshot.modules.find((module) => module.name === 'core').exports, ['Runtime']);
});

test('生成结果确定且自包含，检查模式发现过期但不改写文件', async (context) => {
  const root = await fixture(context);
  await generateArchitecture({ root });
  const filename = path.join(root, 'media/architecture.svg');
  const svg = await readFile(filename, 'utf8');
  const before = (await stat(filename)).mtimeMs;
  assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /:root\s*\{\s*--bg: #f8fafc/);
  assert.match(svg, /miniapp 插件分层架构/);
  assert.match(svg, /扩展装配层/);
  assert.match(svg, /语言能力层/);
  assert.doesNotMatch(svg, /fill="url\(#grid\)"|rx="[1-9]/);
  assert.match(svg, /svg\[data-theme="dark"\]/);
  assert.match(svg, /装配与契约/);
  const html = await readFile(path.join(root, 'docs/architecture.html'), 'utf8');
  assert.match(html, /<html lang="zh-CN" data-theme="light">/);
  assert.match(html, /theme = 'light';/);
  assert.match(html, /return 'light';\s*\}\s*function apply/);
  const diagram = JSON.parse(await readFile(path.join(root, 'docs/architecture.architecture.json'), 'utf8'));
  assert.equal(diagram.connections.length, inspectArchitecture(root).dependencies.length);
  assert.doesNotMatch(svg, /<script\b|<link\b|NaN|undefined/);
  assert.deepEqual((await generateArchitecture({ root, check: true })).changed, []);
  assert.equal((await stat(filename)).mtimeMs, before);
  await put(root, 'src/languages/example/index.ts', `export const plugin = { setup: () => ({ definition: {} }) };`);
  await assert.rejects(generateArchitecture({ root, check: true }), /架构图已过期/);
  assert.equal(await readFile(filename, 'utf8'), svg);
  await generateArchitecture({ root });
  assert.notEqual(await readFile(filename, 'utf8'), svg);
});

test('无效源码保留上次有效产物，修复后恢复生成', async (context) => {
  const root = await fixture(context);
  await generateArchitecture({ root });
  const filename = path.join(root, 'media/architecture.svg');
  const svg = await readFile(filename, 'utf8');
  await put(root, 'src/languages/example/index.ts', 'export const broken = {');
  await assert.rejects(generateArchitecture({ root }));
  assert.equal(await readFile(filename, 'utf8'), svg);
  await put(root, 'src/languages/example/index.ts', 'export const repaired = {};');
  await generateArchitecture({ root });
  assert.notEqual(await readFile(filename, 'utf8'), svg);
});

test('监听新建、连续修改、删除和配置替换，最终产物与源码一致', { timeout: 30000 }, async (context) => {
  const root = await fixture(context);
  let revision = 0;
  let failure;
  const watcher = watchArchitecture({ root, onResult(error) { failure = error; revision++; } });
  context.after(() => watcher.close());

  /** 等待一次实际渲染完成，不用固定睡眠推断监听是否成功。 */
  async function renderedAfter(previous) {
    const deadline = Date.now() + 12000;
    while (revision <= previous && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(revision > previous, '架构图监听未在期限内完成渲染');
    assert.ifError(failure);
  }

  await renderedAfter(0);
  let previous = revision;
  await put(root, 'src/languages/new-language/index.ts', 'export const added = true;');
  await renderedAfter(previous);
  let data = JSON.parse(await readFile(path.join(root, 'docs/architecture.source.json'), 'utf8'));
  assert.ok(data.modules.some((module) => module.name === 'languages/new-language'));

  previous = revision;
  await put(root, 'src/languages/new-language/index.ts', 'export const plugin = { setup: () => ({ hover: {} }) };');
  await put(root, 'src/languages/new-language/index.ts', 'export const plugin = { setup: () => ({ definition: {} }) };');
  await put(root, 'package.json', JSON.stringify({ publisher: 'changed', name: 'miniapp' }));
  await renderedAfter(previous);
  data = JSON.parse(await readFile(path.join(root, 'docs/architecture.source.json'), 'utf8'));
  assert.equal(data.extension, 'changed.miniapp');
  assert.deepEqual(data.modules.find((module) => module.name === 'languages/new-language').features, ['definition']);

  previous = revision;
  await rm(path.join(root, 'src/languages/new-language'), { recursive: true });
  await renderedAfter(previous);
  data = JSON.parse(await readFile(path.join(root, 'docs/architecture.source.json'), 'utf8'));
  assert.ok(!data.modules.some((module) => module.name === 'languages/new-language'));
  await watcher.close();
  await generateArchitecture({ root, check: true });
});
