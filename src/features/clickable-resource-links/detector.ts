import type { DetectedResourceLink, ResourceLinkKind } from "./types";

const ROOT_FILENAME_ALLOWLIST = new Set([
  ".env",
  ".gitignore",
  ".npmrc",
  "Dockerfile",
  "Makefile",
  "README",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "esbuild.js",
]);

const COMMON_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "csv",
  "dockerfile",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "log",
  "lua",
  "mjs",
  "md",
  "mdx",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const CANDIDATE_PATTERN =
  /(?:file:\/\/[^\s<>'"]+|https?:\/\/[^\s<>'"]+|www\.[^\s<>'"]+|[A-Za-z]:[\\/][^\s<>'"]+|\.\.?[\\/][^\s<>'"]+|\/[A-Za-z0-9._~+@%=-][^\s<>'"]*|[A-Za-z0-9._~+@%=-]+(?:[\\/][A-Za-z0-9._~+@%=-]+)+(?:[:#][A-Za-z0-9._~+@%=-]+)?|(?:README\.md|CHANGELOG\.md|package\.json|tsconfig\.json|jsconfig\.json|Dockerfile|Makefile|\.gitignore|\.env)(?:[:#][A-Za-z0-9._~+@%=-]+)?)/g;

const OPENING_PUNCTUATION = new Set(["(", "[", "{", "<", "\"", "'"]);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "\"", "'"]);
const CLOSING_PAIRS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  ">": "<",
};

export function detectResourceLinks(text: string): DetectedResourceLink[] {
  const links: DetectedResourceLink[] = [];
  CANDIDATE_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(CANDIDATE_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const normalized = trimCandidate(raw, index);
    if (!normalized.text) continue;

    const detected = classifyCandidate(
      normalized.text,
      normalized.start,
      normalized.end
    );
    if (!detected) continue;

    const previous = links[links.length - 1];
    if (previous && detected.start < previous.end) continue;
    links.push(detected);
  }

  return links;
}

export function detectExactResourceLink(
  text: string
): DetectedResourceLink | undefined {
  const leadingWhitespaceLength = text.match(/^\s*/)?.[0].length ?? 0;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const links = detectResourceLinks(trimmed);
  if (links.length !== 1) return undefined;

  const [link] = links;
  if (link.start !== 0 || link.end !== trimmed.length) return undefined;

  return {
    ...link,
    start: leadingWhitespaceLength,
    end: leadingWhitespaceLength + trimmed.length,
  };
}

function classifyCandidate(
  text: string,
  start: number,
  end: number
): DetectedResourceLink | undefined {
  const webHref = toWebHref(text);
  if (webHref) {
    return createLink("web", text, webHref, start, end);
  }

  if (!isFilePathCandidate(text)) return undefined;
  return createLink("file", text, text, start, end, extractLineRangeText(text));
}

function createLink(
  kind: ResourceLinkKind,
  text: string,
  href: string,
  start: number,
  end: number,
  lineRangeText?: string
): DetectedResourceLink {
  return { kind, text, href, start, end, lineRangeText };
}

function toWebHref(text: string): string | undefined {
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      if (!url.hostname) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  if (/^www\./i.test(text)) {
    try {
      const url = new URL(`https://${text}`);
      if (!url.hostname.includes(".")) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function isFilePathCandidate(text: string): boolean {
  const withoutRange = stripLineRange(text);
  if (!withoutRange || /\s/.test(withoutRange)) return false;

  if (/^file:\/\/[^/]/i.test(withoutRange) || /^file:\/\/\//i.test(withoutRange)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(withoutRange)) return true;
  if (withoutRange.startsWith("/") && withoutRange.length > 1) return true;
  if (/^\.\.?[\\/]/.test(withoutRange)) return true;

  if (ROOT_FILENAME_ALLOWLIST.has(withoutRange)) return true;

  if (!/[\\/]/.test(withoutRange)) return false;
  if (withoutRange.startsWith("@")) return false;

  const normalized = withoutRange.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return false;

  const lastSegment = segments[segments.length - 1];
  if (!lastSegment || lastSegment === "." || lastSegment === "..") return false;
  if (ROOT_FILENAME_ALLOWLIST.has(lastSegment)) return true;

  const ext = getFileExtension(lastSegment);
  if (ext && COMMON_FILE_EXTENSIONS.has(ext.toLowerCase())) return true;

  return false;
}

function getFileExtension(filename: string): string | undefined {
  const index = filename.lastIndexOf(".");
  if (index <= 0 || index === filename.length - 1) return undefined;
  return filename.slice(index + 1);
}

function extractLineRangeText(text: string): string | undefined {
  const hashRange = text.match(/#L\d+(?:-L?\d+)?$/i)?.[0];
  if (hashRange) return hashRange;

  return text.match(/:\d+(?:-\d+)?$/)?.[0];
}

function stripLineRange(text: string): string {
  const withoutHashRange = text.replace(/#L\d+(?:-L?\d+)?$/i, "");
  const colonRange = withoutHashRange.match(/^(.*):(\d+)(?:-\d+)?$/);
  if (!colonRange) return withoutHashRange;
  if (/^[A-Za-z]$/.test(colonRange[1])) return withoutHashRange;
  return colonRange[1];
}

function trimCandidate(
  raw: string,
  rawStart: number
): { text: string; start: number; end: number } {
  let startOffset = 0;
  let endOffset = raw.length;

  while (
    startOffset < endOffset &&
    OPENING_PUNCTUATION.has(raw[startOffset]) &&
    !isWindowsDrivePrefix(raw, startOffset)
  ) {
    startOffset++;
  }

  while (endOffset > startOffset && shouldTrimTrailing(raw.slice(startOffset, endOffset))) {
    endOffset--;
  }

  return {
    text: raw.slice(startOffset, endOffset),
    start: rawStart + startOffset,
    end: rawStart + endOffset,
  };
}

function shouldTrimTrailing(value: string): boolean {
  const last = value[value.length - 1];
  if (!last) return false;
  if (TRAILING_PUNCTUATION.has(last)) return true;

  const opening = CLOSING_PAIRS[last];
  if (!opening) return false;
  return countChar(value, last) > countChar(value, opening);
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) count++;
  }
  return count;
}

function isWindowsDrivePrefix(value: string, index: number): boolean {
  return index === 0 && /^[A-Za-z]:[\\/]/.test(value);
}
