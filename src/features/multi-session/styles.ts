export const MULTI_SESSION_STYLES = `
.multi-session-header[hidden],.multi-session-overlay[hidden],.multi-session-loading[hidden]{display:none!important}
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
.multi-session-button-icon{width:24px;min-width:24px;padding:3px;color:var(--vscode-descriptionForeground)}
.multi-session-button-icon:hover:not(:disabled){color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12))}
.multi-session-button-primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-color:var(--vscode-button-border,transparent)}
.multi-session-button-primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.multi-session-button-secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground,transparent);border-color:var(--vscode-button-border,var(--vscode-panel-border))}
.multi-session-button-secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)))}
.multi-session-button-ghost{color:var(--vscode-descriptionForeground);background:transparent}
.multi-session-button-ghost:hover:not(:disabled){color:var(--vscode-foreground)}
.multi-session-button-danger{color:var(--vscode-errorForeground)}
.multi-session-button-danger:hover:not(:disabled){background:var(--vscode-inputValidation-errorBackground,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)))}
.multi-session-open{flex-shrink:0;min-width:28px;padding-left:6px;padding-right:6px;overflow:hidden;text-overflow:ellipsis}
.multi-session-open.has-attention{color:var(--vscode-foreground)}
.multi-session-open-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;font-size:10px;line-height:16px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background)}
.multi-session-open-badge.permission{color:var(--vscode-foreground);background:var(--vscode-inputValidation-warningBackground,transparent);border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow))}
.multi-session-overlay{position:fixed;inset:0;background:var(--vscode-sideBar-background);z-index:1000;display:flex;flex-direction:column;outline:none}
.multi-session-overlay-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
.multi-session-overlay-head strong{display:block;font-size:13px;font-weight:600;line-height:1.3;color:var(--vscode-foreground)}
.multi-session-overlay-subtitle{display:block;margin-top:2px;font-size:11px;color:var(--vscode-descriptionForeground)}
.multi-session-overlay-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
.multi-session-agent-label{font-size:11px;color:var(--vscode-descriptionForeground)}
.multi-session-agent-select{height:28px;max-width:180px;padding:3px 24px 3px 8px;border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border));border-radius:var(--border-radius-small,3px);color:var(--vscode-dropdown-foreground,var(--vscode-foreground));background:var(--vscode-dropdown-background,var(--vscode-editor-background));font:inherit;font-size:12px;line-height:1.2}
.multi-session-agent-select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.multi-session-list{overflow:auto;padding:4px 0}
.multi-session-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;border-bottom:1px solid var(--vscode-panel-border);min-height:52px}
.multi-session-item:hover{background:rgba(127,127,127,.08);background:color-mix(in srgb,var(--vscode-foreground) 7%,transparent)}
.multi-session-item.active{box-shadow:inset 2px 0 0 var(--vscode-focusBorder);background:transparent}
.multi-session-item.active:hover{background:rgba(127,127,127,.08);background:color-mix(in srgb,var(--vscode-foreground) 7%,transparent)}
.multi-session-item-main{appearance:none;width:100%;min-width:0;display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px 4px 8px 12px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.multi-session-item .multi-session-item-main:hover:not(:disabled),.multi-session-item .multi-session-item-main:active:not(:disabled){background:transparent;color:inherit}
.multi-session-item-content{min-width:0;display:flex;flex-direction:column;gap:2px}
.multi-session-item-content strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:1.25;color:var(--vscode-foreground)}
.multi-session-item-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.25}
.multi-session-status-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--vscode-descriptionForeground);font-size:12px}
.multi-session-status-icon.multi-session-status-running,.multi-session-status-icon.multi-session-status-starting,.multi-session-status-icon.multi-session-status-loading_history,.multi-session-status-icon.multi-session-status-cancelling{color:var(--vscode-progressBar-background,var(--vscode-foreground))}
.multi-session-status-icon.multi-session-status-awaiting_permission{color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow))}
.multi-session-status-icon.multi-session-status-error{color:var(--vscode-errorForeground)}
.multi-session-badges{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;flex-wrap:wrap}
.multi-session-badge{display:inline-flex;align-items:center;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:999px;padding:1px 6px;font-size:10px;line-height:16px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);background:transparent}
.multi-session-badge-permission{color:var(--vscode-foreground);border-color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow));background:var(--vscode-inputValidation-warningBackground,transparent)}
.multi-session-badge-unread{color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);border-color:transparent}
.multi-session-badge-diff{color:var(--vscode-descriptionForeground)}
.multi-session-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex-wrap:wrap;padding:8px 8px 8px 0}
@keyframes multi-session-spin{to{transform:rotate(360deg)}}
@media(max-width:420px){.multi-session-item{grid-template-columns:1fr}.multi-session-item-main{grid-template-columns:16px minmax(0,1fr);padding-bottom:4px}.multi-session-badges{grid-column:2;justify-content:flex-start}.multi-session-actions{justify-content:flex-start;padding:0 8px 8px 36px}.multi-session-overlay-head{align-items:center}.multi-session-overlay-subtitle{display:none}.multi-session-agent-label{display:none}.multi-session-agent-select{max-width:150px}}
@media(prefers-reduced-motion:reduce){.multi-session-status.busy::before,.multi-session-spinner{animation:none}.multi-session-status-icon.codicon-modifier-spin{animation:none!important}}
`;
