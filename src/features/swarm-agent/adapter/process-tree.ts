import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export async function terminateChildProcessTree(
  child: ChildProcess
): Promise<void> {
  if (hasExited(child)) return;
  const exitedAfterTerm = waitForChildExit(child, 500);
  signalProcessTree(child, "SIGTERM");
  if (await exitedAfterTerm) return;

  const exitedAfterKill = waitForChildExit(child, 500);
  signalProcessTree(child, "SIGKILL");
  await exitedAfterKill;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill(signal);
    } catch {
      // Best effort cleanup.
    }
    return;
  }

  if (process.platform === "win32") {
    killWindowsProcessTree(pid, child);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Best effort cleanup.
    }
  }
}

function killWindowsProcessTree(pid: number, child: ChildProcess): void {
  execFile(
    "taskkill",
    ["/pid", String(pid), "/t", "/f"],
    { windowsHide: true },
    (error) => {
      if (error && !hasExited(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort cleanup.
        }
      }
    }
  );
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}
