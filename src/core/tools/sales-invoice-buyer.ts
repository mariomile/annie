/**
 * The customer of an invoice: who the person names (a client's card of week 57, a customer
 * already invoiced here, the quote's customer, the timesheet's client), and the data FatturaPA
 * needs of them, taken from what the person says now, then the card, the quote and the last
 * invoice to the same customer. A partita IVA or a codice fiscale, the address with CAP, comune
 * and provincia, and the codice destinatario or the PEC: what is missing is asked, never invented.
 * A private person without either gets «0000000»; a foreign customer «XXXXXXX».
 */
import { CARD_ID, type ClientCard, cardKeys } from "../clients.ts";
import { spellingKey } from "../name-keys.ts";
import { latin1 } from "../plain-text.ts";
import type { QuoteCustomer } from "../quotes.ts";
import { FIELD_LIMITS, FOREIGN_CODE, NO_CHANNEL_CODE, PA_CODE } from "../sales-invoice-rules.ts";
import { type Address, type Buyer, buyerCf, buyerVat, foreignAddress, italianAddress, type SalesInvoice, vatCountry } from "../sales-invoices.ts";
import { resolveClient } from "../timesheet-clients.ts";
import type { BuyerFields, Problem } from "./sales-invoice-input.ts";

/** A customer found: the name to write, the card, and the last invoice made for them here. */
export type Known = { readonly name: string; readonly card?: ClientCard; readonly previous?: Buyer };

export type Found = { readonly kind: "exact"; readonly known: Known } | { readonly kind: "close"; readonly candidates: readonly string[] } | { readonly kind: "none" };

/** The newest buyer first: drafts and invoices are kept in order. */
function lastBuyer(invoices: readonly SalesInvoice[], match: (b: Buyer) => boolean): Buyer | undefined {
	return [...invoices].reverse().find((i) => match(i.buyer))?.buyer;
}

/** The last buyer with the card's tax ids or one of its names. */
function previousOf(card: ClientCard, invoices: readonly SalesInvoice[]): Buyer | undefined {
	const keys = cardKeys(card);
	return lastBuyer(invoices, (b) => (card.vat !== undefined && b.vat === card.vat) || (card.cf !== undefined && b.cf === card.cf) || b.card === card.id || keys.includes(spellingKey(b.name)));
}

/** Who `said` names among the cards and the customers already invoiced: by card id, tax id, or name (the timesheet's rule). */
export function findBuyer(said: string, cards: readonly ClientCard[], invoices: readonly SalesInvoice[]): Found {
	const t = said.trim();
	if (CARD_ID.test(t.toUpperCase())) {
		const card = cards.find((c) => c.id === t.toUpperCase());
		return card === undefined ? { kind: "none" } : { kind: "exact", known: known(card, invoices) };
	}
	const compact = t.replace(/[\s.\-/]/g, "").replace(/^(?:p\.?iva|partitaiva|cf)[:]?/i, "").toUpperCase();
	if (/^(?:[A-Z]{2})?\d{8,12}$/.test(compact) || /^[A-Z0-9]{16}$/.test(compact)) {
		const vat = "vat" in buyerVat(compact) ? (buyerVat(compact) as { vat: string }).vat : undefined;
		const card = cards.find((c) => (vat !== undefined && c.vat === vat) || c.cf === compact);
		if (card !== undefined) return { kind: "exact", known: known(card, invoices) };
		const previous = lastBuyer(invoices, (b) => (vat !== undefined && b.vat === vat) || b.cf === compact);
		if (previous !== undefined) return { kind: "exact", known: { name: previous.name, previous } };
	}
	const names = [...cards.flatMap((c) => [c.name, ...c.aliases]), ...[...invoices].reverse().map((i) => i.buyer.name)];
	const r = resolveClient(t, names);
	if (r.kind === "close") return { kind: "close", candidates: r.candidates };
	if (r.kind === "none") return { kind: "none" };
	const key = spellingKey(r.name);
	const card = cards.find((c) => cardKeys(c).includes(key));
	if (card !== undefined) return { kind: "exact", known: known(card, invoices) };
	const previous = lastBuyer(invoices, (b) => spellingKey(b.name) === key);
	return { kind: "exact", known: { name: r.name, ...(previous === undefined ? {} : { previous }) } };
}

