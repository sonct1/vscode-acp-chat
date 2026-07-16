export const LATEST_USER_PROMPT_TIP_STYLES = `
.latest-user-prompt-tip {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px 5px 16px;
  border-bottom: 1px solid var(--vscode-input-border, var(--acp-flat-border));
  color: var(--vscode-descriptionForeground);
  font-size: var(--acp-font-size-sm);
  line-height: 1.35;
  outline: none;
}

.latest-user-prompt-tip:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.latest-user-prompt-tip[hidden] {
  display: none;
}

.latest-user-prompt-tip-label {
  flex: none;
  color: var(--vscode-foreground);
  font-weight: 600;
}

.latest-user-prompt-tip-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.latest-user-prompt-tip:focus-visible > .latest-user-prompt-tip-preview {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}

.latest-user-prompt-tip-actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}

.latest-user-prompt-tip-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
  cursor: pointer;
}

.latest-user-prompt-tip-action:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.latest-user-prompt-tip-action:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.latest-user-prompt-tip-action:disabled {
  color: var(--vscode-disabledForeground);
  cursor: default;
  opacity: 0.55;
}
`;
