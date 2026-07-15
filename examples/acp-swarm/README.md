# ACP Swarm examples

Swarm is experimental orchestration infrastructure. Copy one of these examples into `.vscode/acp-swarm/` and edit role ids, agent ids, prompts, capabilities, locks, and workflows for your workspace.

The extension does not hard-code planner/build/review/proof roles. The files here are optional starting points.

```text
.vscode/acp-swarm/
├── swarm.config.json
├── roles/*.json
└── workflows/*.json
```

Minimal setup:

```bash
mkdir -p .vscode/acp-swarm
cp -R examples/acp-swarm/* .vscode/acp-swarm/
```

Then enable `vscode-acp-chat.swarmAgent.enabled` and select `Swarm (Experimental)`.
