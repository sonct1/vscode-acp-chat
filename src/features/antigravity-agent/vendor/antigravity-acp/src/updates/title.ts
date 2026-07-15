import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../types/index.js";
import { toolCallId } from "./utils.js";

/**
 * Step type 23 — the conversation's title was (re)generated.
 * Maps to an ACP `session_info_update` carrying the new title.
 */
export function titleUpdate(stepRow: StepRow): SessionUpdate[] {
	const title = stepRow.stepPayload.titleUpdate?.title || null;

	const updates: SessionUpdate[] = [];
	const blocks = title?.split("\n\n");
	const currentTitle = blocks?.shift() || null;

	updates.push({
		sessionUpdate: "session_info_update",
		title: currentTitle,
	});

	if (!blocks || blocks?.filter((b: string) => b.trim().length > 0).length === 0)
		return updates;

	updates.push({
		sessionUpdate: "tool_call",
		toolCallId: toolCallId(stepRow),
		title: "Think",
		kind: "think",
		status: "completed",
		content: [
			{
				type: "content",
				content: {
					type: "text",
					text: blocks?.join("\n\n") || (currentTitle ?? ""),
				},
			},
		],
	});

	return updates;
}
