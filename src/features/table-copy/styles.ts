export const TABLE_COPY_STYLES = `
.table-copy-wrapper{--table-copy-border:color-mix(in srgb,var(--vscode-editor-foreground,#cccccc) 18%,transparent);--table-copy-header-bg:color-mix(in srgb,var(--vscode-editor-foreground,#cccccc) 7%,transparent);--table-copy-zebra-bg:color-mix(in srgb,var(--vscode-editor-foreground,#cccccc) 3%,transparent);--table-copy-hover-bg:color-mix(in srgb,var(--vscode-editor-foreground,#cccccc) 5%,transparent);max-width:100%;margin:12px 0;background:transparent;position:relative}
.table-copy-table-scroll{max-width:100%;overflow-x:auto;overflow-y:hidden}
.table-copy-toolbar{position:absolute;top:6px;right:6px;z-index:5;display:flex;align-items:center;width:auto;height:auto;padding:0;border:0;background:transparent;opacity:0;pointer-events:none;transition:opacity .15s ease}
.table-copy-wrapper:hover .table-copy-toolbar,.table-copy-wrapper:focus-within .table-copy-toolbar{opacity:1;pointer-events:auto}
.table-copy-split{display:inline-flex;align-items:center;border:0;border-radius:4px;background:color-mix(in srgb,var(--vscode-editor-background,#1e1e1e) 92%,transparent);box-shadow:0 2px 8px rgba(0,0,0,.18);overflow:hidden}
.table-copy-button{appearance:none;min-width:26px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:0;padding:0 6px;background:transparent;color:var(--vscode-icon-foreground,var(--vscode-foreground));cursor:pointer;font:inherit;line-height:1;opacity:.82}
.table-copy-button:first-child{border-top-left-radius:3px;border-bottom-left-radius:3px}
.table-copy-button:last-child{border-left:0;border-top-right-radius:3px;border-bottom-right-radius:3px}
.table-copy-button:hover{background:var(--vscode-toolbar-hoverBackground,rgba(127,127,127,.16))!important;opacity:1}
.table-copy-button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;opacity:1}
.table-copy-button .codicon{font-size:14px;color:inherit!important}
.table-copy-button.copied{color:var(--vscode-testing-iconPassed);opacity:1}
.table-copy-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:30;min-width:168px;padding:4px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-dropdown-background,var(--vscode-editor-background));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));box-shadow:0 4px 12px rgba(0,0,0,.25)}
.table-copy-menu[hidden]{display:none!important}
.table-copy-menu-item{appearance:none;width:100%;display:flex;align-items:center;gap:8px;border:0;border-radius:3px;padding:5px 8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;font-size:12px;line-height:1.35}
.table-copy-menu-item:hover,.table-copy-menu-item:focus-visible{background:var(--vscode-list-hoverBackground,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)))!important;outline:none}
.table-copy-menu-item:focus-visible{box-shadow:0 0 0 1px var(--vscode-focusBorder) inset}
.table-copy-wrapper table{width:max-content;min-width:100%;border-collapse:collapse;border-spacing:0;margin:0;background:transparent;font-size:13px;line-height:1.5;word-break:normal;overflow-wrap:normal}
.table-copy-wrapper th,.table-copy-wrapper td{border:1px solid rgba(127,127,127,.24);border-color:var(--table-copy-border);padding:6px 10px;vertical-align:top;text-align:start}
.table-copy-wrapper th[align="center"],.table-copy-wrapper td[align="center"]{text-align:center}
.table-copy-wrapper th[align="right"],.table-copy-wrapper td[align="right"]{text-align:right}
.table-copy-wrapper th[align="left"],.table-copy-wrapper td[align="left"]{text-align:left}
.table-copy-wrapper thead th{font-weight:600;background:rgba(127,127,127,.08);background:var(--table-copy-header-bg)}
.table-copy-wrapper tbody tr:nth-child(2n){background:rgba(127,127,127,.035);background:var(--table-copy-zebra-bg)}
.table-copy-wrapper tbody tr:hover{background:rgba(127,127,127,.06);background:var(--table-copy-hover-bg)}
.table-copy-wrapper th code,.table-copy-wrapper td code{font-family:var(--vscode-editor-font-family,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:.92em;padding:.1em .35em;border-radius:3px;background:var(--vscode-textCodeBlock-background,color-mix(in srgb,var(--vscode-editor-foreground,#cccccc) 10%,transparent));color:var(--vscode-editor-foreground,var(--vscode-foreground));white-space:break-spaces}
.table-copy-source{display:none!important}
@media(hover:none){.table-copy-toolbar{opacity:1;pointer-events:auto}}
`;
