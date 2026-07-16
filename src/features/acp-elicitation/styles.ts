export const ACP_ELICITATION_STYLES = `
.acp-elicitation-panel {
  display: none;
  margin: 8px 12px;
  padding: 12px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 8px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-editorWidget-foreground);
}
.acp-elicitation-panel.visible { display: block; }
.acp-elicitation-header { margin-bottom: 10px; }
.acp-elicitation-title { font-weight: 600; margin-bottom: 4px; }
.acp-elicitation-message { white-space: pre-wrap; }
.acp-elicitation-queue { color: var(--vscode-descriptionForeground); margin-top: 6px; font-size: 0.9em; }
.acp-elicitation-error-summary { color: var(--vscode-inputValidation-errorForeground); margin-top: 6px; }
.acp-elicitation-error-summary:empty { display: none; }
.acp-elicitation-field { margin: 10px 0; }
.acp-elicitation-label,
.acp-elicitation-options legend { display: block; font-weight: 600; margin-bottom: 4px; }
.acp-elicitation-description { opacity: 0.8; margin: 3px 0 5px; font-size: 0.92em; }
.acp-elicitation-panel input[type="text"],
.acp-elicitation-panel input[type="email"],
.acp-elicitation-panel input[type="url"],
.acp-elicitation-panel input[type="date"],
.acp-elicitation-panel input[type="datetime-local"],
.acp-elicitation-panel input[type="number"],
.acp-elicitation-panel textarea,
.acp-elicitation-panel select {
  width: 100%;
  box-sizing: border-box;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 5px 7px;
  border-radius: 3px;
}
.acp-elicitation-options { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.acp-elicitation-option { display: flex; gap: 6px; align-items: flex-start; }
.acp-elicitation-option-content { display: grid; gap: 2px; }
.acp-elicitation-option-description { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.acp-elicitation-option-description:empty { display: none; }
.acp-elicitation-error { color: var(--vscode-inputValidation-errorForeground); margin-top: 4px; }
.acp-elicitation-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.acp-elicitation-actions button { padding: 4px 10px; }
`;
