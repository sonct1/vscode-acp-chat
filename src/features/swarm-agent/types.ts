import { z } from "zod";

export const SWARM_AGENT_ID = "swarm" as const;
export const SWARM_RUNTIME_CONFIG_VERSION = 1 as const;

export type SwarmWorkerState =
  | "CREATED"
  | "STARTING"
  | "IDLE"
  | "RUNNING"
  | "AWAITING_PERMISSION"
  | "BLOCKED"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
  | "DISPOSED";

export type SwarmFailurePolicy = "stop" | "continue" | "retry" | "askUser";
export type SwarmTerminalCapability = boolean | "restricted";

export interface SwarmCapabilityPolicy {
  read: boolean;
  write: boolean;
  terminal: SwarmTerminalCapability;
  allowFileDelete: boolean;
  testLock: boolean;
  allowedTerminalCommands: string[];
  requireApprovalBeforeWrite: boolean;
  requireApprovalBeforeTerminal: boolean;
}

export interface SwarmRuntimeAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  availabilityCommand?: string;
}

export interface SwarmRoleConfig {
  id: string;
  displayName?: string;
  agentId: string;
  mode?: string;
  prompt?: string;
  promptFile?: string;
  capabilities: SwarmCapabilityPolicy;
}

export interface SwarmWorkflowStepConfig {
  id: string;
  role: string;
  prompt: string;
  dependsOn: string[];
  requiresLocks: string[];
  produces: string[];
  onFailure: SwarmFailurePolicy;
  retryLimit: number;
}

export interface SwarmWorkflowConfig {
  id: string;
  displayName?: string;
  entry?: string;
  final?: string;
  maxWorkers?: number;
  steps: SwarmWorkflowStepConfig[];
}

export interface SwarmLockConfig {
  test_runner: {
    patterns: string[];
  };
  named: string[];
}

export interface SwarmRuntimeConfig {
  version: typeof SWARM_RUNTIME_CONFIG_VERSION;
  workspaceRoot: string;
  defaultWorkflow: string;
  maxWorkers: number;
  requireApprovalBeforeWrites: boolean;
  testLockPatterns: string[];
  agents: SwarmRuntimeAgentConfig[];
  roles: Record<string, SwarmRoleConfig>;
  workflows: Record<string, SwarmWorkflowConfig>;
  locks: SwarmLockConfig;
  setupError?: string;
}

export interface SwarmValidationIssue {
  path: string;
  message: string;
}

export class SwarmConfigValidationError extends Error {
  constructor(readonly issues: SwarmValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "SwarmConfigValidationError";
  }
}

const nonEmptyString = z.string().trim().min(1);

const partialCapabilitiesSchema = z
  .object({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    terminal: z.union([z.boolean(), z.literal("restricted")]).optional(),
    allowFileDelete: z.boolean().optional(),
    testLock: z.boolean().optional(),
    allowedTerminalCommands: z.array(z.string()).optional(),
    requireApprovalBeforeWrite: z.boolean().optional(),
    requireApprovalBeforeTerminal: z.boolean().optional(),
  })
  .strict()
  .partial();

const roleInputSchema = z
  .object({
    id: nonEmptyString.optional(),
    displayName: z.string().optional(),
    agentId: nonEmptyString,
    mode: z.string().optional(),
    prompt: z.string().optional(),
    promptFile: z.string().optional(),
    capabilities: partialCapabilitiesSchema.optional(),
  })
  .strict();

const workflowStepInputSchema = z
  .object({
    id: nonEmptyString,
    role: nonEmptyString,
    prompt: z.string().default(""),
    dependsOn: z.array(nonEmptyString).optional(),
    requiresLocks: z.array(nonEmptyString).optional(),
    produces: z.array(nonEmptyString).optional(),
    onFailure: z.enum(["stop", "continue", "retry", "askUser"]).optional(),
    retryLimit: z.number().int().min(0).optional(),
  })
  .strict();

const workflowInputSchema = z
  .object({
    id: nonEmptyString.optional(),
    displayName: z.string().optional(),
    entry: nonEmptyString.optional(),
    final: nonEmptyString.optional(),
    maxWorkers: z.number().int().min(1).optional(),
    steps: z.array(workflowStepInputSchema).min(1),
  })
  .strict();

const runtimeAgentSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    command: nonEmptyString,
    args: z.array(z.string()),
    env: z.record(z.string()).optional(),
    availabilityCommand: z.string().optional(),
  })
  .strict();

const runtimeConfigSchema = z
  .object({
    version: z.literal(SWARM_RUNTIME_CONFIG_VERSION),
    workspaceRoot: nonEmptyString,
    defaultWorkflow: nonEmptyString,
    maxWorkers: z.number().int().min(1),
    requireApprovalBeforeWrites: z.boolean(),
    testLockPatterns: z.array(z.string()),
    agents: z.array(runtimeAgentSchema),
    roles: z.record(z.unknown()),
    workflows: z.record(z.unknown()),
    locks: z
      .object({
        test_runner: z.object({ patterns: z.array(z.string()) }),
        named: z.array(z.string()),
      })
      .strict(),
    setupError: z.string().optional(),
  })
  .strict();

export const DEFAULT_SWARM_CAPABILITIES: SwarmCapabilityPolicy = {
  read: true,
  write: false,
  terminal: false,
  allowFileDelete: false,
  testLock: true,
  allowedTerminalCommands: [],
  requireApprovalBeforeWrite: false,
  requireApprovalBeforeTerminal: false,
};

