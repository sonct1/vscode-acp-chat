import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  JsonRpcId,
} from "@agentclientprotocol/sdk";
import {
  compileElicitationForm,
  validateElicitationContent,
  type NormalizedElicitationForm,
} from "./form-schema";
import {
  ELICITATION_LIMITS,
  type ElicitationHostMessage,
  type ElicitationOwnerState,
  type ElicitationFormView,
} from "./types";

export interface ElicitationRequestContext {
  params: CreateElicitationRequest;
  requestId: JsonRpcId;
  signal: AbortSignal;
}

export interface AcpElicitationOwner {
  readonly ownerId: string;
  handleRequest(
    context: ElicitationRequestContext
  ): Promise<CreateElicitationResponse>;
  getPendingViews(): ElicitationFormView[];
  cancelAll(): void;
  dispose(): void;
}

interface OwnerOptions {
  ownerId: string;
  postState: (state: ElicitationOwnerState) => void;
  postMessage: (message: Record<string, unknown>) => void;
  onPendingChanged?: () => void;
}

interface PendingElicitation {
  interactionId: string;
  ownerId: string;
  normalizedForm: NormalizedElicitationForm;
  state: "pending" | "resolved";
  resolve: (response: CreateElicitationResponse) => void;
  abortListener: () => void;
  signal: AbortSignal;
}

export class AcpElicitationHostFeature {
  private readonly owners = new Map<string, AcpElicitationOwnerImpl>();

  createOwner(options: OwnerOptions): AcpElicitationOwner {
    this.owners.get(options.ownerId)?.dispose();
    const owner = new AcpElicitationOwnerImpl(options, () =>
      this.owners.delete(options.ownerId)
    );
    this.owners.set(options.ownerId, owner);
    return owner;
  }

  async handleMessage(message: unknown): Promise<boolean> {
    const response = parseHostResponse(message);
    if (!response) return isAcpElicitationResponseType(message);
    const owner = this.owners.get(response.ownerId);
    if (!owner) return false;
    owner.respond(response);
    return true;
  }

  dispose(): void {
    for (const owner of this.owners.values()) owner.dispose();
    this.owners.clear();
  }
}

class AcpElicitationOwnerImpl implements AcpElicitationOwner {
  readonly ownerId: string;
  private readonly pending: PendingElicitation[] = [];
  private disposed = false;

  constructor(
    private readonly options: OwnerOptions,
    private readonly onDispose: () => void
  ) {
    this.ownerId = options.ownerId;
  }

  handleRequest(
    context: ElicitationRequestContext
  ): Promise<CreateElicitationResponse> {
    if (
      this.disposed ||
      this.pending.length >= ELICITATION_LIMITS.maxPendingPerOwner
    ) {
      return Promise.resolve({ action: "cancel" });
    }
    let normalizedForm: NormalizedElicitationForm;
    try {
      normalizedForm = compileElicitationForm(context.params, {
        interactionId: randomInteractionId(),
        ownerId: this.ownerId,
        createdAt: Date.now(),
      });
    } catch {
      return Promise.resolve({ action: "cancel" });
    }

    return new Promise<CreateElicitationResponse>((resolve) => {
      const pending: PendingElicitation = {
        interactionId: normalizedForm.view.interactionId,
        ownerId: this.ownerId,
        normalizedForm,
        state: "pending",
        resolve,
        signal: context.signal,
        abortListener: () => this.cancel(normalizedForm.view.interactionId),
      };
      if (context.signal.aborted) {
        resolve({ action: "cancel" });
        return;
      }
      context.signal.addEventListener("abort", pending.abortListener, {
        once: true,
      });
      this.pending.push(pending);
      this.publish();
    });
  }

  getPendingViews(): ElicitationFormView[] {
    return this.pending.map((pending) => pending.normalizedForm.view);
  }

  respond(message: ElicitationHostMessage): void {
    const pending = this.pending.find(
      (item) => item.interactionId === message.interactionId
    );
    if (
      !pending ||
      pending.ownerId !== message.ownerId ||
      pending.state !== "pending"
    )
      return;
    if (message.action === "accept") {
      const result = validateElicitationContent(
        pending.normalizedForm,
        message.content
      );
      if (!result.ok) {
        this.postValidation(pending.interactionId, result.errors);
        return;
      }
      this.settle(pending, { action: "accept", content: result.content });
      return;
    }
    this.settle(pending, { action: message.action });
  }

  cancelAll(): void {
    for (const pending of [...this.pending])
      this.settle(pending, { action: "cancel" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.onDispose();
  }

  private cancel(interactionId: string): void {
    const pending = this.pending.find(
      (item) => item.interactionId === interactionId
    );
    if (pending) this.settle(pending, { action: "cancel" });
  }

  private settle(
    pending: PendingElicitation,
    response: CreateElicitationResponse
  ): void {
    if (pending.state !== "pending") return;
    pending.state = "resolved";
    pending.signal.removeEventListener("abort", pending.abortListener);
    const index = this.pending.indexOf(pending);
    if (index >= 0) this.pending.splice(index, 1);
    pending.resolve(response);
    this.publish();
  }

  private publish(): void {
    this.options.postState({
      ownerId: this.ownerId,
      pendingElicitations: this.getPendingViews(),
    });
    this.options.onPendingChanged?.();
  }

  private postValidation(
    interactionId: string,
    errors: Record<string, string>
  ): void {
    this.options.postMessage({
      type: "feature.acp-elicitation.validation",
      ownerId: this.ownerId,
      interactionId,
      errors,
    });
  }
}

function parseHostResponse(
  message: unknown
): ElicitationHostMessage | undefined {
  if (!isPlainRecord(message)) return undefined;
  if (message.type !== "feature.acp-elicitation.respond") return undefined;
  if (
    typeof message.ownerId !== "string" ||
    typeof message.interactionId !== "string"
  )
    return undefined;
  if (
    message.action !== "accept" &&
    message.action !== "decline" &&
    message.action !== "cancel"
  )
    return undefined;
  if (message.action !== "accept") {
    return {
      type: "feature.acp-elicitation.respond",
      ownerId: message.ownerId,
      interactionId: message.interactionId,
      action: message.action,
    };
  }
  if (!isPlainRecord(message.content)) return undefined;
  const content: ElicitationHostMessage["content"] = {};
  for (const [key, value] of Object.entries(message.content)) {
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      content[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      content[key] = value;
    } else {
      return undefined;
    }
  }
  return {
    type: "feature.acp-elicitation.respond",
    ownerId: message.ownerId,
    interactionId: message.interactionId,
    action: "accept",
    content,
  };
}

function isAcpElicitationResponseType(message: unknown): boolean {
  return (
    isPlainRecord(message) && message.type === "feature.acp-elicitation.respond"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function randomInteractionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `elicitation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function registerAcpElicitationHostFeature(): AcpElicitationHostFeature {
  return new AcpElicitationHostFeature();
}
