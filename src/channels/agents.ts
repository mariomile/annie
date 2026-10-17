import { AGENT_CHANNEL, type Origin, agentInboundText, agentThreadId, parseAgentThread } from "../core/agent-messages.ts";
import { ChannelRefused, type ChannelAdapter, type InboundMessage, type OutboundFile, type OutboundMessage } from "./types.ts";

/** An answer of the agente bound to this channel, on its way back to the agente that asked. */
export type AgentAnswer = {
	/** The agente that asked, and its conversation the answer goes to. */
	readonly to: string;
	readonly origin: Origin;
	readonly text?: string;
	readonly file?: { readonly name: string; readonly data: Uint8Array };
	/** Same for every resend of the same answer. */
	readonly key: string;
};

/**
 * The channel `agente` of one agente (ADR 0042): other agenti write to it through `ask`, and its
 * answers go back through `deliver`. Who may write is the agente's allowlist on this channel,
 * checked by the core like for people; a refusal comes back to the asker as an error.
 */
export class AgentChannel implements ChannelAdapter {
	readonly name = AGENT_CHANNEL;
	readonly surfacesRefusals = true;
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;

	constructor(
		private readonly target: { readonly tenantId: string; readonly instanceId: string },
		private readonly deliver: (answer: AgentAnswer) => Promise<void>,
	) {}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	/** A message from agente `from`, written in its conversation `origin`. `messageId` drops a repeat. */
	async ask(message: { readonly from: { readonly id: string; readonly name: string }; readonly origin: Origin; readonly text: string; readonly messageId: string }): Promise<void> {
		if (this.handler === undefined) throw new Error(`agente ${this.target.instanceId} is not connected`);
		await this.handler({
			...this.target,
			channel: AGENT_CHANNEL,
			threadId: agentThreadId(message.from.id, message.origin),
			userId: message.from.id,
			text: agentInboundText(message.from, message.text),
			messageId: message.messageId,
			privateThread: false,
		});
	}

	async send(message: OutboundMessage): Promise<void> {
		await this.deliver({ ...this.back(message.threadId), text: message.text, key: message.idempotencyKey });
	}

	async sendFile(file: OutboundFile): Promise<void> {
		await this.deliver({ ...this.back(file.threadId), file: { name: file.name, data: file.data }, ...(file.caption === undefined ? {} : { text: file.caption }), key: file.idempotencyKey });
	}

	private back(threadId: string): { to: string; origin: Origin } {
		const parsed = parseAgentThread(threadId);
		// Not a thread this channel made: nobody to give it to, and trying again will not help.
		if (parsed === undefined) throw new ChannelRefused(`not an agente thread: ${threadId}`);
		return { to: parsed.from, origin: parsed.origin };
	}
}
