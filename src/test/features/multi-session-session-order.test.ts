import * as assert from "assert";
import type { MultiSessionListItem } from "../../features/multi-session/contracts";
import { compareSessionsByCreatedAt } from "../../features/multi-session/session-order";

suite("multi-session session order", () => {
  test("sorts newest-created sessions first regardless of status", () => {
    const sessions: MultiSessionListItem[] = [
      createSession("permission", "awaiting_permission", 1, 100, 1),
      createSession("running", "running", 2, 2),
      createSession("draft", "draft", 3, 3),
      createSession("idle", "idle", 4, 4),
    ];

    sessions.sort(compareSessionsByCreatedAt);

    assert.deepStrictEqual(
      sessions.map((session) => session.localSessionId),
      ["idle", "draft", "running", "permission"]
    );
  });
});

function createSession(
  localSessionId: string,
  status: MultiSessionListItem["status"],
  createdAt: number,
  updatedAt: number,
  pendingPermissionCount = 0
): MultiSessionListItem {
  return {
    localSessionId,
    agentId: "test-agent",
    agentName: "Test Agent",
    title: localSessionId,
    status,
    createdAt,
    updatedAt,
    pendingPermissionCount,
  };
}
