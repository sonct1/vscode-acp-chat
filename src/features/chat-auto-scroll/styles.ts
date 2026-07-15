export const CHAT_AUTO_SCROLL_STYLES = `
.chat-auto-scroll-jump-button {
  position: absolute;
  top: -38px;
  right: 10px;
  z-index: 20;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--acp-flat-border, var(--vscode-widget-border, transparent));
  border-radius: 999px;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  opacity: 0.92;
}

.chat-auto-scroll-jump-button:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--acp-flat-hover-background));
  opacity: 1;
}

.chat-auto-scroll-jump-button:focus-visible {
  outline: none;
  border-color: var(--acp-flat-border, var(--vscode-widget-border, transparent));
  box-shadow: 0 0 0 1px var(--acp-flat-border, var(--vscode-widget-border, transparent)), 0 2px 8px rgba(0, 0, 0, 0.22);
  opacity: 1;
}

.chat-auto-scroll-jump-button[hidden] {
  display: none;
}

.chat-auto-scroll-jump-button .codicon {
  font-size: 14px;
  color: inherit !important;
}
`;
