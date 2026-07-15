import * as vscode from "vscode";
import { MultiSessionHostController } from "./host";
import { buildMultiSessionQuickSwitchItems } from "./quick-switch-items";

export async function showMultiSessionQuickSwitch(
  sessions: MultiSessionHostController
): Promise<void> {
  const state = sessions.getManagerStateSnapshot();
  if (state.sessions.length === 0) {
    vscode.window.showInformationMessage("No open ACP sessions.");
    return;
  }

  const items = buildMultiSessionQuickSwitchItems(state);

  const selected = await vscode.window.showQuickPick(items, {
    title: "Switch ACP Session",
    placeHolder: "Select a session to open in the chat view",
    matchOnDetail: true,
  });
  if (!selected) return;
  sessions.activateSession(selected.session.localSessionId, { focusChat: true });
}
