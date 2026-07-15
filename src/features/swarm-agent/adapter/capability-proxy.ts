import type {
  AgentContext,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { methods, RequestError } from "@agentclientprotocol/sdk";
import type { SwarmCapabilityPolicy } from "../types";
import type { SwarmEvidenceStore } from "./evidence-store";
import type { SwarmLockManager } from "./lock-manager";

export interface CapabilityProxyContext {
  workflowId: string;
  stepId: string;
  roleId: string;
  workerSessionId: string;
  rootSessionId: string;
}

export class SwarmCapabilityProxy {
  constructor(
    private readonly upstream: AgentContext,
    private readonly policy: SwarmCapabilityPolicy,
    private readonly context: CapabilityProxyContext,
    private readonly options: {
      evidence?: SwarmEvidenceStore;
      lockManager?: SwarmLockManager;
      testLockPatterns?: string[];
      requireApprovalBeforeWrites?: boolean;
    } = {}
  ) {}

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    if (!this.policy.read) {
      throw this.deny("read", `Role "${this.context.roleId}" cannot read files`);
    }
    return this.upstream.request(methods.client.fs.readTextFile, this.rewrite(params));
  }

  async writeTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse | void> {
    if (!this.policy.write) {
      throw this.deny("write", `Role "${this.context.roleId}" cannot write files`);
    }

    await this.maybeRequestWriteApproval(params);
    const action = () =>
      this.upstream.request(methods.client.fs.writeTextFile, this.rewrite(params));
    const lockManager = this.options.lockManager;
    if (!lockManager) return action();
    return lockManager.withLocks(
      [lockManager.pathLock(params.path)],
      this.context.stepId,
      action
    );
  }

  async createTerminal(
    params: CreateTerminalRequest
  ): Promise<CreateTerminalResponse> {
    if (this.policy.terminal === false) {
      throw this.deny(
        "terminal",
        `Role "${this.context.roleId}" cannot create terminals`
      );
    }

    const commandText = commandLine(params);
    if (
      this.policy.terminal === "restricted" &&
      !this.policy.allowedTerminalCommands.some((pattern) =>
        commandText.toLowerCase().includes(pattern.toLowerCase())
      )
    ) {
      throw this.deny(
        "terminal",
        `Terminal command is not allowed for role "${this.context.roleId}": ${commandText}`
      );
    }

    await this.maybeRequestTerminalApproval(params);
    const action = () =>
      this.upstream.request(methods.client.terminal.create, this.rewrite(params));
    const lockManager = this.options.lockManager;
    const patterns = this.options.testLockPatterns ?? [];
    if (lockManager && this.policy.testLock && lockManager.isTestCommand(commandText, patterns)) {
      return lockManager.withLocks(["test_runner"], this.context.stepId, action);
    }
    return action();
  }

  async terminalOutput(
    params: TerminalOutputRequest
  ): Promise<TerminalOutputResponse> {
    return this.upstream.request(methods.client.terminal.output, this.rewrite(params));
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    return this.upstream.request(methods.client.terminal.waitForExit, this.rewrite(params));
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse | void> {
    return this.upstream.request(methods.client.terminal.kill, this.rewrite(params));
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest
  ): Promise<ReleaseTerminalResponse | void> {
    return this.upstream.request(methods.client.terminal.release, this.rewrite(params));
  }

  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return this.upstream.request(methods.client.session.requestPermission, {
      ...params,
      sessionId: this.context.rootSessionId,
      _meta: {
        ...(params._meta ?? {}),
        swarm: this.context,
      },
    });
  }

  private rewrite<T extends { sessionId: string; _meta?: Record<string, unknown> | null }>(
    params: T
  ): T {
    return {
      ...params,
      sessionId: this.context.rootSessionId,
      _meta: {
        ...(params._meta ?? {}),
        swarm: this.context,
        workerSessionId: params.sessionId,
      },
    };
  }

  private async maybeRequestWriteApproval(params: WriteTextFileRequest): Promise<void> {
    if (
      !this.policy.requireApprovalBeforeWrite &&
      !this.options.requireApprovalBeforeWrites
    ) {
      return;
    }
    await this.requireApproval("write", `Allow Swarm step ${this.context.stepId} to write ${params.path}?`);
  }

  private async maybeRequestTerminalApproval(
    params: CreateTerminalRequest
  ): Promise<void> {
    if (!this.policy.requireApprovalBeforeTerminal) return;
    await this.requireApproval(
      "terminal",
      `Allow Swarm step ${this.context.stepId} to run terminal command: ${commandLine(params)}?`
    );
  }

  private async requireApproval(title: string, message: string): Promise<void> {
    const response = await this.requestPermission({
      sessionId: this.context.workerSessionId,
      toolCall: {
        toolCallId: `swarm-permission-${this.context.stepId}-${title}`,
        title,
        kind: title === "terminal" ? "execute" : "edit",
        status: "pending",
        rawInput: { message, swarm: this.context },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });

    if (response.outcome.outcome !== "selected" || response.outcome.optionId !== "allow") {
      throw this.deny(title, `Permission denied for ${title}`);
    }
  }

  private deny(capability: string, message: string): RequestError {
    this.options.evidence?.addViolation({
      stepId: this.context.stepId,
      roleId: this.context.roleId,
      capability,
      message,
    });
    return RequestError.invalidParams(
      { swarm: this.context, capability },
      `Swarm capability denied: ${message}`
    );
  }
}

function commandLine(params: CreateTerminalRequest): string {
  return [params.command, ...(params.args ?? [])].join(" ").trim();
}
