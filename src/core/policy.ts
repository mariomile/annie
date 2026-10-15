import { EgressDenied, UserNotAllowed } from "./errors.ts";

/**
 * What an instance may talk to. Default deny: an empty list allows nothing.
 * `modelProviders` are pi-ai provider IDs ("anthropic", "openai", ...; "faux" is the
 * local deterministic model). `channels` are channel adapter names ("telegram", ...).
 */
export type EgressPolicy = {
	readonly modelProviders: readonly string[];
	readonly channels: readonly string[];
};

export const DENY_ALL: EgressPolicy = { modelProviders: [], channels: [] };

/**
 * Who may talk to an instance: channel name → channel-native user IDs. Default deny: a
 * channel without an entry, or with an empty list, accepts nobody.
 */
export type AllowedUsers = Readonly<Record<string, readonly string[]>>;

export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function assertModelProviderAllowed(policy: EgressPolicy, provider: string): void {
	if (!policy.modelProviders.includes(provider)) throw new EgressDenied("model_provider", provider);
}

export function assertChannelAllowed(policy: EgressPolicy, channel: string): void {
	if (!policy.channels.includes(channel)) throw new EgressDenied("channel", channel);
}

export function assertUserAllowed(allowed: AllowedUsers, message: { channel: string; userId: string; threadId: string }): void {
	const list = allowed[message.channel];
	if (list === undefined || list.length === 0) throw new UserNotAllowed(message.channel, message.userId, message.threadId, "no_users_allowed_on_channel");
	if (!list.includes(message.userId)) throw new UserNotAllowed(message.channel, message.userId, message.threadId, "user_not_in_allowlist");
}
