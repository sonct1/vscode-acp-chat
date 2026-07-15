import type {
  ComposerPayload,
  MessageQueueSnapshot,
  QueuedComposerMessage,
  QueueIntent,
  QueueSubmitDisposition,
} from "./types";

export interface MessageQueueControllerOptions {
  sessionId?: string;
  isBusy: () => boolean;
  dispatch: (payload: ComposerPayload) => Promise<void>;
  cancel: () => Promise<void>;
  onState: (snapshot: MessageQueueSnapshot) => void;
}

export function createMessageQueueController(
  options: MessageQueueControllerOptions
): MessageQueueController {
  return new MessageQueueController(options);
}

export function registerMessageQueueHostFeature(): {
  createController(
    options: MessageQueueControllerOptions
  ): MessageQueueController;
} {
  return { createController: createMessageQueueController };
}

export class MessageQueueController {
  private revision = 0;
  private readonly steering: QueuedComposerMessage[] = [];
  private readonly followUp: QueuedComposerMessage[] = [];
  private inFlight = false;
  private drainRequested = false;
  private pumpRunning = false;
  private failed = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: MessageQueueControllerOptions) {}

  async submit(request: {
    id: string;
    intent: QueueIntent;
    payload: ComposerPayload;
  }): Promise<QueueSubmitDisposition> {
    if (!hasPayloadContent(request.payload)) return "rejected";

    if (
      this.failed ||
      this.options.isBusy() ||
      this.inFlight ||
      this.pumpRunning ||
      this.hasQueued()
    ) {
      this.enqueue(request.id, request.intent, request.payload);
      this.drainRequested = true;
      this.emit();
      this.startPump();
      return "queued";
    }

    this.drainRequested = true;
    this.emit();
    this.startPump(request.payload);
    return "dispatched";
  }

  async abortAndRestore(
    currentDraft?: ComposerPayload
  ): Promise<ComposerPayload[]> {
    const restored = this.detachQueued();
    if (currentDraft && hasPayloadContent(currentDraft))
      restored.push(currentDraft);
    this.emit();
    if (this.options.isBusy() || this.pumpRunning) await this.options.cancel();
    return restored;
  }

  restoreQueuedWithoutAbort(currentDraft?: ComposerPayload): ComposerPayload[] {
    const restored = this.detachQueued();
    if (currentDraft && hasPayloadContent(currentDraft))
      restored.push(currentDraft);
    this.emit();
    return restored;
  }

  getSnapshot(): MessageQueueSnapshot {
    return {
      type: "feature.message-queue.state",
      sessionId: this.options.sessionId,
      revision: this.revision,
      ownership: "host",
      processing: this.isProcessing(),
      steering: [...this.steering],
      followUp: [...this.followUp],
      effectiveSteering: "after-current-acp-turn",
    };
  }

  notifyStateChanged(): void {
    this.emit();
    this.startPump();
  }

  waitForIdle(): Promise<void> {
    if (this.isIdleForWait()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  hasQueued(): boolean {
    return this.steering.length > 0 || this.followUp.length > 0;
  }

  isDrainActive(): boolean {
    return this.isProcessing();
  }

  private enqueue(
    id: string,
    intent: QueueIntent,
    payload: ComposerPayload
  ): void {
    const item: QueuedComposerMessage = {
      id,
      intent,
      payload,
      createdAt: Date.now(),
    };
    if (intent === "steer") this.steering.push(item);
    else this.followUp.push(item);
  }

  private startPump(initialPayload?: ComposerPayload): void {
    if (this.pumpRunning || this.failed) return;
    if (
      !initialPayload &&
      (!this.drainRequested || this.options.isBusy() || !this.hasQueued())
    )
      return;
    this.pumpRunning = true;
    this.inFlight = true;
    void this.pump(initialPayload);
  }

  private async pump(initialPayload?: ComposerPayload): Promise<void> {
    let nextPayload = initialPayload;
    try {
      while (nextPayload || (this.drainRequested && !this.options.isBusy())) {
        if (!nextPayload) {
          const next = this.dequeueNext();
          if (!next) break;
          nextPayload = next.payload;
        }
        this.emit();
        await this.options.dispatch(nextPayload);
        nextPayload = undefined;
      }
    } catch (error) {
      this.failed = true;
      this.drainRequested = false;
      console.error(
        "[MessageQueue] Dispatch failed; automatic drain stopped",
        error
      );
    } finally {
      this.pumpRunning = false;
      this.inFlight = false;
      if (!this.hasQueued()) this.drainRequested = false;
      this.emit();
      this.resolveIdleWaitersIfIdle();
    }
  }

  private dequeueNext(): QueuedComposerMessage | undefined {
    return this.steering.shift() ?? this.followUp.shift();
  }

  private detachQueued(): ComposerPayload[] {
    const payloads = [...this.steering, ...this.followUp].map(
      (item) => item.payload
    );
    this.steering.length = 0;
    this.followUp.length = 0;
    this.drainRequested = false;
    this.failed = false;
    return payloads;
  }

  private isProcessing(): boolean {
    return (
      this.inFlight ||
      this.drainRequested ||
      this.options.isBusy() ||
      this.hasQueued()
    );
  }

  private isIdleForWait(): boolean {
    return (
      !this.inFlight &&
      !this.pumpRunning &&
      !this.options.isBusy() &&
      (!this.hasQueued() || this.failed)
    );
  }

  private resolveIdleWaitersIfIdle(): void {
    if (!this.isIdleForWait()) return;
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private emit(): void {
    this.revision += 1;
    this.options.onState(this.getSnapshot());
    this.resolveIdleWaitersIfIdle();
  }
}

export function hasPayloadContent(payload: ComposerPayload): boolean {
  return (
    payload.text.trim().length > 0 ||
    payload.images.length > 0 ||
    payload.mentions.length > 0
  );
}
