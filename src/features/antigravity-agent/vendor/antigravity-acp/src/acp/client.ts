// Thin wrapper over the SDK's AgentContext for client-bound messages.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { type AgentContext, methods } from "@agentclientprotocol/sdk";

export class AcpClient {
	constructor(private readonly ctx: AgentContext) {}

	/** Send a `session/update` notification carrying one ACP update. */
	async update(sessionId: string, update: SessionUpdate): Promise<void> {
		await this.ctx.notify(methods.client.session.update, {
			sessionId,
			update,
		});
	}

	/** Request a permission decision from the client (not all clients support it). */
	async requestPermission(
		params: Parameters<AgentContext["request"]>[1],
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.ctx.request(
			methods.client.session.requestPermission,
			params,
			signal ? { cancellationSignal: signal } : undefined,
		);
	}
}
