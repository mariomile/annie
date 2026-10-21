/**
 * DurableEngine implemented on @earendil-works/pi-durable 1.3.0 (experimental API).
 * This file and pi-durable-models.ts are the only places that import Pi packages.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Message, Type } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	AssistantEntry,
	UserEntry,
	configure,
	type ConversationId,
	type Cursor,
	createRegistry,
	type EntryRecord,
	type Page,
	defineDoc,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	type Submission,
	type SubmissionId,
	type SettledSubmissionRecord,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { AnnieTool, DurableEngine, EngineImage, EngineOpenOptions, EngineReply, EngineSession, JsonValue } from "../engine.ts";
import type { ModelSelection } from "../registry.ts";
import { isTurnOrigin, type TurnOrigin } from "../turn-origin.ts";
import { createProvider } from "./pi-durable-models.ts";

const context = BACKGROUND_CONTEXT;

/** Thread key (channel:threadId) → Pi conversation ID, stored in the same SQLite file. */
const ThreadsDoc = defineDoc<{ threads: Record<string, number> }>({
	kind: "annie.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: {} }),
});

/**
 * The entry a turn's input is placed as (ADR 0088): the person's words as the model sees them, with
 * where the turn comes from in its data, written in the same commit as the submission.
 */
const INPUT_KIND = "annie.input";

/** Thread key → the model that conversation answers with instead of the instance's (ADR 0036). */
const ThreadModelsDoc = defineDoc<{ models: Record<string, ModelSelection> }>({
	kind: "annie.thread-models",
	version: 1,
	scope: "session",
	initial: () => ({ models: {} }),
});

export const piDurableEngine: DurableEngine = {
	async open(options: EngineOpenOptions): Promise<EngineSession> {
		const provider = createProvider(options.model.provider, options.localProviders);
		const models = createModels({
			credentials: {
				async read(providerId) {
					const key = await options.apiKey(providerId);
					return key === undefined ? undefined : { type: "api_key", key };
				},
				async list() {
					return [];
				},
				async modify() {
					throw new Error("Annie credentials are read-only; manage them in the tenant secret store");
				},
				async delete() {
					throw new Error("Annie credentials are read-only; manage them in the tenant secret store");
				},
			},
			// No ambient credentials: no env vars, no credential files.
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		// The instance's provider; a chat's own model adds its provider when it is first used.
		// Which of them can actually be reached is apiKey's call (the instance's policy).
		models.setProvider(provider);

		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "annie",
				tools: options.tools.map(toPiTool),
				// Old pictures leave the request, not the history: a long thread does not resend every photo.
				hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: withRecentImages(messages, RECENT_IMAGE_MESSAGES) }) })],
			}),
		);

		const storage = await openNodeSqliteStorage(join(options.storageDir, "pi-durable.sqlite"));
		const harness = await Harness.open(storage, { models, registry }, context);
		return new PiDurableSession(harness, models, options);
	},
};

class PiDurableSession implements EngineSession {
	private readonly listeners = new Set<(reply: EngineReply) => void>();
	private readonly tracked = new Set<SubmissionId>();
	private readonly creating = new Map<string, Promise<ConversationId>>();
	private closing = false;
	private recovery: Promise<number> | undefined;

	constructor(
		private readonly harness: Harness,
		private readonly models: MutableModels,
		private readonly options: EngineOpenOptions,
	) {}

	async submit(threadKey: string, text: string, requestId?: string, images: readonly EngineImage[] = [], origin: TurnOrigin = "scheduled"): Promise<{ submissionId: string }> {
		// Submitting starts Pi's scheduler: reattach the previous process's open work first.
		await this.recover();
		const conversationId = await this.conversationFor(threadKey);
		// Each message: the owner may have changed the instance's model, or the person the chat's.
		await this.alignAgent(conversationId, threadKey);
		const conversation = await this.harness.conversation(conversationId, context);
		if (conversation === undefined) throw new Error(`Conversation ${conversationId} of ${threadKey} is missing`);
		if (requestId !== undefined) {
			// A redelivered message: already admitted, so it is answered (or being answered) once.
			const existing = await conversation.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
			if (existing !== undefined) return { submissionId: String(existing.id) };
		}
		const submission = await conversation.submit(
			{
				type: "input",
				content: images.length === 0 ? text : [{ type: "text", text }, ...(await Promise.all(images.map(toPiImage)))],
				entry: { kind: INPUT_KIND, data: { origin } },
				...(requestId === undefined ? {} : { requestId }),
			},
			context,
		);
		this.track(submission, threadKey);
		return { submissionId: String(submission.id) };
	}

