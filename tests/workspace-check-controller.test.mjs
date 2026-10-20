import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';

/** 最小编辑器接口运行真实控制器，用显式等待点重现任务竞争。 */
const commands = new Map(), diagnostics = new Map();
const disposable = { dispose() {} };
/** URI 保留控制器实际使用的路径和字符串能力。 */
function uri(value) { return { path: new URL(value).pathname, toString: () => value }; }
let resumed, picked, changed, revision = 0, inputCalls = 0;
const stub = {
  Uri: { parse: uri, joinPath: (base, relative) => uri(new URL(relative, base.toString().replace(/\/?$/, '/')).href) },
  FileType: { Directory: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 }, DiagnosticSeverity: { Error: 0, Warning: 1 },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  Range: class { constructor(...values) { this.values = values; } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
  commands: { registerCommand: (name, run) => { commands.set(name, run); return { dispose: () => commands.delete(name) }; } },
  workspace: {
    textDocuments: [], workspaceFolders: [{ uri: uri('file:///workspace/') }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback }), asRelativePath: (value) => value.path,
    onDidOpenTextDocument: () => disposable,
    fs: { stat: async (target) => target.path.includes('slow') ? new Promise((resolve) => { resumed = resolve; }) : { type: 2 } },
    findFiles: async (pattern, _exclude, limit) => pattern.base.path.includes('overlap') ? Array.from({ length: pattern.pattern === 'first' ? 10 : 11 }, (_, index) => uri(pattern.base.toString() + index + '.wxml')).slice(0, limit) : [uri(pattern.base.toString().replace(/\/?$/, '/') + 'page.wxml')],
  },
  languages: { match: () => 0, createDiagnosticCollection: () => ({ clear: () => diagnostics.clear(), set: (target, items) => diagnostics.set(target.toString(), items), delete: (target) => diagnostics.delete(target.toString()), dispose() {} }) },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }), showInformationMessage() {},
    withProgress: async (_options, run) => run({ report() {} }, { onCancellationRequested: () => disposable }),
    showQuickPick: () => new Promise((resolve) => { picked = resolve; }),
    showInputBox: async () => { inputCalls++; return ''; },
  },
};
const require = createRequire(import.meta.url), original = Module._load;
let registerWorkspaceCheck;
try {
  Module._load = function load(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
  ({ registerWorkspaceCheck } = require('../src/adapters/vscode/workspace-check.ts'));
} finally { Module._load = original; }

test('路径准备和筛选等待不能覆盖新任务，准备阶段也能取消', async () => {
  const checked = [];
  const registration = registerWorkspaceCheck({ checkProviders: () => [{ id: 'check', name: '检查器', languages: ['wxml'], active: () => true, provide: (request) => { checked.push(request.document.uri); return [{ range: { start: 0, end: 1 }, severity: 'warning', message: '问题' }]; } }] }, { root: () => 'file:///workspace/', revision: () => String(revision), onDidChange: (listener) => { changed = listener; return disposable; }, read: async () => ({ text: '<view/>' }) }, { info() {}, warn() {}, error(message) { throw new Error(message); } });
  const check = commands.get('miniprogramlab.miniapp.checkWorkspace');
  try {
    const older = check(uri('file:///workspace/slow/'));
    const newer = await check(uri('file:///workspace/newer/'));
    resumed({ type: 2 });
    assert.equal(await older, undefined);
    assert.equal(newer.checked, 1);
    assert.deepEqual(checked, ['file:///workspace/newer/page.wxml']);
    assert.ok(diagnostics.has('file:///workspace/newer/page.wxml'));

    const pendingFilter = commands.get('miniprogramlab.miniapp.filterCheckResults')();
    await check(uri('file:///workspace/latest/'));
    picked('按文件筛选');
    assert.equal(await pendingFilter, undefined);
    assert.equal(inputCalls, 0, '旧菜单不能继续读取新报告或弹出文件输入');
    assert.ok(diagnostics.has('file:///workspace/latest/page.wxml'));
    revision++;
    changed('file:///workspace/latest/new.wxml', 'structure');
    assert.equal(diagnostics.size, 0, '新增源码需要使发现范围快照失效');

    const overlap = await check(uri('file:///workspace/overlap/'), { include: ['first', 'second'], maxFiles: 10 });
    assert.equal(overlap.status, 'incomplete'); assert.equal(overlap.selected, 11);

    const preparing = check(uri('file:///workspace/slow/'));
    assert.equal(commands.get('miniprogramlab.miniapp.cancelWorkspaceCheck')(), true);
    resumed({ type: 2 });
    assert.equal((await preparing).status, 'cancelled');
  } finally { registration.dispose(); }
});
