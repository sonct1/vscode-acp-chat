import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../../types/index.js";
import {
	asStr,
	codeBlock,
	parseRawInput,
	pick,
	toolCallUpdate,
} from "../utils.js";

/**
{
  "idx": 143,
  "stepType": 127,
  "parsedPayload": {
    "validityCheck": "127",
    "toolRun": {
      "call": {
        "callId": "nupyhm7g",
        "namePrimary": "invoke_subagent",
        "rawInputJson": "{\"Subagents\":[{\"Prompt\":\"Please analyze ...\"}],\"toolAction\":\"Delegating task to subagent\",\"toolSummary\":\"Delegating task\"}",
        "nameSecondary": "invoke_subagent"
      },
      "titlePrimary": "Subagents",
      "titleSecondary": "Delegating task to subagent"
    }
  }
}
*/

/**
 * Step type 127 — `invoke_subagent`. The agent delegates one or more tasks to
 * subagents. We list each subagent's prompt as content and surface a count in
 * the title. Mapped to the ACP `think`/delegation-style kind via `other`.
 */
export function subagentUpdate(stepRow: StepRow): SessionUpdate {
	const { stepPayload } = stepRow;
	const toolRun = stepPayload.toolRun;

	const rawInput = parseRawInput(stepRow);
	const subagentsRaw = pick(rawInput, "Subagents", "subagents");
	const subagents = Array.isArray(subagentsRaw) ? subagentsRaw : [];

	const title =
		subagents.length > 0
			? `Delegate to ${subagents.length} subagent${subagents.length > 1 ? "s" : ""}`
			: asStr(toolRun?.titleSecondary)?.trim() ||
				asStr(toolRun?.titlePrimary)?.trim() ||
				"Invoke subagent";

	const content: Record<string, unknown>[] = [];
	for (const sub of subagents) {
		const prompt = asStr(pick(sub, "Prompt", "prompt"))?.trim();
		if (prompt) content.push(codeBlock(prompt));
	}

	return toolCallUpdate({ stepRow, title, kind: "other", content });
}
