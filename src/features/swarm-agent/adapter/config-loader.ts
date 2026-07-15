import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  parseSwarmRoleConfig,
  parseSwarmWorkflowConfig,
  SWARM_RUNTIME_CONFIG_VERSION,
  SwarmConfigValidationError,
  validateSwarmRuntimeConfig,
  validateSwarmWorkflow,
  zodIssues,
  type SwarmRuntimeAgentConfig,
  type SwarmRuntimeConfig,
  type SwarmValidationIssue,
} from "../types";

export const DEFAULT_SWARM_CONFIG_DIRECTORY = ".vscode/acp-swarm";
export const DEFAULT_SWARM_WORKFLOW = "default";
export const DEFAULT_SWARM_MAX_WORKERS = 4;
export const DEFAULT_SWARM_TEST_LOCK_PATTERNS = [
  "npm test",
  "npm run test",
  "cargo test",
  "go test",
  "pytest",
];

export interface SwarmRuntimeConfigMaterializeInput {
  workspaceRoot: string;
  configDirectory: string;
  defaultWorkflow: string;
  maxWorkers: number;
  requireApprovalBeforeWrites: boolean;
  testLockPatterns: string[];
  agents: SwarmRuntimeAgentConfig[];
}

const swarmConfigSchema = z
  .object({
    defaultWorkflow: z.string().trim().min(1).optional(),
    maxWorkers: z.number().int().min(1).optional(),
    requireApprovalBeforeWrites: z.boolean().optional(),
    testLockPatterns: z.array(z.string()).optional(),
    locks: z
      .object({
        named: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict();

export async function loadSwarmRuntimeConfigFile(
  configPath: string
): Promise<SwarmRuntimeConfig> {
  const text = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  return validateSwarmRuntimeConfig(parsed);
}

export async function createSwarmRuntimeConfig(
  input: SwarmRuntimeConfigMaterializeInput
): Promise<SwarmRuntimeConfig> {
  const rolesDir = path.join(input.configDirectory, "roles");
  const workflowsDir = path.join(input.configDirectory, "workflows");
  const configFile = path.join(input.configDirectory, "swarm.config.json");
  const issues: SwarmValidationIssue[] = [];

  const baseConfig = await readOptionalJson(configFile, "swarm.config", issues);
  const parsedBase = baseConfig
    ? safeParseBaseConfig(baseConfig, issues)
    : undefined;

  const roles = await readConfigDirectory(rolesDir, (id, value) =>
    parseSwarmRoleConfig(id, value)
  );
  issues.push(...roles.issues);

  const workflows = await readConfigDirectory(workflowsDir, (id, value) =>
    parseSwarmWorkflowConfig(id, value)
  );
  issues.push(...workflows.issues);

  const defaultWorkflow =
    parsedBase?.defaultWorkflow ?? input.defaultWorkflow ?? DEFAULT_SWARM_WORKFLOW;
  const testLockPatterns =
    parsedBase?.testLockPatterns ?? input.testLockPatterns ?? DEFAULT_SWARM_TEST_LOCK_PATTERNS;

  const runtime: SwarmRuntimeConfig = {
    version: SWARM_RUNTIME_CONFIG_VERSION,
    workspaceRoot: input.workspaceRoot,
    defaultWorkflow,
    maxWorkers: parsedBase?.maxWorkers ?? input.maxWorkers,
    requireApprovalBeforeWrites:
      parsedBase?.requireApprovalBeforeWrites ?? input.requireApprovalBeforeWrites,
    testLockPatterns,
    agents: input.agents,
    roles: roles.values,
    workflows: workflows.values,
    locks: {
      test_runner: { patterns: testLockPatterns },
      named: parsedBase?.locks?.named ?? [],
    },
  };

  try {
    const validated = validateSwarmRuntimeConfig(runtime);
    for (const workflow of Object.values(validated.workflows)) {
      issues.push(...validateSwarmWorkflow(workflow, validated.roles));
    }
    if (issues.length > 0) throw new SwarmConfigValidationError(issues);
    return validated;
  } catch (error) {
    if (error instanceof SwarmConfigValidationError) {
      throw new SwarmConfigValidationError([...issues, ...error.issues]);
    }
    throw error;
  }
}

export async function writeSwarmRuntimeConfig(
  filePath: string,
  config: SwarmRuntimeConfig
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readOptionalJson(
  filePath: string,
  label: string,
  issues: SwarmValidationIssue[]
): Promise<unknown | undefined> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    issues.push({
      path: label,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function safeParseBaseConfig(
  value: unknown,
  issues: SwarmValidationIssue[]
): z.infer<typeof swarmConfigSchema> | undefined {
  const parsed = swarmConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  issues.push(...zodIssues("swarm.config", parsed.error));
  return undefined;
}

async function readConfigDirectory<T>(
  directory: string,
  parse: (id: string, value: unknown) => T & { id: string }
): Promise<{ values: Record<string, T>; issues: SwarmValidationIssue[] }> {
  const values: Record<string, T> = {};
  const issues: SwarmValidationIssue[] = [];
  let entries: string[];

  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    issues.push({
      path: directory,
      message:
        code === "ENOENT"
          ? "missing Swarm config directory"
          : error instanceof Error
            ? error.message
            : String(error),
    });
    return { values, issues };
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(directory, entry);
    const id = path.basename(entry, ".json");
    try {
      const text = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(text) as unknown;
      const value = parse(id, parsed);
      if (values[value.id]) {
        issues.push({ path: filePath, message: `duplicate id "${value.id}"` });
      }
      values[value.id] = value;
    } catch (error) {
      issues.push(...zodIssues(filePath, error));
    }
  }

  return { values, issues };
}
