import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';

/** 事件和取消信号覆盖真实预览适配器，测试不另行实现失效规则。 */
class Emitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(...args) { for (const listener of this.listeners) listener(...args); }
}

const documents = new Map();
let onOpen, onApply, resolvePreview, discarded = 0;
const stub = {
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  Uri: { parse: (value) => ({ toString: () => value }) },
  WorkspaceEdit: class {
    /** 保留实际提交的文件操作，核验创建内容与普通编辑的边界。 */
    entries = [];
    /** 记录已有文档的修改。 */
    replace(...args) { this.entries.push({ kind: 'replace', args }); }
    /** 记录新文件及其初始字节和确认信息。 */
    createFile(...args) { this.entries.push({ kind: 'create', args }); }
    /** 普通提供器的文件内容沿用可往返的文本编辑。 */
    insert(...args) { this.entries.push({ kind: 'insert', args }); }
  },
  CancellationTokenSource: class {
    cancellation = new Emitter();
    token = { isCancellationRequested: false, onCancellationRequested: this.cancellation.event };
    cancel() { this.token.isCancellationRequested = true; this.cancellation.fire(); }
    dispose() { this.cancellation.listeners.clear(); }
  },
  workspace: {
    get textDocuments() { return [...documents.values()]; },
    fs: { stat: async () => { throw new Error('不存在'); } },
    openTextDocument: async (uri) => { onOpen?.(); return documents.get(uri.toString()); },
    applyEdit: () => { const pending = new Promise((resolve) => { resolvePreview = resolve; }); onApply?.(); return pending; },
  },
  commands: { executeCommand: async (command) => { assert.equal(command, 'refactorPreview.discard'); discarded++; resolvePreview(false); } },
};
const require = createRequire(import.meta.url), original = Module._load;
let applyRefactorEdit, toWorkspaceEdit;
try {
  Module._load = function load(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
  ({ applyRefactorEdit, toWorkspaceEdit } = require('../src/adapters/vscode/language-host.ts'));
} finally { Module._load = original; }

/** 提供实际文档和修订快照，预览是否结束由原生应用桩控制。 */
function fixture() {
  documents.clear(); onOpen = undefined; discarded = 0;
  const uri = 'file:///workspace/page.wxml', text = 'old';
  const document = { uri: stub.Uri.parse(uri), version: 1, text, positionAt: (character) => new stub.Position(0, character), getText(range) { return range ? this.text.slice(range.start.character, range.end.character) : this.text; } };
  documents.set(uri, document);
  const revisions = new Map(), changed = new Emitter();
  const reader = { revision: (uri) => String(revisions.get(uri) ?? 0), onDidChange: changed.event };
  const source = new stub.CancellationTokenSource();
  const edits = [{ uri, range: { start: 0, end: 3 }, oldText: text, expectedText: text, version: 1, newText: 'new' }, { uri: 'file:///workspace/components/card/index.wxml', range: { start: 0, end: 0 }, newText: '<view/>', create: true }];
  const dependencies = [uri, 'file:///workspace/', 'file:///workspace/shared.wxml', 'file:///workspace/missing.wxml'].map((uri) => ({ uri, revision: reader.revision(uri) }));
  const started = new Promise((resolve) => { onApply = resolve; });
  const change = (uri, kind = 'content') => { if (uri) revisions.set(uri, (revisions.get(uri) ?? 0) + 1); changed.fire(uri, kind); };
  return { reader, source, edits, dependencies, started, change, changed, document };
}

test('新文件原子创建时保留完整 UTF-8 内容与预览确认信息', async () => {
  const graph = fixture();
  graph.edits[1].newText = '<view>中文🙂\r\n</view>';
  const edit = await toWorkspaceEdit(graph.edits, graph.source.token, '提取', true);
  assert.equal(edit.entries.length, 2);
  const created = edit.entries.find((entry) => entry.kind === 'create');
  assert.equal(created.args[0].toString(), graph.edits[1].uri);
  assert.equal(created.args[1].overwrite, false);
  assert.equal(new TextDecoder().decode(created.args[1].contents), graph.edits[1].newText);
  assert.deepEqual(created.args[2], { needsConfirmation: true, label: '提取' });
  assert.equal(graph.document.text, 'old');
  const ordinary = await toWorkspaceEdit(graph.edits, graph.source.token);
  assert.deepEqual(ordinary.entries.map((entry) => entry.kind), ['replace', 'create', 'insert']);
  assert.equal(ordinary.entries[1].args[1].contents, undefined);
  assert.equal(ordinary.entries[2].args[2], graph.edits[1].newText);
});

test('只读依赖、缺失候选和配置变化会取消待确认预览且不修改目标', async () => {
  for (const uri of ['file:///workspace/shared.wxml', 'file:///workspace/missing.wxml', undefined]) {
    const graph = fixture();
    const pending = applyRefactorEdit(graph.edits, graph.source, '提取', graph.reader, graph.dependencies);
    await graph.started; graph.change(uri);
    await assert.rejects(pending, /旧预览已取消/);
    assert.equal(discarded, 1); assert.equal(graph.document.text, 'old');
    assert.equal(graph.changed.listeners.size, 0); assert.equal(graph.source.cancellation.listeners.size, 0);
  }
});

test('无关修改及提取自身的文件创建不取消预览，应用后释放依赖监听', async () => {
  const graph = fixture();
  const pending = applyRefactorEdit(graph.edits, graph.source, '提取', graph.reader, graph.dependencies);
  await graph.started;
  graph.change('file:///workspace/unrelated.ts');
  graph.change('file:///workspace/components/card/index.wxml', 'structure');
  graph.change('file:///workspace/', 'structure');
  graph.document.text = 'new'; graph.document.version++; graph.change(graph.document.uri.toString());
  assert.equal(discarded, 0);
  resolvePreview(true); assert.equal(await pending, true);
  assert.equal(graph.changed.listeners.size, 0); assert.equal(graph.source.cancellation.listeners.size, 0);
});

test('生成期间或转换期间的旧依赖不能进入预览，卸载取消也能结束等待', async () => {
  let graph = fixture(); graph.change('file:///workspace/shared.wxml');
  await assert.rejects(applyRefactorEdit(graph.edits, graph.source, '提取', graph.reader, graph.dependencies), /生成期间/);
  graph = fixture(); onOpen = () => graph.change('file:///workspace/shared.wxml');
  await assert.rejects(applyRefactorEdit(graph.edits, graph.source, '提取', graph.reader, graph.dependencies), /生成期间/);
  assert.equal(graph.changed.listeners.size, 0);
  graph = fixture();
  const pending = applyRefactorEdit(graph.edits, graph.source, '提取', graph.reader, graph.dependencies);
  await graph.started; graph.source.cancel();
  assert.equal(await pending, false); assert.equal(discarded, 1);
  assert.equal(graph.changed.listeners.size, 0);
});
