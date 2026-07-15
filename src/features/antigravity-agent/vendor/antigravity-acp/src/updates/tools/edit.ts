import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../../types/index.js";
import {
	asNum,
	asStr,
	fsPath,
	parseRawInput,
	pick,
	textBlock,
	toDisplayPath,
	toolCallUpdate,
} from "../utils.js";

/**
{
  "idx": 723,
  "stepType": 5,
  "parsedPayload": {
    "validityCheck": "5",
    "toolRun": {
      "call": {
        "callId": "n51a38f1",
        "namePrimary": "write_to_file",
        "rawInputJson": "{\"ArtifactMetadata\":{\"RequestFeedback\":true,\"Summary\":\"Sample plan for testing embedding of files\",\"UserFacing\":true},\"CodeContent\":\"# Enhanced ACP Feature Plan\\n\\nThis is a newly generated sample plan to verify that the file contents are now being correctly embedded in the client view as a diff or file block.\\n\\n## Changes Made\\n* Added support for `type: \\\"diff\\\"` in `src/protobuf.rs`.\\n* Ensured `write_to_file` and `replace_file_content` will emit diff structures instead of standard text summaries.\\n\\n## Next Steps\\n1. User verifies the plan content is visibly embedded.\\n2. We continue building out background task tracking.\",\"Description\":\"Generating sample plan for inline diff embedding test\",\"Overwrite\":true,\"TargetFile\":\"/Users/user/.gemini/antigravity-cli/brain/e5b62c13-955e-4f80-9564-37715bc32eb2/plan.md\",\"toolAction\":\"Editing file\",\"toolSummary\":\"File edit\"}",
        "nameSecondary": "write_to_file"
      },
      "titlePrimary": "File edit",
      "titleSecondary": "Editing file"
    },
    "writeFile": {
      "summary": "Generating sample plan for inline diff embedding test"
    }
  }
}

{
  "idx": 502,
  "stepType": 5,
  "parsedPayload": {
    "validityCheck": "5",
    "toolRun": {
      "call": {
        "callId": "yllmupbk",
        "namePrimary": "multi_replace_file_content",
        "rawInputJson": "{\"Description\":\"Improve command visibility by showing command string as title and formatting it as a code block.\",\"Instruction\":\"Update title extraction to prioritize CommandLine/command for terminal tools, and enable code_block for input when kind is execute.\",\"ReplacementChunks\":[{\"AllowMultiple\":false,\"EndLine\":590,\"ReplacementContent\":\"    let title_from_command = if name.as_deref().map(tool_kind).unwrap_or(\\\"other\\\") == \\\"execute\\\" {\\n        raw_input\\n            .as_ref()\\n            .and_then(|v| v.get(\\\"CommandLine\\\").or_else(|| v.get(\\\"command\\\")))\\n            .and_then(|v| v.as_str())\\n            .map(|s| {\\n                let first_line = s.lines().next().unwrap_or(\\\"\\\").trim();\\n                if first_line.len() \\u003e 60 {\\n                    format!(\\\"{}...\\\", \\u0026first_line[..57])\\n                } else {\\n                    first_line.to_string()\\n                }\\n            })\\n    } else {\\n        None\\n    };\\n\\n    let title_from_input = title_from_command.or_else(|| {\\n        raw_input\\n            .as_ref()\\n            .and_then(|v| v.get(\\\"toolSummary\\\").or_else(|| v.get(\\\"toolAction\\\")))\\n            .and_then(|v| v.as_str())\\n            .map(String::from)\\n    });\",\"StartLine\":586,\"TargetContent\":\"    let title_from_input = raw_input\\n        .as_ref()\\n        .and_then(|v| v.get(\\\"toolSummary\\\").or_else(|| v.get(\\\"toolAction\\\")))\\n        .and_then(|v| v.as_str())\\n        .map(String::from);\"},{\"AllowMultiple\":false,\"EndLine\":611,\"ReplacementContent\":\"    let mut contents = Vec::new();\\n    if let Some(input) = raw_input.as_ref() {\\n        let is_code = kind == \\\"execute\\\" || kind == \\\"edit\\\" || kind == \\\"read\\\";\\n        if let Some(c) = tool_content(input, is_code) {\\n            contents.push(c);\\n        }\\n    }\",\"StartLine\":608,\"TargetContent\":\"    let mut contents = Vec::new();\\n    if let Some(input) = raw_input.as_ref() {\\n        if let Some(c) = tool_content(input, false) {\\n            contents.push(c);\\n        }\\n    }\"}],\"TargetFile\":\"/Users/user/Desktop/src/protobuf.rs\",\"toolAction\":\"Editing file\",\"toolSummary\":\"File edit\"}",
        "nameSecondary": "multi_replace_file_content"
      },
      "titlePrimary": "File edit",
      "titleSecondary": "Editing file"
    },
    "writeFile": {
      "summary": "Improve command visibility by showing command string as title and formatting it as a code block."
    }
  }
}

{
  "idx": 839,
  "stepType": 5,
  "parsedPayload": {
    "validityCheck": "5",
    "toolRun": {
      "call": {
        "callId": "nkdarugk",
        "namePrimary": "replace_file_content",
        "rawInputJson": "{\"AllowMultiple\":false,\"Description\":\"Fix return type of read_rows_from_db\",\"EndLine\":52,\"Instruction\":\"Update the return type of read_rows_from_db\",\"ReplacementContent\":\") -\\u003e Option\\u003cVec\\u003c(i64, i64, Vec\\u003cu8\\u003e, Option\\u003cVec\\u003cu8\\u003e\\u003e, Option\\u003cVec\\u003cu8\\u003e\\u003e, i64)\\u003e\\u003e {\",\"StartLine\":52,\"TargetContent\":\") -\\u003e Option\\u003cVec\\u003c(i64, i64, Vec\\u003cu8\\u003e, Option\\u003cVec\\u003cu8\\u003e\\u003e, Option\\u003cVec\\u003cu8\\u003e\\u003e)\\u003e\\u003e {\",\"TargetFile\":\"/Users/user/Desktop\",\"toolAction\":\"Editing file\",\"toolSummary\":\"File edit\"}",
        "nameSecondary": "replace_file_content"
      },
      "titlePrimary": "File edit",
      "titleSecondary": "Editing file"
    },
    "writeFile": {
      "summary": "Fix return type of read_rows_from_db"
    }
  }
}
*/

