import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage, Mention } from "../../views/webview/types";
import type {
  ComposerPayload,
  MessageQueueSnapshot,
  QueueIntent,
} from "./types";
import { messageQueueStyles } from "./styles";

interface PendingSubmit {
  payload: ComposerPayload;
  acceptedHtml: string;
  sessionId?: string;
}

export function registerMessageQueueWebviewFeature(
  controller: WebviewController
): MessageQueueWebviewFeature {
  return new MessageQueueWebviewFeature(controller);
}

export class MessageQueueWebviewFeature {
  private snapshot: MessageQueueSnapshot | undefined;
  private turnGenerating = false;
  private readonly pending = new Map<string, PendingSubmit>();
  private readonly preview: HTMLElement;

  constructor(private readonly controller: WebviewController) {
    this.injectStyles();
    this.preview = this.createPreview();
    this.installKeyboardCapture();
    this.updateComposerState();
  }

  handleMessage(msg: ExtensionMessage): boolean | void {
    if (msg.type === "feature.message-queue.state") {
      this.snapshot = msg as unknown as MessageQueueSnapshot;
      this.renderPreview();
      this.updateComposerState();
      return true;
    }
    if (msg.type === "feature.message-queue.submitResult" && msg.requestId) {
      const pending = this.pending.get(msg.requestId);
      this.pending.delete(msg.requestId);
      this.setInputLocked(false);
      if (!pending) return true;
      const result = msg as unknown as {
        disposition?: string;
        acceptedHtml?: string;
        sessionId?: string;
      };
      const resultSessionId = result.sessionId ?? pending.sessionId;
      if (
        result.disposition === "dispatched" ||
        result.disposition === "queued"
      ) {
        if (this.isCurrentSession(resultSessionId)) {
          if (
            this.controller.inputPanel.getInputHtml() === result.acceptedHtml
          ) {
            this.controller.inputPanel.clearInput();
            this.controller.inputPanel.updateInputState();
          }
        }
        this.controller.acknowledgeSubmittedDraft(resultSessionId);
        this.controller.getEventBus().emit("messageSent", {
          text: pending.payload.text,
          images: pending.payload.images,
          mentions: pending.payload.mentions,
        });
      } else {
        const restoreHtml = this.isCurrentSession(resultSessionId)
          ? this.joinComposerHtml([
              pending.payload,
              ...this.currentPayloadIfChanged(pending.acceptedHtml),
            ])
          : pending.payload.composerHtml;
        this.controller.restoreDraftPayloads(resultSessionId, restoreHtml);
      }
      this.updateComposerState();
      return true;
    }
    if (msg.type === "feature.message-queue.restoreResult") {
      const payloads = Array.isArray((msg as { payloads?: unknown }).payloads)
        ? (msg as unknown as { payloads: ComposerPayload[] }).payloads
        : [];
      if (payloads.length > 0) {
        const sessionId = (msg as unknown as { sessionId?: string }).sessionId;
        this.controller.restoreDraftPayloads(
          sessionId ?? this.snapshot?.sessionId,
          this.joinComposerHtml(payloads)
        );
        if (this.isCurrentSession(sessionId))
          this.controller.inputPanel.focus();
      }
      this.renderPreview();
      this.updateComposerState();
      return true;
    }
  }

  setTurnGenerating(isGenerating: boolean): void {
    this.turnGenerating = isGenerating;
    this.updateComposerState();
  }