	async resume(): Promise<{ pending: number }> {
		return { pending: await this.recover() };
	}

	async reattach(submissionId: string, threadKey: string): Promise<boolean> {
		const submission = await this.harness.submission(Number(submissionId) as SubmissionId, context);
		if (submission === undefined) return false;
		this.track(submission, threadKey);
		return true;
	}

	/**
	 * Once per session: attach a waiter to every unsettled submission while the scheduler is
	 * still paused (Harness.open leaves it paused), then start it. Starting first would let a
	 * fast run settle before it is tracked, and its reply would be lost.
	 */
	private recover(): Promise<number> {
		this.recovery ??= this.attachPending().then((pending) => {
			this.harness.resume();
			return pending;
		});
		return this.recovery;
	}

	private async attachPending(): Promise<number> {
		const inspection = await this.harness.inspect(context);
		const threads = await this.threads();
		const byConversation = new Map<number, string>(Object.entries(threads).map(([key, id]) => [id, key]));
		let pending = 0;
		const aligned = new Set<number>();
		for (const record of inspection.submissions) {
			if (record.type !== "input") continue;
			const threadKey = byConversation.get(record.conversationId);
			const submission = await this.harness.submission(record.id, context);
			if (threadKey === undefined || submission === undefined) continue;
			// Work left half done goes on with the instance's model, before the scheduler starts.
			if (!aligned.has(record.conversationId)) {
				aligned.add(record.conversationId);
				await this.alignAgent(record.conversationId, threadKey);
			}
			pending++;
			this.track(submission, threadKey);
		}
		return pending;
	}

	async setThreadModel(threadKey: string, model: ModelSelection | undefined): Promise<void> {
		await this.harness.commit(async (tx) => {
			const { models } = await tx.doc(ThreadModelsDoc);
			if (model === undefined) delete models[threadKey];
			else models[threadKey] = { provider: model.provider, modelId: model.modelId };
		}, context);
	}

	async threadModel(threadKey: string): Promise<ModelSelection | undefined> {
		return (await this.harness.snapshot(ThreadModelsDoc, context))?.models[threadKey];
	}

	onReply(listener: (reply: EngineReply) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	idle(): Promise<void> {
		return this.harness.waitForIdle(context);
	}

	async close(): Promise<void> {
		this.closing = true;
		await this.harness.close(context);
	}

	private async threads(): Promise<Readonly<Record<string, number>>> {
		return (await this.harness.snapshot(ThreadsDoc, context))?.threads ?? {};
	}

	private conversationFor(threadKey: string): Promise<ConversationId> {
		let pending = this.creating.get(threadKey);
		if (pending === undefined) {
			pending = this.findOrCreate(threadKey);
			this.creating.set(threadKey, pending);
			pending.catch(() => this.creating.delete(threadKey));
		}
		return pending;
	}

	private async findOrCreate(threadKey: string): Promise<ConversationId> {
		const existing = (await this.threads())[threadKey];
		if (existing !== undefined) return existing as ConversationId;
		const instructions = this.instructionsNow();
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: await this.modelOf(threadKey),
					...(instructions === undefined ? {} : { instructions }),
				},
				// Same commit as the conversation: the mapping can never point to nothing.
				init: async (tx, id) => {
					(await tx.doc(ThreadsDoc)).threads[threadKey] = id;
				},
			},
			context,
		);
		return conversation.id;
	}

	/**
	 * A conversation keeps the model and instructions it was created with. The ones that count
	 * are the instance's, or the chat's own model: after either changes, an old thread answers
	 * with the new ones (its history stays). Written only when they differ.
	 */
	private async alignAgent(id: ConversationId, threadKey: string): Promise<void> {
		const conversation = await this.harness.conversation(id, context);
		if (conversation === undefined) return;
		const model = await this.modelOf(threadKey);
		const instructions = this.instructionsNow();
		await conversation.commit(async (tx) => {
			const agent = await tx.doc(AgentDoc, id);
			const sameModel = agent.model?.provider === model.provider && agent.model?.modelId === model.modelId;
			const sameInstructions = agent.instructions === instructions;
			if (sameModel && sameInstructions) return;
			await configure(tx, id, { ...(sameModel ? {} : { model }), ...(sameInstructions ? {} : { instructions: instructions ?? null }) });
		}, context);
	}

	private instructionsNow(): string | undefined {
		const { instructions } = this.options;
		return typeof instructions === "function" ? instructions() : instructions;
	}

	/**
	 * The chat's own model while it can answer, otherwise the instance's; its provider registered.
	 * A provider this version no longer offers counts as one that cannot answer.
	 */
	private async modelOf(threadKey: string): Promise<ModelSelection> {
		const own = await this.threadModel(threadKey);
		if (own !== undefined && this.register(own.provider) && ((await this.options.modelUsable?.(own.provider)) ?? true)) return own;
		this.register(this.options.model.provider);
		return this.options.model;
	}

	private register(provider: string): boolean {
		if (this.models.getProvider(provider) !== undefined) return true;
		try {
			this.models.setProvider(createProvider(provider, this.options.localProviders));
			return true;
		} catch {
			return false;
		}
	}

	/** Each submission is tracked, and so replied to, at most once per session. */
	private track(submission: Submission, threadKey: string): void {
		if (this.tracked.has(submission.id)) return;
		this.tracked.add(submission.id);
		this.settle(submission, threadKey).catch((error: unknown) => {
			console.error(`annie: reply for submission ${submission.id} failed: ${String(error)}`);
		});
	}

	private async settle(submission: Submission, threadKey: string): Promise<void> {
		const submissionId = String(submission.id);
		let reply: EngineReply;
		try {
			const settled = await submission.wait(context);
			if (settled.status === "done" && settled.type === "input") {
				reply = { status: "answered", threadKey, submissionId, ...(await this.answer(settled)) };
			} else {
				reply = { status: "unanswered", threadKey, submissionId, reason: settled.reason ?? settled.status };
			}
		} catch (error) {
			if (this.closing) return; // the next process resumes it
			reply = { status: "unanswered", threadKey, submissionId, reason: String(error) };
		}
		for (const listener of this.listeners) {
			try {
				listener(reply);
			} catch (error) {
				console.error(`annie: reply listener failed: ${String(error)}`);
			}
		}
	}

	private async answer(settled: SettledSubmissionRecord & { status: "done"; type: "input" }): Promise<{ text: string; model?: ModelSelection }> {
		const conversation = await this.harness.conversation(settled.conversationId, context);
		// A read-only commit, as in the pi-durable README.
		const entry = await conversation?.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0] as Message | undefined;
		if (message?.role !== "assistant") return { text: "" };
		return { text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""), model: { provider: message.provider, modelId: message.model } };
	}
}

