export const MANAGER_STYLES = `
:root{color-scheme:dark light}
body{margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background,var(--vscode-editor-background));font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);overflow:hidden}
button,input,select{font:inherit;min-width:0}
.manager-shell{display:flex;flex-direction:column;height:100vh;min-height:0;max-width:100%;overflow:hidden}
.manager-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 10px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
.manager-title{min-width:0}.manager-title h1{margin:0 0 4px;font-size:16px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.manager-summary{color:var(--vscode-descriptionForeground);font-size:12px}
.manager-actions,.row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.manager-filters{display:flex;gap:8px;padding:10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background));min-width:0}
.manager-search{flex:1;min-width:0}
.manager-select,.manager-search{height:28px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);padding:3px 8px}
.manager-button{min-height:26px;display:inline-flex;align-items:center;gap:5px;border-radius:3px;border:1px solid var(--vscode-button-border,transparent);padding:3px 9px;cursor:pointer;color:var(--vscode-foreground);background:transparent}
.manager-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12))}
.manager-button:disabled{opacity:.55;cursor:default}
.manager-button-primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
.manager-button-primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.manager-button-secondary{background:var(--vscode-button-secondaryBackground,transparent);border-color:var(--vscode-button-border,var(--vscode-panel-border))}
.manager-button-danger{color:var(--vscode-errorForeground)}
.manager-button-icon{width:28px;height:28px;min-height:28px;justify-content:center;gap:0;padding:0;border-color:transparent;background:transparent;color:var(--vscode-descriptionForeground)}
.manager-button-icon .codicon{font-size:15px;color:inherit}
.manager-button-icon.manager-button-primary{color:var(--vscode-focusBorder);background:transparent;border-color:transparent}
.manager-button-icon.manager-button-secondary{background:transparent;border-color:transparent}
.manager-button-icon.manager-button-danger{background:transparent;border-color:transparent;color:var(--vscode-errorForeground)}
.manager-button-icon:hover:not(:disabled),.manager-button-icon.manager-button-primary:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12))}
.manager-button-icon[aria-pressed="true"]{background:var(--vscode-toolbar-activeBackground,var(--vscode-list-activeSelectionBackground));color:var(--vscode-foreground)}
.manager-button-icon[aria-busy="true"]{color:var(--vscode-progressBar-background,var(--vscode-focusBorder))}
.manager-list{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:auto}
.manager-empty{padding:28px 16px;color:var(--vscode-descriptionForeground);text-align:center}
.session-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:11px 10px;border-bottom:1px solid var(--vscode-panel-border);min-width:0}
.session-row:hover{background:color-mix(in srgb,var(--vscode-foreground) 6%,transparent)}
.session-row.active{box-shadow:inset 3px 0 0 var(--vscode-focusBorder)}
.row-main{min-width:0;display:grid;grid-template-columns:18px minmax(0,1fr);gap:8px;align-items:start}
.status-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--vscode-descriptionForeground);margin-top:1px}
.status-running,.status-starting,.status-loading_history,.status-cancelling{color:var(--vscode-progressBar-background,var(--vscode-foreground))}
.status-awaiting_permission{color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow))}
.status-error{color:var(--vscode-errorForeground)}
.row-content{min-width:0;display:flex;flex-direction:column;gap:4px}
.row-title-line{display:flex;align-items:center;gap:8px;min-width:0}
.row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.active-pill{font-size:10px;line-height:16px;border:1px solid var(--vscode-focusBorder);border-radius:999px;padding:0 6px;color:var(--vscode-focusBorder)}
.row-meta,.row-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-size:12px}
.badges{display:flex;gap:4px;flex-wrap:wrap}
.badge{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:1px 6px;font-size:10px;line-height:16px;color:var(--vscode-descriptionForeground)}
.badge-permission{color:var(--vscode-foreground);border-color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow));background:var(--vscode-inputValidation-warningBackground,transparent)}
.badge-unread{color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);border-color:transparent}
@media(max-width:650px){.session-row{grid-template-columns:1fr}.row-actions{justify-content:flex-start;padding-left:26px}.manager-summary{line-height:1.35}}
@media(max-width:360px){.manager-header{align-items:stretch}.manager-title h1{font-size:14px}.manager-filters{flex-direction:column}.manager-select,.manager-search{width:100%;box-sizing:border-box}.manager-actions{justify-content:flex-end}.row-main{grid-template-columns:16px minmax(0,1fr);gap:6px}.row-actions{padding-left:22px}.active-pill{display:none}}
@media(max-width:280px){.manager-header{flex-direction:column}.manager-actions{justify-content:flex-start}.manager-button-icon{width:26px;height:26px;min-height:26px}.row-actions{gap:2px}.session-row{padding-left:8px;padding-right:8px}}
`;
