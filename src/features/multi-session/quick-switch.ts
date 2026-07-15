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
  const quickPick = vscode.window.createQuickPick<(typeof items)[number]>();
  quickPick.title = "Switch ACP Session";
  quickPick.placeholder = "Select a session to open in the chat view";
  quickPick.matchOnDetail = true;
  quickPick.items = items;

  const activeItem = items.find(
    (item) => item.session.localSessionId === state.activeLocalSessionId
  );
  if (activeItem) quickPick.activeItems = [activeItem];

  const selected = await new Promise<(typeof items)[number] | undefined>(
    (resolve) => {
      let settled = false;
      const disposables: vscode.Disposable[] = [];
      const finish = (item?: (typeof items)[number]): void => {
        if (settled) return;
        settled = true;
        for (const disposable of disposables) disposable.dispose();
        quickPick.dispose();
        resolve(item);
      };

      disposables.push(
        quickPick.onDidAccept(() => {
          const item = quickPick.activeItems[0];
          if (!item) return;
          finish(item);
        }),
        quickPick.onDidHide(() => finish())
      );
      quickPick.show();
    }
  );

  if (!selected) return;
  sessions.activateSession(selected.session.localSessionId, { focusChat: true });
}
