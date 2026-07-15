import * as vscode from "vscode";
import { MultiSessionHostController } from "./multi-session/host";
import {
  registerAddToChatHostFeature,
  type ChatMentionTarget,
} from "./add-to-chat/host";
import { registerOpenSettingsHostFeature } from "./open-settings/host";
import { registerChatAutoScrollHostFeature } from "./chat-auto-scroll/host";
import { registerChatFontSizeHostFeature } from "./chat-font-size/host";
import { registerClickableResourceLinksHostFeature } from "./clickable-resource-links/host";
import {
  registerAgentSelectionHostFeature,
  type AgentSelectionTarget,
} from "./agent-selection/host";
import { registerMessageQueueHostFeature } from "./message-queue/host";

export interface HostFeatureRegistry {
  addToChat?: ReturnType<typeof registerAddToChatHostFeature>;
  agentSelection?: ReturnType<typeof registerAgentSelectionHostFeature>;
  chatAutoScroll?: ReturnType<typeof registerChatAutoScrollHostFeature>;
  chatFontSize?: ReturnType<typeof registerChatFontSizeHostFeature>;
  clickableResourceLinks?: ReturnType<
    typeof registerClickableResourceLinksHostFeature
  >;
  messageQueue?: ReturnType<typeof registerMessageQueueHostFeature>;
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
    chatAutoScroll: registerChatAutoScrollHostFeature({
      postMessage: options.postMessage,
    }),
    chatFontSize: registerChatFontSizeHostFeature({
      postMessage: options.postMessage,
    }),
    clickableResourceLinks: registerClickableResourceLinksHostFeature(),
    messageQueue: registerMessageQueueHostFeature(),
  };

  if (MultiSessionHostController.isEnabled()) {
    features.multiSession = new MultiSessionHostController({
      globalState: options.globalState,
      postMessage: options.postMessage,
      onStatusChanged: options.onStatusChanged,
      onOpenManager: options.onOpenManager,
      onFocusChat: options.onFocusChat,
      onQuickSwitch: options.onQuickSwitch,
      messageQueueFactory: features.messageQueue,
    });
  }

  return features;
}

export function registerExtensionHostFeatures(options: {
  context: vscode.ExtensionContext;
  getChatTarget: () => (ChatMentionTarget & AgentSelectionTarget) | undefined;
}): HostFeatureRegistry {
  return {
    addToChat: registerAddToChatHostFeature({
      context: options.context,
      getChatTarget: options.getChatTarget,
    }),
    agentSelection: registerAgentSelectionHostFeature({
      context: options.context,
      getTarget: options.getChatTarget,
    }),
    openSettings: registerOpenSettingsHostFeature({
      context: options.context,
    }),
  };
}
