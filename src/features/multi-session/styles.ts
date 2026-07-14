export const MULTI_SESSION_STYLES = `
.multi-session-header[hidden],.multi-session-loading[hidden]{display:none!important}
.multi-session-header{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);position:sticky;top:0;z-index:20;min-height:38px}
.multi-session-heading{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.multi-session-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:1.25;color:var(--vscode-foreground)}
.multi-session-heading span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.25;color:var(--vscode-descriptionForeground)}
.multi-session-status::before{content:"";display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--vscode-descriptionForeground);vertical-align:1px;opacity:.75}
.multi-session-status.busy::before{width:8px;height:8px;border:1.5px solid currentColor;border-right-color:transparent;background:transparent;animation:multi-session-spin .8s linear infinite;vertical-align:-1px;opacity:1}
.multi-session-status.multi-session-status-awaiting_permission::before{background:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow));opacity:1}
.multi-session-status.multi-session-status-error::before{background:var(--vscode-errorForeground);opacity:1}
.multi-session-status.multi-session-status-draft::before{background:transparent;border:1px solid var(--vscode-descriptionForeground)}
.multi-session-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:12px;background:var(--vscode-sideBar-background)}
.multi-session-spinner{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:multi-session-spin .8s linear infinite}
.multi-session-button{font:inherit;min-height:24px;display:inline-flex;align-items:center;justify-content:center;gap:4px;border-radius:var(--border-radius-small,3px);border:1px solid transparent;padding:3px 7px;cursor:pointer;line-height:1.2;color:var(--vscode-foreground);background:transparent;white-space:nowrap}
.multi-session-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12))}
.multi-session-button:disabled{opacity:.55;cursor:default}
.multi-session-button .codicon{font-size:14px;color:inherit}
.multi-session-button-secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground,transparent);border-color:var(--vscode-button-border,var(--vscode-panel-border))}
.multi-session-button-secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)))}
.multi-session-button-ghost{color:var(--vscode-descriptionForeground);background:transparent}
.multi-session-button-ghost:hover:not(:disabled){color:var(--vscode-foreground)}
.multi-session-open{flex-shrink:0;min-width:28px;padding-left:6px;padding-right:6px;overflow:hidden;text-overflow:ellipsis}
@keyframes multi-session-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.multi-session-status.busy::before,.multi-session-spinner{animation:none}}
`;
