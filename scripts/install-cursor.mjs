import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** 使用 Cursor 官方 CLI 更新日常扩展，同版本开发包也强制覆盖。 */
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executable = process.env.CURSOR_EXECUTABLE ?? '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
const execute = promisify(execFile);
const options = { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 };
const archive = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);

const installation = await execute(executable, ['--install-extension', archive, '--force'], options);
process.stdout.write(installation.stdout);
const installed = await execute(executable, ['--list-extensions', '--show-versions'], options);
const identity = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
if (!installed.stdout.split(/\r?\n/).some((line) => line.trim().toLowerCase() === identity.toLowerCase())) {
  throw new Error(`Cursor 未确认已安装 ${identity}。`);
}
console.log(`已更新 Cursor 中的 ${identity}；已打开的窗口需重新加载以使用新实现。`);
