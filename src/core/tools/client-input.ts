/**
 * What the person says to change on a client's card, read and applied: the name (the old spelling
 * kept as another name), partita IVA and codice fiscale (checked), the address, other names,
 * labels, one referente by name (a field cleared with ""), and whether the card so changed would
 * clash with another (a name or a partita IVA it has).
 */
import { CLIENT_LIMITS, type ClientCard, type ClientContact, cardCf, cardKeys, cardVat, channelOf, emailProblem, phoneProblem, tagOf } from "../clients.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import { line, strings } from "./field-input.ts";
import { isProblem, type Problem } from "./quote-input.ts";

/** The changes upsert reads, each undefined when not said; null clears. */
export type Edits = {
	newName?: string;
	vat?: string | null;
	cf?: string | null;
	address?: string | null;
	aliases?: string[];
	removeAliases?: string[];
	tags?: string[];
	removeTags?: string[];
	contact?: { readonly name?: string; readonly fields: Partial<Record<"role" | "phone" | "email" | "channel", string | null>> };
	removeContact?: string;
};

export const EDIT_FIELDS = ["new_name", "vat", "cf", "address", "aliases", "remove_aliases", "tags", "remove_tags", "contact", "remove_contact"] as const;

export function readEdits(args: Record<string, unknown>): Edits | Problem {
	const e: Edits = {};
	if (args.new_name !== undefined) {
		const n = line(args.new_name, CLIENT_LIMITS.name, "il nome");
		if (isProblem(n)) return n;
		if (spellingKey(n) === "") return { problem: "il nome deve avere almeno una lettera o una cifra" };
		e.newName = n;
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
	if (args.address !== undefined) {
		if (args.address === "" || args.address === null) e.address = null;
		else {
			const a = line(args.address, CLIENT_LIMITS.address, "l'indirizzo");
			if (isProblem(a)) return a;
			e.address = a;
		}
	}
	for (const [field, key, max] of [
		["aliases", "aliases", CLIENT_LIMITS.name],
		["remove_aliases", "removeAliases", CLIENT_LIMITS.name],
		["tags", "tags", CLIENT_LIMITS.tagChars],
		["remove_tags", "removeTags", CLIENT_LIMITS.tagChars],
	] as const) {
		const list = strings(args[field], max, field.includes("tag") ? "un'etichetta" : "un altro nome");
		if (isProblem(list)) return list;
		if (list !== undefined) e[key] = list;
	}
	if (args.contact !== undefined) {
		if (typeof args.contact !== "object" || args.contact === null || Array.isArray(args.contact)) return { problem: "il referente va dato con nome, ruolo, telefono, email o canale preferito" };
		const c = args.contact as Record<string, unknown>;
		for (const k of Object.keys(c)) if (!["name", "role", "phone", "email", "channel"].includes(k)) return { problem: "del referente tengo solo nome, ruolo, telefono, email e canale preferito" };
		let name: string | undefined;
		if (c.name !== undefined && c.name !== "") {
			const n = line(c.name, CLIENT_LIMITS.name, "il nome del referente");
			if (isProblem(n)) return n;
			name = n;
		}
		const fields: Partial<Record<"role" | "phone" | "email" | "channel", string | null>> = {};
		for (const k of ["role", "phone", "email", "channel"] as const) {
			const v = c[k];
			if (v === undefined) continue;
			if (v === "" || v === null) {
				fields[k] = null;
				continue;
			}
			const max = k === "role" ? CLIENT_LIMITS.role : k === "phone" ? CLIENT_LIMITS.phone : k === "email" ? CLIENT_LIMITS.email : 40;
			const l = line(v, max, k === "role" ? "il ruolo" : k === "phone" ? "il telefono" : k === "email" ? "l'email" : "il canale");
			if (isProblem(l)) return l;
			if (k === "phone") {
				const p = phoneProblem(l);
				if (p !== undefined) return { problem: p };
			}
			if (k === "email") {
				const p = emailProblem(l);
				if (p !== undefined) return { problem: p };
			}
			if (k === "channel") {
				const ch = channelOf(l);
				if (ch === undefined) return { problem: "il canale preferito è telefono, WhatsApp, email, PEC, Telegram o di persona" };
				fields[k] = ch;
				continue;
			}
			fields[k] = l;
		}
		if (name === undefined && Object.keys(fields).length === 0) return { problem: "il referente va dato con nome, ruolo, telefono, email o canale preferito" };
		e.contact = { ...(name === undefined ? {} : { name }), fields };
	}
	if (args.remove_contact !== undefined) {
		const n = line(args.remove_contact, CLIENT_LIMITS.name, "il referente da togliere");
		if (isProblem(n)) return n;
		e.removeContact = n;
	}
	return e;
}

/** The card with the edits applied (a new object), or why not. Uniqueness against the other cards is checked by the caller. */
export function edited(card: ClientCard, e: Edits, by: Marker): ClientCard | string {
	let c: ClientCard = { ...card };
	if (e.newName !== undefined) {
		// The old spelling stays an other name, so the registers that write it still find the card.
		const aliases = spellingKey(card.name) === spellingKey(e.newName) ? card.aliases : [...card.aliases.filter((a) => spellingKey(a) !== spellingKey(e.newName as string)), card.name];
		c = { ...c, name: e.newName, aliases };
	}
	if (e.vat !== undefined) c = withOptional(c, "vat", e.vat);
	if (e.cf !== undefined) c = withOptional(c, "cf", e.cf);
	if (e.address !== undefined) c = withOptional(c, "address", e.address);
	if (e.aliases !== undefined) for (const a of e.aliases) if (!cardKeys(c).includes(spellingKey(a)) && spellingKey(a) !== "") c = { ...c, aliases: [...c.aliases, a] };
	if (e.removeAliases !== undefined) c = { ...c, aliases: c.aliases.filter((a) => !e.removeAliases?.some((r) => spellingKey(r) === spellingKey(a))) };
	if (c.aliases.length > CLIENT_LIMITS.aliases) return `una scheda tiene al più ${CLIENT_LIMITS.aliases} altri nomi`;
	if (e.tags !== undefined) for (const t of e.tags.map(tagOf)) if (!c.tags.includes(t)) c = { ...c, tags: [...c.tags, t] };
	if (e.removeTags !== undefined) c = { ...c, tags: c.tags.filter((t) => !e.removeTags?.some((r) => tagOf(r) === t)) };
	if (c.tags.length > CLIENT_LIMITS.tags) return `una scheda tiene al più ${CLIENT_LIMITS.tags} etichette`;
	if (e.contact !== undefined) {
		const { name, fields } = e.contact;
		const at = name !== undefined ? c.contacts.findIndex((x) => x.name !== undefined && spellingKey(x.name) === spellingKey(name)) : c.contacts.length === 1 ? 0 : c.contacts.findIndex((x) => x.name === undefined);
		const old: ClientContact = at >= 0 ? (c.contacts[at] as ClientContact) : {};
		const made: Record<string, string> = { ...old } as Record<string, string>;
		// A referente already named keeps the spelling written first.
		if (name !== undefined && made.name === undefined) made.name = name;
		for (const [k, v] of Object.entries(fields)) {
			if (v === null) delete made[k];
			else if (v !== undefined) made[k] = v;
		}
		const contact = made as ClientContact;
		if (contact.name === undefined && contact.phone === undefined && contact.email === undefined) return "un referente ha almeno un nome, un telefono o un'email";
		const contacts = at >= 0 ? c.contacts.map((x, i) => (i === at ? contact : x)) : [...c.contacts, contact];
		if (contacts.length > CLIENT_LIMITS.contacts) return `una scheda tiene al più ${CLIENT_LIMITS.contacts} referenti`;
		c = { ...c, contacts };
	}
	if (e.removeContact !== undefined) {
		const key = spellingKey(e.removeContact);
		c = { ...c, contacts: c.contacts.filter((x) => x.name === undefined || spellingKey(x.name) !== key) };
	}
	return { ...c, edited: by };
}

export function withOptional<K extends "vat" | "cf" | "address">(card: ClientCard, key: K, value: string | null): ClientCard {
	const { [key]: _gone, ...rest } = card;
	return (value === null ? rest : { ...rest, [key]: value }) as ClientCard;
}

/** Why `card` cannot sit with `others`: a name or a partita IVA another card has. */
export function clash(card: ClientCard, others: readonly ClientCard[]): string | undefined {
	const keys = new Set(cardKeys(card));
	for (const o of others) {
		if (o.id === card.id) continue;
		if (cardKeys(o).some((k) => keys.has(k))) return `un nome di questa scheda è già della scheda ${o.id}: se sono lo stesso cliente, uniscile`;
		if (card.vat !== undefined && o.vat === card.vat) return `la stessa partita IVA è già nella scheda ${o.id}: se sono lo stesso cliente, uniscile`;
	}
	return undefined;
}
