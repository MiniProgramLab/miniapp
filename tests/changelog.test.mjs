import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { generateChangelog } from '../scripts/update-changelog.mjs';

/** 使用真实的隔离 Git 仓库验证版本边界，不修改项目提交和 tag。 */
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'miniapp-changelog-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const execute = promisify(execFile);
  let sequence = 0;
  /** 固定身份和时间，轻量及附注 tag 在不同环境生成一致结果。 */
  async function git(...args) {
    return (await execute('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-02T03:00:00+00:00', GIT_COMMITTER_DATE: '2026-11-02T03:00:00+00:00' },
    })).stdout.trim();
  }
  /** 每次写独立文件，分支合并不依赖冲突处理或空提交。 */
  async function commit(subject) {
    await writeFile(path.join(root, `change-${sequence++}.txt`), subject);
    await git('add', '.');
    await git('commit', '-m', subject);
    return git('rev-parse', 'HEAD');
  }
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', '变更日志测试');
  await git('config', 'user.email', 'changelog@example.invalid');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0', repository: { url: 'https://github.com/MiniProgramLab/miniapp.git' } }));
  return { root, git, commit };
}

test('只分类记录当前发布 tag 的变更，保留历史说明且重复执行不改写文件', async (context) => {
  const graph = await fixture(context);
  await graph.commit('feat: 初始化能力');
  await graph.git('tag', '-a', 'v0.0.2', '-m', '初始版本');
  const fix = await graph.commit('fix(wxml): 修复 [模板] *跳转*');
  await graph.commit('perf: 优化首次加载');
  await graph.commit('chore: 更新变更日志至 v0.0.2');
  await graph.git('tag', 'v0.0.3');
  await graph.commit('feat(api)!: 调整接口');
  await graph.git('tag', 'v9.0.0-beta.1');
  await graph.git('tag', 'v01.0.0');
  const result = await generateChangelog({ root: graph.root, tag: 'v0.0.3' });
  assert.ok(result.changed);
  assert.doesNotMatch(result.content, /未发布|调整接口/);
  assert.ok(result.content.includes('wxml：修复 \\[模板\\] \\*跳转\\*'));
  assert.ok(result.content.includes(`/commit/${fix}`));
  assert.match(result.content, /compare\/v0\.0\.2\.\.\.v0\.0\.3\) - 2026-11-02/);
  assert.match(result.content, /tree\/v0\.0\.2\) - 2026-11-02/);
  assert.equal(result.content.match(/初始化能力/g).length, 1);
  assert.doesNotMatch(result.content, /更新变更日志至|v9\.0\.0-beta|v01\.0\.0/);
  const before = (await stat(path.join(graph.root, 'CHANGELOG.md'))).mtimeMs;
  assert.equal((await generateChangelog({ root: graph.root, tag: 'v0.0.3' })).changed, false);
  assert.equal((await stat(path.join(graph.root, 'CHANGELOG.md'))).mtimeMs, before);
  await writeFile(path.join(graph.root, 'CHANGELOG.md'), result.content.replace('初始化能力', '初始化能力（历史补充说明）'));
  await graph.git('tag', 'v0.0.4');
  const release = await generateChangelog({ root: graph.root, tag: 'v0.0.4' });
  assert.doesNotMatch(release.content, /未发布/);
  assert.match(release.content, /## \[0\.0\.4\][\s\S]*api：调整接口（破坏性变更）/);
  assert.match(release.content, /初始化能力（历史补充说明）/);
  assert.match(release.content, /性能优化\n\n- 优化首次加载/);
  assert.equal((await generateChangelog({ root: graph.root, tag: 'v0.0.3' })).content, release.content);
});

test('旁支版本、合并提交和旧 tag 重跑不会污染版本边界或丢失新版本', async (context) => {
  const graph = await fixture(context);
  await graph.commit('feat: 公共基础');
  await graph.git('tag', 'v1.0.0');
  await graph.git('switch', '-c', 'feature');
  await graph.commit('fix: 侧分支修复');
  await graph.git('switch', 'main');
  await graph.git('merge', '--no-ff', 'feature', '-m', '合并功能分支');
  await graph.git('tag', 'v1.1.0');
  await graph.git('switch', '-c', 'other-release', 'v1.0.0');
  await graph.commit('feat: 另一版本专属能力');
  await graph.git('tag', 'v2.0.0');
  await graph.git('switch', 'main');
  await graph.commit('docs: 待发布说明');
  const older = await generateChangelog({ root: graph.root, tag: 'v1.1.0' });
  assert.match(older.content, /侧分支修复/);
  assert.doesNotMatch(older.content, /合并功能分支|另一版本专属能力|待发布说明|\[2\.0\.0\]/);
  const current = await generateChangelog({ root: graph.root, tag: 'v2.0.0' });
  assert.match(current.content, /\[2\.0\.0\]/);
  assert.match(current.content, /另一版本专属能力/);
  assert.equal(current.content.match(/侧分支修复/g).length, 1);
  assert.doesNotMatch(current.content, /未发布|待发布说明/);
});

