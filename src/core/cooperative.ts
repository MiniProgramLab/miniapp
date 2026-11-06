import type { Cancellation } from '../api';

/** 批量解析按时间片让出线程，使交互和取消事件及时进入。 */
export function createCheckpoint(milliseconds = 8): (cancellation: Cancellation) => Promise<boolean> {
  let deadline = Date.now() + milliseconds;
  return async (cancellation) => {
    if (cancellation.isCancellationRequested) return false;
    if (Date.now() >= deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      deadline = Date.now() + milliseconds;
    }
    return !cancellation.isCancellationRequested;
  };
}
