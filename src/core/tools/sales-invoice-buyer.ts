/**
 * The customer of an invoice: who the person names (a client's card of week 57 or a customer
 * already invoiced here, found with the clients' own rule in client-find.ts), and the data
 * FatturaPA needs of them, taken from what the person says now, then the card, the quote and the
 * last invoice to the same customer. A partita IVA or a codice fiscale, the address with CAP,
 * comune and provincia, and the codice destinatario or the PEC: what is missing is asked, never
 * invented. A private person without either gets «0000000»; a foreign customer «XXXXXXX».
 */
import { type Candidate, findNamed } from "../client-find.ts";
import { type ClientCard, cardKeys } from "../clients.ts";
import { spellingKey } from "../name-keys.ts";
import { latin1 } from "../plain-text.ts";
import type { QuoteCustomer } from "../quotes.ts";
import { FIELD_LIMITS, FOREIGN_CODE, NO_CHANNEL_CODE, PA_CODE } from "../sales-invoice-rules.ts";
import { type Address, type Buyer, buyerCf, buyerVat, foreignAddress, italianAddress, type SalesInvoice, vatCountry } from "../sales-invoices.ts";
import type { Problem } from "../text-input.ts";
import type { BuyerFields } from "./sales-invoice-input.ts";

/** A customer found: the name to write, the card, and the last invoice made for them here. */
export type Known = { readonly name: string; readonly card?: ClientCard; readonly previous?: Buyer };

/**
 * exact: the customer meant; close: some customers to ask among (labels with their tax ids);
 * conflict: the customer named has another tax id than the one given (`id`: theirs, in words);
 * none: a new customer.
 */
export type Found =
	| { readonly kind: "exact"; readonly known: Known; readonly form?: true }
	| { readonly kind: "close"; readonly candidates: readonly string[] }
	| { readonly kind: "conflict"; readonly known: Known; readonly id: string }
	| { readonly kind: "none" };

const idKey = (v: string | undefined) => v?.replace(/^IT/, "");

/** Whether a buyer is the one with these tax ids: one of them the same, none different. */
export function sameTaxIds(b: Pick<Buyer, "vat" | "cf">, vat: string | undefined, cf: string | undefined): boolean {
	if (vat === undefined && cf === undefined) return b.vat === undefined && b.cf === undefined;
	const conflict = (vat !== undefined && b.vat !== undefined && idKey(b.vat) !== idKey(vat)) || (cf !== undefined && b.cf !== undefined && b.cf !== cf);
	const same = (vat !== undefined && b.vat !== undefined && idKey(b.vat) === idKey(vat)) || (cf !== undefined && b.cf !== undefined && b.cf === cf);
	return same && !conflict;
}

/** The newest buyer first: drafts and invoices are kept in order. */
function lastBuyer(invoices: readonly SalesInvoice[], match: (b: Buyer) => boolean): Buyer | undefined {
	return [...invoices].reverse().find((i) => match(i.buyer))?.buyer;
}

/** The last buyer with the card's tax ids (never one with another); by name or card id only when the card has none. */
function previousOf(card: ClientCard, invoices: readonly SalesInvoice[]): Buyer | undefined {
	if (card.vat !== undefined || card.cf !== undefined) return lastBuyer(invoices, (b) => sameTaxIds(b, card.vat, card.cf));
	const keys = cardKeys(card);
	return lastBuyer(invoices, (b) => b.card === card.id || keys.includes(spellingKey(b.name)));
}

/** How much of what the person says is matched against the names. */
const MAX_SAID = 200;

/** The tax ids a customer found is known by. */
function idsOf(k: Known): string[] {
	return [k.card?.vat, k.card?.cf, k.previous?.vat, k.previous?.cf].map(idKey).filter((v): v is string => v !== undefined);
}

/** A customer as listed to ask: the name and the tax id that tells it apart. */
function label(k: Known): string {
	const vat = k.card?.vat ?? k.previous?.vat;
	const cf = k.card?.cf ?? k.previous?.cf;
	return vat !== undefined ? `${k.name}, P.IVA ${vat}` : cf !== undefined ? `${k.name}, C.F. ${cf}` : k.name;
}

