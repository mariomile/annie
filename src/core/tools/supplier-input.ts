/**
 * What the person says to set on a supplier's card, read and applied: one referente (the clients'
 * rule, client-input.ts), a referente taken off, and an IBAN, a partita IVA or a codice fiscale
 * they dictated (checked; "" clears). Two suppliers made one card: notes, referenti and names of
 * the first go into the second's card; two different partite IVA, codici fiscali or IBAN
 * dictated are refused. Whether a card so changed would clash with another (a name, a partita IVA).
 */
import { cardCf, cardVat, goodVat } from "../clients.ts";
import { validIban } from "../iban.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import type { Supplier } from "../supplier-sums.ts";
import type { SupplierState } from "../supplier-store.ts";
import { SUPPLIER_LIMITS, type SupplierCard, SupplierError, supplierKeys } from "../suppliers.ts";
import { isProblem, type Problem } from "../text-input.ts";
import { type ContactEdit, readContact, withContact } from "./client-input.ts";
import { line } from "./field-input.ts";

/** The changes contact_set reads, each undefined when not said; null clears. */
export type SupplierEdits = {
	contact?: ContactEdit;
	removeContact?: string;
	iban?: string | null;
	vat?: string | null;
	cf?: string | null;
};

export const SUPPLIER_EDIT_FIELDS = ["contact", "remove_contact", "iban", "vat", "cf"] as const;

export function readSupplierEdits(args: Record<string, unknown>): SupplierEdits | Problem {
	const e: SupplierEdits = {};
	if (args.contact !== undefined) {
		const c = readContact(args.contact);
		if (isProblem(c)) return c;
		e.contact = c;
	}
	if (args.remove_contact !== undefined) {
		const n = line(args.remove_contact, SUPPLIER_LIMITS.name, "il referente da togliere");
		if (isProblem(n)) return n;
		e.removeContact = n;
	}
	if (args.iban !== undefined) {
		if (args.iban === "" || args.iban === null) e.iban = null;
		else {
			const iban = typeof args.iban === "string" ? validIban(args.iban) : undefined;
			if (iban === undefined) return { problem: "l'IBAN non passa il controllo delle cifre: fattelo ripetere" };
			e.iban = iban;
		}
	}
	if (args.vat !== undefined) {
		if (args.vat === "" || args.vat === null) e.vat = null;
		else {
			const v = typeof args.vat === "string" ? cardVat(args.vat) : { problem: "la partita IVA va scritta come testo" };
			if ("problem" in v) return v;
			e.vat = v.vat;
		}
	}
	if (args.cf !== undefined) {
		if (args.cf === "" || args.cf === null) e.cf = null;
		else {
			const v = typeof args.cf === "string" ? cardCf(args.cf) : { problem: "il codice fiscale va scritto come testo" };
			if ("problem" in v) return v;
			e.cf = v.cf;
		}
	}
	if (Object.keys(e).length === 0) return { problem: "dimmi il referente (nome, ruolo, telefono, email), l'IBAN o la partita IVA da segnare" };
	return e;
}

function withField<K extends "vat" | "cf" | "iban">(card: SupplierCard, key: K, value: string | null): SupplierCard {
	const { [key]: _gone, ...rest } = card;
	return (value === null ? rest : { ...rest, [key]: value }) as SupplierCard;
}

/** The card with the edits applied (a new object), or why not. Uniqueness against the other cards is checked by the caller. */
export function supplierEdited(card: SupplierCard, e: SupplierEdits, by: Marker): SupplierCard | string {
	let c: SupplierCard = { ...card };
	if (e.contact !== undefined) {
		const contacts = withContact(c.contacts, e.contact, SUPPLIER_LIMITS.contacts);
		if (typeof contacts === "string") return contacts;
		c = { ...c, contacts };
	}
	if (e.removeContact !== undefined) {
		const key = spellingKey(e.removeContact);
		c = { ...c, contacts: c.contacts.filter((x) => x.name === undefined || spellingKey(x.name) !== key) };
	}
	if (e.iban !== undefined) c = withField(c, "iban", e.iban);
	if (e.vat !== undefined) c = withField(c, "vat", e.vat);
	if (e.cf !== undefined) c = withField(c, "cf", e.cf);
	return { ...c, edited: by };
}