function toPiTool(tool: AnnieTool): ToolRegistration {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters as never),
		replay: tool.replaySafe ? "safe" : "unsafe",
		execute: async (args, api, callContext) => {
			const threads = (await api.snapshot(ThreadsDoc, callContext))?.threads ?? {};
			const threadKey = Object.entries(threads).find(([, id]) => id === Number(api.conversationId))?.[0];
			const at = threadKey?.indexOf(":") ?? -1;
			const origin = await turnOrigin(api, callContext);
			const result = await tool.execute(args, {
				callId: `${api.conversationId}/${api.callId}`,
				origin,
				...(threadKey === undefined || at < 0 ? {} : { thread: { channel: threadKey.slice(0, at), threadId: threadKey.slice(at + 1) } }),
				signal: callContext.abortSignal ?? new AbortController().signal,
				progress: (chunk) => api.output(chunk),
				step: async <T extends JsonValue>(key: string, work: () => Promise<T>): Promise<T> => {
					const name = `step:${key}`;
					const stored = await api.memo<{ value: T }>(name, callContext);
					if (stored !== undefined) return stored.value;
					const value = await work();
					return (await api.memo<{ value: T }>(name, { value } as never, callContext)).value;
				},
			});
			if (typeof result === "string") return { output: [{ type: "text", text: result }] };
			return { output: [{ type: "text", text: result.text }, ...(await Promise.all(result.images.map(toPiImage)))] };
		},
	});
}

type OriginApi = Pick<Parameters<ToolRegistration["execute"]>[1], "memo" | "commit" | "conversationId">;
type OriginContext = Parameters<ToolRegistration["execute"]>[2];

/**
 * Where the turn of a tool call comes from: kept in the call's memo the first time, so a rerun
 * after a crash gets the same one even if more messages arrived meanwhile.
 */
async function turnOrigin(api: OriginApi, callContext: OriginContext): Promise<TurnOrigin> {
	const stored = await api.memo<{ origin: string }>("annie:origin", callContext);
	if (stored !== undefined && isTurnOrigin(stored.origin)) return stored.origin;
	const found = await api.commit((tx) => inputsOrigin(tx, api.conversationId), callContext);
	const kept = await api.memo<{ origin: string }>("annie:origin", { origin: found }, callContext);
	return isTurnOrigin(kept.origin) ? kept.origin : "scheduled";
}

