/**
 * Marked configuration with syntax highlighting via highlight.js.
 *
 * Provides a custom code-block renderer that highlights fenced code blocks
 * using highlight.js and wraps them in a container with a copy button.
 */

import { marked, type RendererObject, type Tokens } from "marked";
import hljs from "highlight.js";

const defaultTableRenderer = marked.Renderer.prototype.table;
export const TABLE_COPY_METADATA_TOKEN = createTableCopyMetadataToken();

/**
 * Custom renderer override for fenced code blocks.
 * Attempts to highlight with the specified language; falls back to auto-detection.
 * On failure, returns the raw text to avoid breaking the render pipeline.
 */
const renderer: RendererObject = {
  code({ text, lang }: { text: string; lang?: string }) {
    const validLanguage = lang && hljs.getLanguage(lang) ? lang : undefined;
    let highlighted: string;

    if (validLanguage) {
      try {
        highlighted = hljs.highlight(text, { language: validLanguage }).value;
      } catch (err) {
        console.error("Highlight error:", err);
        highlighted = text;
      }
    } else {
      try {
        highlighted = hljs.highlightAuto(text).value;
      } catch (err) {
        console.error("Auto-highlight error:", err);
        highlighted = text;
      }
    }

    return `<div class="code-block-wrapper"><pre><code class="hljs ${validLanguage || ""}">${highlighted}</code></pre><button class="code-copy-btn" acp-title="Copy code"><span class="codicon codicon-copy"></span></button></div>`;
  },

  table(token: Tokens.Table) {
    const tableHtml = defaultTableRenderer.call(this, token);
    const markdown = encodeURIComponent(token.raw);
    return `<template class="table-copy-source" data-table-copy-token="${TABLE_COPY_METADATA_TOKEN}" data-markdown="${markdown}"></template>${tableHtml}`;
  },
};

// Merge renderer and options into the global marked instance.
// `breaks: true` converts single newlines to <br> (GitHub-flavored behavior).
// `gfm: true` enables GitHub Flavored Markdown extensions (tables, strikethrough, etc.).
marked.use({
  breaks: true,
  gfm: true,
  renderer,
});

function createTableCopyMetadataToken(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `tc-${cryptoApi.randomUUID()}`;
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    cryptoApi.getRandomValues(values);
    return `tc-${Array.from(values, (value) => value.toString(36)).join("-")}`;
  }

  return `tc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export { marked };
