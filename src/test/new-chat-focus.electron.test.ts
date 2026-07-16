import * as assert from "assert";
import * as vscode from "vscode";
import type {
  MultiSessionFocusInputProof,
  MultiSessionFocusInputResponseMessage,
} from "../features/multi-session/contracts";

suite("New Chat focus Electron integration", () => {
  test("focuses the real chat composer with a durable caret", async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension(
      "fiyqkrc.vscode-acp-chat"
    );
    assert.ok(extension);
    await extension.activate();

    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const previous = config.inspect<boolean>("multiSession.enabled")?.globalValue;
    await config.update(
      "multiSession.enabled",
      true,
      vscode.ConfigurationTarget.Global
    );

    try {
      await vscode.commands.executeCommand("vscode-acp-chat.chatView.focus");
      await vscode.commands.executeCommand("vscode-acp-chat.newChat");

      const ack = await waitForFocusAck();
      await delay(150);
      const stableAck = (await vscode.commands.executeCommand(
        "vscode-acp-chat._test.getLastFocusInputAck"
      )) as MultiSessionFocusInputResponseMessage | undefined;

      assert.ok(ack.requestId);
      assert.ok(ack.localSessionId);
      assert.ok(ack.activationRevision > 0);
      assertFocusProof(ack.proof);
      assert.strictEqual(stableAck?.requestId, ack.requestId);
      assertFocusProof(stableAck?.proof);
    } finally {
      await config.update(
        "multiSession.enabled",
        previous,
        vscode.ConfigurationTarget.Global
      );
    }
  });
});

async function waitForFocusAck(): Promise<MultiSessionFocusInputResponseMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = (await vscode.commands.executeCommand(
      "vscode-acp-chat._test.getLastFocusInputAck"
    )) as MultiSessionFocusInputResponseMessage | undefined;
    if (result?.type === "feature.multi-session.focusInputAck") return result;
    await delay(50);
  }
  const debug = await vscode.commands.executeCommand(
    "vscode-acp-chat._test.getFocusInputDebug"
  );
  throw new Error(
    `Timed out waiting for New Chat focus acknowledgement: ${JSON.stringify(
      debug
    )}`
  );
}

function assertFocusProof(
  proof: MultiSessionFocusInputProof | undefined
): asserts proof is MultiSessionFocusInputProof {
  assert.deepStrictEqual(proof, {
    documentHasFocus: true,
    activeInput: true,
    caret: true,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
