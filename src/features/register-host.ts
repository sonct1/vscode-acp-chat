import * as vscode from "vscode";
import { MultiSessionHostController } from "./multi-session/host";
import {
  registerAddToChatHostFeature,
  type ChatMentionTarget,
} from "./add-to-chat/host";
import { registerOpenSettingsHostFeature } from "./open-settings/host";
import { registerChatFontSizeHostFeature } from "./chat-font-size/host";
import { registerClickableResourceLinksHostFeature } from "./clickable-resource-links/host";

export interface HostFeatureRegistry {
  addToChat?: ReturnType<typeof registerAddToChatHostFeature>;
  chatFontSize?: ReturnType<typeof registerChatFontSizeHostFeature>;
  clickableResourceLinks?: ReturnType<
    typeof registerClickableResourceLinksHostFeature
  >;
  multiSession?: MultiSessionHostController;
  openSettings?: ReturnType<typeof registerOpenSettingsHostFeature>;
}

export function registerHostFeatures(options: {
  globalState: vscode.Memento;
  postMessage: (message: Record<string, unknown>) => void;
  onStatusChanged?: (summary: string) => void;
  onOpenManager?: () => void;
  onFocusChat?: () => Thenable<void> | void;
  onQuickSwitch?: () => Thenable<void> | void;
}): HostFeatureRegistry {
  const features: HostFeatureRegistry = {
    chatFontSize: registerChatFontSizeHostFeature({
      postMessage: options.postMessage,
    }),
    clickableResourceLinks: registerClickableResourceLinksHostFeature(),
  };

  if (MultiSessionHostController.isEnabled()) {
    features.multiSession = new MultiSessionHostController({
      globalState: options.globalState,
      postMessage: options.postMessage,
      onStatusChanged: options.onStatusChanged,
      onOpenManager: options.onOpenManager,
      onFocusChat: options.onFocusChat,
      onQuickSwitch: options.onQuickSwitch,
    });
  }

  return features;
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
    openSettings: registerOpenSettingsHostFeature({
      context: options.context,
    }),
  };
}
