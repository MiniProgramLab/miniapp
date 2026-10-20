import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageHost, LanguagePlugin, Logger } from '../src/api';
import { DisposableStore } from '../src/core/disposable-store';
import { PluginRuntime } from '../src/core/plugin-runtime';

/** 使用内存宿主验证底座行为，不加载编辑器模块。 */
function fixture() {
  const events: string[] = [];
  const logger: Logger = { info: (message) => events.push(message), error: (message) => events.push(message) };
  const host: LanguageHost = { register: (plugin) => {
    events.push(`注册:${plugin.id}`);
    return { dispose: () => events.push(`卸载:${plugin.id}`) };
  } };
  return { events, logger, runtime: new PluginRuntime(host, logger) };
}

/** 创建带有真实待清理资源的测试插件。 */
function plugin(id: string, events: string[]): LanguagePlugin {
  return { id, displayName: id, languages: [id], setup: ({ subscriptions }) => {
    subscriptions.add({ dispose: () => events.push(`释放:${id}`) });
    return {};
  } };
}

test('多个语言独立注册，卸载其中一个不会影响另一个', () => {
  const { runtime, events } = fixture();
  const first = runtime.register(plugin('first', events));
  runtime.register(plugin('second', events));
  first.dispose();
  first.dispose();
  assert.deepEqual(runtime.getPlugins().map((item) => item.id), ['second']);
  assert.deepEqual(events.slice(2), ['卸载:first', '释放:first']);
  runtime.dispose();
  assert.deepEqual(events.slice(-2), ['卸载:second', '释放:second']);
});

test('重复标识符在执行初始化之前被拒绝', () => {
  const { runtime, events } = fixture();
  runtime.register(plugin('same', events));
  let called = false;
  assert.throws(() => runtime.register({ ...plugin('same', events), setup: () => { called = true; return {}; } }), /已注册/);
  assert.equal(called, false);
  runtime.dispose();
});

test('初始化失败自动回滚，随后可用同一标识符重新注册', () => {
  const { runtime, events } = fixture();
  assert.throws(() => runtime.register({ ...plugin('broken', events), setup: ({ subscriptions }) => {
    subscriptions.add({ dispose: () => events.push('回滚') });
    throw new Error('初始化失败');
  } }), /初始化失败/);
  assert.deepEqual(events, ['回滚']);
  assert.deepEqual(runtime.getPlugins(), []);
  runtime.register(plugin('broken', events));
  runtime.dispose();
});

test('宿主注册失败也会释放插件自身资源', () => {
  const { logger, events } = fixture();
  const runtime = new PluginRuntime({ register: () => { throw new Error('宿主失败'); } }, logger);
  assert.throws(() => runtime.register(plugin('broken', events)), /宿主失败/);
  assert.deepEqual(events, ['释放:broken']);
  assert.equal(runtime.getPlugins().length, 0);
});

test('旧注册句柄不会卸载新注册的同名插件', () => {
  const { runtime, events } = fixture();
  const old = runtime.register(plugin('same', events));
  old.dispose();
  runtime.register(plugin('same', events));
  old.dispose();
  assert.equal(runtime.getPlugins().length, 1);
  runtime.dispose();
});

test('底座逆序关闭，已关闭底座拒绝注册，快照不能被外部修改', () => {
  const { runtime, events } = fixture();
  const api = runtime.createApi();
  api.registerPlugin(plugin('first', events));
  api.registerPlugin(plugin('second', events));
  assert.equal(api.apiVersion, 1);
  assert.ok(Object.isFrozen(api));
  assert.ok(Object.isFrozen(api.getPlugins()));
  assert.ok(Object.isFrozen(api.getPlugins()[0]?.languages));
  runtime.dispose();
  runtime.dispose();
  assert.deepEqual(events.slice(2), ['卸载:second', '释放:second', '卸载:first', '释放:first']);
  assert.throws(() => api.registerPlugin(plugin('third', events)), /已关闭/);
});

test('初始化期间递归注册同一标识符被拒绝', () => {
  const { runtime, events } = fixture();
  runtime.register({ ...plugin('same', events), setup: () => {
    assert.throws(() => runtime.register(plugin('same', events)), /已注册/);
    return {};
  } });
  runtime.dispose();
});

test('单个资源或日志异常不阻止其他资源释放', () => {
  const events: number[] = [];
  const store = new DisposableStore(() => { throw new Error('日志失败'); });
  store.add({ dispose: () => events.push(1) });
  store.add({ dispose: () => { throw new Error('释放失败'); } });
  store.add({ dispose: () => events.push(2) });
  store.dispose();
  store.add({ dispose: () => events.push(3) });
  assert.deepEqual(events, [2, 1, 3]);
});
