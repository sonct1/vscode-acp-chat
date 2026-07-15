export const LATEST_USER_PROMPT_TIP_STYLES = `
.latest-user-prompt-tip {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 7px 16px 5px;
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.latest-user-prompt-tip:focus .latest-user-prompt-tip-preview {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}
`;
