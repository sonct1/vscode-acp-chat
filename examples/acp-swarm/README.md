# ACP Swarm examples

Swarm is experimental orchestration infrastructure. Copy one of these examples into `.vscode/acp-swarm/` and edit role ids, agent ids, prompts, capabilities, locks, and workflows for your workspace.

The extension does not hard-code planner/build/review/proof roles. The files here are optional starting points.

`swarm.config.json` must name a `rootRole` (for example `roles/root.json`). Swarm starts that real ACP agent as the persistent Root session. For every user prompt, Root first makes a hidden routing-only JSON decision: answer directly, or run exactly one configured workflow. `defaultWorkflow` remains only a backward-compatible tie-break hint for Root; it is not auto-executed when routing is malformed.

```text
.vscode/acp-swarm/
├── swarm.config.json
├── roles/root.json
├── roles/*.json
└── workflows/*.json
```

Minimal setup:

```bash
mkdir -p .vscode/acp-swarm
cp -R examples/acp-swarm/* .vscode/acp-swarm/
```

Then enable `vscode-acp-chat.swarmAgent.enabled` and select `Swarm (Experimental)`.
