import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';

/** 隔离的 Node 测试宿主记录真实提供器调用，不依赖编辑器内部计时统计。 */
class Emitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
}
/** 文档接口仅实现实际诊断路径使用的能力。 */
const document = (uri, languageId = 'wxml') => ({ uri: { toString: () => uri }, languageId, version: 1, isClosed: false, getText: () => '<view/>', offsetAt: () => 0, positionAt: () => ({ line: 0, character: 0 }) });
const opened = new Emitter(), changed = new Emitter(), closed = new Emitter(), files = new Emitter();
const first = document('file:///workspace/first.wxml'), second = document('file:///workspace/second.wxml');
const stub = {
  workspace: { textDocuments: [first, second], onDidOpenTextDocument: opened.event, onDidChangeTextDocument: changed.event, onDidCloseTextDocument: closed.event,
    openTextDocument: async (uri) => { if (uri.toString().includes('deleted')) throw new Error('目标不存在'); return document(uri.toString()); } },
  languages: { match: (selector, document) => selector.some((item) => item.language === document.languageId), createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }), registerDefinitionProvider: () => ({ dispose() {} }) },
  Uri: { parse: (value) => ({ toString: () => value }) },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
};
const require = createRequire(import.meta.url);
const original = Module._load;
let createLanguageHost, formatNavigationReport;
try {
  Module._load = function load(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
  ({ createLanguageHost } = require('../src/adapters/vscode/language-host.ts'));
  ({ formatNavigationReport } = require('../src/adapters/vscode/navigation-report.ts'));
} finally { Module._load = original; }
const { createWorkspaceRevisions } = require('../src/core/workspace-revisions.ts');
const { createDependencyTracking } = require('../src/adapters/vscode/dependency-tracking.ts');
const { createNavigationTracking } = require('../src/adapters/vscode/navigation-tracking.ts');
/** 等待宿主原有的 300ms 合并窗口，测试不自行实现刷新规则。 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 360));

test('真实诊断宿主只刷新相关依赖，磁盘和配置事件与当前文档编辑正常生效', async () => {
  const revisions = createWorkspaceRevisions();
  const tracking = createDependencyTracking(revisions.revision);
  const reader = { revision: tracking.observe, capture: tracking.capture, onDidChange: files.event };
  const counts = new Map();
  const host = createLanguageHost({ info() {}, error(message, error) { throw error ?? new Error(message); } }, reader);
  const registration = host.register({ id: 'test.dependent', displayName: '依赖验收', languages: ['wxml'] }, { diagnostics: { dependencyLanguages: ['typescript'], provide: async (request) => {
    const uri = request.document.uri;
    counts.set(uri, (counts.get(uri) ?? 0) + 1);
    tracking.observe(uri.replace('.wxml', '.ts'));
    return [];
  } } });
  try {
    await settled();
    const calls = () => [counts.get(first.uri.toString()), counts.get(second.uri.toString())];
    assert.deepEqual(calls(), [1, 1]);
    changed.fire({ document: document('file:///workspace/unrelated.ts', 'typescript') });
    await settled();
    assert.deepEqual(calls(), [1, 1], '无关同语言文件不重算已有消费文档');
    revisions.changed('file:///workspace/first.ts', 'file:///workspace/');
    changed.fire({ document: document('file:///workspace/first.ts', 'typescript') });
    await settled();
    assert.deepEqual(calls(), [2, 1]);
    revisions.changed('file:///workspace/second.ts', 'file:///workspace/');
    files.fire('file:///workspace/second.ts');
    await settled();
    assert.deepEqual(calls(), [2, 2], '未打开依赖的磁盘事件也触发消费文档');
    first.version++;
    changed.fire({ document: first });
    await settled();
    assert.deepEqual(calls(), [3, 2], '当前模板编辑不会被依赖筛选漏掉');
    revisions.invalidate(); files.fire(undefined);
    await settled();
    assert.deepEqual(calls(), [4, 3]);
  } finally { registration.dispose(); tracking.dispose(); }
});

test('没有跟踪依赖的外部提供器保留原有语言刷新语义', async () => {
  const revisions = createWorkspaceRevisions();
  const tracking = createDependencyTracking(revisions.revision);
  let calls = 0;
  const host = createLanguageHost({ info() {}, error(message, error) { throw error ?? new Error(message); } }, { revision: tracking.observe, capture: tracking.capture });
  const registration = host.register({ id: 'test.external', displayName: '外部验收', languages: ['wxml'] }, { diagnostics: { dependencyLanguages: ['typescript'], provide: () => { calls++; return []; } } });
  try {
    await settled(); const initial = calls;
    changed.fire({ document: document('file:///workspace/external.ts', 'typescript') });
    await settled(); assert.equal(calls, initial + 2);
  } finally { registration.dispose(); tracking.dispose(); }
});

test('导航宿主合并来源、报告预算并排除删除目标、取消与过期草稿', async () => {
  const navigation = createNavigationTracking();
  const host = createLanguageHost({ info() {}, error(message, error) { throw error ?? new Error(message); } }, { navigation });
  const source = document('file:///workspace/report.wxml');
  let phase = 'multiple';
  let resumed;
  const registrations = ['甲', '乙'].map((name) => host.register({ id: name, displayName: name, languages: ['wxml'] }, { definition: {
    async provide() {
      if (phase === 'stale' && name === '甲') await new Promise((resolve) => { resumed = resolve; });
      if (phase === 'budget') navigation.record({ code: 'budget', message: '实际解析预算耗尽' });
      return [{ uri: `file:///workspace/${phase === 'deleted' ? 'deleted' : phase === 'multiple' ? name : 'same'}.ts`, range: { start: 0, end: 1 }, originRange: { start: 0, end: 1 } }];
    },
  } }));
  const position = new stub.Position(0, 0), token = { isCancellationRequested: false };
  try {
    const multiple = await host.explainNavigation(source, position, token);
    assert.equal(multiple.status, 'ambiguous');
    assert.match(formatNavigationReport(multiple), /多个定义来源/);
    phase = 'same';
    const same = await host.explainNavigation(source, position, token);
    assert.equal(same.status, 'resolved'); assert.equal(same.definitions.length, 1);
    phase = 'budget';
    const budget = await host.explainNavigation(source, position, token);
    assert.equal(budget.status, 'incomplete');
    assert.match(formatNavigationReport(budget), /\[扫描上限\] 实际解析预算耗尽/);
    phase = 'deleted';
    const deleted = await host.explainNavigation(source, position, token);
    assert.equal(deleted.status, 'unresolved');
    assert.ok(deleted.providers.every((provider) => provider.steps.some((step) => step.code === 'missing')));
    assert.equal(await host.explainNavigation(source, position, { isCancellationRequested: true }), undefined);
    phase = 'stale';
    const pending = host.explainNavigation(source, position, token);
    source.version++; resumed();
    assert.equal(await pending, undefined);
    for (const registration of registrations) registration.dispose();
    assert.equal((await host.explainNavigation(source, position, token)).providers.length, 0);
  } finally { for (const registration of registrations) registration.dispose(); navigation.dispose(); }
});
