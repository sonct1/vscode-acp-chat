import * as assert from "assert";
import type { MultiSessionListItem } from "../../features/multi-session/contracts";
import { buildMultiSessionQuickSwitchItems } from "../../features/multi-session/quick-switch-items";

suite("multi-session quick switch items", () => {
  test("keeps long titles on the label and moves metadata to detail", () => {
    const title = "A very long session title that should own the first row";
    const session = createSession({
      localSessionId: "local-a",
      acpSessionId: "acp-a",
      title,
      status: "running",
      createdAt: 1,
    });

    const [item] = buildMultiSessionQuickSwitchItems({
      sessions: [session],
      activeLocalSessionId: "local-a",
    });

    assert.strictEqual(item.label, `● ${title}`);
    assert.strictEqual(item.detail, "Active · Running · Test Agent · acp-a");
    assert.ok(!("description" in item));
  });

  test("sorts newest-created sessions first", () => {
    const items = buildMultiSessionQuickSwitchItems({
      sessions: [
        createSession({
          localSessionId: "older",
          title: "Older",
          status: "awaiting_permission",
          createdAt: 1,
          pendingPermissionCount: 1,
        }),
        createSession({
          localSessionId: "newer",
          title: "Newer",
          status: "idle",
          createdAt: 2,
        }),
      ],
      activeLocalSessionId: "older",
    });

    assert.deepStrictEqual(
      items.map((item) => item.session.localSessionId),
      ["newer", "older"]
    );
    assert.strictEqual(
      items[1]?.detail,
      "Active · Needs permission · Test Agent"
    );
  });
});

function createSession(
  overrides: Partial<MultiSessionListItem> &
    Pick<
      MultiSessionListItem,
      "localSessionId" | "title" | "status" | "createdAt"
    >
): MultiSessionListItem {
  return {
    agentId: "test-agent",
    agentName: "Test Agent",
    updatedAt: overrides.createdAt,
    pendingPermissionCount: 0,
    ...overrides,
  };
}
