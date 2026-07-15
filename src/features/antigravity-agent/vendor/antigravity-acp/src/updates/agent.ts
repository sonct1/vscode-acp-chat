import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../types/index.js";

/**
 * Step type 15 — a chunk of the agent's streamed text message.
 * Maps to an ACP `agent_message_chunk`.
 */
export function agentUpdate(stepRow: StepRow): SessionUpdate {
	const text = stepRow.stepPayload.agentText?.text ?? "";
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
		messageId: String(stepRow.idx),
	};
}
