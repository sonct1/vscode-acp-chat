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
  "idx": 31,
  "stepType": 31,
  "parsedPayload": {
    "validityCheck": "31",
    "toolRun": {
      "call": {
        "callId": "toolu_vrtx_01KECVcD2W4iLCvS5hWLrHUs",
        "namePrimary": "read_url_content",
        "rawInputJson": "{\"Url\":\"https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest\",\"toolAction\":\"Fetching latest release\",\"toolSummary\":\"GitHub release info\"}",
        "nameSecondary": "read_url_content"
      },
      "titlePrimary": "GitHub release info",
      "titleSecondary": "Reading URL"
    }
  }
}
*/

/**
 * Step type 31 — `read_url_content`. A call-only step (the fetched body is not
 * decoded into the payload), so we surface the URL as the title and echo it as
 * content. Mapped to the ACP `fetch` tool kind.
 */
export function fetchUpdate(stepRow: StepRow): SessionUpdate {
	const { stepPayload } = stepRow;
	const toolRun = stepPayload.toolRun;

	const rawInput = parseRawInput(stepRow);
	const url = asStr(pick(rawInput, "Url", "url"))?.trim();

	const title =
		(url ? `Fetch ${url}` : null) ||
		asStr(toolRun?.titlePrimary)?.trim() ||
		asStr(toolRun?.titleSecondary)?.trim() ||
		"Fetch URL";

	const content = url ? [textBlock(url)] : [];

	return toolCallUpdate({ stepRow, title, kind: "fetch", content });
}
