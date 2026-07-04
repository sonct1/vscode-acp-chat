import * as vscode from "vscode";
import { spawn } from "child_process";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from "@agentclientprotocol/sdk";

interface ManagedTerminal {
  id: string;
  proc: ReturnType<typeof spawn> | null;
  output: string;
  outputByteLimit: number | null;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<void>;
  exitResolve: () => void;
}

export class TerminalHandler {
  private terminals: Map<string, ManagedTerminal> = new Map();
  private terminalCounter = 0;

  async handleCreateTerminal(
    params: CreateTerminalRequest
  ): Promise<CreateTerminalResponse> {
    const terminalId = `term-${++this.terminalCounter}-${Date.now()}`;

    let exitResolve: () => void = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });

    const managedTerminal: ManagedTerminal = {
      id: terminalId,
      proc: null,
      output: "",
      outputByteLimit: params.outputByteLimit ?? null,
      truncated: false,
      exitCode: null,
      signal: null,
      exitPromise,
      exitResolve,
    };

    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd =
      params.cwd && params.cwd.trim() !== ""
        ? params.cwd
        : workspaceCwd ||
          process.env.HOME ||
          process.env.USERPROFILE ||
          process.cwd();

    const proc = spawn(params.command, params.args || [], {
      cwd,
      env: {
        ...process.env,
        ...(params.env?.reduce(
          (acc, e) => ({ ...acc, [e.name]: e.value }),
          {}
        ) || {}),
      },
      shell: true,
    });

    managedTerminal.proc = proc;

    proc.stdout?.on("data", (data: Buffer) => {
      this.appendTerminalOutput(managedTerminal, data.toString());
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this.appendTerminalOutput(managedTerminal, data.toString());
    });

    proc.on("close", (code: number | null, signal: string | null) => {
      managedTerminal.exitCode = code;
      managedTerminal.signal = signal;
      managedTerminal.exitResolve();
    });

    proc.on("error", (err: Error) => {
      this.appendTerminalOutput(managedTerminal, `Error: ${err.message}\n`);
      managedTerminal.exitCode = 1;
      managedTerminal.exitResolve();
    });

    this.terminals.set(terminalId, managedTerminal);

    return { terminalId };
  }

  async handleTerminalOutput(
    params: TerminalOutputRequest
  ): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const exitStatus =
      terminal.exitCode !== null
        ? {
            exitCode: terminal.exitCode,
            ...(terminal.signal !== null && { signal: terminal.signal }),
          }
        : null;

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus,
    };
  }

  async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await terminal.exitPromise;

    return {
      exitCode: terminal.exitCode,
      ...(terminal.signal !== null && { signal: terminal.signal }),
    };
  }

  async handleKillTerminalCommand(
    params: KillTerminalRequest
  ): Promise<KillTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    this.killTerminalProcess(terminal);
    return {};
  }

  async handleReleaseTerminal(
    params: ReleaseTerminalRequest
  ): Promise<ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      return {};
    }

    this.killTerminalProcess(terminal);
    this.terminals.delete(params.terminalId);
    return {};
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) {
      this.killTerminalProcess(terminal);
    }
    this.terminals.clear();
  }

  private appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
    terminal.output += text;
    if (terminal.outputByteLimit !== null) {
      const byteLength = Buffer.byteLength(terminal.output, "utf8");
      if (byteLength > terminal.outputByteLimit) {
        const encoded = Buffer.from(terminal.output, "utf8");
        const sliced = encoded.slice(-terminal.outputByteLimit);
        terminal.output = sliced.toString("utf8");
        terminal.truncated = true;
      }
    }
  }

  private killTerminalProcess(terminal: ManagedTerminal): void {
    if (terminal.proc && !terminal.proc.killed) {
      try {
        terminal.proc.kill();
      } catch {}
    }
  }
}