export function normalizeSwarmCapabilities(
  input: Partial<SwarmCapabilityPolicy> | undefined,
  defaults: SwarmCapabilityPolicy = DEFAULT_SWARM_CAPABILITIES
): SwarmCapabilityPolicy {
  return {
    ...defaults,
    ...input,
    allowedTerminalCommands: input?.allowedTerminalCommands
      ? [...input.allowedTerminalCommands]
      : [...defaults.allowedTerminalCommands],
  };
}

export function parseSwarmRoleConfig(
  idFromFile: string,
  input: unknown
): SwarmRoleConfig {
  const parsed = roleInputSchema.parse(input);
  const id = parsed.id ?? idFromFile;
  return {
    ...parsed,
    id,
    capabilities: normalizeSwarmCapabilities(parsed.capabilities),
  };
}

export function parseSwarmWorkflowConfig(
  idFromFile: string,
  input: unknown
): SwarmWorkflowConfig {
  const parsed = workflowInputSchema.parse(input);
  const id = parsed.id ?? idFromFile;
  return {
    ...parsed,
    id,
    steps: parsed.steps.map((step) => ({
      ...step,
      dependsOn: step.dependsOn ?? [],
      requiresLocks: step.requiresLocks ?? [],
      produces: step.produces ?? [],
      onFailure: step.onFailure ?? "stop",
      retryLimit: step.retryLimit ?? 0,
    })),
  };
}

export function validateSwarmWorkflow(
  workflow: SwarmWorkflowConfig,
  roles: Record<string, SwarmRoleConfig>
): SwarmValidationIssue[] {
  const issues: SwarmValidationIssue[] = [];
  const stepIds = new Set<string>();

  for (const step of workflow.steps) {
    const path = `workflows.${workflow.id}.steps.${step.id}`;
    if (stepIds.has(step.id)) {
      issues.push({ path, message: `duplicate step id "${step.id}"` });
    }
    stepIds.add(step.id);

    if (!roles[step.role]) {
      issues.push({ path: `${path}.role`, message: `unknown role "${step.role}"` });
    }
  }

  for (const step of workflow.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        issues.push({
          path: `workflows.${workflow.id}.steps.${step.id}.dependsOn`,
          message: `unknown dependency "${dependency}"`,
        });
      }
    }
  }

  for (const key of ["entry", "final"] as const) {
    const value = workflow[key];
    if (value && !stepIds.has(value)) {
      issues.push({
        path: `workflows.${workflow.id}.${key}`,
        message: `unknown step "${value}"`,
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));

  function visit(id: string, stack: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), id].join(" -> ");
      issues.push({
        path: `workflows.${workflow.id}.steps`,
        message: `cyclic dependency detected: ${cycle}`,
      });
      return;
    }

    visiting.add(id);
    const step = byId.get(id);
    for (const dependency of step?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...stack, dependency]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const step of workflow.steps) visit(step.id, [step.id]);
  return issues;
}

export function validateSwarmRuntimeConfig(
  input: unknown
): SwarmRuntimeConfig {
  const parsed = runtimeConfigSchema.parse(input);
  const roles: Record<string, SwarmRoleConfig> = {};
  const workflows: Record<string, SwarmWorkflowConfig> = {};
  const issues: SwarmValidationIssue[] = [];

  const agentIds = new Set<string>();
  for (const agent of parsed.agents) {
    if (agentIds.has(agent.id)) {
      issues.push({ path: `agents.${agent.id}`, message: "duplicate agent id" });
    }
    agentIds.add(agent.id);
  }

  for (const [id, value] of Object.entries(parsed.roles)) {
    try {
      const role = parseSwarmRoleConfig(id, value);
      roles[role.id] = role;
      if (!agentIds.has(role.agentId)) {
        issues.push({
          path: `roles.${role.id}.agentId`,
          message: `unknown agent "${role.agentId}"`,
        });
      }
    } catch (error) {
      issues.push(...zodIssues(`roles.${id}`, error));
    }
  }

  for (const [id, value] of Object.entries(parsed.workflows)) {
    try {
      const workflow = parseSwarmWorkflowConfig(id, value);
      workflows[workflow.id] = workflow;
    } catch (error) {
      issues.push(...zodIssues(`workflows.${id}`, error));
    }
  }

  if (!workflows[parsed.defaultWorkflow]) {
    issues.push({
      path: "defaultWorkflow",
      message: `unknown workflow "${parsed.defaultWorkflow}"`,
    });
  }

  for (const workflow of Object.values(workflows)) {
    issues.push(...validateSwarmWorkflow(workflow, roles));
  }

  if (issues.length > 0) throw new SwarmConfigValidationError(issues);

  return {
    ...parsed,
    roles,
    workflows,
  };
}

export function zodIssues(prefix: string, error: unknown): SwarmValidationIssue[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      path: [prefix, ...issue.path.map(String)].filter(Boolean).join("."),
      message: issue.message,
    }));
  }
  return [
    {
      path: prefix,
      message: error instanceof Error ? error.message : String(error),
    },
  ];
}

export function getWorkflowExecutionOrder(
  workflow: SwarmWorkflowConfig
): string[] {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    order.push(id);
  }

  for (const step of workflow.steps) visit(step.id);
  return order;
}
