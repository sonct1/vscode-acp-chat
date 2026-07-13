export const MULTI_SESSION_STYLES = `
.multi-session-header[hidden],.multi-session-overlay[hidden],.multi-session-loading[hidden]{display:none!important}
.multi-session-header{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);position:sticky;top:0;z-index:20}
.multi-session-heading{flex:1;min-width:0;display:flex;flex-direction:column}
.multi-session-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multi-session-heading span{font-size:11px;opacity:.75}
.multi-session-status.busy::before{content:"";display:inline-block;width:8px;height:8px;margin-right:6px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:multi-session-spin .8s linear infinite;vertical-align:-1px}
.multi-session-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;color:var(--vscode-descriptionForeground);font-size:12px}
.multi-session-spinner{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:multi-session-spin .8s linear infinite}
.multi-session-header button,.multi-session-overlay button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:3px 7px}
.multi-session-header button:disabled,.multi-session-overlay button:disabled{opacity:.55}
.multi-session-overlay{position:fixed;inset:0;background:var(--vscode-sideBar-background);z-index:1000;display:flex;flex-direction:column}
.multi-session-overlay-head{display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid var(--vscode-panel-border)}
.multi-session-list{overflow:auto;padding:6px}
.multi-session-item{border:1px solid var(--vscode-panel-border);border-radius:5px;margin:6px 0;padding:8px;cursor:pointer}
.multi-session-item.active{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}
.multi-session-item.busy .multi-session-item-main span::before{content:"";display:inline-block;width:8px;height:8px;margin-right:6px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:multi-session-spin .8s linear infinite;vertical-align:-1px}
.multi-session-item-main{display:flex;flex-direction:column;gap:3px}
.multi-session-item-main span{font-size:12px;opacity:.8}
.multi-session-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
@keyframes multi-session-spin{to{transform:rotate(360deg)}}
@media(max-width:360px){.multi-session-header{flex-wrap:wrap}.multi-session-heading{order:3;flex-basis:100%}}
`;
