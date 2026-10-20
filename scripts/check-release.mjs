import { appendFile, readFile } from 'node:fs/promises';

/** 发布身份与版本必须和安装包一致，避免 tag 发布到错误的市场条目。 */
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const identity = `${manifest.publisher}.${manifest.name}`;
const version = manifest.version;
const ref = process.env.GITHUB_REF ?? '';

if (identity !== 'miniprogramlab.miniapp') {
  throw new Error(`扩展标识必须为 miniprogramlab.miniapp，实际为 ${identity}。`);
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('正式发布版本必须使用不带前缀和预发布后缀的 major.minor.patch。');
}
// 分支构建只校验清单；tag 构建还必须与清单版本严格对应。
if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${version}`) {
  throw new Error(`发布 tag 必须为 v${version}，实际为 ${ref.slice('refs/tags/'.length)}。`);
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(`发布清单校验通过：${identity}@${version}${ref ? `（${ref}）` : ''}。`);
