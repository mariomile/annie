/**
 * I fornitori: one card per supplier with only what the person said (how they write the name,
 * the referenti, dated notes, other names from a merge, and an IBAN or a partita IVA they
 * dictated). Everything else Annie knows about a supplier (invoices received and paid in the
 * scadenzario, expenses, renewals, the bank's confirmed payments) stays in its own register and is
 * read, never copied here: a supplier seen in those registers is a supplier even without a card.
 * An IBAN read on an invoice is never written on a card. Kept per instance in `suppliers.json`
 * (supplier-store.ts); the reading of the registers in supplier-sums.ts.
 */
import { type ClientContact, type ClientNote, cardCf, goodVat, validContact, validNote } from "./clients.ts";
import { validIban } from "./iban.ts";
import type { Marker } from "./marker.ts";
import { spellingKey } from "./name-keys.ts";
import { isMarker, isText } from "./stored-fields.ts";

export class SupplierError extends Error {
	override readonly name = "SupplierError";
}

export const SUPPLIER_LIMITS = {
	cards: 5000,
	notes: 50,
	noteChars: 1000,
	contacts: 10,
	aliases: 10,
	name: 120,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 500,
	fileBytes: 16 * 1024 * 1024,
} as const;

/** An IBAN that changed is said in the brief when the supplier has an open invoice due within these days. */
export const IBAN_BRIEF_DAYS = 7;

/** What the person is told when the IBAN changed: never paid before a call. */
export const IBAN_WARNING = "l'IBAN dell'ultima fattura è diverso da quello di prima, verifica con il fornitore per telefono prima di pagare";

/** The ops that only read: they run in the brief. */
const SUPPLIER_READ_OPS = ["summary", "top", "late"] as const;

export function supplierCallReads(args: Record<string, unknown>): boolean {
	return SUPPLIER_READ_OPS.some((o) => o === args.op);
}

/**
 * What another agente may ask: totals, counts and shares, never a supplier's name, IBAN or
 * referenti. The ranking and the overall summary (the tool cuts them to numbers); never one
 * supplier's card, the late payments by name, a write nor an export.
 */
export function supplierAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "top" || args.op === "summary";
}

/** A referente and a note are kept as the clients keep theirs. */
export type SupplierContact = ClientContact;
export type SupplierNote = ClientNote;

export type SupplierCard = Marker & {
	/** «FO-0001», never used again. */
	readonly id: string;
	/** The name as the person writes it. */
	readonly name: string;
	/** The partita IVA the card answers to: the one the registers gave it when made, or one dictated. */
	readonly vat?: string;
	readonly cf?: string;
	/** An IBAN the person dictated: never changed by a document. */
	readonly iban?: string;
	readonly aliases: readonly string[];
	readonly contacts: readonly SupplierContact[];
	readonly notes: readonly SupplierNote[];
	readonly edited?: Marker;
};

export const supplierId = (n: number) => `FO-${String(n).padStart(4, "0")}`;
export const SUPPLIER_ID = /^FO-(\d{4,6})$/;
/** A card's id as a person may say it, for client-find.ts. */
export const SUPPLIER_ID_SAID = /^FO-\d{4,6}$/;

/** Every name a card answers to, compared the timesheet's way (legal form included). */
export function supplierKeys(card: Pick<SupplierCard, "name" | "aliases">): string[] {
	return [card.name, ...card.aliases].map(spellingKey).filter((k) => k !== "");
}

const plainText = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);

/** A card as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validSupplierCard(v: unknown): v is SupplierCard {
	if (!isMarker(v)) return false;
	const c = v as SupplierCard;
	for (const key of Object.keys(c)) if (!["id", "name", "vat", "cf", "iban", "aliases", "contacts", "notes", "edited", "by", "at"].includes(key)) return false;
	if (typeof c.id !== "string" || !SUPPLIER_ID.test(c.id) || !plainText(c.name, SUPPLIER_LIMITS.name) || spellingKey(c.name) === "") return false;
	if (c.vat !== undefined && (typeof c.vat !== "string" || !goodVat(c.vat))) return false;
	if (c.cf !== undefined && (typeof c.cf !== "string" || !("cf" in cardCf(c.cf)))) return false;
	if (c.iban !== undefined && (typeof c.iban !== "string" || validIban(c.iban) !== c.iban)) return false;
	if (!Array.isArray(c.aliases) || c.aliases.length > SUPPLIER_LIMITS.aliases || !c.aliases.every((a) => plainText(a, SUPPLIER_LIMITS.name))) return false;
	if (!Array.isArray(c.contacts) || c.contacts.length > SUPPLIER_LIMITS.contacts || !c.contacts.every(validContact)) return false;
	if (!Array.isArray(c.notes) || c.notes.length > SUPPLIER_LIMITS.notes || !c.notes.every((n) => validNote(n) && isText(n.text, SUPPLIER_LIMITS.noteChars))) return false;
	return c.edited === undefined || isMarker(c.edited);
}

export const validSupplierCall = (v: unknown): boolean => isText(v, 200);
