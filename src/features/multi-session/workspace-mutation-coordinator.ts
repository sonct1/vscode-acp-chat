import * as crypto from "crypto";
import * as vscode from "vscode";
import type { FileChange } from "../../acp/diff-manager";

export interface RollbackResult {
  ok: boolean;
  conflict?: boolean;
  message?: string;
}

export class WorkspaceMutationCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly writeListeners = new Set<
    (
      ownerId: string | undefined,
      path: string,
      oldText: string | null,
      newText: string
    ) => void
  >();

  async serialize<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(
      path,
      next.finally(() => {
        if (this.queues.get(path) === next) this.queues.delete(path);
      })
    );
    return next;
  }

  onDidWrite(
    listener: (
      ownerId: string | undefined,
      path: string,
      oldText: string | null,
      newText: string
    ) => void
  ): { dispose(): void } {
    this.writeListeners.add(listener);
    return { dispose: () => this.writeListeners.delete(listener) };
  }

  didWrite(
    ownerId: string | undefined,
    path: string,
    oldText: string | null,
    newText: string
  ): void {
    for (const listener of this.writeListeners) {
      listener(ownerId, path, oldText, newText);
    }
  }

  forOwner(ownerId: string): {
    serialize<T>(path: string, task: () => Promise<T>): Promise<T>;
    didWrite(path: string, oldText: string | null, newText: string): void;
  } {
    return {
      serialize: (path, task) => this.serialize(path, task),
      didWrite: (path, oldText, newText) =>
        this.didWrite(ownerId, path, oldText, newText),
    };
  }

  async matchesCurrent(change: FileChange): Promise<boolean> {
    return this.serialize(change.path, async () => {
      const current = await readFileText(vscode.Uri.file(change.path));
      return current === change.newText;
    });
  }

  async safeRollback(change: FileChange): Promise<RollbackResult> {
    return this.serialize(change.path, async () => {
      const uri = vscode.Uri.file(change.path);
      const current = await readFileText(uri);
      if (current !== change.newText) {
        return {
          ok: false,
          conflict: true,
          message: `Rollback conflict for ${vscode.workspace.asRelativePath(change.path)}: file content changed after this session wrote it.`,
        };
      }
      if (change.oldText === null) {
        try {
          await vscode.workspace.fs.delete(uri, {
            recursive: true,
            useTrash: true,
          });
        } catch (error) {
          if (!(
            error instanceof vscode.FileSystemError &&
            error.code === "FileNotFound"
          ))
            throw error;
        }
      } else {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(change.oldText)
        );
      }
      return { ok: true };
    });
  }

  static hash(text: string | null): string | null {
    return text === null
      ? null
      : crypto.createHash("sha256").update(text).digest("hex");
  }
}

async function readFileText(uri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    )
      return null;
    throw error;
  }
}
