import type { AnnieTool } from "../engine.ts";
import { MemoryError, type MemoryStore, SHARED } from "../memory.ts";

/**
 * Tools for the memoria: remember a fact about the person in this conversation (or for
 * everyone), forget one, list what applies. What is remembered also reaches the instance by
 * itself with each message of that person.
 */
export function createMemoryTools(options: { readonly store: MemoryStore; readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined }): AnnieTool[] {
	const { store } = options;
	const subject = (thread: { channel: string; threadId: string } | undefined) => (thread === undefined ? undefined : options.whoIs(thread));
	return [
		{
			name: "memory_remember",
			description:
				"Remember a lasting fact or preference about the person you are talking to (or, with shared, about the company, for everyone), " +
				"to use in later conversations. One short fact per call. Do not store passwords, card numbers or health data unless the person asks.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", minLength: 1, maxLength: 500, description: "The fact, as a short sentence" },
					shared: { type: "boolean", description: "True if it is about the company or everyone, not this person" },
				},
				required: ["text"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const about = args.shared === true ? SHARED : subject(ctx.thread);
				if (about === undefined) return "Errore: non so con chi sto parlando, quindi non posso ricordarlo.";
				return ctx.step("remember", async () => {
					try {
						const memory = store.add({ about, text: String(args.text), source: "annie" });
						return `Ricordato (id ${memory.id}).`;
					} catch (error) {
						if (error instanceof MemoryError) return `Errore: ${error.message}`;
						throw error;
					}
				});
			},
		},
		{
			name: "memory_forget",
			description: "Forget one remembered fact, by its id (from memory_list or from the memory notes). Use it when the person asks, or when a fact is no longer true.",
			parameters: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
			replaySafe: true,
			async execute(args, ctx) {
				const who = subject(ctx.thread);
				// Only what is about this person, or shared: never someone else's memory.
				const removed = store.remove(String(args.id), (m) => m.about === SHARED || m.about === who);
				return removed === undefined ? `Non trovo una memoria ${String(args.id)} da dimenticare.` : `Dimenticato: ${removed.text}`;
			},
		},
		{
			name: "memory_list",
			description: "List what you remember about the person you are talking to, and the shared facts, with their ids.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute(_args, ctx) {
				const who = subject(ctx.thread);
				const memories = who === undefined ? store.forSubject(SHARED) : store.forSubject(who);
				return memories.length === 0 ? "Non ricordo ancora nulla." : memories.map((m) => `${m.id}: ${m.text}${m.about === SHARED ? " (condivisa)" : ""}`).join("\n");
			},
		},
	];
}
