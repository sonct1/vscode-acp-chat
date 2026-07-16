# VSCode ACP Chat

> AI coding agents in VS Code via the Agent Client Protocol (ACP)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

[VSCode ACP Chat](https://github.com/pengjiantao/vscode-acp-chat) allows you to chat with Claude, OpenCode, and other ACP-compatible AI agents directly in your editor. No context switching, no copy-pasting code. If you encounter any problems, please report them to [Issues](https://github.com/pengjiantao/vscode-acp-chat/issues).

> **Note:** This is NOT an official ACP protocol or any agent's official VS Code integration. It's a community-driven project. If you find this extension helpful, please consider giving it a ⭐ on [GitHub](https://github.com/pengjiantao/vscode-acp-chat)!

![VSCode ACP Chat Sidebar](screenshots/acp-sidebar.png)

## 🚀 Features

- **Multi-Agent Support** — Connect to OpenCode, Grok Build, Pi, Antigravity (experimental opt-in), Claude Code, Codex CLI, Gemini CLI, Goose, CodeBuddy Code, and other ACP-compatible agents.
- **Native Chat Interface** — Integrated sidebar chat that feels like a native part of VS Code.
- **Context-Aware** — Send code selections or terminal output directly to the chat via context menus.
- **Tool Visibility** — See what commands the AI runs with expandable input/output and file diffs.
- **Rich Markdown** — Full support for code blocks, syntax highlighting, and formatted responses.
- **Streaming Responses** — Watch the AI think and work in real-time.
- **Session Management** — Load and resume previous conversations with full history restoration.
- **Terminal Integration** — View terminal output with full ANSI color support.
- **MCP Server Configuration** — Connect to MCP servers via `stdio`, `http`, or `sse` transports. Configurations are loaded from:
  - Workspace: `<workspace>/.vscode/mcp.json`
  - User-level: `~/.config/Code/User/mcp.json` (Linux), `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%/Code/User/mcp.json` (Windows)
  - HTTP/SSE servers are sent to agents based on the agent's advertised `mcpCapabilities`.

## 📦 Getting Started

### Prerequisites

You need at least one ACP-compatible agent installed and available in your `$PATH`:

- **[OpenCode](https://github.com/sst/opencode)**: `pnpm add -g opencode`
- **[Pi](https://github.com/earendil-works/pi)**: `npm install -g @earendil-works/pi-coding-agent`
- **[Claude Code](https://claude.ai/code)**: `npm install -g @anthropic-ai/claude-code`
- **[Gemini CLI](https://github.com/google/gemini-cli)**: `npm install -g @google/gemini-cli`
- **[Grok Build](https://github.com/xai-org/grok-build)**: install the official `grok` CLI, then run `grok login`
- **[Google Antigravity](https://antigravity.google/)** (experimental bundled adapter, disabled by default): install the official `agy` CLI separately, then run `agy` and `agy models` in an interactive terminal before enabling `vscode-acp-chat.antigravity.enabled`.

> [!IMPORTANT]
> Ensure you have completed the agent's login/authentication setup before connecting via VS Code.

### Installation

1. Open **VS Code**
2. Go to **Extensions** (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search for **"VSCode ACP Chat"**
4. Click **Install**

## 💡 Usage

1. **Connect**: Click the **ACP icon** in the Activity Bar and select an agent to start a session.
2. **Chat**: Type your requests in the input box.
3. **Quick Send**:
   - Highlight code in the editor → Right-click → **Send to ACP**.
   - Select text in the terminal → Right-click → **Send to ACP**.
4. **Inspect Tools**: Click on tool icons (✓, ✗, ⋯) to view command inputs and execution results.

## 🛠️ Configuration

The extension automatically detects installed agents by checking your system's `$PATH` for the following commands:

| Agent          | Command                                     | Detection      |
| -------------- | ------------------------------------------- | -------------- |
| OpenCode       | `opencode acp`                              | Checks `$PATH` |
| Grok Build     | `grok --no-auto-update agent stdio`         | Checks `grok`  |
| Pi             | bundled `pi-acp` adapter                    | Checks `pi`    |
| Antigravity    | bundled experimental adapter                | Checks `agy`   |
| Claude Code    | `npx @agentclientprotocol/claude-agent-acp` | Checks `$PATH` |
| Codex CLI      | `npx @agentclientprotocol/codex-acp`        | Checks `$PATH` |
| CodeBuddy Code | `codebuddy --acp`                           | Checks `$PATH` |
| Gemini CLI     | `gemini --acp`                              | Checks `$PATH` |
| Goose          | `goose acp`                                 | Checks `$PATH` |
| Amp            | `amp acp`                                   | Checks `$PATH` |
| Aider          | `aider --acp`                               | Checks `$PATH` |
| Augment Code   | `augment acp`                               | Checks `$PATH` |
| Kimi CLI       | `kimi --acp`                                | Checks `$PATH` |
| Mistral Vibe   | `vibe acp`                                  | Checks `$PATH` |
| OpenHands      | `openhands acp`                             | Checks `$PATH` |
| Qwen Code      | `qwen --acp`                                | Checks `$PATH` |
| Kiro CLI       | `kiro-cli acp`                              | Checks `$PATH` |
| Cursor Cli     | `agent acp`                                 | Checks `$PATH` |

### Grok Build

The built-in `grok-build` agent launches the installed official Grok Build CLI directly:

```bash
grok --no-auto-update agent stdio
```

Authenticate before connecting from VS Code:

```bash
grok login
grok --version
```

`XAI_API_KEY` can be used when it is available to the VS Code Extension Host environment. The extension does not install Grok, manage its credentials, or start an interactive ACP authentication flow. Grok session loading is used when advertised; session listing falls back to the extension's local session metadata when Grok does not advertise `session/list`.

A custom agent with `id: "grok-build"` replaces this built-in launch configuration.

### Antigravity (Experimental, opt-in)

The extension can launch a bundled ACP adapter for Google Antigravity with built-in id `antigravity`, but it is **disabled by default**. Enable `vscode-acp-chat.antigravity.enabled` only after reviewing Google's official terms and FAQ:

- https://antigravity.google/terms
- https://antigravity.google/docs/faq

Google states that third-party software access using Antigravity OAuth may violate the Antigravity Terms of Service and may result in account suspension or termination. This extension and bundled adapter are unofficial and unsupported by Google.

Setup:

```bash
agy
agy models
```

Use the official `agy` CLI to install/sign in and verify models. The bundled adapter does not install `agy`, does not store OAuth credentials, and does not require or claim API-key authentication for this path; it reuses the existing `agy` OAuth/keyring session. It runs with VS Code's Electron Node runtime, not Bun.

Antigravity modes are the native `agy` modes exposed by the adapter: default, `accept-edits`, and `plan`. The adapter does not add `--dangerously-skip-permissions`. Interactive permission prompts and MCP configuration remain governed by Antigravity/`agy`; VS Code ACP MCP server forwarding is not passed through to `agy`, so configure MCP servers in Antigravity itself.

If you previously configured an external custom agent with `id: "antigravity"`, it continues to override the bundled entry when the bundled feature is enabled, and it continues to work when the bundled feature is disabled. Remove that custom entry only when you want to migrate to the bundled adapter.

### Custom Agents

You can add custom agents via VS Code settings:

1. Open **Settings** (`Cmd+Shift+P` / `Ctrl+Shift+P` → `Preferences: Open User Settings`)
2. Search for `vscode-acp-chat.customAgents`
3. Click **Edit in settings.json**

#### Example Configuration

```json
{
  "vscode-acp-chat.customAgents": [
    {
      "id": "my-agent",
      "name": "My Custom Agent",
      "command": "my-agent-cli",
      "args": ["--acp"],
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  ]
}
```

#### Configuration Fields

| Field     | Type       | Required | Description                            |
| --------- | ---------- | -------- | -------------------------------------- |
| `id`      | `string`   | Yes      | Unique identifier for the agent        |
| `name`    | `string`   | Yes      | Display name shown in agent selector   |
| `command` | `string`   | Yes      | Executable command                     |
| `args`    | `string[]` | No       | Command-line arguments (default: `[]`) |
| `env`     | `object`   | No       | Environment variables                  |

> [!NOTE]
> Custom agents with the same `id` as a built-in agent will **replace** the built-in configuration.
> To use the bundled Pi adapter, remove any old custom agent with `id: "pi"` and `command: "pi-acp"`. Keep a custom `pi` entry only when intentionally overriding the bundled adapter.
>
> Bundled Pi history loading defaults to `vscode-acp-chat.pi.historyLoadMode: "full"`, which replays the active-path transcript from Pi JSONL session files so compacted Pi sessions still show earlier conversation turns in the UI. Set it to `"compacted"` to use Pi's compacted `get_messages` RPC context instead.

## 👨‍💻 Development

```bash
# Install dependencies
npm install

# Build the extension
npm run compile

# Package as VSIX
npx vsce package

# Run tests & linting
npm test
npm run lint
npm run format
```

## 🤝 Acknowledgments

This project is an enhanced fork of the original [vscode-acp](https://github.com/omercnet/vscode-acp) repository, adding significant improvements to agent compatibility, session management, and the overall user interface.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

# Service Documentation Skeleton

This skeleton keeps durable service knowledge in `docs/`, lightweight agent routing in `AGENTS.md`, and active multi-step execution in Beads.

Core split:

- `AGENTS.md` — short agent behavior and docs-routing policy.
- `README.md` — service entry point: purpose, owner, runtime, local setup, verification, and important links.
- `docs/` — product, feature, architecture, design, contracts, engineering, operations, and implementation-plan source-of-truth.
- `.beads/` — local Beads boundary notes; actual task graph/status should live in the Beads CLI/store when available.

Do not turn documentation into a task tracker. Use `docs/features/README.md` to know what durable feature context exists, and use Beads to manage active implementation work.