/**
 * Who `said` names among the cards and the customers already invoiced here (one per tax id), with
 * the clients' rule. Several with the very name said are asked, unless the tax ids `given` tell
 * one, or exactly one of them is a card. A name close to some (or the same but for the legal
 * form) with tax ids none of them has is a new customer; the very name of one with a tax id that
 * conflicts with theirs is asked (`conflict`), never mixed.
 */
export function findBuyer(said: string, cards: readonly ClientCard[], invoices: readonly SalesInvoice[], given: Pick<BuyerFields, "vat" | "cf"> = {}): Found {
	const candidates: Candidate<Known>[] = cards.map((card) => {
		const previous = previousOf(card, invoices);
		return { item: { name: card.name, card, ...(previous === undefined ? {} : { previous }) }, names: [card.name, ...card.aliases], ...(card.vat === undefined ? {} : { vat: card.vat }), ...(card.cf === undefined ? {} : { cf: card.cf }), ids: [card.id] };
	});
	// The customers invoiced here without a card: the newest invoice to each, told apart by tax id (by name only without one).
	const cardNames = new Set(cards.flatMap((c) => [c.name, ...c.aliases].map(spellingKey)));
	const seen = new Set<string>();
	for (const inv of [...invoices].reverse()) {
		const b = inv.buyer;
		const key = b.vat ?? b.cf ?? `name:${spellingKey(b.name)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (b.vat === undefined && b.cf === undefined ? cardNames.has(spellingKey(b.name)) : cards.some((c) => (b.vat !== undefined && c.vat === b.vat) || (b.cf !== undefined && c.cf === b.cf))) continue;
		candidates.push({ item: { name: b.name, previous: b }, names: [b.name], ...(b.vat === undefined ? {} : { vat: b.vat }), ...(b.cf === undefined ? {} : { cf: b.cf }) });
	}
	const r = findNamed(candidates, said, MAX_SAID);
	const ids = [given.vat, given.cf].map(idKey).filter((v): v is string => v !== undefined);
	const matches = (k: Known) => idsOf(k).some((id) => ids.includes(id));
	const other = (ks: readonly Known[]) => ids.length > 0 && ks.every((k) => !matches(k));
	if (r.kind === "exact") {
		const k = r.item;
		if (r.form === true) return other([k]) ? { kind: "none" } : { kind: "exact", known: k, form: true };
		// The same customer by name or card id, but given another tax id than theirs: asked, never mixed.
		const vat = k.card?.vat ?? k.previous?.vat;
		const cf = k.card?.cf ?? k.previous?.cf;
		if (given.vat !== undefined && vat !== undefined && idKey(given.vat) !== idKey(vat)) return { kind: "conflict", known: k, id: `un'altra partita IVA (${vat})` };
		if (given.cf !== undefined && cf !== undefined && given.cf !== cf && !matches(k)) return { kind: "conflict", known: k, id: `un altro codice fiscale (${cf})` };
		return { kind: "exact", known: k };
	}
	if (r.kind === "close") {
		const meant = ids.length === 0 ? [] : r.candidates.filter(matches);
		if (meant.length === 1) return { kind: "exact", known: meant[0] as Known };
		if (r.same === true && ids.length === 0) {
			const withCard = r.candidates.filter((k) => k.card !== undefined);
			if (withCard.length === 1) return { kind: "exact", known: withCard[0] as Known };
		}
		if (r.same !== true && other(r.candidates)) return { kind: "none" };
		return { kind: "close", candidates: r.candidates.map(label) };
	}
	return r;
}

/** The data FatturaPA needs that is missing, in words, to ask. */
export type BuyerAsk = { readonly missing: readonly string[] };

const NO_IDS = "partita IVA e codice destinatario (7 caratteri) o PEC; per un privato il codice fiscale";

/**
 * The buyer from what the person says now, the card, the quote's customer and the last invoice to
 * them, in this order. `name`: as the card, quote or timesheet writes it, or as said.
 */