test('默认使用清单版本，缺失发布 tag 时不写日志并清理旧版草稿章节', async (context) => {
  const graph = await fixture(context);
  await graph.commit('自定义提交说明');
  const original = '# 版本变更记录\n\n## 未发布\n\n- 旧版草稿\n';
  await writeFile(path.join(graph.root, 'CHANGELOG.md'), original);
  await assert.rejects(generateChangelog({ root: graph.root }));
  for (const tag of ['--all', 'v1.0', 'v1.0.0-rc.1', 'v1.0.0']) await assert.rejects(generateChangelog({ root: graph.root, tag }));
  assert.equal(await readFile(path.join(graph.root, 'CHANGELOG.md'), 'utf8'), original);
  await graph.git('tag', 'v1.0.0');
  const result = await generateChangelog({ root: graph.root });
  assert.equal(result.tag, 'v1.0.0');
  assert.match(result.content, /## \[1\.0\.0\][\s\S]*### 其他更改\n\n- 自定义提交说明/);
  assert.doesNotMatch(result.content, /未发布|旧版草稿/);
  await graph.commit('feat: tag 后新增的能力');
  assert.equal((await generateChangelog({ root: graph.root })).content, result.content);
});

test('浅克隆拒绝生成不完整日志，既有文件保持原样', async (context) => {
  const graph = await fixture(context);
  await graph.commit('feat: 初始功能');
  await graph.git('tag', 'v1.0.0');
  await graph.commit('fix: 后续修复');
  const shallow = path.join(graph.root, 'shallow');
  await graph.git('clone', '--depth=1', pathToFileURL(graph.root).href, shallow);
  await writeFile(path.join(shallow, 'CHANGELOG.md'), '原有日志\n');
  await assert.rejects(generateChangelog({ root: shallow }), /完整 Git 历史/);
  assert.equal(await readFile(path.join(shallow, 'CHANGELOG.md'), 'utf8'), '原有日志\n');
});

test('工作流实际回写脚本处理并发提交、重复执行和旧 tag 重跑', { timeout: 30000 }, async (context) => {
  const graph = await fixture(context);
  const staging = await mkdtemp(path.join(tmpdir(), 'miniapp-changelog-remote-'));
  context.after(() => rm(staging, { recursive: true, force: true }));
  const remote = path.join(staging, 'origin.git');
  const runner = path.join(staging, 'runner');
  const contributor = path.join(staging, 'contributor');
  await mkdir(path.join(graph.root, 'scripts'));
  await copyFile(new URL('../scripts/update-changelog.mjs', import.meta.url), path.join(graph.root, 'scripts/update-changelog.mjs'));
  await graph.commit('feat: 初始发布');
  await graph.git('tag', 'v1.0.0');
  await graph.git('init', '--bare', '--initial-branch=main', remote);
  await graph.git('remote', 'add', 'origin', remote);
  await graph.git('push', 'origin', 'main', '--tags');
  await graph.git('clone', remote, runner);
  await graph.git('clone', remote, contributor);
  // 在第一次推送前模拟另一位开发者提交，验证拒绝非快进后会重新生成日志。
  const raceScript = path.join(staging, 'advance.mjs');
  const flag = path.join(staging, 'advanced');
  await writeFile(raceScript, `import {existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if (!existsSync(${JSON.stringify(flag)})) {
  writeFileSync(${JSON.stringify(flag)}, '已推进');
  execFileSync('git', ['-C', ${JSON.stringify(contributor)}, '-c', 'commit.gpgsign=false', '-c', 'user.name=并发测试', '-c', 'user.email=contributor@example.invalid', 'commit', '--allow-empty', '-m', 'fix: 并发修复']);
  execFileSync('git', ['-C', ${JSON.stringify(contributor)}, 'push', 'origin', 'main']);
}
`);
  const hook = path.join(runner, '.git/hooks/pre-push');
  await writeFile(hook, '#!/bin/sh\nexec node "$CHANGELOG_RACE_SCRIPT"\n');
  await chmod(hook, 0o755);
  /** 直接执行工作流中的脚本，远程只使用测试目录中的裸仓库。 */
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const script = workflow.match(/      - name: 生成日志并提交默认分支\n        shell: bash\n        run: \|\n((?:          .*\n)+)/)?.[1].replace(/^ {10}/gm, '');
  assert.ok(script, '没有找到工作流日志回写步骤');
  const execute = promisify(execFile);
  const options = { cwd: runner, env: { ...process.env, DEFAULT_BRANCH: 'main', RELEASE_TAG: 'v1.0.0', CHANGELOG_RACE_SCRIPT: raceScript } };
  const first = await execute('bash', ['-e', '-o', 'pipefail', '-c', script], options);
  assert.match(first.stderr, /rejected/);
  const content = await graph.git('--git-dir', remote, 'show', 'main:CHANGELOG.md');
  assert.doesNotMatch(content, /未发布|并发修复/);
  assert.match(await graph.git('--git-dir', remote, 'log', 'main', '--format=%s'), /并发修复/);
  const head = await graph.git('--git-dir', remote, 'rev-parse', 'main');
  await execute('bash', ['-e', '-o', 'pipefail', '-c', script], options);
  assert.equal(await graph.git('--git-dir', remote, 'rev-parse', 'main'), head);
  await graph.git('--git-dir', remote, 'tag', 'v1.1.0', 'main');
  await execute('bash', ['-e', '-o', 'pipefail', '-c', script], { ...options, env: { ...options.env, RELEASE_TAG: 'v1.1.0' } });
  const refreshed = await graph.git('--git-dir', remote, 'show', 'main:CHANGELOG.md');
  assert.match(refreshed, /\[1\.1\.0\]/);
  assert.match(refreshed, /\[1\.0\.0\]/);
  assert.equal(refreshed.match(/并发修复/g).length, 1);
  await execute('bash', ['-e', '-o', 'pipefail', '-c', script], options);
  assert.equal(await graph.git('--git-dir', remote, 'show', 'main:CHANGELOG.md'), refreshed);
});
