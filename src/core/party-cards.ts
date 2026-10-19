/**
 * What the clients' and the suppliers' cards share: a field set or cleared, whether a card clashes
 * with another (a name, a partita IVA, a codice fiscale), why two parties cannot be one, and the
 * merge of two into one card (other names, referenti, notes, tax ids). Each side adds its own
 * fields to a merge (the clients' labels and ricontatti, the suppliers' IBAN dictated).
 */
import type { ClientContact, ClientNote } from "./clients.ts";
import { goodVat, cardCf } from "./clients.ts";
import type { Marker } from "./marker.ts";
import { spellingKey } from "./name-keys.ts";

/** The fields a merge works on, common to both cards. */
export type MergeCard = Marker & {
	readonly id: string;
	readonly name: string;
	readonly vat?: string;
	readonly cf?: string;
	readonly aliases: readonly string[];
	readonly contacts: readonly ClientContact[];
	readonly notes: readonly ClientNote[];
	readonly edited?: Marker;
};

/** A party as a merge sees it: its key, its card, its names and tax ids from the registers. */
export type MergeParty<C> = { readonly key: string; readonly card?: C; readonly name: string; readonly names: readonly string[]; readonly vat?: string; readonly cf?: string };

/** `obj` with `key` set to `value`, or without it for null. */
export function withOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | null): T {
	const { [key]: _gone, ...rest } = obj;
	return (value === null ? rest : { ...rest, [key]: value }) as T;
}

/** Every name a card answers to (a client's or a supplier's), compared the timesheet's way (legal form included). */
export function cardNameKeys(card: { readonly name: string; readonly aliases: readonly string[] }): string[] {
	return [card.name, ...card.aliases].map(spellingKey).filter((k) => k !== "");
}

/** Why `card` cannot sit with `others`: a name, a partita IVA or a codice fiscale another card has. `word`: «cliente», «fornitore». */
export function cardClash(card: MergeCard, others: readonly MergeCard[], word: string): string | undefined {
	const keys = new Set(cardNameKeys(card));
	for (const o of others) {
		if (o.id === card.id) continue;
		if (cardNameKeys(o).some((k) => keys.has(k))) return `un nome di questa scheda è già della scheda ${o.id}: se sono lo stesso ${word}, uniscile`;
		if (card.vat !== undefined && o.vat === card.vat) return `la stessa partita IVA è già nella scheda ${o.id}: se sono lo stesso ${word}, uniscile`;
		if (card.cf !== undefined && o.cf === card.cf) return `lo stesso codice fiscale è già nella scheda ${o.id}: se sono lo stesso ${word}, uniscile`;
	}
	return undefined;
}

/** Why `a` cannot be merged into `b`, or undefined: the same party, two partite IVA, two codici fiscali. */
export function mergeRefusal(a: Pick<MergeParty<unknown>, "key" | "vat" | "cf">, b: Pick<MergeParty<unknown>, "key" | "vat" | "cf">): "vat" | "cf" | "same" | undefined {
	if (a.key === b.key) return "same";
	if (a.vat !== undefined && b.vat !== undefined && a.vat !== b.vat) return "vat";
	if (a.cf !== undefined && b.cf !== undefined && a.cf !== b.cf) return "cf";
	return undefined;
}

export type MergeOptions<C extends MergeCard, S extends { readonly nextCard: number; readonly cards: readonly C[] }> = {
	/** A card for a party without one. */
	readonly fresh: (state: S, name: string, party: MergeParty<C>) => C;
	readonly by: Marker;
	readonly limits: { readonly aliases: number; readonly contacts: number; readonly notes: number };
	/** «cliente», «fornitore». */
	readonly word: string;
	readonly fail: (message: string) => Error;
	/** The side's own fields of the merged card, from the card kept (`base`) and the other one. */
	readonly extras?: (base: C, other: C | undefined) => Partial<C>;
};

/**
 * The state with `a` merged into `b`, as saved now: what the person said of the first (other
 * names, referenti, notes) goes into the second's card, and the first's name stays as another
 * name, so the registers that write it find the card. When only the first has a card, that card
 * is kept (its id with it), named as the second. `fail` when the merged card would hold too much
 * or clash with another card.
 */
export function mergeCards<C extends MergeCard, S extends { readonly nextCard: number; readonly cards: readonly C[] }>(state: S, a: MergeParty<C>, b: MergeParty<C>, o: MergeOptions<C, S>): S {
	const src = a.card === undefined ? undefined : state.cards.find((c) => c.id === a.card?.id);
	const dst = b.card === undefined ? undefined : state.cards.find((c) => c.id === b.card?.id);
	let next = state;
	let base: C;
	const required: string[] = [];
	if (dst !== undefined) {
		base = dst;
		required.push(a.name, ...(src === undefined ? [] : [src.name, ...src.aliases]));
	} else if (src !== undefined) {
		// Only the first has a card: it is kept, with its id, named as the second.
		base = { ...src, name: b.name, aliases: [] };
		required.push(src.name, ...src.aliases);
	} else {
		base = o.fresh(state, b.name, b);
		next = { ...state, nextCard: state.nextCard + 1, cards: [...state.cards, base] };
		required.push(a.name);
	}
	const aliases = [...base.aliases];
	const has = (n: string) => [base.name, ...aliases].some((x) => spellingKey(x) === spellingKey(n));
	for (const n of required) if (spellingKey(n) !== "" && !has(n)) aliases.push(n);
	if (aliases.length > o.limits.aliases) throw o.fail(`la scheda unita avrebbe più di ${o.limits.aliases} altri nomi: togline qualcuno prima`);
	// The registers' other spellings of a party without a card, while there is room: they find the card by them.
	for (const n of [...(a.card === undefined ? a.names : []), ...(b.card === undefined ? b.names : [])]) if (aliases.length < o.limits.aliases && spellingKey(n) !== "" && !has(n)) aliases.push(n);
	const other = dst !== undefined ? src : undefined;
	const contacts = [...base.contacts];
	for (const c of other?.contacts ?? []) if (!contacts.some((x) => JSON.stringify(x) === JSON.stringify(c))) contacts.push(c);
	if (contacts.length > o.limits.contacts) throw o.fail(`la scheda unita avrebbe più di ${o.limits.contacts} referenti: togline qualcuno prima`);
	const notes = [...base.notes, ...(other?.notes ?? [])].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at)).slice(-o.limits.notes);
	const vat = base.vat ?? other?.vat ?? [b.vat, a.vat].find((v) => v !== undefined && goodVat(v));
	const cf = base.cf ?? other?.cf ?? [b.cf, a.cf].find((v) => v !== undefined && "cf" in cardCf(v));
	const card = {
		...base,
		aliases,
		contacts,
		...(o.extras === undefined ? {} : o.extras(base, other)),
		notes,
		...(vat === undefined ? {} : { vat }),
		...(cf === undefined ? {} : { cf }),
		edited: o.by,
	} as C;
	const rest = next.cards.filter((c) => c.id !== src?.id && c.id !== dst?.id && c.id !== base.id);
	const problem = cardClash(card, rest, o.word);
	if (problem !== undefined) throw o.fail(problem);
	return { ...next, cards: [...rest, card] };
}
