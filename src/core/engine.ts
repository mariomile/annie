import type { ModelSelection } from "./registry.ts";
import type { TurnOrigin } from "./turn-origin.ts";

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
	/**
	 * A function is read again on each message: what it returns now is what a conversation runs
	 * with from that message on (the skills of the agente, ADR 0059).
	 */
	readonly instructions?: string | (() => string | undefined);
	/**
	 * Whether a chat's own model may answer now (ADR 0036): its provider allowed, with a key. When
	 * not, the instance's model answers, also for work resumed after a restart. Missing: always.
	 */
	readonly modelUsable?: (provider: string) => Promise<boolean>;
};

export interface EngineSession {
	/**
	 * Durably admit `text`, and the pictures that came with it, into the conversation identified
	 * by `threadKey` (created on first use). Resolves once admitted; the answer arrives through
	 * `onReply`. The same `requestId` on the same thread is admitted once, also across restarts.
	 * `origin`: where the turn comes from (turn-origin.ts), stored with it so a rerun or a recovery
	 * keeps it, and given to its tools as `ctx.origin`; not given, it is not a person's.
	 */
	submit(threadKey: string, text: string, requestId?: string, images?: readonly EngineImage[], origin?: TurnOrigin): Promise<{ submissionId: string }>;
	/** Continue whatever a previous process left unfinished; replies arrive through `onReply`. */
	resume(): Promise<{ pending: number }>;
	/**
	 * Deliver through `onReply` the outcome of a submission this storage admitted earlier,
	 * also when it has already settled. At most once per session. false: unknown submission.
	 */
	reattach(submissionId: string, threadKey: string): Promise<boolean>;
	/**
	 * The model one conversation answers with instead of the instance's (ADR 0036), from its next
	 * message on and after a restart. undefined: back to the instance's model.
	 */
	setThreadModel(threadKey: string, model: ModelSelection | undefined): Promise<void>;
	/** The conversation's own model as stored, when it has one (usable or not). */
	threadModel(threadKey: string): Promise<ModelSelection | undefined>;
	onReply(listener: (reply: EngineReply) => void): () => void;
	/** Resolves when no work is running or pending. */
	idle(): Promise<void>;
	close(): Promise<void>;
}

export type EngineReply =
	| {
			readonly status: "answered";
			readonly threadKey: string;
			readonly submissionId: string;
			readonly text: string;
			/** The model that wrote the answer: the chat's, or the instance's when the chat's could not answer. */
			readonly model?: ModelSelection;
	  }
	| { readonly status: "unanswered"; readonly threadKey: string; readonly submissionId: string; readonly reason: string };

/** A picture for the model, already checked (src/core/images.ts). */
export type EngineImage = { readonly mimeType: string; readonly data: Uint8Array };

/** What a tool gives the model: text, or text with pictures (image_view). */
export type ToolResult = string | { readonly text: string; readonly images: readonly EngineImage[] };

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
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
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
	/** The conversation the call belongs to, when the engine knows it. */
	readonly thread?: { readonly channel: string; readonly threadId: string };
	/** Stable across reruns of the same call: a key for idempotent side effects. */
	readonly callId: string;
	/**
	 * Where the turn this call belongs to comes from (turn-origin.ts): set by the engine on every
	 * call, the same on a rerun. Undefined only in a context built by hand, which a confirmation
	 * gate (requirePersonFor) never takes for a person's.
	 */
	readonly origin?: TurnOrigin;
};
