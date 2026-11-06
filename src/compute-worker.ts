import { parentPort, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Cancellation, LanguageRequest, NavigationStep, WorkspaceDependency, WorkspaceReader } from './api';
import type { ScriptSettings } from './api/compute';
import type { ComputeChange, ComputePrepare, ComputeRead, ComputeReadReply, ComputeReply, ComputeRequest } from './compute-protocol';
import { createWorkspaceRevisions, workspaceRevisionKey } from './core/workspace-revisions';
import { createCheckpoint } from './core/cooperative';
import { createDependencyTracking } from './adapters/vscode/dependency-tracking';
import { createWorkerFileCache } from './adapters/worker/file-cache';
import type { WorkerFileSnapshot } from './adapters/worker/file-cache';
import { createMessageBatch } from './adapters/worker/message-batch';
import { createScriptResolver, createComponentScriptResolver, createDataPathPlugin, createScriptNavigationPlugin, createWxsPlugin, prepareScriptCompiler } from './languages/typescript';
import { createProjectFileResolver, createFileNavigationPlugin, createRouteDocumentResolver } from './resolution';

/** 并发语义查询独立保存文档、设置、取消及说明步骤。 */
interface Job { message: ComputeRequest; request: LanguageRequest; steps: NavigationStep[] }
/** 宿主修订与线程修订分别保存，线程内不猜测宿主版本号。 */
interface Version { local: string; host: string }
const port = parentPort!;
const send = createMessageBatch<ComputeRead>((messages) => port.postMessage(messages.length === 1 ? messages[0] : messages));
const contexts = new AsyncLocalStorage<Job>();
const revisions = createWorkspaceRevisions(), tracking = createDependencyTracking(revisions.revision);
const versions = new Map<string, Version>();
const reads = new Map<number, { resolve(value: WorkerFileSnapshot): void; reject(error: Error): void; before: Map<string, string> }>();
const callbacks = new Map<string, { fn: (cancellation: Cancellation) => unknown; group: number; epoch: number }>();
/** 同一查询的详情闭包共用文档，只按批次计入保留文本。 */
const callbackGroups = new Map<number, number>();
const scopes = new Map<number, object>();
let serial = 0, callbackSerial = 0, callbackWeight = 0, epoch = 0;

/** 同一本地修订只能对应一个宿主版本，无事件宿主也不能混用并发快照。 */
function remember(uri: string, host: string): void {
  const key = workspaceRevisionKey(uri), known = versions.get(key);
  let local = revisions.revision(key);
  if (known?.local === local && known.host !== host) {
    revisions.changed(key); local = revisions.revision(key); epoch++; scopes.clear();
  }
  versions.set(key, { host, local });
}

/** 同一异步调用始终使用自身的请求状态。 */
function job(): Job { const value = contexts.getStore(); if (!value) throw new Error('语义查询缺少执行上下文。'); return value; }

/** 根目录按资源归属匹配，远程与虚拟 URI 保留原协议。 */
function root(uri: string): string | undefined {
  let selected: string | undefined;
  for (const value of job().message.roots) if ((!selected || value.length > selected.length) && (uri === value || uri.startsWith(value.replace(/\/$/, '') + '/'))) selected = value;
  return selected;
}

/** 文件 RPC 只传公共读取参数，编译器无需直接访问磁盘。 */
function fetch(method: ComputeRead['method'], args: unknown[]): Promise<WorkerFileSnapshot> {
  const current = job(), id = ++serial;
  const before = new Map<string, string>();
  const directory = method === 'findFiles' ? (args[3] as { root?: string } | undefined)?.root ?? root(String(args[0])) : undefined;
  for (const uri of [String(args[0]), directory].filter((uri): uri is string => !!uri)) before.set(workspaceRevisionKey(uri), revisions.revision(uri));
  return new Promise((resolve, reject) => { reads.set(id, { resolve, reject, before }); send({ kind: 'read', id, job: current.message.id, method, args }); });
}

/** 目录、阴性探测和文件快照都在线程内有界复用，避免重复往返宿主。 */
const files = createWorkerFileCache({ revision: revisions.revision, observe: tracking.observe, load: fetch, entries: (uri) => !!workerData.entries && !!root(uri) });
/** 缺少修订能力时继续逐次读取，不缓存无法确认版本的数据。 */
async function read(method: ComputeRead['method'], args: unknown[]): Promise<unknown> { return workerData.revision ? files.read(method, args) : (await fetch(method, args)).value; }

