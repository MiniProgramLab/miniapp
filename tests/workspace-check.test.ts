import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckFile, CheckProvider, Diagnostic, WorkspaceReader } from '../src/api';
import { checkWorkspace } from '../src/core/workspace-check';
import { createNavigationTracking } from '../src/adapters/vscode/navigation-tracking';

/** 文件列表由发现端口提供，检查器只使用读取快照。 */
const files: CheckFile[] = ['first', 'second'].map((name) => ({ uri: `file:///check/${name}.wxml`, languageId: 'wxml' }));
const finding: Diagnostic = { range: { start: 6, end: 8 }, severity: 'warning', code: 'name', message: '名称不存在' };
/** 简单提供器仍经过实际运行器的生命周期、范围和依赖校验。 */
function provider(provide: CheckProvider['provide'], name = '检查器'): CheckProvider { return { id: name, name, languages: ['wxml'], active: () => true, provide }; }
/** 包含 CRLF、中文和代理对的草稿用来验证编辑器位置。 */
function reader(): WorkspaceReader { return { root: () => 'file:///check/', revision: () => 'stable', read: async (uri) => ({ text: '甲😀\r\nabc', ...(uri.includes('second') ? { version: 17 } : {}) }) }; }

test('未打开文件与草稿使用同一诊断规则，UTF-16 位置和重复问题保持正确', async () => {
  const versions: number[] = [];
  const checker = provider((request) => { versions.push(request.document.version); return [finding]; });
  const result = await checkWorkspace(reader(), [...files, files[0]!], [checker, provider(() => [finding], '第二检查器')], { cancellation: { isCancellationRequested: false } });
  assert.equal(result.report.status, 'complete'); assert.equal(result.report.selected, 2); assert.equal(result.report.checked, 2);
  assert.deepEqual(versions, [0, 17]); assert.equal(result.report.findings.length, 2);
  assert.deepEqual(result.report.findings[0]!.position, { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } });
  assert.ok(!JSON.stringify(result.report).includes('甲😀'));
});

test('严重程度与诊断码过滤保留执行范围，文件和问题超限不会报告完整', async () => {
  const checker = provider(() => [finding, { ...finding, severity: 'error', code: 'other', message: '另一问题' }]);
  const filtered = await checkWorkspace(reader(), files, [checker], { cancellation: { isCancellationRequested: false }, severities: ['error'], codes: ['other'] });
  assert.equal(filtered.report.checked, 2); assert.equal(filtered.report.findings.length, 2); assert.ok(filtered.report.findings.every((item) => item.severity === 'error'));
  const limited = await checkWorkspace(reader(), files, [checker], { cancellation: { isCancellationRequested: false }, maxFiles: 1 });
  assert.equal(limited.report.status, 'incomplete'); assert.equal(limited.report.checked, 1);
  const count = await checkWorkspace(reader(), files, [checker], { cancellation: { isCancellationRequested: false }, maxFindings: 1 });
  assert.equal(count.report.status, 'incomplete'); assert.equal(count.report.findings.length, 1);
});

test('取消只保留已完成文件，执行失败和卸载不会隐藏为干净结果', async () => {
  const token = { isCancellationRequested: false };
  const cancelled = await checkWorkspace(reader(), files, [provider((request) => { if (request.document.uri.includes('second')) token.isCancellationRequested = true; return [finding]; })], { cancellation: token });
  assert.equal(cancelled.report.status, 'cancelled'); assert.equal(cancelled.report.checked, 1); assert.equal(cancelled.report.findings.length, 1);
  const failed = await checkWorkspace(reader(), files, [provider(() => { throw new Error('实际失败'); })], { cancellation: { isCancellationRequested: false } });
  assert.equal(failed.report.status, 'incomplete'); assert.match(failed.report.issues[0]!.message, /实际失败/);
  let active = true;
  const removed = await checkWorkspace(reader(), files.slice(0, 1), [{ ...provider(() => { active = false; return [finding]; }), active: () => active }], { cancellation: { isCancellationRequested: false } });
  assert.equal(removed.report.status, 'incomplete'); assert.equal(removed.report.findings.length, 0);
});

test('读取失败、过大文件与未知语言分别记录覆盖范围', async () => {
  const broken: WorkspaceReader = { ...reader(), read: async (uri) => { if (uri.includes('first')) throw new Error('读取拒绝'); return { text: 'x'.repeat(2_000_001) }; } };
  const result = await checkWorkspace(broken, [...files, { uri: 'file:///check/image.png', languageId: 'image' }], [provider(() => [finding])], { cancellation: { isCancellationRequested: false } });
  assert.equal(result.report.status, 'incomplete'); assert.equal(result.report.skipped, 3); assert.equal(result.report.checked, 0);
  assert.ok(result.report.issues.some((item) => item.message.includes('读取拒绝'))); assert.ok(result.report.issues.some((item) => item.message.includes('两百万')));
});

test('依赖在读取期间变化时丢弃结果，跨文件变化不能伪装成一致快照', async () => {
  let revision = 'before';
  const changed: WorkspaceReader = { ...reader(), revision: () => revision, capture: async (provide) => { const initial = revision; const value = await provide(); revision = 'after'; return { value, dependencies: [{ uri: 'file:///check/shared.ts', revision: initial }] }; } };
  const stale = await checkWorkspace(changed, files.slice(0, 1), [provider(() => [finding])], { cancellation: { isCancellationRequested: false } });
  assert.equal(stale.report.status, 'incomplete'); assert.equal(stale.report.findings.length, 0); assert.equal(stale.report.skipped, 1);
  let own = 0;
  const between: WorkspaceReader = { ...reader(), revision: (uri) => uri.includes('first') ? String(own) : 'fixed' };
  const result = await checkWorkspace(between, files, [provider((request) => { if (request.document.uri.includes('second')) own++; return [finding]; })], { cancellation: { isCancellationRequested: false } });
  assert.equal(result.report.status, 'incomplete'); assert.ok(result.report.issues.some((issue) => issue.message.includes('过期')));
});

test('追踪显示上限不隐藏后来的真实解析预算，检查明确标记不完整', async () => {
  const navigation = createNavigationTracking();
  const source = { ...reader(), navigation };
  try {
    const result = await checkWorkspace(source, files.slice(0, 1), [provider(() => {
      for (let index = 0; index < 400; index++) navigation.record({ code: 'path', message: '读取' + index });
      navigation.record({ code: 'budget', message: '真实图已超过预算' }); return [finding];
    })], { cancellation: { isCancellationRequested: false } });
    assert.equal(result.report.status, 'incomplete'); assert.ok(result.report.issues.some((item) => item.message === '真实图已超过预算'));
  } finally { navigation.dispose(); }
});

test('大量或超大执行错误保持有界报告，不能伪装成检查完整', async () => {
  const supplied = Array.from({ length: 1100 }, (_, index) => ({ uri: `file:///check/${index}.wxml`, languageId: 'wxml' }));
  const failed = await checkWorkspace(reader(), supplied, [provider(() => { throw new Error('实际失败'); })], { cancellation: { isCancellationRequested: false } });
  assert.equal(failed.report.status, 'incomplete'); assert.equal(failed.report.checked, 1100);
  assert.equal(failed.report.issues.length, 1001); assert.match(failed.report.issues.at(-1)!.message, /后续原因/);
  const large = await checkWorkspace(reader(), files, [provider(() => { throw new Error('x'.repeat(2_000_001)); })], { cancellation: { isCancellationRequested: false } });
  assert.equal(large.report.status, 'incomplete'); assert.equal(large.report.issues.length, 1);
  assert.ok(JSON.stringify(large.report).length < 1000);
});
