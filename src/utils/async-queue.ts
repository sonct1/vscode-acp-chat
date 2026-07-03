/**
 * Serializes async tasks so each one finishes before the next starts.
 * Prevents race conditions when multiple callers enqueue work concurrently
 * (e.g. rapid session updates or webview postMessage calls).
 * Provides waitForIdle() so callers can wait until all queued work drains.
 */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private idleResolvers: Array<() => void> = [];
  private disposed = false;

  enqueue(task: () => Promise<void>): void {
    if (this.disposed) return;
    this.pendingCount++;
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
        } catch (error) {
          console.error("[AsyncSerialQueue] Error:", error);
        }
      })
      .then(() => {
        this.pendingCount--;
        if (this.pendingCount === 0) {
          this.drainResolvers();
        }
      });
  }

  private drainResolvers(): void {
    const resolvers = this.idleResolvers.splice(0);
    for (const r of resolvers) r();
  }

  waitForIdle(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve();
    if (this.disposed) return this.tail.catch(() => undefined);
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.drainResolvers();
  }
}

/**
 * Combines an item buffer with AsyncSerialQueue. Items pushed via push() are
 * queued and processed one-at-a-time through the provided handler, preserving
 * insertion order. waitForIdle() resolves once the handler has run for every
 * item that was pushed before the call.
 */
export class AsyncSerialProcessor<T> {
  private pending: T[] = [];
  private notifier = new AsyncSerialQueue();
  private disposed = false;

  constructor(private handler: (item: T) => Promise<void>) {}

  push(item: T): void {
    if (this.disposed) return;
    this.pending.push(item);
    this.notifier.enqueue(async () => {
      if (this.disposed || this.pending.length === 0) return;
      await this.handler(this.pending.shift() as T);
    });
  }

  waitForIdle(): Promise<void> {
    return this.notifier.waitForIdle();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.notifier.dispose();
  }
}
