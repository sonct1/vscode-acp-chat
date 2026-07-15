export interface TextReconciliation {
	suffix: string;
	divergent: boolean;
}

/**
 * Drain an agy stdout stream, decode arbitrary UTF-8 byte boundaries, invoke
 * onText for each non-empty decoded chunk, and return the complete decoded text.
 */
export async function streamAgyStdout(
	stream: NodeJS.ReadableStream | null,
	onText: (text: string) => void,
): Promise<string> {
	if (stream === null) return "";

	const decoder = new TextDecoder();
	let complete = "";

	const emit = (text: string): void => {
		if (text.length === 0) return;
		complete += text;
		onText(text);
	};

	for await (const chunk of stream) {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array);
		emit(decoder.decode(bytes, { stream: true }));
	}
	emit(decoder.decode());

	return complete;
}

/**
 * Return only the canonical DB suffix that can be appended without duplicating
 * already-emitted stdout. Divergent sources are reported but never fuzzy-merged.
 */
export function reconcileAgentText(
	liveText: string,
	canonicalText: string,
): TextReconciliation {
	if (canonicalText.startsWith(liveText)) {
		return {
			suffix: canonicalText.slice(liveText.length),
			divergent: false,
		};
	}

	if (liveText.startsWith(canonicalText)) {
		return { suffix: "", divergent: false };
	}

	return { suffix: "", divergent: true };
}