/** Why `card` cannot sit with `others`: a name, a partita IVA or a codice fiscale another card has. */
export function supplierClash(card: SupplierCard, others: readonly SupplierCard[]): string | undefined {
	const keys = new Set(supplierKeys(card));
	for (const o of others) {
		if (o.id === card.id) continue;
		if (supplierKeys(o).some((k) => keys.has(k))) return `un nome di questa scheda è già della scheda ${o.id}: se sono lo stesso fornitore, uniscile`;
		if (card.vat !== undefined && o.vat === card.vat) return `la stessa partita IVA è già nella scheda ${o.id}: se sono lo stesso fornitore, uniscile`;
		if (card.cf !== undefined && o.cf === card.cf) return `lo stesso codice fiscale è già nella scheda ${o.id}: se sono lo stesso fornitore, uniscile`;
	}
	return undefined;
}

/** Why `a` cannot be merged into `b`, or undefined. */
export function supplierMergeRefusal(a: Supplier, b: Supplier): "same" | "vat" | "cf" | "iban" | undefined {
	if (a.key === b.key) return "same";
	if (a.vat !== undefined && b.vat !== undefined && a.vat !== b.vat) return "vat";
	if (a.cf !== undefined && b.cf !== undefined && a.cf !== b.cf) return "cf";
	if (a.card?.iban !== undefined && b.card?.iban !== undefined && a.card.iban !== b.card.iban) return "iban";
	return undefined;
}

/**
 * The state with `a` merged into `b`, as saved now. `fresh` makes a card for a supplier without
 * one. When only the first has a card, that card is kept (its id with it), named as the second.
 * SupplierError when the merged card would hold too much or clash with another card.
 */
export function mergedSuppliers(state: SupplierState, a: Supplier, b: Supplier, fresh: (state: SupplierState, name: string, supplier: Supplier) => SupplierCard, by: Marker): SupplierState {
	const src = a.card === undefined ? undefined : state.cards.find((c) => c.id === a.card?.id);
	const dst = b.card === undefined ? undefined : state.cards.find((c) => c.id === b.card?.id);
	let next = state;
	let base: SupplierCard;
	const required: string[] = [];
	if (dst !== undefined) {
		base = dst;
		required.push(a.name, ...(src === undefined ? [] : [src.name, ...src.aliases]));
	} else if (src !== undefined) {
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
	if (aliases.length > SUPPLIER_LIMITS.aliases) throw new SupplierError(`la scheda unita avrebbe più di ${SUPPLIER_LIMITS.aliases} altri nomi`);
	// The registers' other spellings of a supplier without a card, while there is room: they find the card by them.
	for (const n of [...(a.card === undefined ? a.names : []), ...(b.card === undefined ? b.names : [])]) if (aliases.length < SUPPLIER_LIMITS.aliases && spellingKey(n) !== "" && !has(n)) aliases.push(n);
	const other = dst !== undefined ? src : undefined;
	const contacts = [...base.contacts];
	for (const c of other?.contacts ?? []) if (!contacts.some((x) => JSON.stringify(x) === JSON.stringify(c))) contacts.push(c);
	if (contacts.length > SUPPLIER_LIMITS.contacts) throw new SupplierError(`la scheda unita avrebbe più di ${SUPPLIER_LIMITS.contacts} referenti: togline qualcuno prima`);
	const notes = [...base.notes, ...(other?.notes ?? [])].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at)).slice(-SUPPLIER_LIMITS.notes);
	const vat = base.vat ?? other?.vat ?? [b.vat, a.vat].find((v) => v !== undefined && goodVat(v));
	const cf = base.cf ?? other?.cf ?? [b.cf, a.cf].find((v) => v !== undefined && "cf" in cardCf(v));
	const iban = base.iban ?? other?.iban;
	const card: SupplierCard = {
		...base,
		aliases,
		contacts,
		notes,
		...(vat === undefined ? {} : { vat }),
		...(cf === undefined ? {} : { cf }),
		...(iban === undefined ? {} : { iban }),
		edited: by,
	};
	const rest = next.cards.filter((c) => c.id !== src?.id && c.id !== dst?.id && c.id !== base.id);
	const problem = supplierClash(card, rest);
	if (problem !== undefined) throw new SupplierError(problem);
	return { ...next, cards: [...rest, card] };
}
