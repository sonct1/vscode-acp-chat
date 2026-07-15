import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../types/index.js";

/**
 * Step type 14 — the user's prompt / input that opened a turn.
 *
 * The text lives on `userPrompt.text`, with `userPrompt.content.text` as a
 * fallback for payloads that nest it. Maps to an ACP `user_message_chunk` so
 * replayed conversations show the user's turn alongside the agent's.
 */
export function userPromptUpdate(stepRow: StepRow): SessionUpdate[] {
	const up = stepRow.stepPayload.userPrompt;
	let text = (up?.text || up?.content?.text || "").trim();

	// Remove the planning mode injection if present (wrapped in <system>...</system> or <system>...<system>)
	text = text
		.replace(/^<system>\n\[PLANNING MODE\][\s\S]*?\n<\/?system>\n?/, "")
		.trim();

	const blocks: ContentBlock[] = [];
	const regex =
		/<user_text>\n([\s\S]*?)\n<\/user_text>|<resource_link uri="(.*?)" title="(.*?)"\/>|<embedded_resource uri="(.*?)">\n([\s\S]*?)\n<\/embedded_resource>/g;

	let foundAny = false;

	for (const match of text.matchAll(regex)) {
		foundAny = true;
		if (match[1] !== undefined) {
			blocks.push({ type: "text", text: match[1] });
		} else if (match[2] !== undefined) {
			const uri = match[2].replace(/&quot;/g, '"');
			const title = (match[3] || "").replace(/&quot;/g, '"');
			blocks.push({ type: "resource_link", uri, name: title, title });
		} else if (match[4] !== undefined) {
			const uri = match[4].replace(/&quot;/g, '"');
			const textContent = match[5] || "";
			blocks.push({ type: "resource", resource: { uri, text: textContent } });
		}
	}

	if (!foundAny) {
		blocks.push({ type: "text", text });
	}

	return blocks.map((content) => ({
		sessionUpdate: "user_message_chunk",
		content,
		messageId: String(stepRow.idx),
	}));
}
