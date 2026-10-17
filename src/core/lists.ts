import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { findHits, fold, parseQuery } from "./file-search.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { SHARED } from "./memory.ts";

/**
 * The liste of an instance (ADR 0036): the shopping, the things to do, the gifts, the books to
 * read. A list is one person's (`owner` = "<channel>:<userId>") or shared by everyone who talks to
 * the instance (`owner` = "*"), like the memoria. A person sees their own lists and the shared
 * ones; a group chat only the shared ones.
 */
export type ListItem = { readonly id: string; readonly text: string; readonly done: boolean; readonly addedAt: string; readonly doneAt?: string };

export type List = { readonly id: string; readonly name: string; readonly owner: string; readonly items: readonly ListItem[]; readonly createdAt: string; readonly updatedAt: string };

export const LIST_LIMITS = {
	/** Lists one person, or the shared ones, may have. */
	lists: 30,
	/** Items on a list that are not done yet. */
	open: 200,
	/** Done items kept, the most recent: enough to undo, not a history. */
	done: 50,
	name: 60,
	text: 200,
	/** Items added, ticked or removed in one call. */
	perCall: 50,
} as const;

export class ListError extends Error {
	override readonly name = "ListError";
}

/** Open items first, in the order they were added, then the done ones, latest first: the numbers list_show gives. */
export function ordered(list: List): ListItem[] {
	const open = list.items.filter((i) => !i.done);
	const done = list.items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
	return [...open, ...done];
}

/** «la lista della », «lista per le »: words before a list's name that are not its name. */
const LIST_WORDS = /^(?:(?:la|le|una|la mia|le mie|mia) )?(?:lista|liste) (?:(?:per il|per la|per le|per i|per|della|delle|dello|degli|dei|del|di) )?(?=\S)/;

/** A list's name as the person would write it on top of it: «la lista della spesa» is «spesa». */
export function listName(name: string): string {
	const one = name.trim().replace(/\s+/g, " ");
	return one.slice(LIST_WORDS.exec(fold(one))?.[0].length ?? 0);
}

/** The same list however it is called: «Spesa», «la lista della spesa», «lista spesa». */
export function listKey(name: string): string {
	return fold(listName(name));
}

/** What an item is, for telling two apart: folded, one space. */
function itemKey(text: string): string {
	return fold(text).replace(/\s+/g, " ").trim();
}

export type Resolved = { readonly found: readonly ListItem[]; readonly unknown: readonly string[]; readonly ambiguous: readonly { readonly ref: string; readonly candidates: readonly ListItem[] }[] };

/**
 * The items the person means: a number as list_show gave it, or words. Words pick the item whose
 * text is the same, else the only one holding all of them («latte» is «latte di soia» when no
 * other has it); among `prefer` items first (the open ones when ticking).
 */
export function resolveItems(list: List, refs: readonly string[], prefer: (item: ListItem) => boolean = () => true): Resolved {
	const numbered = ordered(list);
	const found: ListItem[] = [];
	const unknown: string[] = [];
	const ambiguous: { ref: string; candidates: ListItem[] }[] = [];
	for (const ref of refs) {
		const trimmed = ref.trim();
		if (/^\d{1,3}$/.test(trimmed)) {
			const item = numbered[Number(trimmed) - 1];
			if (item === undefined) unknown.push(trimmed);
			else found.push(item);
			continue;
		}
		const key = itemKey(trimmed);
		const terms = parseQuery(trimmed);
		const same = list.items.filter((i) => itemKey(i.text) === key);
		const holding = terms.length === 0 ? [] : list.items.filter((i) => findHits(fold(i.text), terms).reduce((seen, h) => seen.add(h.term), new Set<number>()).size === terms.length);
		const pool = same.length > 0 ? same : holding;
		const preferred = pool.filter(prefer);
		const candidates = preferred.length > 0 ? preferred : pool;
		if (candidates.length === 1) found.push(candidates[0] as ListItem);
		else if (candidates.length === 0) unknown.push(trimmed);
		else ambiguous.push({ ref: trimmed, candidates });
	}
	return { found: [...new Set(found)], unknown, ambiguous };
}

