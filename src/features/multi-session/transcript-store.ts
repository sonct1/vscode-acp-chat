import type { MultiSessionRenderMessage, TranscriptEvent } from "./contracts";

export class TranscriptStore {
  private compactedEvents: TranscriptEvent[] = [];
  private nextSeq = 1;

  append(message: MultiSessionRenderMessage): TranscriptEvent {
    const event: TranscriptEvent = {
      seq: this.nextSeq++,
      message: { ...message },
      createdAt: Date.now(),
    };
    const last = this.compactedEvents[this.compactedEvents.length - 1];
    if (
      last &&
      (message.type === "streamChunk" || message.type === "thoughtChunk") &&
      last.message.type === message.type &&
      typeof last.message.text === "string" &&
      typeof message.text === "string"
    ) {
      last.message = {
        ...last.message,
        text: last.message.text + message.text,
      };
    } else {
      this.compactedEvents.push({ ...event, message: { ...event.message } });
    }
    return event;
  }

  snapshot(): TranscriptEvent[] {
    return this.compactedEvents.map((event) => ({
      ...event,
      message: { ...event.message },
    }));
  }

  clear(): void {
    this.compactedEvents = [];
    this.nextSeq = 1;
  }

  get length(): number {
    return this.lastSeq;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }
}
