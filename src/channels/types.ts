/**
 * Channel adapters connect Annie to the places people talk to it. The core never imports
 * this module: the gateway (src/gateway.ts) passes normalized messages between the two.
 *
 * Implemented: telegram.
 * Planned (interface only, see docs/architettura.md): web app, desktop app, HTTP API /
 * webhook, mobile app. Each one is another ChannelAdapter with its own `name`, which an
 * instance's egress policy must list in `channels` before it can be used.
 */

/** A message received from a channel, normalized. */
export type InboundMessage = {
	readonly tenantId: string;
	readonly instanceId: string;
	/** Adapter name, e.g. "telegram". */
	readonly channel: string;
	/** The channel's conversation: a Telegram chat, a web session, an API thread. */
	readonly threadId: string;
	readonly userId: string;
	readonly text: string;
	/** Channel-native message ID, used to drop redeliveries. */
	readonly messageId?: string;
};

/** A message to deliver through a channel. */
export type OutboundMessage = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly text: string;
	/**
	 * Same value every time this reply is sent, also after a restart. Channels whose
	 * remote end deduplicates (an HTTP API with an Idempotency-Key) should pass it on;
	 * Telegram cannot, so a resend there can show the reply twice.
	 */
	readonly idempotencyKey: string;
};

export interface ChannelAdapter {
	readonly name: string;
	/** Start receiving. Resolves once the adapter is running. */
	start(): Promise<void>;
	/** Stop receiving and release resources. */
	stop(): Promise<void>;
	/** Register the handler for inbound messages. One handler per adapter. */
	onInbound(handler: (message: InboundMessage) => Promise<void>): void;
	/** Resolves once the channel has accepted the whole message; rejects otherwise. */
	send(message: OutboundMessage): Promise<void>;
}
