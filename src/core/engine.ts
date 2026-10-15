import type { ModelSelection } from "./registry.ts";

/**
 * The durable execution engine behind an instance. Annie code depends on this
 * interface only; the Pi Durable implementation lives in src/core/adapters/.
 */
export interface DurableEngine {
	open(options: EngineOpenOptions): Promise<EngineSession>;
}

export type EngineOpenOptions = {
	/** Directory owned exclusively by this instance. One process at a time. */
	readonly storageDir: string;
	readonly model: ModelSelection;
	/**
	 * The only source of model credentials. The engine must not read ambient
	 * credentials (process env, ~/.aws, ...) so that each tenant uses its own keys.
	 */
	readonly apiKey: (provider: string) => Promise<string | undefined>;
	readonly tools: readonly AnnieTool[];
	readonly instructions?: string;
};

export interface EngineSession {
	/**
	 * Durably admit `text` into the conversation identified by `threadKey` (created on first use).
	 * Resolves once admitted; the answer arrives through `onReply`. The same `requestId`
	 * on the same thread is admitted once, also across restarts.
	 */
	submit(threadKey: string, text: string, requestId?: string): Promise<{ submissionId: string }>;
	/** Continue whatever a previous process left unfinished; replies arrive through `onReply`. */
	resume(): Promise<{ pending: number }>;
	onReply(listener: (reply: EngineReply) => void): () => void;
	/** Resolves when no work is running or pending. */
	idle(): Promise<void>;
	close(): Promise<void>;
}

export type EngineReply =
	| { readonly status: "answered"; readonly threadKey: string; readonly submissionId: string; readonly text: string }
	| { readonly status: "unanswered"; readonly threadKey: string; readonly submissionId: string; readonly reason: string };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** An engine-agnostic tool. `parameters` is a JSON Schema object. */
export type AnnieTool = {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	/**
	 * true: after a crash mid-call the tool runs again, and finished `step()`s return their
	 * stored result instead of running again. false: the model gets an "interrupted" result.
	 */
	readonly replaySafe: boolean;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
};

export type ToolContext = {
	/**
	 * Run `work` at most once per call and key, durably: if the process dies after the
	 * step's result is stored, a rerun gets the stored result without running `work`.
	 * A crash between `work` finishing and the result being stored reruns it (at-least-once).
	 */
	step<T extends JsonValue>(key: string, work: () => Promise<T>): Promise<T>;
	/** Running output, visible to watchers while the tool runs. */
	progress(text: string): void;
	readonly signal: AbortSignal;
};
