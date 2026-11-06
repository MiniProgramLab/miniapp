import { Worker } from 'node:worker_threads';
import type { Cancellation, LanguageRequest, LanguageResult, Logger, WorkspaceDependency, WorkspaceReader } from '../../api';
import type { ComputeChange, ComputeRead, ComputeReadReply, ComputeReady, ComputeReply, ComputeRequest, ComputeSettings } from '../../compute-protocol';
import { createMessageBatch } from './message-batch';

/** 每次查询保留宿主修订与共享取消位，不跨请求借用文件版本。 */
interface Pending {
  request: LanguageRequest; cancellation: Int32Array; dependencies: Map<string, string>;
  resolve(value: ComputeReply): void; reject(error: Error): void;
}
/** 工作线程启动参数由组合入口提供，适配器不导入语言内部实现。 */
export interface ComputeHost {
  filename: string; reader: WorkspaceReader; logger: Logger;
  roots(): readonly string[];
  settings(uri: string): ComputeSettings;
}
/** 消费端只接收已核验的结果和依赖。 */
export interface Computed<T> { value: T; dependencies: readonly WorkspaceDependency[] }
/** 详情句柄失效时保留原语言端口，可按同一候选重新计算。 */
interface Origin { method: string; args: unknown[]; fallback?: (request: LanguageRequest) => LanguageResult<unknown> }

/** 按需启动一个语义线程，文件访问、草稿与配置仍由宿主掌握。 */
export class ComputeTransport {
  private worker: Worker | undefined;
  private readonly jobs = new Map<number, Pending>();
  private readonly versions = new Map<string, string>();
  private readonly scopes = new WeakMap<object, number>();
  private serial = 0;
  private generation = 0;
  private scopeSerial = 0;
  private disposed = false;
  private failures = 0;
  private failedUntil = 0;
  private reported = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly changes: import('../../api').Disposable | undefined;

  /** 文件事件在下一查询之前发送，配置变化使线程内缓存整体失效。 */
  constructor(private readonly host: ComputeHost) {
    this.changes = host.reader.onDidChange?.((uri, change) => {
      // 草稿新增或关闭可能同时改变目录可见性，只补发实际变化的已观察祖先。
      if (uri && (change === 'open' || change === 'close') && host.reader.revision) for (const [parent, version] of this.versions) {
        if (uri.startsWith(parent.replace(/\/$/, '') + '/')) {
          const current = host.reader.revision(parent);
          if (current !== version) { this.worker?.postMessage({ kind: 'change', uri: parent, change: 'content' }); this.versions.set(parent, current); }
        }
      }
      const message: ComputeChange = { kind: 'change', ...(uri ? { uri } : {}), ...(change ? { change } : {}) };
      this.worker?.postMessage(message);
    });
  }

