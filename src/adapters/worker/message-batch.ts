/** 同一轮消息合并发送，不等待下一计时器，也不阻塞较快的文件读取。 */
export function createMessageBatch<T>(send: (messages: T[]) => void) {
  let pending: T[] = [];
  return (message: T): void => {
    pending.push(message);
    if (pending.length !== 1) return;
    queueMicrotask(() => {
      const messages = pending; pending = [];
      for (let offset = 0; offset < messages.length; offset += 64) send(messages.slice(offset, offset + 64));
    });
  };
}