function known(card: ClientCard, invoices: readonly SalesInvoice[]): Known {
	const previous = previousOf(card, invoices);
	return { name: card.name, card, ...(previous === undefined ? {} : { previous }) };
}

/** The data FatturaPA needs that is missing, in words, to ask; or a problem with what was given. */
export type BuyerAsk = { readonly missing: readonly string[] };

/**
 * The buyer from what the person says now, the card, the quote's customer and the last invoice to
 * them, in this order. `name`: as the card, quote or timesheet writes it, or as said.
 */
export function composeBuyer(name: string, sources: { readonly card?: ClientCard; readonly previous?: Buyer; readonly quote?: QuoteCustomer }, given: BuyerFields): Buyer | BuyerAsk | Problem {
	const { card, previous, quote } = sources;
	if (latin1(name).length > FIELD_LIMITS.denominazione) return { problem: `il nome del cliente è troppo lungo per la fattura (al massimo ${FIELD_LIMITS.denominazione} caratteri): chiedi a chi ti scrive come scriverlo più corto e passalo come nome in fattura` };
	const fromQuote = quoteIds(quote);
	const vat = given.vat ?? card?.vat ?? fromQuote.vat ?? previous?.vat;
	const cf = given.cf ?? card?.cf ?? fromQuote.cf ?? previous?.cf;
	const code = given.code ?? previous?.code;
	const foreign = (given.country !== undefined && given.country !== "IT") || (vat !== undefined && !vat.startsWith("IT"));
	const pa = code !== undefined && PA_CODE.test(code);
	const country = given.country ?? (vat === undefined ? (previous?.address.country ?? "IT") : vatCountry(vat));
	const missing: string[] = [];
	if (vat === undefined && cf === undefined && !foreign) missing.push("la partita IVA del cliente o, per un privato, il suo codice fiscale");
	const text = given.address ?? card?.address ?? quote?.address;
	let address: Address | undefined = text === undefined ? undefined : foreign ? foreignAddress(text, country) : italianAddress(text);
	if (text === undefined && previous !== undefined && (previous.address.country === "IT") === !foreign) address = previous.address;
	if (address === undefined) missing.push(foreign ? "l'indirizzo del cliente, con la città dopo l'ultima virgola" : text === undefined ? "l'indirizzo del cliente, con CAP, comune e provincia" : "l'indirizzo del cliente scritto con CAP, comune e provincia, come «Via Roma 1, 20121 Milano MI»");
	const pec = given.pec ?? previous?.pec ?? card?.contacts.find((c) => c.channel === "pec" && c.email !== undefined)?.email;
	const kind: Buyer["kind"] = pa ? "pa" : foreign ? "foreign" : vat !== undefined ? "business" : "private";
	let finalCode: string;
	if (kind === "pa") finalCode = code as string;
	else if (kind === "foreign") finalCode = FOREIGN_CODE;
	else if (code !== undefined) finalCode = code;
	else if (pec !== undefined || kind === "private") finalCode = NO_CHANNEL_CODE;
	else {
		missing.push("il codice destinatario (7 caratteri) o la PEC del cliente; se il cliente non li ha, si può usare 0000000 e la fattura la trova nel suo cassetto fiscale");
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
function quoteIds(quote: QuoteCustomer | undefined): { vat?: string; cf?: string } {
	if (quote === undefined) return {};
	const vat = quote.vat === undefined ? undefined : buyerVat(quote.vat);
	const cf = quote.fiscal === undefined ? undefined : buyerCf(quote.fiscal);
	return { ...(vat !== undefined && "vat" in vat ? { vat: vat.vat } : {}), ...(cf !== undefined && "cf" in cf ? { cf: cf.cf } : {}) };
}