/**
 * Build a tool_call update for a file-mutation step.
 *
 * Handles step type 5 (write_to_file / replace_file_content /
 * multi_replace_file_content) and step type 17 (artifact writes, e.g. a
 * generated `plan.md` surfaced for user review) — both carry their arguments in
 * `toolRun.call.rawInputJson` and target a single file.
 */

function isPlanFile(targetFile: string): boolean {
	if (
		targetFile?.includes(".gemini") &&
		targetFile.includes("antigravity-cli") &&
		targetFile.includes("brain") &&
		targetFile.endsWith("md")
	) {
		return true;
	}
	return false;
}
export function editUpdate(
	stepRow: StepRow,
	cwd?: string,
): SessionUpdate | SessionUpdate[] {
	const rawInput = parseRawInput(stepRow);
	const displayCwd = fsPath(cwd) ?? undefined;

	// All edit variants target a single file.
	const targetFile = fsPath(asStr(pick(rawInput, "TargetFile", "targetFile")));
	const shown = targetFile ? toDisplayPath(targetFile, displayCwd) : "";
	const title = isPlanFile(targetFile || "")
		? (shown.split("/").pop() ?? "Implementation Plan")
		: shown
			? `Edit ${shown}`
			: "Edit";

	const content: Record<string, unknown>[] = [];
	const locations: Record<string, unknown>[] = [];

	const fullContent = asStr(pick(rawInput, "CodeContent", "codeContent"));
	if (fullContent !== null) {
		// write_to_file → the whole file content is the new text.
		if (isPlanFile(targetFile || "")) {
			// Plans are user-facing prose, not a code diff — render as text.
			content.push(textBlock(fullContent));
		} else if (targetFile) {
			content.push({
				type: "diff",
				path: targetFile,
				oldText: null,
				newText: fullContent,
			});
		}
		if (targetFile) locations.push({ path: targetFile });
	} else {
		// replace_file_content (single inline chunk) or multi_replace_file_content
		// (a ReplacementChunks array). Normalise both to a list of chunks.
		const chunksRaw = pick(rawInput, "ReplacementChunks", "replacementChunks");
		const chunks = Array.isArray(chunksRaw) ? chunksRaw : [rawInput];

		for (const chunk of chunks) {
			if (isPlanFile(targetFile || "")) continue; // Plans are user-facing prose, not a code diff — render as text.

			const oldText = asStr(pick(chunk, "TargetContent", "targetContent"));
			const newText = asStr(
				pick(chunk, "ReplacementContent", "replacementContent"),
			);
			if (newText === null) continue;

			if (targetFile) {
				content.push({
					type: "diff",
					path: targetFile,
					oldText,
					newText,
				});

				const line = asNum(pick(chunk, "StartLine", "startLine"));
				const loc: Record<string, unknown> = { path: targetFile };
				if (line !== null) loc.line = line;
				locations.push(loc);
			}
		}
	}

	if (isPlanFile(targetFile || "") && content.length === 0) return [];

	return toolCallUpdate({
		stepRow,
		title,
		kind: "edit",
		content,
		locations,
	});
}
