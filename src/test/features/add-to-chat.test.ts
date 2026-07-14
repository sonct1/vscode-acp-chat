import * as assert from "assert";
import * as vscode from "vscode";
import {
  AddToChatHostController,
  createResourceMention,
  createSelectionMention,
  createTerminalMention,
} from "../../features/add-to-chat";
import type { Mention } from "../../utils/mention-serializer";

function fileStat(type: vscode.FileType): vscode.FileStat {
  return {
    type,
    ctime: 0,
    mtime: 0,
    size: 0,
  };
}

function createController(
  options: {
    statTypes?: Map<string, vscode.FileType>;
    dialogUris?: vscode.Uri[];
    activeEditor?: vscode.TextEditor;
    activeTerminal?: vscode.Terminal;
    clipboardText?: string;
    onExecuteCommand?: (
      command: string,
      setClipboard: (value: string) => void
    ) => void | Promise<void>;
  } = {}
) {
  const mentions: Mention[] = [];
  const focusedCommands: string[] = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];
  const openDialogOptions: vscode.OpenDialogOptions[] = [];
  const executedCommands: string[] = [];
  let clipboard = options.clipboardText ?? "";
  const controller = new AddToChatHostController({
    getChatTarget: () => ({
      addMention: (mention) => mentions.push(mention),
    }),
    getActiveEditor: () => options.activeEditor,
    getActiveTerminal: () => options.activeTerminal,
    executeCommand: async (command) => {
      executedCommands.push(command);
      await options.onExecuteCommand?.(command, (value) => {
        clipboard = value;
      });
    },
    readClipboard: async () => clipboard,
    writeClipboard: async (value) => {
      clipboard = value;
    },
    focusChat: async () => {
      focusedCommands.push("vscode-acp-chat.chatView.focus");
    },
    showInformationMessage: async (message) => {
      infoMessages.push(message);
    },
    showWarningMessage: async (message) => {
      warningMessages.push(message);
    },
    showOpenDialog: async (dialogOptions) => {
      openDialogOptions.push(dialogOptions);
      return options.dialogUris;
    },
    statResource: async (uri) => {
      const type = options.statTypes?.get(uri.toString());
      if (type === undefined) {
        throw new Error(`Missing stat for ${uri.toString()}`);
      }
      return fileStat(type);
    },
  });

  return {
    controller,
    mentions,
    focusedCommands,
    infoMessages,
    warningMessages,
    openDialogOptions,
    executedCommands,
    getClipboard: () => clipboard,
  };
}