/** 所有语言端口共用一个只读线程宿主和修订域。 */
const reader: WorkspaceReader = {
  root, capture: tracking.capture,
  ...(workerData.revision ? { revision: tracking.observe } : {}),
  ...(workerData.revision ? { lookup: files.lookup } : {}),
  read: (uri) => read('read', [uri]) as ReturnType<WorkspaceReader['read']>,
  ...(workerData.directory ? { directory: (uri: string) => read('directory', [uri]) as Promise<boolean> } : {}),
  ...(workerData.findFiles ? { findFiles: (...args: Parameters<NonNullable<WorkspaceReader['findFiles']>>) => read('findFiles', args) as Promise<readonly string[]> } : {}),
  fileResolver: (uri, cancellation) => createProjectFileResolver(reader, uri, cancellation),
  navigation: {
    get active() { return !!contexts.getStore()?.message.navigation; },
    record: (step) => { const current = contexts.getStore(); if (current && current.steps.length < 1000) current.steps.push(step); },
    capture: async (provide) => { const value = await provide(); return { value, steps: [...job().steps] }; },
  },
};

/** 资源级设置由宿主逐次快照，同页与跨模板查询使用相同配置规则。 */
function settings(kind: string, uri: string): ScriptSettings {
  const current = job().message;
  return current.settings[uri]?.[kind] ?? current.settings[current.document.uri]?.[kind] ?? {};
}

/** 原有语义实现直接在线程运行，保持候选和类型推断算法。 */
const scripts = createScriptResolver(reader, (uri) => settings('script', uri));
const components = createComponentScriptResolver(reader, (uri) => settings('component', uri));
const context = { logger: { info() {}, error() {} }, subscriptions: { add: <T>(resource: T): T => resource } };
const syntax = createRouteDocumentResolver();
const services: Record<string, unknown> = {
  script: scripts, component: components,
  dataPath: createDataPathPlugin(reader, (uri) => settings('dataPath', uri)).setup(context),
  navigation: createScriptNavigationPlugin(reader, undefined, undefined, (uri) => settings('navigation', uri)).setup(context),
  wxs: createWxsPlugin(reader, (uri) => settings('wxs', uri)).setup(context),
  fileNavigation: createFileNavigationPlugin(reader).setup(context),
  document: { manifest: (_request: LanguageRequest, uri: string, text: string) => syntax.manifest(uri, text), accesses: (request: LanguageRequest) => syntax.accesses(request) },
};
/** 路径解析实例按公开句柄复用，取消始终取当前请求。 */
const paths = new Map<number, import('./api').ProjectFileResolver>();

/** 补全详情仅登记函数句柄，不把编译器对象或闭包传到宿主。 */
function encode(value: unknown): unknown {
  if (typeof value === 'function') {
    const group = job().message.id, id = `${workerData.session}:${++callbackSerial}`;
    if (!callbackGroups.has(group)) { const weight = job().request.document.text.length; callbackGroups.set(group, weight); callbackWeight += weight; }
    callbacks.set(id, { fn: value as (cancellation: Cancellation) => unknown, group, epoch });
    while (callbacks.size > 16384 || callbackGroups.size > 32 || callbackWeight > 4_000_000) {
      const oldest = callbackGroups.keys().next().value!;
      callbackWeight -= callbackGroups.get(oldest)!; callbackGroups.delete(oldest);
      for (const [key, entry] of callbacks) if (entry.group === oldest) callbacks.delete(key);
    }
    return { __miniappCallback: id };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}

/** 公共服务方法显式分派，执行范围限定为内置只读能力。 */
async function execute(message: ComputeRequest): Promise<unknown> {
  if (message.method === 'callback') {
    const callback = callbacks.get(String(message.args[0]));
    return callback?.epoch === epoch ? callback.fn(job().request.cancellation) : undefined;
  }
  if (message.method === 'path') {
    const [id, reference, from, kind] = message.args as [number, string, string, import('./api').FileReferenceKind];
    let resolver = paths.get(id);
    if (!resolver) {
      const cancellation = { get isCancellationRequested() { return job().request.cancellation.isCancellationRequested; } };
      resolver = createProjectFileResolver(reader, message.document.uri, cancellation); paths.set(id, resolver);
      while (paths.size > 128) paths.delete(paths.keys().next().value!);
    }
    return resolver.resolve!(reference, from, kind);
  }
  const names = message.method.split('.');
  let service: unknown = services;
  for (const name of names) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new Error('无效语义方法。');
    service = service && typeof service === 'object' ? (service as Record<string, unknown>)[name] : undefined;
  }
  if (typeof service !== 'function') throw new Error(`语义方法不存在：${message.method}`);
  return service(job().request, ...message.args);
}

