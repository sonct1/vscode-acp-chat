export const messageQueueStyles = `
.message-queue-preview {
  box-sizing: border-box;
  margin: 6px 8px 0;
  padding: 6px 8px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 6px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background);
  font-size: var(--acp-font-size-normal);
  line-height: 1.35;
  max-height: 3.8em;
  overflow: hidden;
  text-overflow: ellipsis;
}

.message-queue-preview:empty,
.message-queue-preview[hidden] {
  display: none;
}
`;
