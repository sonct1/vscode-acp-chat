import type { WebviewController } from "../../views/webview/main";
import { PermissionDialog } from "../../views/webview/widget/permission-dialog";
import type { ExtensionMessage } from "../../views/webview/types";
import type { PermissionUiStateMessage, PermissionView } from "./types";

export function registerPermissionUiWebviewFeature(
  controller: WebviewController
): { handleMessage(message: ExtensionMessage): boolean | void; clear(): void } {
  const dialog = new PermissionDialog(
    controller.getContext(),
    () => controller.messageList.getBlockManager(),
    () => controller.messageList.getIsGenerating(),
    (value) => controller.inputPanel.setGenerating(value),
    () => controller.messageList.scrollToBottom()
  );
  let ownerId: string | undefined;
  let activationRevision: number | undefined;
  let stateRevision: number | undefined;

  const reconcile = (message: PermissionUiStateMessage): void => {
    if (ownerId && message.ownerId !== ownerId) {
      if (!acceptsOwnerTransition(message)) return;
      dialog.clear();
      stateRevision = undefined;
    }
    if (
      activationRevision !== undefined &&
      message.activationRevision !== undefined &&
      message.activationRevision < activationRevision
    ) {
      return;
    }
    if (
      ownerId === message.ownerId &&
      activationRevision === message.activationRevision &&
      stateRevision !== undefined &&
      message.stateRevision !== undefined &&
      message.stateRevision < stateRevision
    ) {
      return;
    }
    ownerId = message.ownerId;
    activationRevision = message.activationRevision;
    stateRevision = message.stateRevision ?? stateRevision;
    dialog.reconcile(
      message.ownerId,
      message.pending.map((pending) => toDialogPermission(pending))
    );
  };

  const acceptsOwnerTransition = (message: PermissionUiStateMessage): boolean => {
    if (
      activationRevision === undefined ||
      message.activationRevision === undefined
    ) {
      return true;
    }
    return message.activationRevision >= activationRevision;
  };

  controller.getEventBus().on("chatSurfaceReplacementStarted", () => {
    ownerId = undefined;
    activationRevision = undefined;
    stateRevision = undefined;
    dialog.clear();
  });

  return {
    handleMessage(message: ExtensionMessage): boolean | void {
      if (message.type === "feature.permission-ui.state") {
        reconcile(message as unknown as PermissionUiStateMessage);
        return true;
      }
      if (message.type === "permissionRequest") {
        reconcile({
          type: "feature.permission-ui.state",
          ownerId: message.ownerId ?? "legacy",
          activationRevision: message.revision,
          stateRevision: message.stateRevision,
          pending:
            message.requestId && message.toolCall && message.options
              ? [
                  {
                    requestId: message.requestId,
                    toolCallId: message.toolCallId,
                    toolCall: message.toolCall,
                    options: message.options,
                  },
                ]
              : [],
        });
        return true;
      }
    },
    clear(): void {
      ownerId = undefined;
      activationRevision = undefined;
      stateRevision = undefined;
      dialog.clear();
    },
  };
}

function toDialogPermission(permission: PermissionView): PermissionView {
  return permission;
}