/** 线程内先核对本地快照，宿主再按真实修订进行第二次核验。 */
async function query(message: ComputeRequest): Promise<void> {
  const cancellation = new Int32Array(message.cancellation);
  const token = { get isCancellationRequested() { return Atomics.load(cancellation, 0) !== 0; } };
  for (const item of message.baseline) remember(item.uri, item.revision);
  let scope: object | undefined;
  if (message.scope !== undefined) {
    scope = scopes.get(message.scope);
    if (!scope) { scope = {}; scopes.set(message.scope, scope); while (scopes.size > 8) scopes.delete(scopes.keys().next().value!); }
  }
  const request: LanguageRequest = { document: message.document, offset: message.offset, cancellation: token,
    deferCompletionDetails: message.deferCompletionDetails, checkpoint: createCheckpoint(), ...(scope ? { analysisScope: scope } : {}) };
  const current: Job = { message, request, steps: [] };
  const reply: ComputeReply = { kind: 'result', id: message.id, dependencies: [], steps: [], stale: false, unobserved: [] };
  try {
    await contexts.run(current, async () => {
      if (token.isCancellationRequested) return;
      const captured = await tracking.capture(() => execute(message));
      const dependencies: WorkspaceDependency[] = [], unobserved: string[] = [];
      let stale = false;
      for (const item of captured.dependencies) {
        if (revisions.revision(item.uri) !== item.revision) stale = true;
        const known = versions.get(workspaceRevisionKey(item.uri));
        if (known?.local === item.revision) dependencies.push({ uri: item.uri, revision: known.host });
        else unobserved.push(item.uri);
      }
      reply.value = token.isCancellationRequested ? undefined : encode(captured.value);
      reply.dependencies = dependencies; reply.unobserved = unobserved; reply.steps = current.steps; reply.stale = stale;
    });
  } catch (error) { reply.error = error instanceof Error ? error.stack ?? error.message : String(error); }
  port.postMessage(reply);
}

/** 文件变化在同一消息端口顺序处理，旧图按既有修订规则失效。 */
function receive(message: ComputeRequest | ComputePrepare | ComputeChange | ComputeReadReply): void {
  if (message.kind === 'prepare') {
    void prepareScriptCompiler().then(() => port.postMessage({ kind: 'ready' }), (error) => port.postMessage({ kind: 'ready', error: String(error) })); return;
  }
  if (message.kind === 'query') { void query(message); return; }
  if (message.kind === 'change') {
    epoch++; scopes.clear();
    if (!message.uri || message.change === 'configuration') { revisions.invalidate(); versions.clear(); paths.clear(); }
    else {
      const roots = [...versions.keys()].filter((uri) => message.uri!.startsWith(uri.replace(/\/$/, '') + '/')).sort((a, b) => a.length - b.length);
      revisions.changed(message.uri, roots[0], message.change === 'structure');
    }
    return;
  }
  const pending = reads.get(message.id);
  if (!pending) return;
  reads.delete(message.id);
  if (message.error) { pending.reject(new Error(message.error)); return; }
  const dependencies = new Map(pending.before);
  for (const item of message.dependencies) {
    const key = workspaceRevisionKey(item.uri), local = revisions.revision(key);
    if (!pending.before.has(key) || pending.before.get(key) === local) remember(key, item.revision);
    if (!dependencies.has(key)) dependencies.set(key, revisions.revision(key));
  }
  if (versions.size > 65536) { versions.clear(); revisions.invalidate(); epoch++; scopes.clear(); paths.clear(); }
  pending.resolve({ value: message.value, dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })), stale: message.stale });
}
/** 批内响应按原顺序分派，每条读取仍保留自己的调用者和修订。 */
port.on('message', (message: ComputeRequest | ComputePrepare | ComputeChange | ComputeReadReply | ComputeReadReply[]) => {
  if (Array.isArray(message)) for (const item of message) receive(item);
  else receive(message);
});
