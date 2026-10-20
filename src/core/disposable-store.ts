import type { Disposable, ResourceScope } from '../api';

/** 按创建顺序的逆序释放资源，单个异常不会阻止剩余清理。 */
export class DisposableStore implements Disposable, ResourceScope {
  private readonly resources = new Set<Disposable>();
  private disposed = false;

  /** 注入错误接收器，避免底座直接依赖控制台或编辑器。 */
  constructor(private readonly onError: (error: unknown) => void) {}

  /** 已关闭的容器立即释放新资源，防止延迟注册泄漏。 */
  add<T extends Disposable>(resource: T): T {
    if (this.disposed) this.release(resource);
    else this.resources.add(resource);
    return resource;
  }

  /** 清空后再执行清理，使递归调用和重复释放保持幂等。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const resources = [...this.resources].reverse();
    this.resources.clear();
    for (const resource of resources) this.release(resource);
  }

  /** 即使日志接收器失败，也继续释放其他资源。 */
  private release(resource: Disposable): void {
    try {
      resource.dispose();
    } catch (error) {
      try { this.onError(error); } catch { /* 清理期间不再传播日志异常。 */ }
    }
  }
}
