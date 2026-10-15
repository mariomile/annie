import { EgressDenied } from "./errors.ts";

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

export function assertModelProviderAllowed(policy: EgressPolicy, provider: string): void {
	if (!policy.modelProviders.includes(provider)) throw new EgressDenied("model_provider", provider);
}

export function assertChannelAllowed(policy: EgressPolicy, channel: string): void {
	if (!policy.channels.includes(channel)) throw new EgressDenied("channel", channel);
}
