import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../../types/index.js";
import {
	asStr,
	parseRawInput,
	pick,
	textBlock,
	toolCallUpdate,
} from "../utils.js";

/**
{
  "idx": 200,
  "stepType": 138,
  "parsedPayload": {
    "validityCheck": "138",
    "toolRun": {
      "call": {
        "callId": "toolu_vrtx_01JikoNXxccLLTXcznymYrTC",
        "namePrimary": "ask_question",
        "rawInputJson": "{\"questions\":[{\"is_multi_select\":false,\"options\":[\"...\",\"...\"],\"question\":\"Since `agy` doesn't support `--acp` yet, what would you like to do?\"}],\"toolAction\":\"Asking next steps\",\"toolSummary\":\"Next steps decision\"}",
        "nameSecondary": "ask_question"
      },
      "titlePrimary": "Next steps decision",
      "titleSecondary": "Asking next steps"
    }
  }
}
*/

/**
 * Step type 138 — `ask_question`. The agent poses one or more multiple-choice
 * questions to the user. We use the first question as the title and render each
 * question with its options as content. Mapped to the ACP `other` tool kind.
 */
export function questionUpdate(stepRow: StepRow): SessionUpdate {
	const { stepPayload } = stepRow;
	const toolRun = stepPayload.toolRun;

	const rawInput = parseRawInput(stepRow);
	const questionsRaw = pick(rawInput, "questions", "Questions");
	const questions = Array.isArray(questionsRaw) ? questionsRaw : [];

	const firstQuestion = asStr(
		pick(questions[0], "question", "Question"),
	)?.trim();
	const title =
		firstQuestion ||
		asStr(toolRun?.titlePrimary)?.trim() ||
		asStr(toolRun?.titleSecondary)?.trim() ||
		"Ask question";

	const content: Record<string, unknown>[] = [];
	for (const q of questions) {
		const question = asStr(pick(q, "question", "Question"))?.trim();
		if (!question) continue;
		const optionsRaw = pick(q, "options", "Options");
		const options = Array.isArray(optionsRaw) ? optionsRaw : [];
		const lines = [question];
		for (const opt of options) {
			const label = asStr(opt) ?? asStr(pick(opt, "label", "Label"));
			if (label) lines.push(`  - ${label}`);
		}
		content.push(textBlock(lines.join("\n")));
	}

	return toolCallUpdate({ stepRow, title, kind: "other", content });
}