  /** 重置异常线程，已开始的请求由各自调用者决定是否回退。 */
  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    if (++this.failures >= 2) this.failedUntil = Date.now() + 5000;
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear(); this.stopTimer();
    void worker.terminate();
  }

  /** 模板打开或首次语义交互共用一个独立线程。 */
  private start(): Worker {
    if (this.disposed) throw new Error('语义线程已卸载。');
    if (Date.now() < this.failedUntil) throw new Error('语义线程暂时不可用。');
    if (this.worker) return this.worker;
    const worker = new Worker(this.host.filename, { workerData: { session: ++this.generation,
      revision: !!this.host.reader.revision, directory: !!this.host.reader.directory, entries: !!this.host.reader.entries, findFiles: !!this.host.reader.findFiles } });
    this.worker = worker;
    const send = createMessageBatch<ComputeReadReply>((messages) => { if (worker === this.worker) worker.postMessage(messages.length === 1 ? messages[0] : messages); });
    worker.on('message', (message: ComputeReply | ComputeRead | ComputeRead[] | ComputeReady) => {
      if (Array.isArray(message)) { for (const item of message) void this.read(worker, item, send); }
      else if (message.kind === 'ready') { if (message.error) this.fail(worker, new Error(message.error)); }
      else if (message.kind === 'read') void this.read(worker, message, send);
      else {
        if (!message.error) { this.failures = 0; this.reported = false; }
        const job = this.jobs.get(message.id);
        if (job) { this.jobs.delete(message.id); job.resolve(message); }
        if (!this.jobs.size) this.stopTimer();
      }
    });
    worker.on('error', (error) => this.fail(worker, error));
    worker.on('exit', (code) => this.fail(worker, new Error(`语义线程退出：${code}`)));
    return worker;
  }

  /** 只在明确需要模板语义时准备线程，空闲期间不读取工程文件。 */
  prepare(): void {
    if (this.disposed || this.worker || Date.now() < this.failedUntil) return;
    try { this.start().postMessage({ kind: 'prepare' }); }
    catch (error) { this.report('语义线程准备失败，将在实际查询时重试。', error); }
  }

  /** 查询完成后释放轮询，避免空闲线程持续唤醒宿主。 */
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** 共享取消位在编译器同步执行期间也可读取。 */
  private poll(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { for (const job of this.jobs.values()) if (job.request.cancellation.isCancellationRequested) Atomics.store(job.cancellation, 0, 1); }, 10);
    this.timer.unref();
  }

  /** 文件 RPC 在宿主读取快照，返回读取前的真实修订。 */
  private async read(worker: Worker, message: ComputeRead, send: (reply: ComputeReadReply) => void): Promise<void> {
    if (worker !== this.worker) return;
    const job = this.jobs.get(message.job), reader = this.host.reader;
    if (!job) {
      send({ kind: 'read-result', id: message.id, value: undefined, dependencies: [], stale: true }); return;
    }
    try {
      const uri = String(message.args[0]);
      const before = reader.revision?.(uri);
      if (before !== undefined && !job.dependencies.has(uri)) job.dependencies.set(uri, before);
      const provide = async (): Promise<unknown> => {
        if (message.method === 'read') return reader.read(uri);
        if (message.method === 'directory') return reader.directory?.(uri) ?? false;
        if (message.method === 'entries') return reader.entries?.(uri);
        return reader.findFiles?.(uri, String(message.args[1]), Number(message.args[2]), message.args[3] as { root: string } | undefined) ?? [];
      };
      const result = reader.capture ? await reader.capture(provide) : { value: await provide(), dependencies: [] };
      if (worker !== this.worker) return;
      const dependencies = new Map(result.dependencies.map((item) => [item.uri, item.revision]));
      if (before !== undefined) dependencies.set(uri, before);
      if (message.method === 'findFiles') {
        const root = (message.args[3] as { root?: string } | undefined)?.root ?? reader.root(uri);
        if (root && reader.revision && !dependencies.has(root)) dependencies.set(root, reader.revision(root));
      }
      for (const [key, version] of dependencies) {
        if (!job.dependencies.has(key)) job.dependencies.set(key, version);
        if (!reader.revision || reader.revision(key) === version) this.versions.set(key, version);
      }
      send({ kind: 'read-result', id: message.id, value: result.value,
        dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })),
        stale: !!reader.revision && [...dependencies].some(([uri, revision]) => reader.revision!(uri) !== revision) });
    } catch (error) {
      send({ kind: 'read-result', id: message.id, error: String(error), dependencies: [], stale: true });
    }
  }

  /** 配置按本次请求涉及的资源取快照，跨模板调用保留各资源设置。 */
  private settings(request: LanguageRequest, args: unknown[]): Record<string, ComputeSettings> {
    const uris = new Set([request.document.uri]);
    const visit = (value: unknown, depth: number): void => {
      if (depth > 16 || uris.size >= 128) return;
      if (typeof value === 'string' && /^(?:file|vscode-remote|untitled|memfs):/.test(value)) uris.add(value);
      else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (key !== 'text' && key !== 'cancellation') visit(item, depth + 1);
    };
    visit(args, 0);
    return Object.fromEntries([...uris].map((uri) => [uri, this.host.settings(uri)]));
  }

  /** 补全详情函数留在线程内，宿主只保留有界句柄与原请求版本。 */
  private revive(value: unknown, request: LanguageRequest, generation: number, dependencies: Map<string, string>, origin: Origin, label?: string): unknown {
    if (Array.isArray(value)) return value.map((item) => this.revive(item, request, generation, dependencies, origin));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 1 && typeof record.__miniappCallback === 'string') {
        const id = record.__miniappCallback;
        return async (cancellation: Cancellation): Promise<unknown> => {
          if (cancellation.isCancellationRequested) return undefined;
          if (generation === this.generation && this.worker) {
            try { const result = (await this.query('callback', { ...request, cancellation }, [id])).value; if (result !== undefined) return result; }
            catch { /* 线程重启或句柄回收后按原查询重新核对详情。 */ }
          }
          if (label === undefined) return undefined;
          const current = { ...request, cancellation, deferCompletionDetails: false };
          let items: readonly import('../../api').Completion[] | undefined;
          try { items = (await this.query<typeof items>(origin.method, current, origin.args)).value; }
          catch (error) {
            if (this.disposed || cancellation.isCancellationRequested) return undefined;
            this.report('语义线程详情失败，使用原有解析器重新核对。', error);
            items = await origin.fallback?.(current) as typeof items;
          }
          const selected = items?.find((item) => item.label === label);
          return selected ? { detail: selected.detail, documentation: selected.documentation } : undefined;
        };
      }
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, key === 'dependencies' && Array.isArray(item)
        ? item.map((dependency: WorkspaceDependency) => ({ uri: dependency.uri, revision: dependencies.get(dependency.uri) ?? this.host.reader.revision?.(dependency.uri) ?? dependency.revision }))
        : this.revive(item, request, generation, dependencies, origin, typeof record.label === 'string' ? record.label : label)]));
    }
    return value;
  }

  /** 依赖在执行途中变化时重试，持续变化时交给同一语义实现重新查询。 */
  async query<T>(method: string, request: LanguageRequest, args: unknown[] = [], fallback?: (request: LanguageRequest) => LanguageResult<T>): Promise<Computed<T>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = this.start(), reader = this.host.reader;
      if (request.cancellation.isCancellationRequested) return { value: undefined as T, dependencies: [] };
      // 无事件宿主也核对已观察依赖，变化先送入线程再开始新查询。
      if (!this.changes && reader.revision) for (const [uri, version] of this.versions) if (reader.revision(uri) !== version) {
        worker.postMessage({ kind: 'change', uri, change: 'content' }); this.versions.set(uri, reader.revision(uri));
      }
      const dependencies = new Map<string, string>();
      for (const uri of [request.document.uri, ...this.host.roots()]) if (reader.revision) dependencies.set(uri, reader.revision(uri));
      const cancellation = new Int32Array(new SharedArrayBuffer(4)), id = ++this.serial;
      let scope: number | undefined;
      if (request.analysisScope) {
        scope = this.scopes.get(request.analysisScope);
        if (scope === undefined) { scope = ++this.scopeSerial; this.scopes.set(request.analysisScope, scope); }
      }
      const message: ComputeRequest = { kind: 'query', id, method, args, document: request.document,
        offset: request.offset,
        cancellation: cancellation.buffer as SharedArrayBuffer, roots: this.host.roots(), settings: this.settings(request, args),
        baseline: [...dependencies].map(([uri, revision]) => ({ uri, revision })),
        deferCompletionDetails: !!request.deferCompletionDetails, navigation: !!reader.navigation?.active, ...(scope === undefined ? {} : { scope }) };
      const reply = await new Promise<ComputeReply>((resolve, reject) => {
        this.jobs.set(id, { request, cancellation, dependencies, resolve, reject }); this.poll(); worker.postMessage(message);
      });
      if (reply.error) throw new Error(reply.error);
      for (const item of reply.dependencies) if (!dependencies.has(item.uri)) dependencies.set(item.uri, item.revision);
      for (const uri of reply.unobserved) if (reader.revision && !dependencies.has(uri)) dependencies.set(uri, reader.revision(uri));
      const changed = reader.revision ? [...dependencies].filter(([uri, version]) => reader.revision!(uri) !== version) : [];
      if ((reply.stale || changed.length) && !request.cancellation.isCancellationRequested) {
        // 已有文件事件无需再次全局失效，避免并发重试互相废弃刚完成的图。
        if (!this.changes && reader.revision) for (const [uri] of changed) {
          const current = reader.revision(uri);
          if (this.versions.get(uri) !== current) { worker.postMessage({ kind: 'change', uri, change: 'content' }); this.versions.set(uri, current); }
        }
        continue;
      }
      for (const step of reply.steps) reader.navigation?.record(step);
      for (const [uri, version] of dependencies) if (!reader.revision || reader.revision(uri) === version) this.versions.set(uri, version);
      while (this.versions.size > 8192) this.versions.delete(this.versions.keys().next().value!);
      return { value: this.revive(reply.value, request, this.generation, dependencies, { method, args, ...(fallback ? { fallback } : {}) }) as T, dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })) };
    }
    throw new Error('查询期间依赖持续变化，请重新获取语义快照。');
  }

  /** 线程异常时沿用原有语言端口，查询错误不会破坏编辑器能力。 */
  async run<T>(method: string, request: LanguageRequest, args: unknown[], fallback: (request: LanguageRequest) => LanguageResult<T>): Promise<T> {
    if (request.cancellation.isCancellationRequested) return fallback(request);
    try { const result = await this.query<T>(method, request, args, fallback); return request.cancellation.isCancellationRequested ? fallback(request) : result.value; }
    catch (error) { if (this.disposed) return undefined as T; this.report('语义线程查询失败，使用原有解析器重新核对。', error); return fallback(request); }
  }

  /** 连续启动失败只记录一次，避免降级期间反复输出同一错误。 */
  report(message: string, error: unknown): void { if (!this.reported && !this.disposed) { this.reported = true; this.host.logger.error(message, error); } }

  /** 卸载后取消在途任务并关闭线程，不遗留文件访问或定时器。 */
  dispose(): void {
    this.disposed = true; this.changes?.dispose(); this.stopTimer();
    this.versions.clear();
    const worker = this.worker;
    if (worker) this.fail(worker, new Error('语义线程已卸载。'));
  }
}
