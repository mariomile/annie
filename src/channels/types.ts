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
	/** Files that came with the message; the gateway stores them in the workspace. */
	readonly attachments?: readonly { readonly name: string; readonly data: Uint8Array }[];
};

/** A tap on a button of an earlier outbound message (Telegram: a callback query). */
export type InboundAction = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly userId: string;
	/** The `data` of the button that was tapped. */
	readonly data: string;
	/** Channel-native ID of the tap; a redelivery after a crash carries the same one. */
	readonly actionId: string;
};

/** A button under an outbound message. `data` comes back in the InboundAction when tapped. */
export type ActionButton = { readonly label: string; readonly data: string };

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
	/**
	 * This message may already have reached the user (resent after a crash). Channels that
	 * cannot deduplicate should tell the user; the others can ignore it.
	 */
	readonly possibleDuplicate?: boolean;
	/** Buttons, in one row, under the message (under its last piece if it is split). */
	readonly buttons?: readonly ActionButton[];
};

/** A file to deliver through a channel. */
export type OutboundFile = Omit<OutboundMessage, "text" | "buttons"> & {
	readonly name: string;
	readonly data: Uint8Array;
	readonly caption?: string;
	/** Where the file is in the instance's workspace, for channels that link instead of uploading. */
	readonly path?: string;
};

export interface ChannelAdapter {
	readonly name: string;
	/** Start receiving. Resolves once the adapter is running. */
	start(): Promise<void>;
	/** Stop receiving and release resources. */
	stop(): Promise<void>;
	/** Register the handler for inbound messages. One handler per adapter. */
	onInbound(handler: (message: InboundMessage) => Promise<void>): void;
	/**
	 * Register the handler for button taps. Optional: channels without buttons omit it.
	 * Taps can be redelivered after a crash, so the handler must be idempotent.
	 */
	onAction?(handler: (action: InboundAction) => Promise<void>): void;
	/** Resolves once the channel has accepted the whole message; rejects otherwise. */
	send(message: OutboundMessage): Promise<void>;
	/** Resolves once the channel has accepted the file. Optional: channels without files omit it. */
	sendFile?(file: OutboundFile): Promise<void>;
}

/**
 * The channel answered and refused the message: it did not reach anyone. Any other error
 * from `send` (network, timeout) leaves open whether it arrived.
 */
export class ChannelRefused extends Error {
	override readonly name = "ChannelRefused";
}
