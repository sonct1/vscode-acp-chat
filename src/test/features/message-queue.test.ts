import * as assert from "assert";
import {
  MessageQueueController,
  type ComposerPayload,
} from "../../features/message-queue";

function payload(text: string): ComposerPayload {
  return { text, images: [], mentions: [], composerHtml: text };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

suite("message queue controller", () => {
  test("acknowledges immediate dispatch without awaiting the agent turn", async () => {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatched: string[] = [];
    const controller = new MessageQueueController({
      isBusy: () => false,
      dispatch: async (item) => {
        dispatched.push(item.text);
        await turn;
      },
      cancel: async () => {},
      onState: () => {},
    });

    const result = await controller.submit({
      id: "first",
      intent: "steer",
      payload: payload("first"),
    });

    assert.strictEqual(result, "dispatched");
    assert.deepStrictEqual(dispatched, ["first"]);
    release();
  });

  test("runs at most one dispatch and marks busy submissions for draining", async () => {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatched: string[] = [];
    const controller = new MessageQueueController({
      isBusy: () => false,
      dispatch: async (item) => {
        dispatched.push(item.text);
        await turn;
      },
      cancel: async () => {},
      onState: () => {},
    });

    assert.strictEqual(
      await controller.submit({
        id: "a",
        intent: "steer",
        payload: payload("a"),
      }),
      "dispatched"
    );
    assert.strictEqual(
      await controller.submit({
        id: "b",
        intent: "followUp",
        payload: payload("b"),
      }),
      "queued"
    );
    assert.deepStrictEqual(dispatched, ["a"]);
    assert.strictEqual(controller.getSnapshot().processing, true);
    release();
    await tick();
    await tick();
    assert.deepStrictEqual(dispatched, ["a", "b"]);
  });

  test("drains steering before follow-up FIFO", async () => {
    let busy = true;
    const dispatched: string[] = [];
    const controller = new MessageQueueController({
      isBusy: () => busy,
      dispatch: async (item) => {
        busy = true;
        dispatched.push(item.text);
      },
      cancel: async () => {},
      onState: () => {},
    });

    assert.strictEqual(
      await controller.submit({
        id: "f1",
        intent: "followUp",
        payload: payload("follow"),
      }),
      "queued"
    );
    assert.strictEqual(
      await controller.submit({
        id: "s1",
        intent: "steer",
        payload: payload("steer"),
      }),
      "queued"
    );
    busy = false;
    controller.notifyStateChanged();
    await tick();
    assert.deepStrictEqual(dispatched, ["steer"]);
    busy = false;
    controller.notifyStateChanged();
    await tick();
    assert.deepStrictEqual(dispatched, ["steer", "follow"]);
  });

  test("restores queued messages without aborting current dispatch", async () => {
    let cancelCount = 0;
    const controller = new MessageQueueController({
      isBusy: () => true,
      dispatch: async () => {},
      cancel: async () => {
        cancelCount += 1;
      },
      onState: () => {},
    });

    await controller.submit({
      id: "s1",
      intent: "steer",
      payload: payload("steer"),
    });
    await controller.submit({
      id: "f1",
      intent: "followUp",
      payload: payload("follow"),
    });
    const restored = controller.restoreQueuedWithoutAbort(payload("draft"));
    assert.deepStrictEqual(
      restored.map((item) => item.text),
      ["steer", "follow", "draft"]
    );
    assert.strictEqual(cancelCount, 0);
    assert.strictEqual(controller.hasQueued(), false);
  });

  test("aborts and restores queued messages plus current draft", async () => {
    let cancelCount = 0;
    const controller = new MessageQueueController({
      isBusy: () => true,
      dispatch: async () => {},
      cancel: async () => {
        cancelCount += 1;
      },
      onState: () => {},
    });

    await controller.submit({
      id: "s1",
      intent: "steer",
      payload: payload("steer"),
    });
    const restored = await controller.abortAndRestore(payload("draft"));
    assert.deepStrictEqual(
      restored.map((item) => item.text),
      ["steer", "draft"]
    );
    assert.strictEqual(cancelCount, 1);
  });

  test("failure stops automatic draining and preserves remaining queue", async () => {
    const dispatched: string[] = [];
    const controller = new MessageQueueController({
      isBusy: () => false,
      dispatch: async (item) => {
        dispatched.push(item.text);
        if (item.text === "first") throw new Error("boom");
      },
      cancel: async () => {},
      onState: () => {},
    });

    assert.strictEqual(
      await controller.submit({
        id: "first",
        intent: "steer",
        payload: payload("first"),
      }),
      "dispatched"
    );
    assert.strictEqual(
      await controller.submit({
        id: "second",
        intent: "followUp",
        payload: payload("second"),
      }),
      "queued"
    );
    await tick();
    assert.deepStrictEqual(dispatched, ["first"]);
    assert.deepStrictEqual(
      controller.restoreQueuedWithoutAbort().map((item) => item.text),
      ["second"]
    );
  });
});
