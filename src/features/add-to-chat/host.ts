import * as path from "path";
import * as vscode from "vscode";
import type { Mention } from "../../utils/mention-serializer";

export const ADD_TO_CHAT_COMMANDS = {
  addSelection: "vscode-acp-chat.sendSelectionToChat",
  addTerminalSelection: "vscode-acp-chat.sendTerminalSelectionToChat",
  addFile: "vscode-acp-chat.addFileToChat",
  addFolder: "vscode-acp-chat.addFolderToChat",
} as const;

export type ResourceMentionType = "file" | "folder";

export interface ChatMentionTarget {
  addMention(mention: Mention): void;
}

export interface AddToChatHostControllerOptions {
  getChatTarget: () => ChatMentionTarget | undefined;
  getActiveEditor?: () => vscode.TextEditor | undefined;
  getActiveTerminal?: () => vscode.Terminal | undefined;
  executeCommand?: (command: string, ...args: unknown[]) => Thenable<unknown>;
  readClipboard?: () => Thenable<string>;
  writeClipboard?: (value: string) => Thenable<void>;
  focusChat?: () => Thenable<unknown>;
  showInformationMessage?: (message: string) => Thenable<unknown>;
  showWarningMessage?: (message: string) => Thenable<unknown>;
  showOpenDialog?: (
    options: vscode.OpenDialogOptions
  ) => Thenable<vscode.Uri[] | undefined>;
  statResource?: (uri: vscode.Uri) => Thenable<vscode.FileStat>;
  asRelativePath?: (uri: vscode.Uri) => string;
}

interface TerminalSelectionContext {
  selection?: string;
  terminalName?: string;
}

