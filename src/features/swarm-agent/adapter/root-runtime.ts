import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  AgentContext,
  ClientConnection,
  ContentBlock,
  InitializeResponse,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SwarmCapabilityPolicy, SwarmRoleConfig, SwarmRuntimeAgentConfig } from "../types";
import { SwarmCapabilityProxy } from "./capability-proxy";
import { SwarmLockManager } from "./lock-manager";
import { terminateChildProcessTree } from "./process-tree";
import type { SwarmSpawnFunction } from "./worker-runtime";

export type SwarmRootPhase = "route" | "direct" | "finalizeWorkflow";

export interface SwarmRootRuntimeOptions {
  rootSessionId: string;
  role: SwarmRoleConfig;
  agent: SwarmRuntimeAgentConfig;
  cwd: string;
  upstream: AgentContext;
  requireApprovalBeforeWrites: boolean;
  lockManager?: SwarmLockManager;
  testLockPatterns: string[];
  spawn?: SwarmSpawnFunction;
}

const NO_TOOL_ROOT_CAPABILITIES: SwarmCapabilityPolicy = {
  read: false,
  write: false,
  terminal: false,
  allowFileDelete: false,
  testLock: false,
  allowedTerminalCommands: [],
  requireApprovalBeforeWrite: false,
  requireApprovalBeforeTerminal: false,
};

export class SwarmRootRuntime {
  private readonly spawn: SwarmSpawnFunction;
  private child: ChildProcess | null = null;
  private connection: ClientConnection | null = null;
  private agentContext: import("@agentclientprotocol/sdk").ClientContext | null = null;
  private rootAgentSessionId: string | null = null;
  private capabilityProxy: SwarmCapabilityProxy | null = null;
  private capabilityProxyKey: string | null = null;
  private phase: SwarmRootPhase = "route";
  private output = "";
  private cancelled = false;
  private turnId = 0;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: SwarmRootRuntimeOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
  }

  async prompt(phase: SwarmRootPhase, prompt: string | ContentBlock[]): Promise<{ output: string; stopReason?: PromptResponse["stopReason"] }> {
    if (this.disposePromise) throw new Error("Swarm Root runtime has been disposed");
    this.phase = phase;
    this.output = "";
    this.cancelled = false;
    const turnId = ++this.turnId;
    await this.ensureStarted();
    const response = await this.agentContext!.request(methods.agent.session.prompt, {
      sessionId: this.rootAgentSessionId!,
      prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
    });
    if (turnId !== this.turnId || this.cancelled) return { output: "", stopReason: "cancelled" };
    return { output: this.output, stopReason: response.stopReason };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.turnId += 1;
    if (this.agentContext && this.rootAgentSessionId) {
      try {
        await this.agentContext.notify(methods.agent.session.cancel, {
          sessionId: this.rootAgentSessionId,
        });
      } catch {
        // Best effort; dispose follows on cancellation paths.
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.cancelled = true;
    this.turnId += 1;
    const agentContext = this.agentContext;
    const rootAgentSessionId = this.rootAgentSessionId;
    const child = this.child;
    try {
      if (agentContext && rootAgentSessionId) {
        await withTimeout(
          agentContext.request(methods.agent.session.close, {
            sessionId: rootAgentSessionId,
          }),
          1_000
        );
      }
    } catch {
      // Graceful close is best effort; process termination below is guaranteed.
    } finally {
      this.connection?.close();
      this.connection = null;
      this.agentContext = null;
      this.capabilityProxy = null;
      this.capabilityProxyKey = null;
      this.rootAgentSessionId = null;
      this.child = null;
      if (child) await terminateChildProcessTree(child);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.agentContext && this.rootAgentSessionId) return;
    await this.connect();
    const response = await this.agentContext!.request(methods.agent.session.new, {
      cwd: this.options.cwd,
      mcpServers: [],
    });
    this.rootAgentSessionId = response.sessionId;
    if (this.options.role.mode) {
      await this.setMode(this.options.role.mode);
    }
  }

  private async connect(): Promise<InitializeResponse> {
    const pathEnvName = process.platform === "win32" ? "Path" : "PATH";
    this.child = this.spawn(this.options.agent.command, this.options.agent.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env: {
        ...baseRootEnv(),
        ...decodeAgentEnv(this.options.agent.envKey),
        ...this.options.agent.env,
        [pathEnvName]: process.env[pathEnvName] ?? "",
      },
      detached: process.platform !== "win32",
      windowsHide: true,
    } satisfies SpawnOptions);

    this.child.stderr?.resume();

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>
    );

    const clientApp = client({ name: "vscode-acp-chat-swarm-root" })
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
      clientInfo: { name: "vscode-acp-chat-swarm-root", version: "0.0.1" },
    });
  }

  private async setMode(modeId: string): Promise<void> {
    try {
      await this.agentContext!.request(methods.agent.session.setConfigOption, {
        sessionId: this.rootAgentSessionId!,
        configId: "mode",
        value: modeId,
      });
    } catch {
      await this.agentContext!.request(methods.agent.session.setMode, {
        sessionId: this.rootAgentSessionId!,
        modeId,
      });
    }
  }

  private async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    if (this.cancelled) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.output += update.content.text;
      if (this.phase === "direct" || this.phase === "finalizeWorkflow") {
        await this.options.upstream.notify(methods.client.session.update, {
          sessionId: this.options.rootSessionId,
          update,
        });
      }
    }
  }

  private proxy(): SwarmCapabilityProxy {
    const sessionId = this.rootAgentSessionId ?? "pending-root-session";
    const key = `${this.phase}:${sessionId}`;
    if (this.capabilityProxy && this.capabilityProxyKey === key) {
      return this.capabilityProxy;
    }

    const policy = this.phase === "direct" ? this.options.role.capabilities : NO_TOOL_ROOT_CAPABILITIES;
    this.capabilityProxy = new SwarmCapabilityProxy(
      this.options.upstream,
      policy,
      {
        workflowId: this.phase,
        stepId: `root-${this.phase}`,
        roleId: this.options.role.id,
        workerSessionId: sessionId,
        rootSessionId: this.options.rootSessionId,
      },
      {
        lockManager: this.options.lockManager,
        testLockPatterns: this.options.testLockPatterns,
        requireApprovalBeforeWrites: this.options.requireApprovalBeforeWrites,
        cwd: this.options.cwd,
      }
    );
    this.capabilityProxyKey = key;
    return this.capabilityProxy;
  }
}

function baseRootEnv(): NodeJS.ProcessEnv {
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
