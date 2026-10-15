import type { ModelSelection } from "./registry.ts";

/**
 * One-shot model calls (extraction, drafting, judging), outside any durable conversation.
 * Annie code depends on this interface only; the Pi implementation lives in
 * src/core/adapters/pi-durable-completion.ts.
 */
export interface ModelClient {
	complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type CompletionRequest = {
	readonly model: ModelSelection;
	readonly system: string;
	readonly user: string;
	readonly maxTokens: number;
	readonly signal?: AbortSignal;
};

export type CompletionResult = {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Cost reported by the provider, when it reports one. */
	readonly costUsd?: number;
};
