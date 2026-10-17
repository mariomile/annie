import type { AnnieTool } from "../engine.ts";
import { LIST_LIMITS, type List, ListError, type ListItem, type ListStore, ordered, resolveItems } from "../lists.ts";
import { SHARED } from "../memory.ts";

type Thread = { readonly channel: string; readonly threadId: string };

export type ListAction = "added" | "checked" | "unchecked" | "removed" | "cleared" | "deleted";

/**
 * Tools for the liste (ADR 0036): add to a list, show it, tick items off, remove them. A person's
 * own lists in a conversation with them alone; the shared ones also in a group.
 */
export function createListTools(options: {
	readonly store: ListStore;
	/** The person a private conversation is with; undefined in a group or unknown thread. */
	readonly whoIs: (thread: Thread) => string | undefined;
	/** What changed, for the audit: which list, what kind of change, how many items, never their text. */
	readonly record?: (event: { type: "list.changed"; listId: string; action: ListAction; count: number }) => Promise<void>;
}): AnnieTool[] {
	const { store } = options;
	const subject = (thread: Thread | undefined) => (thread === undefined ? undefined : options.whoIs(thread));
	const record = async (list: List, action: ListAction, count: number) => {
		if (count > 0) await options.record?.({ type: "list.changed", listId: list.id, action, count });
	};
	const missing = (who: string | undefined, name: string) => {
		const names = store.visible(who).map((l) => l.name);
		return `Errore: non c'è una lista «${name}»${names.length === 0 ? "" : `; ci sono: ${names.join(", ")}`}.`;
	};
	const listParam = { type: "string", minLength: 1, maxLength: LIST_LIMITS.name, description: "The list's name, e.g. spesa, cose da fare, regali" };
	const itemsParam = (what: string) => ({ type: "array", minItems: 1, maxItems: LIST_LIMITS.perCall, items: { type: "string", minLength: 1, maxLength: LIST_LIMITS.text }, description: what });
	return [
		{
			name: "list_add",
			description:
				"Add items to a list (the shopping, things to do, gifts, books, anything the person wants to keep a list of), creating the list if there is none with that name. " +
				"One item per entry, as the person said it (latte, 2 kg di farina, chiamare il commercialista). An item already on the list is not added twice. " +
				"Lists are the person's own; shared: true makes a new list everyone who talks to you can see and change (the family's shopping, a team's to-dos): only when the person asks for it. In a group chat lists are always shared. " +
				"For a reminder at a time, use schedule_create as well.",
			parameters: {
				type: "object",
				properties: { list: listParam, items: itemsParam("The items to add"), shared: { type: "boolean", description: "Create the list shared with everyone who talks to you (default false)" } },
				required: ["list", "items"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const who = subject(ctx.thread);
				return ctx.step("add", async () => {
					try {
						const r = store.add({ subject: who, name: String(args.list), items: (args.items as unknown[]).map(String), shared: args.shared === true });
						await record(r.list, "added", r.added.length + r.back.length);
						const what = [
							r.added.length === 0 ? "" : `Aggiunto: ${r.added.join(", ")}.`,
							r.back.length === 0 ? "" : `Rimesso da fare: ${r.back.join(", ")}.`,
							r.already.length === 0 ? "" : `Già in lista: ${r.already.join(", ")}.`,
						].filter((t) => t !== "");
						return r.created ? `Creata la lista ${title(r.list)}. ${[...what, remaining(r.list)].join(" ")}` : said(r.list, what);
					} catch (error) {
						if (error instanceof ListError) return `Errore: ${error.message}.`;
						throw error;
					}
				});
			},
		},
		{
			name: "list_show",
			description:
				"Show a list with its items numbered (the ones to do first, then the ones done lately), or, without a name, which lists there are. " +
				"Use it when the person asks what is on a list, or before ticking or removing items you are not sure of.",
			parameters: { type: "object", properties: { list: { ...listParam, description: "The list to show; leave out to see all the lists" } }, additionalProperties: false },
			replaySafe: true,
			async execute(args, ctx) {
				const who = subject(ctx.thread);
				if (typeof args.list !== "string" || args.list.trim() === "") {
					const lists = store.visible(who);
					if (lists.length === 0) return "Non ci sono ancora liste.";
					return `Liste:\n${lists.map((l) => `- ${title(l)}: ${open(l)}${doneCount(l)}`).join("\n")}`;
				}
				const list = store.find(who, args.list);
				if (list === undefined) return missing(who, args.list);
				return shown(list);
			},
		},
		{
			name: "list_check",
			description:
				"Tick items off a list when they are done or bought, by their number from list_show or by their words (latte). undo: true puts them back to do. " +
				"When words fit more than one item, nothing is ticked and the answer says which: ask or use the number.",
			parameters: {
				type: "object",
				properties: { list: listParam, items: itemsParam("The items: numbers from list_show, or their words"), undo: { type: "boolean", description: "Put the items back to do (default false)" } },
				required: ["list", "items"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const who = subject(ctx.thread);
				const name = String(args.list);
				const done = args.undo !== true;
				return ctx.step("check", async () => {
					const outcome = store.update(who, name, (list) => {
						const r = resolveItems(list, (args.items as unknown[]).map(String), (i) => i.done !== done);
						if (r.ambiguous.length > 0) return { list, result: { list, text: ambiguity(r.ambiguous), count: 0 } };
						const now = new Date().toISOString();
						const changing = new Set(r.found.filter((i) => i.done !== done).map((i) => i.id));
						const items = list.items.map((i): ListItem => (!changing.has(i.id) ? i : done ? { ...i, done: true, doneAt: now } : { id: i.id, text: i.text, done: false, addedAt: i.addedAt }));
						const next: List = { ...list, items };
						const names = r.found.map((i) => i.text);
						const text = said(next, [names.length === 0 ? "" : `${done ? "Spuntato" : "Rimesso da fare"}: ${names.join(", ")}.`, notFound(r.unknown)]);
						return { list: next, result: { list: next, text, count: changing.size } };
					});
					if (outcome === undefined) return missing(who, name);
					await record(outcome.list, done ? "checked" : "unchecked", outcome.count);
					return outcome.text;
				});
			},
		},
		{
			name: "list_remove",
			description:
				"Remove items from a list (by number or words), or all the done ones (done: true), or the whole list (whole: true). Only when the person asks: to mark an item done use list_check.",
			parameters: {
				type: "object",
				properties: {
					list: listParam,
					items: itemsParam("The items to remove: numbers from list_show, or their words"),
					done: { type: "boolean", description: "Remove all the items already done" },
					whole: { type: "boolean", description: "Delete the whole list" },
				},
				required: ["list"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const who = subject(ctx.thread);
				const name = String(args.list);
				const refs = Array.isArray(args.items) ? args.items.map(String) : [];
				const ways = [refs.length > 0, args.done === true, args.whole === true].filter(Boolean).length;
				if (ways !== 1) return "Errore: indica le voci da togliere, oppure done: true per togliere quelle fatte, oppure whole: true per cancellare la lista (una cosa alla volta).";
				return ctx.step("remove", async () => {
					const outcome = store.update(who, name, (list): { list: List | undefined; result: { list: List; text: string; action: ListAction; count: number } } => {
						if (args.whole === true) return { list: undefined, result: { list, text: `Cancellata la lista ${title(list)}.`, action: "deleted", count: list.items.length } };
						if (args.done === true) {
							const next = { ...list, items: list.items.filter((i) => !i.done) };
							const count = list.items.length - next.items.length;
							return { list: next, result: { list: next, text: said(next, [count === 0 ? "Non c'erano voci fatte." : count === 1 ? "Tolta una voce fatta." : `Tolte ${count} voci fatte.`]), action: "cleared", count } };
						}
						const r = resolveItems(list, refs);
						if (r.ambiguous.length > 0) return { list, result: { list, text: ambiguity(r.ambiguous), action: "removed", count: 0 } };
						const gone = new Set(r.found.map((i) => i.id));
						const next = { ...list, items: list.items.filter((i) => !gone.has(i.id)) };
						const text = said(next, [r.found.length === 0 ? "" : `Tolto: ${r.found.map((i) => i.text).join(", ")}.`, notFound(r.unknown)]);
						return { list: next, result: { list: next, text, action: "removed", count: gone.size } };
					});
					if (outcome === undefined) return missing(who, name);
					await record(outcome.list, outcome.action, outcome.count);
					return outcome.text;
				});
			},
		},
	];
}

/** «Spesa (condivisa)». */
function title(list: List): string {
	return list.owner === SHARED ? `«${list.name}» (condivisa)` : `«${list.name}»`;
}

/** «Lista «Spesa»: Spuntato: latte. Restano 2 voci da fare.» */
function said(list: List, parts: readonly string[]): string {
	return `Lista ${title(list)}: ${[...parts.filter((p) => p !== ""), remaining(list)].join(" ")}`;
}

/** «Restano 3 voci da fare.» */
function remaining(list: List): string {
	const n = list.items.filter((i) => !i.done).length;
	return n === 0 ? "Non resta niente da fare." : n === 1 ? "Resta una voce da fare." : `Restano ${n} voci da fare.`;
}

/** «3 voci da fare», «niente da fare». */
function open(list: List): string {
	const n = list.items.filter((i) => !i.done).length;
	return n === 0 ? "niente da fare" : n === 1 ? "una voce da fare" : `${n} voci da fare`;
}

function doneCount(list: List): string {
	const n = list.items.filter((i) => i.done).length;
	return n === 0 ? "" : n === 1 ? ", una fatta" : `, ${n} fatte`;
}

/** The list numbered as list_check and list_remove take the numbers. */
function shown(list: List): string {
	const items = ordered(list);
	if (items.length === 0) return `Lista ${title(list)}: è vuota.`;
	const lines = items.map((i, n) => `${n + 1}. ${i.text}${i.done ? " (fatto)" : ""}`);
	return `Lista ${title(list)}, ${open(list)}${doneCount(list)}:\n${lines.join("\n")}`;
}

function ambiguity(ambiguous: readonly { ref: string; candidates: readonly ListItem[] }[]): string {
	return `Errore: non ho cambiato niente, perché ${ambiguous.map((a) => `«${a.ref}» può essere ${a.candidates.map((c) => `«${c.text}»`).join(" o ")}`).join("; ")}. Chiedi quale, o usa il numero di list_show.`;
}

function notFound(unknown: readonly string[]): string {
	return unknown.length === 0 ? "" : `Non trovo: ${unknown.map((u) => `«${u}»`).join(", ")}.`;
}
