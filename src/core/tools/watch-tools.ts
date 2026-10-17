import type { AnnieTool } from "../engine.ts";
import { threadPerson } from "../schedules.ts";
import { snapshot, untrustedPage, type Watch, WatchError, WATCH_LIMITS, type WatchStore, watchUrl } from "../watches.ts";

/**
 * Tools to create, list and delete sentinelle (ADR 0018): pages the instance checks by itself and
 * reports on in this conversation when they change, or when a price crosses a threshold.
 */
export function createWatchTools(options: { readonly store: WatchStore; readonly read: (url: string) => Promise<{ title: string; text: string }>; readonly now?: () => Date }): AnnieTool[] {
	const { store } = options;
	const now = options.now ?? (() => new Date());
	return [
		{
			name: "watch_create",
			description:
				"Watch a web page and tell this conversation when it changes, e.g. a price, availability, a results page, an announcement. " +
				"what: a phrase to watch near (product name, 'Prezzo', 'Disponibile'); without it the whole page. " +
				"below/above: tell only when the price near `what` goes under/over this number (a price alert). " +
				`everyMinutes: how often to check, ${WATCH_LIMITS.minEveryMinutes} to ${WATCH_LIMITS.maxEveryMinutes} (default ${WATCH_LIMITS.defaultEveryMinutes}). Only sites the owner allowed.`,
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", minLength: 8, maxLength: 2000 },
					what: { type: "string", maxLength: WATCH_LIMITS.maxWhatChars },
					below: { type: "number", minimum: 0 },
					above: { type: "number", minimum: 0 },
					everyMinutes: { type: "integer", minimum: WATCH_LIMITS.minEveryMinutes, maximum: WATCH_LIMITS.maxEveryMinutes },
				},
				required: ["url"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (ctx.thread === undefined) return "Errore: una sentinella va creata in una conversazione.";
				const thread = ctx.thread;
				// Annie never calls first: what a sentinella sees would only be heard at the next call.
				if (thread.channel === "phone") return "Errore: al telefono non posso creare sentinelle, perché non chiamo per prima. Chiedi alla persona di farlo su Telegram, WhatsApp o nella console.";
				// It writes by itself for someone: in a group there is nobody it acts for, so it would never write.
				if (threadPerson({ createdBy: { kind: "instance" }, ...thread }) === undefined) return "Errore: le sentinelle si creano in una chat privata con la persona da avvisare (o nella console), non in un gruppo.";
				const input = {
					what: typeof args.what === "string" && args.what.trim() !== "" ? args.what.replace(/\s+/g, " ").trim() : undefined,
					below: typeof args.below === "number" ? args.below : undefined,
					above: typeof args.above === "number" ? args.above : undefined,
				};
				// Once per call, also when the call reruns after a crash.
				return ctx.step("create", async () => {
					try {
						const url = watchUrl(String(args.url));
						const at = now();
						// The first look now: the person learns at once whether the page and the price are readable.
						const first = snapshot(await options.read(url), defined(input), at);
						if (input.what !== undefined && first.excerpt === "") return `Errore: non trovo «${input.what}» nella pagina. Prova con una frase che c'è, o senza frase per tutta la pagina.`;
						const w = await store.create({ url, ...defined(input), ...(typeof args.everyMinutes === "number" ? { everyMinutes: args.everyMinutes } : {}), channel: thread.channel, threadId: thread.threadId, createdBy: { kind: "instance" }, last: first }, at);
						return describeNew(w, first);
					} catch (error) {
						if (error instanceof WatchError) return `Errore: ${error.message}.`;
						throw error;
					}
				});
			},
		},
		{
			name: "watch_list",
			description: "List your sentinelle (watched pages) with what they watch and their last check.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute() {
				const all = await store.list();
				if (all.length === 0) return "Nessuna sentinella.";
				return all.map((w) => `${w.id}\t${w.url}\t${condition(w)}\togni ${w.everyMinutes} min\t${state(w)}`).join("\n");
			},
		},
		{
			name: "watch_delete",
			description: "Delete a sentinella by its ID.",
			parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				return (await store.remove(String(args.id))) ? `Eliminata la sentinella ${String(args.id)}.` : `Nessuna sentinella con ID ${String(args.id)}.`;
			},
		},
	];
}

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** What it tells about, in words. */
export function condition(w: Pick<Watch, "what" | "below" | "above">): string {
	const near = w.what === undefined ? "" : ` vicino a «${w.what}»`;
	if (w.below !== undefined && w.above !== undefined) return `prezzo${near} sotto ${w.below} o sopra ${w.above}`;
	if (w.below !== undefined) return `prezzo${near} sotto ${w.below}`;
	if (w.above !== undefined) return `prezzo${near} sopra ${w.above}`;
	return w.what === undefined ? "qualsiasi cambiamento della pagina" : `cambiamenti${near}`;
}

function state(w: Watch): string {
	if (w.disabledReason !== undefined) return `ferma: ${w.disabledReason}`;
	const last = w.lastCheckAt === undefined ? "mai controllata" : `ultimo controllo ${w.lastCheckAt}`;
	return `${last}${w.last?.price === undefined ? "" : `, prezzo ${w.last.price}`}${w.lastError === undefined ? "" : `, ultimo errore: ${w.lastError}`}`;
}

function describeNew(w: Watch, first: { price?: number; met?: boolean; excerpt: string }): string {
	const head = `Sentinella ${w.id} attiva su ${new URL(w.url).host}: ${condition(w)}, controllo ogni ${w.everyMinutes} minuti. Scrivo qui quando c'è qualcosa.`;
	if (first.price !== undefined) return `${head}\nPrezzo adesso: ${first.price}.${first.met ? " La condizione è già vera adesso: dillo alla persona." : ""}`;
	return first.excerpt === "" ? head : `${head}\n${untrustedPage(`Adesso: ${first.excerpt}`)}`;
}
