import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 使用独立配置目录运行本机 VS Code，不改动用户现有扩展与设置。 */
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
if (!existsSync(executable)) throw new Error('未找到 VS Code，请通过 VSCODE_EXECUTABLE 指定可执行文件路径。');
const directory = await mkdtemp(path.join(tmpdir(), 'miniapp-extension-host-'));

try {
  await mkdir(path.join(directory, 'extensions'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const completion = path.join(directory, 'host-complete');
  environment.MINIAPP_HOST_COMPLETION = completion;
  const child = spawn(executable, [
    `--user-data-dir=${path.join(directory, 'profile')}`,
    `--extensions-dir=${path.join(directory, 'extensions')}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'tests/extension-host.cjs')}`,
    '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust',
    path.join(root, 'examples/wxml'),
  ], { env: environment, stdio: 'inherit' });
  // 宿主异常时限制测试时长，避免遗留独立测试窗口。
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status));
    });
    if (timedOut) throw new Error('扩展宿主测试超过六十秒，未完成验收。');
    if (code !== 0) throw new Error(`扩展宿主测试失败，退出码：${code}`);
    if (await readFile(completion, 'utf8').catch(() => '') !== 'passed\n') throw new Error('扩展宿主提前退出，缺少完整验收结果。');
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
