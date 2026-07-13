export type TableCopyFormat = "markdown" | "html" | "displayed-text";

export interface TableClipboard {
  writeText(value: string): Promise<void>;
  writeHtml?(html: string, plainText: string): Promise<void>;
}

export interface TableCopyFeedbackOptions {
  feedbackDurationMs?: number;
}