/** The liste of one instance, in `lists.json`, changed under the shared file lock. */
export class ListStore {
	private readonly file: string;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "lists.json");
	}

	/** The lists `subject` sees (theirs, then the shared ones); only the shared ones when undefined (a group). */
	visible(subject: string | undefined): List[] {
		return seenBy(readJsonFile<List[]>(this.file, []), subject);
	}

	/** The list with this name that `subject` sees, their own before a shared one. */
	find(subject: string | undefined, name: string): List | undefined {
		return named(this.visible(subject), name);
	}

	/**
	 * Add items to a list `subject` sees, creating it when there is none with that name: theirs,
	 * or shared when `shared` (always shared from a group). An item already on the list and not
	 * done is not added twice; one done is put back.
	 */
	add(input: { subject: string | undefined; name: string; items: readonly string[]; shared: boolean }): { list: List; created: boolean; added: string[]; already: string[]; back: string[] } {
		const name = listName(input.name);
		if (listKey(name) === "") throw new ListError("Dai un nome alla lista");
		if (name.length > LIST_LIMITS.name) throw new ListError(`Il nome di una lista è di ${LIST_LIMITS.name} caratteri al più`);
		const texts = cleanItems(input.items);
		const owner = input.shared || input.subject === undefined ? SHARED : input.subject;
		const now = new Date().toISOString();
		let result: { list: List; created: boolean; added: string[]; already: string[]; back: string[] } | undefined;
		updateJsonFile<List[]>(this.file, [], (all) => {
			const existing = named(seenBy(all, input.subject), name);
			if (existing === undefined && all.filter((l) => l.owner === owner).length >= LIST_LIMITS.lists) throw new ListError(`Al più ${LIST_LIMITS.lists} liste: cancellane qualcuna`);
			const list: List = existing ?? { id: randomBytes(5).toString("hex"), name, owner, items: [], createdAt: now, updatedAt: now };
			const items = [...list.items];
			const added: string[] = [];
			const already: string[] = [];
			const back: string[] = [];
			for (const text of texts) {
				const at = items.findIndex((i) => itemKey(i.text) === itemKey(text));
				const same = items[at];
				if (same !== undefined && !same.done) already.push(same.text);
				else if (same !== undefined) {
					items.splice(at, 1);
					items.push({ id: same.id, text: same.text, done: false, addedAt: now });
					back.push(same.text);
				} else {
					items.push({ id: randomBytes(4).toString("hex"), text, done: false, addedAt: now });
					added.push(text);
				}
			}
			if (items.filter((i) => !i.done).length > LIST_LIMITS.open) throw new ListError(`Una lista tiene ${LIST_LIMITS.open} voci da fare al più: spunta o togli quelle vecchie`);
			const next: List = { ...list, items, updatedAt: now };
			result = { list: next, created: existing === undefined, added, already, back };
			return existing === undefined ? [...all, next] : all.map((l) => (l.id === list.id ? next : l));
		});
		return result as NonNullable<typeof result>;
	}

	/**
	 * Change a list `subject` sees with `change`, which gets the list and returns it changed (or
	 * throws ListError); done items beyond the limit, the oldest, go. Undefined when there is no such list.
	 */
	update<R>(subject: string | undefined, name: string, change: (list: List) => { list: List | undefined; result: R }): R | undefined {
		let result: R | undefined;
		updateJsonFile<List[]>(this.file, [], (all) => {
			const list = named(seenBy(all, subject), name);
			if (list === undefined) return all;
			const changed = change(list);
			result = changed.result;
			if (changed.list === undefined) return all.filter((l) => l.id !== list.id);
			return all.map((l) => (l.id === list.id ? prune({ ...(changed.list as List), updatedAt: new Date().toISOString() }) : l));
		});
		return result;
	}
}

function seenBy(all: readonly List[], subject: string | undefined): List[] {
	return [...all.filter((l) => subject !== undefined && l.owner === subject), ...all.filter((l) => l.owner === SHARED)];
}

function named(lists: readonly List[], name: string): List | undefined {
	const key = listKey(name);
	return lists.find((l) => listKey(l.name) === key);
}

/** The oldest done items beyond the limit go. */
function prune(list: List): List {
	const done = list.items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
	const gone = new Set(done.slice(LIST_LIMITS.done).map((i) => i.id));
	return gone.size === 0 ? list : { ...list, items: list.items.filter((i) => !gone.has(i.id)) };
}

/** Items as given, trimmed and on one line, without empty ones and repeats; too many or too long is an error. */
function cleanItems(items: readonly string[]): string[] {
	const texts = items.map((t) => t.trim().replace(/\s+/g, " ")).filter((t) => t !== "");
	if (texts.length === 0) throw new ListError("Non c'è niente da aggiungere");
	if (texts.length > LIST_LIMITS.perCall) throw new ListError(`Al più ${LIST_LIMITS.perCall} voci alla volta`);
	const long = texts.find((t) => t.length > LIST_LIMITS.text);
	if (long !== undefined) throw new ListError(`Una voce è di ${LIST_LIMITS.text} caratteri al più`);
	const seen = new Set<string>();
	return texts.filter((t) => !seen.has(itemKey(t)) && seen.add(itemKey(t)));
}