suite("add-to-chat feature", () => {
  test("creates editor selection mention with content and 1-based range", () => {
    const uri = vscode.Uri.file("/workspace/src/example.ts");
    const mention = createSelectionMention({
      uri,
      relativePath: "src/example.ts",
      content: "const value = 1;",
      startLine: 2,
      endLine: 4,
    });

    assert.deepStrictEqual(mention, {
      type: "selection",
      name: "src/example.ts:2-4",
      path: uri.fsPath,
      content: "const value = 1;",
      range: { startLine: 2, endLine: 4 },
    });
  });

  test("creates terminal mention with selected content", () => {
    const mention = createTerminalMention("npm test", "bash");

    assert.deepStrictEqual(mention, {
      type: "terminal",
      name: "Terminal: bash",
      content: "npm test",
    });
  });

  test("creates file and folder mentions as path references without content", () => {
    const fileUri = vscode.Uri.file("/workspace/src/example.ts");
    const folderUri = vscode.Uri.file("/workspace/src/features");

    assert.deepStrictEqual(createResourceMention(fileUri, "file"), {
      type: "file",
      name: "example.ts",
      path: fileUri.fsPath,
    });
    assert.deepStrictEqual(createResourceMention(folderUri, "folder"), {
      type: "folder",
      name: "features",
      path: folderUri.fsPath,
    });
    assert.strictEqual(
      createResourceMention(fileUri, "file").content,
      undefined
    );
    assert.strictEqual(
      createResourceMention(folderUri, "folder").content,
      undefined
    );
  });

  test("does not add stale clipboard when terminal copy finds no selection", async () => {
    const activeTerminal = { name: "bash" } as vscode.Terminal;
    const {
      controller,
      mentions,
      infoMessages,
      executedCommands,
      getClipboard,
    } = createController({
      activeTerminal,
      clipboardText: "stale clipboard",
    });

    await controller.addTerminalSelectionToChat();

    assert.strictEqual(mentions.length, 0);
    assert.deepStrictEqual(executedCommands, [
      "workbench.action.terminal.copySelection",
    ]);
    assert.deepStrictEqual(infoMessages, ["No text selected in terminal."]);
    assert.strictEqual(getClipboard(), "stale clipboard");
  });

  test("adds terminal selection copied by VS Code command", async () => {
    const activeTerminal = { name: "bash" } as vscode.Terminal;
    const { controller, mentions, getClipboard } = createController({
      activeTerminal,
      clipboardText: "previous clipboard",
      onExecuteCommand: (_command, setClipboard) =>
        setClipboard("selected text"),
    });

    await controller.addTerminalSelectionToChat();

    assert.deepStrictEqual(mentions, [
      {
        type: "terminal",
        name: "Terminal: bash",
        content: "selected text",
      },
    ]);
    assert.strictEqual(getClipboard(), "selected text");
  });

  test("editor command fallback ignores stale terminal clipboard", async () => {
    const activeTerminal = { name: "bash" } as vscode.Terminal;
    const { controller, mentions, infoMessages, getClipboard } =
      createController({
        activeTerminal,
        clipboardText: "stale clipboard",
      });

    await controller.addEditorSelectionToChat();

    assert.strictEqual(mentions.length, 0);
    assert.deepStrictEqual(infoMessages, [
      "No text selected in editor or terminal.",
    ]);
    assert.strictEqual(getClipboard(), "stale clipboard");
  });

  test("adds multi-selected file mentions in input order and filters folders", async () => {
    const fileA = vscode.Uri.file("/workspace/a.ts");
    const folder = vscode.Uri.file("/workspace/src");
    const fileB = vscode.Uri.file("/workspace/b.ts");
    const { controller, mentions, focusedCommands } = createController({
      statTypes: new Map([
        [fileA.toString(), vscode.FileType.File],
        [folder.toString(), vscode.FileType.Directory],
        [fileB.toString(), vscode.FileType.File],
      ]),
    });

    await controller.addFileToChat(fileA, [fileA, folder, fileB]);

    assert.deepStrictEqual(
      mentions.map((mention) => [mention.type, mention.name, mention.path]),
      [
        ["file", "a.ts", fileA.fsPath],
        ["file", "b.ts", fileB.fsPath],
      ]
    );
    assert.deepStrictEqual(focusedCommands, ["vscode-acp-chat.chatView.focus"]);
  });

  test("adds multi-selected folder mentions in input order and filters files", async () => {
    const folderA = vscode.Uri.file("/workspace/src");
    const file = vscode.Uri.file("/workspace/src/example.ts");
    const folderB = vscode.Uri.file("/workspace/docs");
    const { controller, mentions } = createController({
      statTypes: new Map([
        [folderA.toString(), vscode.FileType.Directory],
        [file.toString(), vscode.FileType.File],
        [folderB.toString(), vscode.FileType.Directory],
      ]),
    });

    await controller.addFolderToChat(folderA, [folderA, file, folderB]);

    assert.deepStrictEqual(
      mentions.map((mention) => [mention.type, mention.name, mention.path]),
      [
        ["folder", "src", folderA.fsPath],
        ["folder", "docs", folderB.fsPath],
      ]
    );
  });

  test("adds active editor file when no Explorer URI is provided", async () => {
    const fileUri = vscode.Uri.file("/workspace/active.ts");
    const activeEditor = {
      document: { uri: fileUri },
    } as vscode.TextEditor;
    const { controller, mentions, openDialogOptions } = createController({
      activeEditor,
      statTypes: new Map([[fileUri.toString(), vscode.FileType.File]]),
    });

    await controller.addFileToChat();

    assert.strictEqual(openDialogOptions.length, 0);
    assert.deepStrictEqual(mentions, [
      { type: "file", name: "active.ts", path: fileUri.fsPath },
    ]);
  });

  test("prefers explicit file URI over active editor fallback", async () => {
    const explicitUri = vscode.Uri.file("/workspace/from-title.ts");
    const activeUri = vscode.Uri.file("/workspace/active.ts");
    const activeEditor = {
      document: { uri: activeUri },
    } as vscode.TextEditor;
    const { controller, mentions, openDialogOptions } = createController({
      activeEditor,
      statTypes: new Map([
        [explicitUri.toString(), vscode.FileType.File],
        [activeUri.toString(), vscode.FileType.File],
      ]),
    });

    await controller.addFileToChat(explicitUri);

    assert.strictEqual(openDialogOptions.length, 0);
    assert.deepStrictEqual(mentions, [
      { type: "file", name: "from-title.ts", path: explicitUri.fsPath },
    ]);
  });

  test("opens command palette fallback file picker when no file context is available", async () => {
    const fileUri = vscode.Uri.file("/workspace/from-picker.ts");
    const { controller, mentions, openDialogOptions } = createController({
      dialogUris: [fileUri],
      statTypes: new Map([[fileUri.toString(), vscode.FileType.File]]),
    });

    await controller.addFileToChat();

    assert.strictEqual(openDialogOptions.length, 1);
    assert.strictEqual(openDialogOptions[0].canSelectFiles, true);
    assert.strictEqual(openDialogOptions[0].canSelectFolders, false);
    assert.deepStrictEqual(mentions, [
      { type: "file", name: "from-picker.ts", path: fileUri.fsPath },
    ]);
  });

  test("does not add mention and shows feedback for invalid selected resource", async () => {
    const folder = vscode.Uri.file("/workspace/src");
    const { controller, mentions, warningMessages } = createController({
      statTypes: new Map([[folder.toString(), vscode.FileType.Directory]]),
    });

    await controller.addFileToChat(folder, [folder]);

    assert.strictEqual(mentions.length, 0);
    assert.deepStrictEqual(warningMessages, [
      "No files selected to add to chat.",
    ]);
  });
});