export function composeBuyer(name: string, sources: { readonly card?: ClientCard; readonly previous?: Buyer; readonly quote?: QuoteCustomer }, given: BuyerFields): Buyer | BuyerAsk | Problem {
	const { card, quote } = sources;
	if (latin1(name).length > FIELD_LIMITS.denominazione) return { problem: `il nome del cliente è troppo lungo per la fattura (al massimo ${FIELD_LIMITS.denominazione} caratteri): chiedi a chi ti scrive come scriverlo più corto e passalo come nome in fattura` };
	const fromQuote = quoteIds(quote);
	const vat = given.vat ?? card?.vat ?? fromQuote.vat ?? sources.previous?.vat;
	const cf = given.cf ?? card?.cf ?? fromQuote.cf ?? sources.previous?.cf;
	// The code, the PEC and the address of a past invoice only when it is the same customer (the same tax id).
	const previous = sources.previous !== undefined && sameTaxIds(sources.previous, vat, cf) ? sources.previous : undefined;
	const code = given.code ?? previous?.code;
	const foreign = (given.country !== undefined && given.country !== "IT") || (vat !== undefined && !vat.startsWith("IT"));
	const pa = code !== undefined && PA_CODE.test(code);
	const country = given.country ?? (vat === undefined ? (previous?.address.country ?? "IT") : vatCountry(vat));
	const missing: string[] = [];
	const noIds = vat === undefined && cf === undefined && !foreign;
	if (noIds) missing.push(NO_IDS);
	const text = given.address ?? card?.address ?? quote?.address;
	let address: Address | undefined = text === undefined ? undefined : foreign ? foreignAddress(text, country) : italianAddress(text);
	if (text === undefined && previous !== undefined && (previous.address.country === "IT") === !foreign) address = previous.address;
	if (address === undefined) missing.push(foreign ? "indirizzo, con la città dopo l'ultima virgola" : text === undefined ? "indirizzo" : "indirizzo scritto con CAP, comune e provincia, come «Via Roma 1, 20121 Milano MI»");
	const pec = given.pec ?? previous?.pec ?? card?.contacts.find((c) => c.channel === "pec" && c.email !== undefined)?.email;
	const kind: Buyer["kind"] = pa ? "pa" : foreign ? "foreign" : vat !== undefined ? "business" : "private";
	let finalCode: string;
	if (kind === "pa") finalCode = code as string;
	else if (kind === "foreign") finalCode = FOREIGN_CODE;
	else if (code !== undefined) finalCode = code;
	else if (pec !== undefined || kind === "private") finalCode = NO_CHANNEL_CODE;
	else {
		if (!noIds) missing.push("codice destinatario (7 caratteri) o PEC; se non li ha, si usa 0000000 e la fattura la trova nella sua area dell'Agenzia delle Entrate");
		finalCode = NO_CHANNEL_CODE;
	}
	if (missing.length > 0 || address === undefined) return { missing };
	if (latin1(address.street).length > FIELD_LIMITS.indirizzo || latin1(address.town).length > FIELD_LIMITS.comune) return { problem: `l'indirizzo del cliente è troppo lungo per la fattura (via e comune al massimo ${FIELD_LIMITS.indirizzo} caratteri ciascuno)` };
	return {
		name,
		kind,
		...(vat === undefined ? {} : { vat }),
		...(cf === undefined || kind === "foreign" ? {} : { cf }),
		address,
		code: finalCode,
		...(pec === undefined || finalCode !== NO_CHANNEL_CODE || kind === "foreign" || kind === "pa" ? {} : { pec }),
		...(card === undefined ? {} : { card: card.id }),
	};
}

/** A quote's customer ids as a buyer keeps them: the quote writes an Italian partita IVA without «IT». */
export function quoteIds(quote: QuoteCustomer | undefined): { vat?: string; cf?: string } {
	if (quote === undefined) return {};
	const vat = quote.vat === undefined ? undefined : buyerVat(quote.vat);
	const cf = quote.fiscal === undefined ? undefined : buyerCf(quote.fiscal);
	return { ...(vat !== undefined && "vat" in vat ? { vat: vat.vat } : {}), ...(cf !== undefined && "cf" in cf ? { cf: cf.cf } : {}) };
}
