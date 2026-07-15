import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { SearchHit } from "../../gen/steps.js";
import type { StepRow } from "../../types/index.js";
import {
	asStr,
	codeBlock,
	fsPath,
	parseRawInput,
	pick,
	toDisplayPath,
	toolCallUpdate,
} from "../utils.js";

/**
{
  "idx": 4,
  "stepType": 7,
  "stepPayload": {
    "validityCheck": "7",
    "toolRun": {
      "call": {
        "callId": "ifsipg6e",
        "namePrimary": "grep_search",
        "rawInputJson": "{\"Query\":\"context/\",\"SearchPath\":\"/Users/user/Desktop/agy-acp\",\"toolAction\":\"Searching the web\",\"toolSummary\":\"Web search\"}",
        "nameSecondary": "grep_search"
      },
      "titlePrimary": "Web search",
      "titleSecondary": "Searching the web"
    },
    "grepSearch": {
      "query": "context/",
      "shellCommand": "/usr/bin/git grep --untracked --no-recurse-submodules --fixed-strings -l -- context/",
      "cwdUri": "file:///Users/user/Desktop/agy-acp"
    }
  }
}

{
  "idx": 35,
  "stepType": 33,
  "stepPayload": {
    "validityCheck": "33",
    "toolRun": {
      "call": {
        "callId": "djvk2ebu",
        "namePrimary": "search_web",
        "rawInputJson": "{\"query\":\"openab ACP protocol \\\"prompt\\\" block \\\"resource\\\" context\",\"toolAction\":\"Searching the web\",\"toolSummary\":\"Web search\"}",
        "nameSecondary": "search_web"
      },
      "titlePrimary": "Web search",
      "titleSecondary": "Searching the web"
    }
  }
}
*/

/** Render grep hits (generic field1..field5) into readable, pipe-joined lines. */
function renderHits(hits: SearchHit[] | undefined): string {
	if (!hits || hits.length === 0) return "";
	return hits
		.map((h) =>
			[h.field1, h.field2, h.field3, h.field4, h.field5]
				.filter((v) => v && v.trim().length > 0)
				.join(" | "),
		)
		.filter((l) => l.length > 0)
		.join("\n");
}

export function searchUpdate(stepRow: StepRow, cwd?: string): SessionUpdate {
	const { stepPayload, stepType } = stepRow;
	const toolRun = stepPayload.toolRun;
	const name = toolRun?.call?.namePrimary ?? "";

	const rawInput = parseRawInput(stepRow);
	const displayCwd = fsPath(cwd) ?? undefined;
	const grep = stepPayload.grepSearch;

	let title = "Search";
	const content: Record<string, unknown>[] = [];
	const locations: Record<string, unknown>[] = [];

	if (grep || name === "grep_search" || stepType === 7) {
		// grep_search → "Search '<query>' <path>"
		const query =
			asStr(grep?.query) ?? asStr(pick(rawInput, "Query", "query")) ?? "";
		const searchPath =
			fsPath(asStr(pick(rawInput, "SearchPath", "searchPath"))) ??
			fsPath(asStr(grep?.cwdUri));
		const shown = searchPath ? toDisplayPath(searchPath, displayCwd) : "";
		title = shown ? `Search '${query}' ${shown}` : `Search '${query}'`;

		if (searchPath) locations.push({ path: searchPath });

		// Content: the rendered matches, or the shell command that produced them.
		const body =
			asStr(grep?.textOutput)?.trim() ||
			renderHits(grep?.hits) ||
			asStr(grep?.shellCommand)?.trim();
		if (body) {
			content.push(codeBlock(body));
		}
	} else {
		// search_web → "Web search <query>"  (call-only step, no result body)
		const query = asStr(pick(rawInput, "query", "Query"))?.trim() ?? "";
		title = query ? `Web search ${query}` : "Web search";
	}

	return toolCallUpdate({ stepRow, title, kind: "search", content, locations });
}
