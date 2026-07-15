import type {
  AgentContext,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { SwarmRuntimeConfig, SwarmWorkerState } from "../types";
import { loadSwarmRuntimeConfigFile } from "./config-loader";
import { SwarmEvidenceStore } from "./evidence-store";
import { SwarmLockManager } from "./lock-manager";
import { SwarmMonitor } from "./monitor";
import { renderStepPrompt } from "./prompt-renderer";
import { SwarmWorkerRuntime } from "./worker-runtime";
import { SwarmWorkflowEngine } from "./workflow-engine";

interface RootSession {
  sessionId: string;
  cwd: string;
  cancelled: boolean;
  workers: Set<SwarmWorkerRuntime>;
}

export class SwarmRootOrchestrator {
  private readonly sessions = new Map<string, RootSession>();
  private config: SwarmRuntimeConfig | null = null;

  constructor(
    private readonly options: {
      configPath: string | undefined;
      version?: string;
    }
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "vscode-acp-chat-swarm",
        title: "Swarm ACP Root Orchestrator",
        version: this.options.version ?? "0.0.0",
      },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {} },
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      cwd: params.cwd,
      cancelled: false,
      workers: new Set(),
    });
    return { sessionId };
  }

  closeSession(params: { sessionId?: string }): void {
    if (!params.sessionId) return;
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    for (const worker of session.workers) worker.dispose();
    this.sessions.delete(params.sessionId);
  }

  async prompt(params: PromptRequest, client: AgentContext): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    session.cancelled = false;
    const config = await this.loadConfig();
    const workflow = config.workflows[config.defaultWorkflow];
    if (!workflow) {
      throw RequestError.invalidParams(
        { defaultWorkflow: config.defaultWorkflow },
        `Unknown Swarm workflow: ${config.defaultWorkflow}`
      );
    }

    const originalPrompt = promptToText(params.prompt);
    const evidence = new SwarmEvidenceStore();
    const monitor = new SwarmMonitor(client, session.sessionId, workflow.id);
    const lockManager = new SwarmLockManager(monitor, evidence);
    const engine = new SwarmWorkflowEngine(config);

    await monitor.run("RUNNING", `Starting workflow ${workflow.id}`);

    const result = await engine.execute(workflow, async (step, attempt) => {
      if (session.cancelled) return { state: "CANCELLED", output: "" };
      const role = config.roles[step.role];
      if (!role) {
        throw new Error(`Step "${step.id}" references missing role "${step.role}"`);
      }
      const agent = config.agents.find((item) => item.id === role.agentId);
      if (!agent) {
        throw new Error(`Role "${role.id}" references missing agent "${role.agentId}"`);
      }

      evidence.startStep(step.id, role.id, attempt);
      await monitor.step({
        stepId: step.id,
        roleId: role.id,
        state: "RUNNING",
        preview: `Attempt ${attempt}`,
      });

      const runStep = async () => {
        const renderedPrompt = renderStepPrompt({
          workflow,
          step,
          role,
          originalPrompt,
          evidence,
          variables: {
            workflowId: workflow.id,
            stepId: step.id,
            roleId: role.id,
            workspaceRoot: config.workspaceRoot,
          },
        });
        const worker = new SwarmWorkerRuntime({
          workflowId: workflow.id,
          rootSessionId: session.sessionId,
          stepId: step.id,
          role,
          agent,
          cwd: session.cwd || config.workspaceRoot,
          upstream: client,
          monitor,
          evidence,
          lockManager,
          testLockPatterns: config.testLockPatterns,
          requireApprovalBeforeWrites: config.requireApprovalBeforeWrites,
        });
        session.workers.add(worker);
        try {
          return await worker.run(renderedPrompt);
        } finally {
          session.workers.delete(worker);
          worker.dispose();
        }
      };

      try {
        const workerResult = await lockManager.withLocks(
          step.requiresLocks,
          step.id,
          runStep
        );
        evidence.finishStep({
          stepId: step.id,
          roleId: role.id,
          state: workerResult.state,
          output: workerResult.output,
        });
        await monitor.step({
          stepId: step.id,
          roleId: role.id,
          state: workerResult.state,
          preview: workerResult.output,
        });
        return workerResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        evidence.finishStep({
          stepId: step.id,
          roleId: role.id,
          state: "FAILED",
          error: message,
        });
        await monitor.step({
          stepId: step.id,
          roleId: role.id,
          state: "FAILED",
          preview: message,
        });
        return { state: "FAILED", output: "", error: message };
      }
    });

    const finalState: SwarmWorkerState = session.cancelled ? "CANCELLED" : result.state;
    const summary = evidence.summarize(finalState);
    await monitor.evidence({ state: finalState, preview: summary });
    await monitor.run(finalState, summary);
    await client.notify(methods.client.session.update, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: summary },
      },
    });

    return { stopReason: finalState === "CANCELLED" ? "cancelled" : "end_turn" };
  }

  async cancel(params: { sessionId?: string }): Promise<void> {
    if (!params.sessionId) return;
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    await Promise.all([...session.workers].map((worker) => worker.cancel()));
  }

  private requireSession(sessionId: string): RootSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId }, `Unknown sessionId: ${sessionId}`);
    }
    return session;
  }

  private async loadConfig(): Promise<SwarmRuntimeConfig> {
    if (this.config) return this.config;
    if (!this.options.configPath) {
      throw RequestError.invalidParams(
        undefined,
        "Missing VSCODE_ACP_CHAT_SWARM_CONFIG_PATH"
      );
    }
    this.config = await loadSwarmRuntimeConfigFile(this.options.configPath);
    return this.config;
  }
}

function promptToText(prompt: ContentBlock[]): string {
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return `[resource_link] ${block.uri}`;
      if (block.type === "resource") return `[resource] ${block.resource.uri}`;
      if (block.type === "image") return `[image] ${block.mimeType}`;
      if (block.type === "audio") return `[audio] ${block.mimeType}`;
      return "[unsupported content]";
    })
    .join("\n");
}
