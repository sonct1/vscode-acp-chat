import * as assert from "assert";
import { AsyncSerialQueue, AsyncSerialProcessor } from "../utils/async-queue";

suite("AsyncSerialQueue", () => {
  test("tasks execute serially in order", async () => {
    const queue = new AsyncSerialQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      await delay(20);
      order.push(1);
    });
    queue.enqueue(async () => {
      order.push(2);
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    await queue.waitForIdle();
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  test("waitForIdle resolves immediately when idle", async () => {
    const queue = new AsyncSerialQueue();
    let resolved = false;
    queue.waitForIdle().then(() => {
      resolved = true;
    });
    await delay(5);
    assert.strictEqual(resolved, true);
  });

  test("waitForIdle resolves after queued tasks complete", async () => {
    const queue = new AsyncSerialQueue();
    let done = false;

    queue.enqueue(async () => {
      await delay(20);
    });
    queue.enqueue(async () => {
      await delay(20);
    });

    queue.waitForIdle().then(() => {
      done = true;
    });

    assert.strictEqual(done, false);
    await queue.waitForIdle();
    assert.strictEqual(done, true);
  });

  test("error in task does not break the chain", async () => {
    const queue = new AsyncSerialQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      order.push(1);
    });
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    await queue.waitForIdle();
    assert.deepStrictEqual(order, [1, 3]);
  });

  test("multiple concurrent waitForIdle calls all resolve", async () => {
    const queue = new AsyncSerialQueue();

    queue.enqueue(async () => {
      await delay(10);
    });

    const p1 = queue.waitForIdle();
    const p2 = queue.waitForIdle();
    const p3 = queue.waitForIdle();

    await Promise.all([p1, p2, p3]);
  });

  test("dispose rejects new enqueues but lets in-flight tasks complete", async () => {
    const queue = new AsyncSerialQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      order.push(1);
    });
    // Task 1 is already in the chain — it will complete.
    queue.dispose();
    // This enqueue is rejected because disposed=true.
    queue.enqueue(async () => {
      order.push(2);
    });

    await queue.waitForIdle();
    assert.deepStrictEqual(order, [1]);
  });

  test("dispose resolves pending waitForIdle callers immediately", async () => {
    const queue = new AsyncSerialQueue();

    queue.enqueue(async () => {
      await delay(100);
    });

    let resolved = false;
    queue.waitForIdle().then(() => {
      resolved = true;
    });

    await delay(5);
    assert.strictEqual(resolved, false);

    queue.dispose();
    await delay(5);
    assert.strictEqual(resolved, true);
  });
});

suite("AsyncSerialProcessor", () => {
  test("items processed in order through handler", async () => {
    const order: number[] = [];
    const processor = new AsyncSerialProcessor<number>(async (item) => {
      await delay(item === 2 ? 20 : 0);
      order.push(item);
    });

    processor.push(1);
    processor.push(2);
    processor.push(3);

    await processor.waitForIdle();
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  test("waitForIdle resolves after all items processed", async () => {
    let count = 0;
    const processor = new AsyncSerialProcessor<number>(async () => {
      await delay(5);
      count++;
    });

    for (let i = 0; i < 5; i++) {
      processor.push(i);
    }

    await processor.waitForIdle();
    assert.strictEqual(count, 5);
  });

  test("dispose clears pending items", async () => {
    const processed: number[] = [];
    const processor = new AsyncSerialProcessor<number>(async (item) => {
      await delay(10);
      processed.push(item);
    });

    processor.push(1);
    processor.dispose();

    processor.push(2);
    processor.push(3);

    await delay(30);
    assert.deepStrictEqual(processed, []);
  });

  test("dispose resolves waitForIdle callers immediately", async () => {
    const processor = new AsyncSerialProcessor<number>(async () => {
      await delay(100);
    });

    processor.push(1);

    let resolved = false;
    processor.waitForIdle().then(() => {
      resolved = true;
    });

    await delay(5);
    assert.strictEqual(resolved, false);

    processor.dispose();
    await delay(5);
    assert.strictEqual(resolved, true);
  });

  test("error in handler does not stop subsequent items", async () => {
    const order: number[] = [];
    const processor = new AsyncSerialProcessor<number>(async (item) => {
      if (item === 2) throw new Error("boom");
      order.push(item);
    });

    processor.push(1);
    processor.push(2);
    processor.push(3);

    await processor.waitForIdle();
    assert.deepStrictEqual(order, [1, 3]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