function uriToMentionPath(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function basenameForUri(uri: vscode.Uri): string {
  const rawPath = uri.fsPath || uri.path || uri.toString();
  const normalized = rawPath.replace(/[\\/]+$/, "");
  return path.basename(normalized) || uri.authority || uri.toString();
}

export function createSelectionMention(input: {
  uri: vscode.Uri;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
}): Mention {
  return {
    type: "selection",
    name: `${input.relativePath}:${input.startLine}-${input.endLine}`,
    path: uriToMentionPath(input.uri),
    content: input.content,
    range: {
      startLine: input.startLine,
      endLine: input.endLine,
    },
  };
}

export function createSelectionMentionFromEditor(
  editor: vscode.TextEditor,
  asRelativePath: (uri: vscode.Uri) => string = (uri) =>
    vscode.workspace.asRelativePath(uri)
): Mention | undefined {
  if (editor.selection.isEmpty) {
    return undefined;
  }

  const selection = editor.selection;
  return createSelectionMention({
    uri: editor.document.uri,
    relativePath: asRelativePath(editor.document.uri),
    content: editor.document.getText(selection),
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
  });
}

export function createTerminalMention(
  selection: string,
  terminalName: string
): Mention {
  return {
    type: "terminal",
    name: `Terminal: ${terminalName}`,
    content: selection,
  };
}

export function createResourceMention(
  uri: vscode.Uri,
  type: ResourceMentionType
): Mention {
  return {
    type,
    name: basenameForUri(uri),
    path: uriToMentionPath(uri),
  };
}

export function fileTypeMatchesResourceType(
  fileType: vscode.FileType,
  resourceType: ResourceMentionType
): boolean {
  const expected =
    resourceType === "folder"
      ? vscode.FileType.Directory
      : vscode.FileType.File;
  return (fileType & expected) === expected;
}

export function parseTerminalSelectionContext(
  args: unknown
): TerminalSelectionContext {
  if (!args || typeof args !== "object") {
    return {};
  }

  const argsObj = args as Record<string, unknown>;
  const context: TerminalSelectionContext = {};

  if (typeof argsObj.selection === "string" && argsObj.selection.length > 0) {
    context.selection = argsObj.selection;
  }

  if (argsObj.terminal && typeof argsObj.terminal === "object") {
    const terminal = argsObj.terminal as Record<string, unknown>;
    if (typeof terminal.name === "string" && terminal.name.length > 0) {
      context.terminalName = terminal.name;
    }
  }

  if (!context.terminalName && typeof argsObj.name === "string") {
    context.terminalName = argsObj.name;
  }

  return context;
}

export class AddToChatHostController {
  private readonly getChatTarget: () => ChatMentionTarget | undefined;
  private readonly getActiveEditor: () => vscode.TextEditor | undefined;
  private readonly getActiveTerminal: () => vscode.Terminal | undefined;
  private readonly executeCommand: (
    command: string,
    ...args: unknown[]
  ) => Thenable<unknown>;
  private readonly readClipboard: () => Thenable<string>;
  private readonly writeClipboard: (value: string) => Thenable<void>;
  private readonly focusChat: () => Thenable<unknown>;
  private readonly showInformationMessage: (
    message: string
  ) => Thenable<unknown>;
  private readonly showWarningMessage: (message: string) => Thenable<unknown>;
  private readonly showOpenDialog: (
    options: vscode.OpenDialogOptions
  ) => Thenable<vscode.Uri[] | undefined>;
  private readonly statResource: (uri: vscode.Uri) => Thenable<vscode.FileStat>;
  private readonly asRelativePath: (uri: vscode.Uri) => string;

  constructor(options: AddToChatHostControllerOptions) {
    this.getChatTarget = options.getChatTarget;
    this.getActiveEditor =
      options.getActiveEditor ?? (() => vscode.window.activeTextEditor);
    this.getActiveTerminal =
      options.getActiveTerminal ?? (() => vscode.window.activeTerminal);
    this.executeCommand =
      options.executeCommand ??
      ((command, ...args) => vscode.commands.executeCommand(command, ...args));
    this.readClipboard =
      options.readClipboard ?? (() => vscode.env.clipboard.readText());
    this.writeClipboard =
      options.writeClipboard ??
      ((value) => vscode.env.clipboard.writeText(value));
    this.focusChat =
      options.focusChat ??
      (() => vscode.commands.executeCommand("vscode-acp-chat.chatView.focus"));
    this.showInformationMessage =
      options.showInformationMessage ??
      ((message) => vscode.window.showInformationMessage(message));
    this.showWarningMessage =
      options.showWarningMessage ??
      ((message) => vscode.window.showWarningMessage(message));
    this.showOpenDialog =
      options.showOpenDialog ??
      ((dialogOptions) => vscode.window.showOpenDialog(dialogOptions));
    this.statResource =
      options.statResource ?? ((uri) => vscode.workspace.fs.stat(uri));
    this.asRelativePath =
      options.asRelativePath ?? ((uri) => vscode.workspace.asRelativePath(uri));
  }

  async addEditorSelectionToChat(): Promise<void> {
    const activeEditor = this.getActiveEditor();
    if (activeEditor) {
      const mention = createSelectionMentionFromEditor(
        activeEditor,
        this.asRelativePath
      );
      if (mention) {
        await this.addMentionsToChat([mention]);
        return;
      }
    }

    if (await this.addActiveTerminalSelectionToChat()) {
      return;
    }

    await this.showInformationMessage(
      "No text selected in editor or terminal."
    );
  }

  async addTerminalSelectionToChat(args?: unknown): Promise<void> {
    const context = parseTerminalSelectionContext(args);
    const activeTerminal = this.getActiveTerminal();
    const terminalName =
      context.terminalName || activeTerminal?.name || "Terminal";
    let selection = context.selection ?? "";

    if (!selection && activeTerminal) {
      selection = await this.copyActiveTerminalSelection();
    }

    if (!selection) {
      await this.showInformationMessage("No text selected in terminal.");
      return;
    }

    await this.addMentionsToChat([
      createTerminalMention(selection, terminalName),
    ]);
  }

  async addFileToChat(
    uri?: vscode.Uri,
    selectedUris?: readonly vscode.Uri[]
  ): Promise<void> {
    await this.addResourceToChat("file", uri, selectedUris);
  }

  async addFolderToChat(
    uri?: vscode.Uri,
    selectedUris?: readonly vscode.Uri[]
  ): Promise<void> {
    await this.addResourceToChat("folder", uri, selectedUris);
  }

  private async addActiveTerminalSelectionToChat(): Promise<boolean> {
    const activeTerminal = this.getActiveTerminal();
    if (!activeTerminal) {
      return false;
    }

    const selection = await this.copyActiveTerminalSelection();
    if (!selection) {
      return false;
    }

    await this.addMentionsToChat([
      createTerminalMention(selection, activeTerminal.name),
    ]);
    return true;
  }

  private async copyActiveTerminalSelection(): Promise<string> {
    const previousClipboard = await this.readClipboard();
    const sentinel = `__vscode_acp_chat_terminal_selection_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

    try {
      await this.writeClipboard(sentinel);
      await this.executeCommand("workbench.action.terminal.copySelection");

      const copied = await this.readClipboard();
      if (copied === sentinel) {
        await this.writeClipboard(previousClipboard);
        return "";
      }

      return copied;
    } catch (error) {
      try {
        await this.writeClipboard(previousClipboard);
      } catch (restoreError) {
        console.warn(
          "[AddToChat] Failed to restore clipboard after terminal copy error:",
          restoreError
        );
      }
      console.warn("[AddToChat] Failed to copy terminal selection:", error);
      return "";
    }
  }

  private async addResourceToChat(
    resourceType: ResourceMentionType,
    uri?: vscode.Uri,
    selectedUris?: readonly vscode.Uri[]
  ): Promise<void> {
    const candidates = await this.getCandidateResourceUris(
      resourceType,
      uri,
      selectedUris
    );

    if (candidates.length === 0) {
      await this.showInformationMessage(
        `No ${resourceType}s selected to add to chat.`
      );
      return;
    }

    const mentions: Mention[] = [];
    for (const candidate of candidates) {
      try {
        const stat = await this.statResource(candidate);
        if (fileTypeMatchesResourceType(stat.type, resourceType)) {
          mentions.push(createResourceMention(candidate, resourceType));
        }
      } catch {
        // Ignore resources that disappear or cannot be stat'ed.
      }
    }

    if (mentions.length === 0) {
      await this.showWarningMessage(
        `No ${resourceType}s selected to add to chat.`
      );
      return;
    }

    await this.addMentionsToChat(mentions);
  }

  private async getCandidateResourceUris(
    resourceType: ResourceMentionType,
    uri?: vscode.Uri,
    selectedUris?: readonly vscode.Uri[]
  ): Promise<vscode.Uri[]> {
    const contextUris =
      selectedUris && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
    if (contextUris.length > 0) {
      return [...contextUris];
    }

    const dialogOptions: vscode.OpenDialogOptions = {
      canSelectFiles: resourceType === "file",
      canSelectFolders: resourceType === "folder",
      canSelectMany: true,
      openLabel:
        resourceType === "file" ? "Add File to Chat" : "Add Folder to Chat",
    };
    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (firstWorkspaceFolder) {
      dialogOptions.defaultUri = firstWorkspaceFolder.uri;
    }

    return (await this.showOpenDialog(dialogOptions)) ?? [];
  }

  private async addMentionsToChat(mentions: Mention[]): Promise<boolean> {
    const target = this.getChatTarget();
    if (!target || mentions.length === 0) {
      return false;
    }

    try {
      await this.focusChat();
    } catch (error) {
      console.warn("[AddToChat] Failed to focus chat view:", error);
    }

    for (const mention of mentions) {
      target.addMention(mention);
    }

    return true;
  }
}

export function registerAddToChatHostFeature(options: {
  context: vscode.ExtensionContext;
  getChatTarget: () => ChatMentionTarget | undefined;
}): AddToChatHostController {
  const controller = new AddToChatHostController({
    getChatTarget: options.getChatTarget,
  });

  options.context.subscriptions.push(
    vscode.commands.registerCommand(ADD_TO_CHAT_COMMANDS.addSelection, () =>
      controller.addEditorSelectionToChat()
    ),
    vscode.commands.registerCommand(
      ADD_TO_CHAT_COMMANDS.addTerminalSelection,
      (args?: unknown) => controller.addTerminalSelectionToChat(args)
    ),
    vscode.commands.registerCommand(
      ADD_TO_CHAT_COMMANDS.addFile,
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) =>
        controller.addFileToChat(uri, selectedUris)
    ),
    vscode.commands.registerCommand(
      ADD_TO_CHAT_COMMANDS.addFolder,
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) =>
        controller.addFolderToChat(uri, selectedUris)
    )
  );

  return controller;
}
