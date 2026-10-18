/**
 * Two clients made one card: what the person said of the first (other names, referenti, labels,
 * notes, ricontatti, contacts had) goes into the second's card, and the first's name stays as
 * another name, so the registers that write it find the card. When only the first has a card,
 * that card is kept (its id with it), named as the second. Two different partite IVA, or two
 * different codici fiscali, are two clients: refused. Invoices, quotes and hours never change.
 */
import type { Client } from "../client-sums.ts";
import type { ClientState } from "../client-store.ts";
import { CLIENT_LIMITS, type ClientCard, ClientError, cardCf, goodVat } from "../clients.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import { clash } from "./client-input.ts";

/** Why `a` cannot be merged into `b`, or undefined. */
export function mergeRefusal(a: Client, b: Client): "vat" | "cf" | "same" | undefined {
	if (a.key === b.key) return "same";
	if (a.vat !== undefined && b.vat !== undefined && a.vat !== b.vat) return "vat";
	if (a.cf !== undefined && b.cf !== undefined && a.cf !== b.cf) return "cf";
	return undefined;
}

/**
 * The state with `a` merged into `b`, as saved now. `fresh` makes a card for a client without one.
 * ClientError when the merged card would hold too much or clash with another card.
 */
export function merged(state: ClientState, a: Client, b: Client, fresh: (state: ClientState, name: string, client: Client) => ClientCard, by: Marker): ClientState {
	const src = a.card === undefined ? undefined : state.cards.find((c) => c.id === a.card?.id);
	const dst = b.card === undefined ? undefined : state.cards.find((c) => c.id === b.card?.id);
	let next = state;
	let base: ClientCard;
	const required: string[] = [];
	if (dst !== undefined) {
		base = dst;
		required.push(a.name, ...(src === undefined ? [] : [src.name, ...src.aliases]));
	} else if (src !== undefined) {
		// Only the first has a card: it is kept, with its id, named as the second.
		base = { ...src, name: b.name, aliases: [] };
		required.push(src.name, ...src.aliases);
	} else {
		base = fresh(state, b.name, b);
		next = { ...state, nextCard: state.nextCard + 1, cards: [...state.cards, base] };
		required.push(a.name);
	}
	const aliases = [...base.aliases];
	const has = (n: string) => [base.name, ...aliases].some((x) => spellingKey(x) === spellingKey(n));
	for (const n of required) if (spellingKey(n) !== "" && !has(n)) aliases.push(n);
	if (aliases.length > CLIENT_LIMITS.aliases) throw new ClientError(`la scheda unita avrebbe più di ${CLIENT_LIMITS.aliases} altri nomi: togline qualcuno prima`);
	// The registers' other spellings of a client without a card, while there is room: they find the card by them.
	for (const n of [...(a.card === undefined ? a.names : []), ...(b.card === undefined ? b.names : [])]) if (aliases.length < CLIENT_LIMITS.aliases && spellingKey(n) !== "" && !has(n)) aliases.push(n);
	const other = dst !== undefined ? src : undefined;
	const contacts = [...base.contacts];
	for (const c of other?.contacts ?? []) if (!contacts.some((x) => JSON.stringify(x) === JSON.stringify(c))) contacts.push(c);
	if (contacts.length > CLIENT_LIMITS.contacts) throw new ClientError(`la scheda unita avrebbe più di ${CLIENT_LIMITS.contacts} referenti: togline qualcuno prima`);
	const tags = [...new Set([...base.tags, ...(other?.tags ?? [])])].slice(0, CLIENT_LIMITS.tags);
	const notes = [...base.notes, ...(other?.notes ?? [])].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at)).slice(-CLIENT_LIMITS.notes);
	const followUps = [...base.followUps, ...(other?.followUps ?? [])];
	const open = followUps.filter((f) => f.done === undefined);
	if (open.length > CLIENT_LIMITS.followUps) throw new ClientError("la scheda unita avrebbe troppi ricontatti aperti");
	const room = CLIENT_LIMITS.followUps - open.length;
	const closed = followUps.filter((f) => f.done !== undefined);
	const kept = room > 0 ? closed.slice(-room) : [];
	const log = [...(base.log ?? []), ...(other?.log ?? [])].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at)).slice(-CLIENT_LIMITS.log);
	const vat = base.vat ?? other?.vat ?? [b.vat, a.vat].find((v) => v !== undefined && goodVat(v));
	const cf = base.cf ?? other?.cf ?? [b.cf, a.cf].find((v) => v !== undefined && "cf" in cardCf(v));
	const address = base.address ?? other?.address;
	const card: ClientCard = {
		...base,
		aliases,
		contacts,
		tags,
		notes,
		followUps: [...open, ...kept].sort((x, y) => x.id.localeCompare(y.id)),
		...(log.length === 0 ? {} : { log }),
		...(vat === undefined ? {} : { vat }),
		...(cf === undefined ? {} : { cf }),
		...(address === undefined ? {} : { address }),
		edited: by,
	};
	const rest = next.cards.filter((c) => c.id !== src?.id && c.id !== dst?.id && c.id !== base.id);
	const problem = clash(card, rest);
	if (problem !== undefined) throw new ClientError(problem);
	return { ...next, cards: [...rest, card] };
}
