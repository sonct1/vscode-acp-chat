import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  AgentContext,
  ClientConnection,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  SwarmRoleConfig,
  SwarmRuntimeAgentConfig,
  SwarmWorkerState,
} from "../types";
import { SwarmCapabilityProxy } from "./capability-proxy";
import type { SwarmEvidenceStore } from "./evidence-store";
import type { SwarmLockManager } from "./lock-manager";
import type { SwarmMonitor } from "./monitor";

export type SwarmSpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export interface SwarmWorkerRuntimeOptions {
  workflowId: string;
  rootSessionId: string;
  stepId: string;
  role: SwarmRoleConfig;
  agent: SwarmRuntimeAgentConfig;
  cwd: string;
  upstream: AgentContext;
  monitor: SwarmMonitor;
  evidence: SwarmEvidenceStore;
  lockManager: SwarmLockManager;
  testLockPatterns: string[];
  requireApprovalBeforeWrites: boolean;
  spawn?: SwarmSpawnFunction;
}

export interface SwarmWorkerResult {
  state: SwarmWorkerState;
  output: string;
  stopReason?: PromptResponse["stopReason"];
}

export class SwarmWorkerRuntime {
  private readonly spawn: SwarmSpawnFunction;
  private child: ChildProcess | null = null;
  private connection: ClientConnection | null = null;
  private agentContext: import("@agentclientprotocol/sdk").ClientContext | null = null;
  private workerSessionId: string | null = null;
  private capabilityProxy: SwarmCapabilityProxy | null = null;
  private capabilityProxySessionId: string | null = null;
  private output = "";

  constructor(private readonly options: SwarmWorkerRuntimeOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
  }

  async run(prompt: string): Promise<SwarmWorkerResult> {
    await this.options.monitor.worker({
      stepId: this.options.stepId,
      roleId: this.options.role.id,
      state: "STARTING",
    });

    await this.connect();
    await this.newSession();

    await this.options.monitor.worker({
      stepId: this.options.stepId,
      roleId: this.options.role.id,
      state: "RUNNING",
      preview: "Worker prompt dispatched",
    });

    const response = await this.agentContext!.request(methods.agent.session.prompt, {
      sessionId: this.workerSessionId!,
      prompt: [{ type: "text", text: prompt }],
    });

    const state = response.stopReason === "cancelled" ? "CANCELLED" : "DONE";
    await this.options.monitor.worker({
      stepId: this.options.stepId,
      roleId: this.options.role.id,
      state,
      preview: preview(this.output),
    });

    return { state, output: this.output, stopReason: response.stopReason };
  }

  async cancel(): Promise<void> {
    if (this.agentContext && this.workerSessionId) {
      await this.agentContext.notify(methods.agent.session.cancel, {
        sessionId: this.workerSessionId,
      });
    }
    this.dispose();
  }

  dispose(): void {
    this.connection?.close();
    this.connection = null;
    this.agentContext = null;
    this.capabilityProxy = null;
    this.capabilityProxySessionId = null;
    this.child?.kill();
    this.child = null;
  }

  private async connect(): Promise<InitializeResponse> {
    const pathEnvName = process.platform === "win32" ? "Path" : "PATH";
    this.child = this.spawn(this.options.agent.command, this.options.agent.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env: {
        ...baseWorkerEnv(),
        ...decodeAgentEnv(this.options.agent.envKey),
        ...this.options.agent.env,
        [pathEnvName]: process.env[pathEnvName] ?? "",
      },
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      void this.options.monitor.worker({
        stepId: this.options.stepId,
        roleId: this.options.role.id,
        state: "RUNNING",
        preview: text,
        extra: { stream: "stderr" },
      });
    });

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>
    );

    const clientApp = client({ name: "vscode-acp-chat-swarm-worker" })
      .onNotification(methods.client.session.update, (ctx) =>
        this.handleSessionUpdate(ctx.params)
      )
      .onRequest(methods.client.fs.readTextFile, (ctx) =>
        this.proxy().readTextFile(ctx.params)
      )
      .onRequest(methods.client.fs.writeTextFile, (ctx) =>
        this.proxy().writeTextFile(ctx.params)
      )
      .onRequest(methods.client.terminal.create, (ctx) =>
        this.proxy().createTerminal(ctx.params)
      )
      .onRequest(methods.client.terminal.output, (ctx) =>
        this.proxy().terminalOutput(ctx.params)
      )
      .onRequest(methods.client.terminal.waitForExit, (ctx) =>
        this.proxy().waitForTerminalExit(ctx.params)
      )
      .onRequest(methods.client.terminal.kill, (ctx) =>
        this.proxy().killTerminal(ctx.params)
      )
      .onRequest(methods.client.terminal.release, (ctx) =>
        this.proxy().releaseTerminal(ctx.params)
      )
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        this.proxy().requestPermission(ctx.params)
      );

    this.connection = clientApp.connect(stream);
    this.agentContext = this.connection.agent;

    return this.agentContext.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "vscode-acp-chat-swarm", version: "0.0.1" },
    });
  }

  private async newSession(): Promise<NewSessionResponse> {
    const response = await this.agentContext!.request(methods.agent.session.new, {
      cwd: this.options.cwd,
      mcpServers: [],
    });
    this.workerSessionId = response.sessionId;
    return response;
  }

  private async handleSessionUpdate(
    notification: SessionNotification
  ): Promise<void> {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.output += update.content.text;
      this.options.evidence.appendStepOutput(this.options.stepId, update.content.text);
    }

    await this.options.monitor.worker({
      stepId: this.options.stepId,
      roleId: this.options.role.id,
      state: update.sessionUpdate === "tool_call" ? "RUNNING" : "RUNNING",
      preview: sessionUpdatePreview(update),
      extra: { workerSessionId: notification.sessionId },
    });
  }

  private proxy(): SwarmCapabilityProxy {
    if (this.capabilityProxy && this.capabilityProxySessionId === this.workerSessionId) {
      return this.capabilityProxy;
    }

    this.capabilityProxy = new SwarmCapabilityProxy(
      this.options.upstream,
      this.options.role.capabilities,
      {
        workflowId: this.options.workflowId,
        stepId: this.options.stepId,
        roleId: this.options.role.id,
        workerSessionId: this.workerSessionId ?? "pending-worker-session",
        rootSessionId: this.options.rootSessionId,
      },
      {
        evidence: this.options.evidence,
        lockManager: this.options.lockManager,
        testLockPatterns: this.options.testLockPatterns,
        requireApprovalBeforeWrites: this.options.requireApprovalBeforeWrites,
        cwd: this.options.cwd,
      }
    );
    this.capabilityProxySessionId = this.workerSessionId;
    return this.capabilityProxy;
  }
}

function baseWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VSCODE_ACP_CHAT_SWARM_AGENT_ENV_")) continue;
    env[key] = value;
  }
  return env;
}

function decodeAgentEnv(envKey: string | undefined): Record<string, string> {
  if (!envKey) return {};
  const encoded = process.env[envKey];
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function sessionUpdatePreview(update: SessionNotification["update"]): string {
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    return preview(update.content.text);
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return `${update.title ?? update.toolCallId}: ${update.status ?? "in_progress"}`;
  }
  return update.sessionUpdate;
}

function preview(text: string, limit = 2000): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}