/**
 * The origin of the inputs the model is answering: every input since the run began, back to the
 * last answer that ended a run (an assistant message without tool calls). A person's only when
 * every one of them is; an input without an origin (written before origins were kept) is not.
 *
 * Robust to steering: inputs are admitted as follow-ups today (submit leaves `whenBusy` at its
 * default, so a new message waits for the run to end), but a message steered into a running turn
 * lands after an assistant message with tool calls; scanning past those to the run's start keeps
 * a notice that began the run in the reckoning even when a person's message is steered in later.
 * Past the scan's bound, the turn is not taken for a person's.
 */
export async function inputsOrigin(tx: Pick<Tx, "scanEntries">, conversationId: ConversationId, warn: (message: string) => void = warnBoundOnce): Promise<TurnOrigin> {
	const found: (TurnOrigin | undefined)[] = [];
	let cursor: Cursor | undefined;
	for (let page = 0; page < 20; page++) {
		const { items, next }: Page<EntryRecord, Cursor> = await tx.scanEntries({ conversationId, order: "descending" }, 50, cursor);
		for (const entry of items) {
			const input = entry.kind === INPUT_KIND || entry.kind === UserEntry.kind;
			if (input) {
				const data = entry.data as { origin?: unknown } | undefined;
				found.push(entry.kind === INPUT_KIND && isTurnOrigin(data?.origin) ? data.origin : undefined);
			} else if (found.length > 0 && endsRun(entry)) return worst(found);
		}
		if (next === undefined) return found.length === 0 ? "scheduled" : worst(found);
		cursor = next;
	}
	warn(SCAN_BOUND);
	return worst([...found, undefined]);
}

const SCAN_BOUND = "annie: the scan for a turn's origin reached its bound before the start of the run; the turn is not taken for a person's";
let boundWarned = false;

/** Said once per process, with no value of the conversation: a run that long is rare, and the line is enough to look into it. */
function warnBoundOnce(message: string): void {
	if (boundWarned) return;
	boundWarned = true;
	console.error(message);
}

/** An assistant message that answered without calling a tool: the run it belongs to ended there. */
function endsRun(entry: EntryRecord): boolean {
	return entry.model?.some((m) => m.role === "assistant" && !(Array.isArray(m.content) && m.content.some((c) => (c as { type?: string }).type === "toolCall"))) === true;
}

/** The least trusted of the inputs: another agente, then a notice, then something scheduled (or not known). */
function worst(found: readonly (TurnOrigin | undefined)[]): TurnOrigin {
	if (found.every((o) => o === "person")) return "person";
	for (const o of ["agent", "notice"] as const) if (found.includes(o)) return o;
	return "scheduled";
}

/**
 * A picture as the model takes it: as it is when it fits, otherwise turned upright, scaled and
 * re-encoded until it does (Photon, in a worker thread, loaded on the first big photo). One
 * that cannot be made to fit becomes a line saying so.
 */
async function toPiImage(image: EngineImage): Promise<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> {
	if (Math.ceil(image.data.length / 3) * 4 <= DEFAULT_IMAGE_LIMITS.maxBytes) return { type: "image", data: Buffer.from(image.data).toString("base64"), mimeType: image.mimeType };
	photon ??= createNodePhotonImages();
	const prepared = await (await photon).prepare(image.data, image.mimeType, DEFAULT_IMAGE_LIMITS).catch(() => undefined);
	if (prepared === undefined) return { type: "text", text: "[Immagine troppo grande: non si è riusciti a ridurla]" };
	return { type: "image", data: prepared.data, mimeType: prepared.mimeType };
}

let photon: Promise<ImageProcessor> | undefined;

/** How many of the newest messages carrying pictures still show them to the model. */
export const RECENT_IMAGE_MESSAGES = 2;

/**
 * The messages with pictures only in the newest `keep` that carry any; older ones get a line
 * saying a picture was there, so the model can reopen it from the workspace with image_view.
 */
export function withRecentImages(messages: readonly Message[], keep: number): readonly Message[] {
	let seen = 0;
	const out = [...messages];
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i] as Message;
		if (message.role === "assistant" || typeof message.content === "string" || !message.content.some((c) => c.type === "image")) continue;
		seen += 1;
		if (seen <= keep) continue;
		const content = message.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[Immagine vista prima: non più allegata, riaprila con image_view se serve]" } : c));
		out[i] = { ...message, content } as Message;
	}
	return out;
}