  private installKeyboardCapture(): void {
    const input = this.controller.inputPanel.elements.inputEl;
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.isComposing) return;
        if (
          this.controller.inputPanel.autocomplete.isActive() &&
          isAutocompleteKey(event)
        )
          return;
        if (event.shiftKey && event.key === "Enter") return;
        if (event.key === "Enter" && event.altKey) {
          this.submit(event, this.isProcessing() ? "followUp" : "steer");
          return;
        }
        if (
          event.key === "Enter" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          this.submit(event, "steer");
          return;
        }
        if (event.key === "Escape" && this.isProcessing()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.restore("feature.message-queue.abortAndRestore");
          return;
        }
        if (event.key === "ArrowUp" && event.altKey && this.hasQueued()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.restore("feature.message-queue.restoreQueued");
        }
      },
      true
    );

    this.controller.inputPanel.elements.sendBtn.addEventListener(
      "click",
      (event) => {
        const queued = this.queueCurrentDraft("steer");
        if (!queued) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true
    );

    this.controller.inputPanel.elements.stopBtn.addEventListener(
      "click",
      (event) => {
        if (!this.isProcessing()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.restore("feature.message-queue.abortAndRestore");
      },
      true
    );
  }

  private submit(event: KeyboardEvent, intent: QueueIntent): void {
    const queued = this.queueCurrentDraft(intent);
    if (!queued) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private queueCurrentDraft(intent: QueueIntent): boolean {
    if (!this.snapshot && !this.turnGenerating) return false;
    const panel = this.controller.inputPanel;
    const message = panel.collectMessage();
    if (!message) return false;
    const composerHtml = panel.getInputHtml();
    const payload: ComposerPayload = {
      text: message.text,
      images: message.images,
      mentions: message.mentions as Mention[],
      composerHtml,
      currentDraft: composerHtml,
    };
    const requestId = `mq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = this.snapshot?.sessionId;
    this.pending.set(requestId, {
      payload,
      acceptedHtml: composerHtml,
      sessionId,
    });
    this.setInputLocked(true);
    this.controller.getVsCodeApi().postMessage({
      type: "feature.message-queue.submit",
      requestId,
      sessionId,
      intent,
      payload,
      currentDraft: payload,
    });
    return true;
  }

  private restore(
    type:
      | "feature.message-queue.abortAndRestore"
      | "feature.message-queue.restoreQueued"
  ): void {
    const message = this.controller.inputPanel.collectMessage();
    const requestId = `mq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = this.snapshot?.sessionId;
    this.controller.getVsCodeApi().postMessage({
      type,
      requestId,
      sessionId,
      currentDraft: message
        ? {
            text: message.text,
            images: message.images,
            mentions: message.mentions,
            composerHtml: this.controller.inputPanel.getInputHtml(),
          }
        : undefined,
    });
  }

  private injectStyles(): void {
    const doc = this.controller.getDocument();
    if (doc.getElementById("message-queue-styles")) return;
    const style = doc.createElement("style");
    style.id = "message-queue-styles";
    style.textContent = messageQueueStyles;
    doc.head.appendChild(style);
  }

  private createPreview(): HTMLElement {
    const doc = this.controller.getDocument();
    const preview = doc.createElement("div");
    preview.id = "message-queue-preview";
    preview.className = "message-queue-preview";
    preview.setAttribute("role", "status");
    preview.setAttribute("aria-live", "polite");
    preview.hidden = true;
    const composer = doc.getElementById("chat-input-area");
    const inputContainer = doc.getElementById("input-container");
    if (composer && inputContainer) {
      composer.insertBefore(preview, inputContainer);
    } else {
      inputContainer?.prepend(preview);
    }
    return preview;
  }

  private renderPreview(): void {
    const steering = this.snapshot?.steering ?? [];
    const followUp = this.snapshot?.followUp ?? [];
    if (steering.length === 0 && followUp.length === 0) {
      this.preview.hidden = true;
      this.preview.textContent = "";
      return;
    }
    this.preview.hidden = false;
    const parts = [];
    if (steering[0])
      parts.push(
        `Steering (${steering.length}): ${truncate(steering[0].payload.text)}`
      );
    if (followUp[0])
      parts.push(
        `Follow-up (${followUp.length}): ${truncate(followUp[0].payload.text)}`
      );
    parts.push("Alt+Up to edit queued messages");
    this.preview.textContent = parts.join(" · ");
  }

  private updateComposerState(): void {
    const processing = this.isProcessing();
    this.controller.inputPanel.setGenerating(processing);
    this.controller.inputPanel.updateInputState();
    const send = this.controller.inputPanel.elements.sendBtn;
    const stop = this.controller.inputPanel.elements.stopBtn;
    send.style.display = "flex";
    stop.style.display = processing ? "flex" : "none";
    send.setAttribute(
      "aria-label",
      processing ? "Queue steering message" : "Send message"
    );
    send.setAttribute(
      "acp-title",
      processing ? "Queue steering message (Enter)" : "Send (Enter)"
    );
    stop.setAttribute(
      "aria-label",
      processing ? "Abort and restore queued messages" : "Stop"
    );
    stop.setAttribute(
      "acp-title",
      processing ? "Abort and restore queued messages (Escape)" : "Stop"
    );
  }

  private isProcessing(): boolean {
    return this.snapshot?.processing ?? this.turnGenerating;
  }

  private hasQueued(): boolean {
    return (
      (this.snapshot?.steering.length ?? 0) +
        (this.snapshot?.followUp.length ?? 0) >
      0
    );
  }

  private setInputLocked(locked: boolean): void {
    this.controller.inputPanel.elements.inputEl.setAttribute(
      "contenteditable",
      locked ? "false" : "true"
    );
  }

  private isCurrentSession(sessionId: string | undefined): boolean {
    return !sessionId || sessionId === this.snapshot?.sessionId;
  }

  private currentPayloadIfChanged(acceptedHtml: string): ComposerPayload[] {
    const current = this.controller.inputPanel.getInputHtml();
    if (!current || current === acceptedHtml) return [];
    return [{ text: "", images: [], mentions: [], composerHtml: current }];
  }

  private joinComposerHtml(payloads: ComposerPayload[]): string {
    return payloads
      .map((payload) => payload.composerHtml || escapeHtml(payload.text))
      .join("<br><br>");
  }
}

function isAutocompleteKey(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" ||
    event.key === "Escape" ||
    event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "Tab"
  );
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}…` : singleLine;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
