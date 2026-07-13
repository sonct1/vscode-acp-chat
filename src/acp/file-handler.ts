import * as vscode from "vscode";
import {
  RequestError,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { DiffManager } from "./diff-manager";

export interface FileWriteCoordinator {
  serialize<T>(path: string, task: () => Promise<T>): Promise<T>;
  didWrite?(path: string, oldText: string | null, newText: string): void;
}

export class FileHandler {
  private lastFileContents: Map<string, string | null> = new Map();
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();

  constructor(
    private diffManager: DiffManager,
    private readonly writeCoordinator?: FileWriteCoordinator
  ) {}

  /**
   * Return the pre-write snapshot for `path` and remove it from the cache.
   * Returns `undefined` when no snapshot was captured for this path.
   * Returns `null` when the file was newly created (did not exist before write).
   */
  getLastFileContent(path: string): string | null | undefined {
    if (!this.lastFileContents.has(path)) {
      return undefined;
    }
    const value = this.lastFileContents.get(path);
    this.lastFileContents.delete(path);
    return value;
  }

  clearLastFileContents(): void {
    this.lastFileContents.clear();
  }

  dispose(): void {
    this.lastFileContents.clear();
  }

  async handleReadTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    try {
      const uri = vscode.Uri.file(params.path);
      const openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.fsPath === uri.fsPath
      );

      let content: string;
      if (openDoc) {
        content = openDoc.getText();
      } else {
        let stat: vscode.FileStat | undefined;
        let statError: unknown;
        try {
          stat = await vscode.workspace.fs.stat(uri);
        } catch (err) {
          statError = err;
        }

        if (stat && stat.type & vscode.FileType.Directory) {
          content = await this.buildDirectoryListing(uri);
        } else {
          try {
            const fileContent = await vscode.workspace.fs.readFile(uri);
            content = this.textDecoder.decode(fileContent);
          } catch (readError) {
            const errorMessage =
              readError instanceof Error
                ? readError.message
                : String(readError);
            if (
              errorMessage.includes("ENOENT") ||
              errorMessage.includes("File not found") ||
              errorMessage.includes("no such file")
            ) {
              throw RequestError.resourceNotFound(params.path);
            } else if (statError !== undefined) {
              throw statError instanceof RequestError
                ? statError
                : new RequestError(-32603, String(statError), {
                    path: params.path,
                  });
            } else {
              throw readError instanceof RequestError
                ? readError
                : new RequestError(-32603, String(readError), {
                    path: params.path,
                  });
            }
          }
        }
      }

      if (params.line !== undefined || params.limit !== undefined) {
        const lines = content.split("\n");
        const startLine = params.line ?? 0;
        const lineLimit = params.limit ?? lines.length;
        const selectedLines = lines.slice(startLine, startLine + lineLimit);
        content = selectedLines.join("\n");
      }

      return { content };
    } catch (error) {
      console.error("[FileHandler] Failed to read file:", error);
      if (error instanceof RequestError) {
        throw error;
      }
      throw new RequestError(-32603, String(error), { path: params.path });
    }
  }

  async handleWriteTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    const write = () => this.writeTextFile(params);
    return this.writeCoordinator
      ? this.writeCoordinator.serialize(params.path, write)
      : write();
  }

  private async writeTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    try {
      const uri = vscode.Uri.file(params.path);

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          throw new RequestError(
            -32602,
            `Cannot write to "${params.path}": path is a directory, not a file. Use readTextFile to list directory contents.`,
            { path: params.path }
          );
        }
      } catch (error) {
        if (error instanceof RequestError) {
          throw error;
        }
      }

      const parentUri = vscode.Uri.joinPath(uri, "..");
      try {
        const parentStat = await vscode.workspace.fs.stat(parentUri);
        if (!(parentStat.type & vscode.FileType.Directory)) {
          throw new RequestError(
            -32602,
            `Cannot write to "${params.path}": parent path is not a directory.`,
            { path: params.path, parent: parentUri.fsPath }
          );
        }
      } catch (error) {
        if (error instanceof RequestError) {
          throw error;
        }
        throw new RequestError(-32603, String(error), {
          path: params.path,
          parent: parentUri.fsPath,
        });
      }

      let oldContent: string | null = null;
      try {
        const fileContent = await vscode.workspace.fs.readFile(uri);
        oldContent = this.textDecoder.decode(fileContent);
        this.lastFileContents.set(params.path, oldContent);
      } catch {
        this.lastFileContents.set(params.path, null);
      }

      const content = this.textEncoder.encode(params.content);
      await vscode.workspace.fs.writeFile(uri, content);

      this.diffManager.recordChange(params.path, oldContent, params.content);
      this.writeCoordinator?.didWrite?.(
        params.path,
        oldContent,
        params.content
      );

      return {};
    } catch (error) {
      console.error("[FileHandler] Failed to write file:", error);
      if (error instanceof RequestError) {
        throw error;
      }
      throw new RequestError(-32603, String(error), { path: params.path });
    }
  }

  private async buildDirectoryListing(uri: vscode.Uri): Promise<string> {
    const entries = await vscode.workspace.fs.readDirectory(uri);

    const childStats = await Promise.all(
      entries.map(async ([name, type]) => {
        try {
          const childStat = await vscode.workspace.fs.stat(
            vscode.Uri.joinPath(uri, name)
          );
          return { name, type, stat: childStat, error: null };
        } catch (err) {
          return {
            name,
            type,
            stat: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    return this.formatDirectoryListing(uri, childStats);
  }

  private formatDirectoryListing(
    uri: vscode.Uri,
    childStats: Array<{
      name: string;
      type: vscode.FileType;
      stat: vscode.FileStat | null;
      error: string | null;
    }>
  ): string {
    const header = `[Directory listing for: ${uri.fsPath}]`;
    if (childStats.length === 0) {
      return `${header}\n(empty directory)\nNote: line/limit parameters are ignored for directory paths. Recursive listing is not supported.`;
    }

    const lines = childStats.map((entry) => {
      const tag = this.fileTypeTag(entry.type);
      if (entry.error) {
        return `${tag} ${entry.name}  (stat error: ${entry.error})`;
      }
      const stat = entry.stat!;
      const mtime = new Date(stat.mtime).toISOString();
      const ctime = new Date(stat.ctime).toISOString();
      const perms = this.formatPermissions(stat.permissions);
      return `${tag} ${entry.name}  size=${stat.size}  mtime=${mtime}  ctime=${ctime}  perms=${perms}`;
    });

    return [
      header,
      ...lines,
      "Note: line/limit parameters are ignored for directory paths. Recursive listing is not supported.",
    ].join("\n");
  }

  private fileTypeTag(type: vscode.FileType): string {
    const isLink = (type & vscode.FileType.SymbolicLink) !== 0;
    const isDir = (type & vscode.FileType.Directory) !== 0;
    const isFile = (type & vscode.FileType.File) !== 0;
    if (isLink) {
      return isDir ? "[LINK->DIR]" : isFile ? "[LINK->FILE]" : "[LINK]";
    }
    if (isDir) return "[DIR]";
    if (isFile) return "[FILE]";
    return "[UNKNOWN]";
  }

  private formatPermissions(perms: vscode.FilePermission | undefined): string {
    if (perms === undefined) {
      return "n/a";
    }
    const isReadonly = (perms & vscode.FilePermission.Readonly) !== 0;
    return isReadonly ? "r--" : "-w-";
  }
}
