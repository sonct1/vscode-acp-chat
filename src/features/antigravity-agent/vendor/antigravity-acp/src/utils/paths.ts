import * as os from "node:os";
import * as path from "node:path";

export function resolveAntigravityHome(): string {
	return (
		process.env.ANTIGRAVITY_CLI_HOME ||
		path.join(os.homedir(), ".gemini", "antigravity-cli")
	);
}

export function resolveConversationsDir(): string {
	return (
		process.env.AGY_CONVERSATIONS_DIR ||
		path.join(resolveAntigravityHome(), "conversations")
	);
}

export function resolveLastConversationsFile(): string {
	return path.join(
		resolveAntigravityHome(),
		"cache",
		"last_conversations.json",
	);
}

export function resolveBrainDir(): string {
	return path.join(resolveAntigravityHome(), "brain");
}

export function resolveAcpStateDir(): string {
	return (
		process.env.AGY_ACP_STATE_DIR ||
		path.join(os.homedir(), ".vscode-acp-chat", "antigravity-acp")
	);
}

export function resolveLegacyAcpStateDir(): string {
	return path.join(os.homedir(), ".agy-acp");
}
