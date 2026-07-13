import * as vscode from "vscode";
import { MultiSessionHostController } from "./multi-session/host";
import {
  registerAddToChatHostFeature,
  type ChatMentionTarget,
} from "./add-to-chat/host";

export interface HostFeatureRegistry {
  addToChat?: ReturnType<typeof registerAddToChatHostFeature>;
  multiSession?: MultiSessionHostController;
}

export function registerHostFeatures(options: {
  globalState: vscode.Memento;
  postMessage: (message: Record<string, unknown>) => void;
  onStatusChanged?: (summary: string) => void;
}): HostFeatureRegistry {
  if (!MultiSessionHostController.isEnabled()) {
    return {};
  }
  return {
    multiSession: new MultiSessionHostController({
      globalState: options.globalState,
      postMessage: options.postMessage,
      onStatusChanged: options.onStatusChanged,
    }),
  };
}

export function registerExtensionHostFeatures(options: {
  context: vscode.ExtensionContext;
  getChatTarget: () => ChatMentionTarget | undefined;
}): HostFeatureRegistry {
  return {
    addToChat: registerAddToChatHostFeature({
      context: options.context,
      getChatTarget: options.getChatTarget,
    }),
  };
}
