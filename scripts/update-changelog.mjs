import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** 提交记录只通过参数调用 Git，不把提交说明拼接为命令。 */
const execute = promisify(execFile);
/** 发布规则与清单校验一致，只收录正式版本 tag。 */
const versionTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** 分类顺序固定，同一份提交历史始终生成相同结果。 */
const categories = [
  ['feat', '新增功能'], ['fix', '问题修复'], ['perf', '性能优化'], ['refactor', '重构优化'],
  ['docs', '文档更新'], ['test', '测试验证'], ['build', '构建与发布'], ['ci', '构建与发布'],
  ['chore', '工程维护'], ['style', '代码样式'], ['revert', '变更回退'],
];

/** 转义 Markdown 中的提交标题，避免标题内容改变日志结构。 */
function escape(text) { return text.replace(/[\\`*_[\]<>]/g, '\\$&'); }

/** 历史版本按版本号倒序排列，旧 tag 重跑不改变其他版本的说明。 */
function compareVersions(left, right) {
  const a = left.slice(1).split('.').map(BigInt);
  const b = right.slice(1).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
  return 0;
}

/** 按提交类型组织中文条目，自动日志回写不会进入下一版变更说明。 */
function changes(output, repository) {
  const groups = new Map();
  const records = output.split('\0');
  for (let index = 0; index + 1 < records.length; index += 2) {
    const hash = records[index];
    const subject = records[index + 1];
    if (/^chore: 更新变更日志至 v\d+\.\d+\.\d+$/.test(subject)) continue;
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    const category = categories.find(([type]) => type === match?.[1])?.[1] ?? '其他更改';
    const description = match ? `${match[2] ? `${match[2]}：` : ''}${match[4]}${match[3] ? '（破坏性变更）' : ''}` : subject || '未填写说明的提交';
    const entries = groups.get(category) ?? [];
    entries.push(`- ${escape(description)}（[${hash.slice(0, 7)}](${repository}/commit/${hash})）`);
    groups.set(category, entries);
  }
  return [...new Set([...categories.map(([, category]) => category), '其他更改'])]
    .filter((category) => groups.has(category))
    .map((category) => `### ${category}\n\n${groups.get(category).join('\n')}`).join('\n\n');
}

/** 只梳理当前发布 tag 的变更，未指定 tag 时使用清单中的版本号。 */
export async function generateChangelog({ root = fileURLToPath(new URL('../', import.meta.url)), tag } = {}) {
  /** 每次生成只读取当前仓库，版本、标题和路径均不经过 shell。 */
  async function git(...args) {
    return (await execute('git', args, { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  }
  if ((await git('rev-parse', '--is-shallow-repository')).trim() === 'true') throw new Error('生成变更日志需要完整 Git 历史，请先获取全部历史和 tag。');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  tag ??= `v${manifest.version}`;
  if (!versionTag.test(tag)) throw new Error('日志 tag 必须使用 vmajor.minor.patch 格式。');
  await git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  const repository = (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url)?.replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!repository || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('package.json 必须提供有效的 GitHub 仓库 HTTPS 地址。');
  const tags = (await git('tag', '--list', '--sort=-version:refname'))
    .trim().split('\n').filter((name) => versionTag.test(name));
  const filename = path.join(root, 'CHANGELOG.md');
  let previous;
  try { previous = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = new Map();
  // 仅保留正式版本记录，兼容清理旧版生成器留下的草稿章节。
  for (const section of previous?.split(/(?=^## )/m) ?? []) {
    const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(section)?.[1];
    if (version && versionTag.test(`v${version}`)) entries.set(`v${version}`, section.trim());
  }
  const ancestors = new Set((await git('tag', '--merged', `refs/tags/${tag}`)).trim().split('\n'));
  // 初次建立日志时补齐已发布历史；后续只更新当前版本，保留其他版本的原文。
  const releases = entries.size ? [tag] : tags.slice(tags.indexOf(tag)).filter((name) => ancestors.has(name));
  for (const current of releases) {
    const ancestors = new Set((await git('tag', '--merged', `refs/tags/${current}`)).trim().split('\n'));
    const previous = tags.slice(tags.indexOf(current) + 1).filter((name) => ancestors.has(name));
    const commits = await git('log', '--no-merges', '--reverse', '-z', '--format=%H%x00%s', `refs/tags/${current}`, ...(previous.length ? ['--not', ...previous.map((name) => `refs/tags/${name}`)] : []));
    const date = (await git('for-each-ref', '--format=%(creatordate:short)', `refs/tags/${current}`)).trim();
    const link = previous[0] ? `${repository}/compare/${previous[0]}...${current}` : `${repository}/tree/${current}`;
    entries.set(current, `## [${current.slice(1)}](${link}) - ${date}\n\n${changes(commits, repository) || '本版本没有新增的非合并提交。'}`);
  }
  const sections = ['# 版本变更记录', '发版时根据当前 tag 与之前正式版本之间的提交记录，按当前发布版本号分类记录变更，并保留历史版本说明。', ...[...entries].sort(([left], [right]) => compareVersions(left, right)).map(([, section]) => section)];
  const content = sections.join('\n\n') + '\n';
  if (previous !== content) await writeFile(filename, content);
  return { tag, content, changed: previous !== content };
}

// 导入脚本只提供生成器；命令行入口校验参数后才写入日志。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--tag')) throw new Error('用法：pnpm dev:changelog [--tag vmajor.minor.patch]');
  const result = await generateChangelog(args.length ? { tag: args[1] } : {});
  console.log(`变更日志${result.changed ? '已更新' : '已是最新'}：${result.tag}。`);
}
