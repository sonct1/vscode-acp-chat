import * as fs from "node:fs";
import * as path from "node:path";
import type { SwarmEvidenceStore } from "./evidence-store";
import type { SwarmMonitor } from "./monitor";

export type LockRelease = () => void;

interface QueueEntry {
  stepId: string;
  resolve: (release: LockRelease) => void;
}

export class SwarmLockManager {
  private readonly held = new Set<string>();
  private readonly queues = new Map<string, QueueEntry[]>();

  constructor(
    private readonly monitor?: SwarmMonitor,
    private readonly evidence?: SwarmEvidenceStore
  ) {}

  async acquire(lockId: string, stepId: string): Promise<LockRelease> {
    if (!this.held.has(lockId)) {
      this.held.add(lockId);
      await this.record(stepId, lockId, "acquire");
      return () => void this.release(lockId, stepId);
    }

    await this.record(stepId, lockId, "wait");
    return new Promise<LockRelease>((resolve) => {
      const queue = this.queues.get(lockId) ?? [];
      queue.push({ stepId, resolve });
      this.queues.set(lockId, queue);
    });
  }

  async withLocks<T>(
    lockIds: string[],
    stepId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const releases: LockRelease[] = [];
    try {
      for (const lockId of [...lockIds].sort()) {
        releases.push(await this.acquire(lockId, stepId));
      }
      return await action();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  isTestCommand(command: string, patterns: string[]): boolean {
    const normalized = normalizeCommand(command);
    return patterns.some((pattern) => normalized.includes(normalizeCommand(pattern)));
  }

  pathLock(filePath: string, cwd = process.cwd()): string {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);
    const normalized = canonicalizePath(absolute);
    return `workspace_write:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
  }

  private async release(lockId: string, stepId: string): Promise<void> {
    const queue = this.queues.get(lockId);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.queues.delete(lockId);

    if (!next) {
      this.held.delete(lockId);
      await this.record(stepId, lockId, "release");
      return;
    }

    await this.record(stepId, lockId, "release");
    await this.record(next.stepId, lockId, "acquire");
    next.resolve(() => void this.release(lockId, next.stepId));
  }

  private async record(
    stepId: string,
    lockId: string,
    event: "wait" | "acquire" | "release"
  ): Promise<void> {
    this.evidence?.addLockEvent({ stepId, lockId, event, timestamp: Date.now() });
    await this.monitor?.lock({ stepId, lockId, event });
  }
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function canonicalizePath(filePath: string): string {
  const normalized = path.normalize(filePath);
  try {
    return fs.realpathSync.native(normalized);
  } catch {
    const existingParent = findExistingParent(path.dirname(normalized));
    if (!existingParent) return normalized;
    const relative = path.relative(existingParent, normalized);
    return path.join(fs.realpathSync.native(existingParent), relative);
  }
}

function findExistingParent(directory: string): string | null {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
