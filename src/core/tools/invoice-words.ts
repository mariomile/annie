/**
 * How the scadenzario names things in its answers: parties, documents, amounts of an invoice.
 * Names come from the files: whoever uses these puts the result inside the fence (invoice-fence.ts).
 */
import { TIPO_DOCUMENTO } from "../fattura-pa-codes.ts";
import { type FatturaParty, fromUnits, money } from "../fattura-pa.ts";
import { dayMonth } from "../invoice-windows.ts";
import { type Company, countedAmount, type Invoice, matchesParty, vatOf } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import type { ReadArgs } from "./invoice-fence.ts";

/** Rows in one answer; the rest are counted. */
export const MAX_ROWS = 30;
/** A party's name in a row: the files allow 80 characters, a phone line fewer. */
const MAX_NAME = 60;
/** Names in a direction's label before «e altri N». */
const MAX_NAMES = 3;

export function filtered(invoices: readonly Invoice[], args: ReadArgs): readonly Invoice[] {
	const { side, party } = args;
	return invoices.filter((i) => (side === undefined || i.side === side) && (party === undefined || matchesParty(i.supplier, party) || matchesParty(i.customer, party)));
}

/** Names in the order a person reads them: «Fornitore 2» before «Fornitore 10». */
export function byName(a: string, b: string): number {
	return a.localeCompare(b, "it", { numeric: true });
}

/** The party on the other side: the supplier of an invoice to pay, the customer of one to collect, the supplier of one to a customer. */
export function otherParty(invoice: Invoice): FatturaParty {
	return invoice.side === "active" ? invoice.customer : invoice.supplier;
}

/** «Alfa», «Alfa e Delta», «Alfa, Delta, Gamma e altri 2», in the order a person reads them. */
export function namesText(parties: readonly FatturaParty[]): string {
	const all = parties.map(partyName).sort(byName);
	const names = all.slice(0, MAX_NAMES);
	const rest = all.length - names.length;
	if (rest > 0) return `${names.join(", ")} e ${rest === 1 ? "un altro" : `altri ${rest}`}`;
	return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

/** «, 1.253,50 €»: what the invoice counts for, its instalments up to the total (alternatives once). */
export function worthText(invoice: Invoice): string {
	const units = countedAmount(invoice);
	return units === undefined ? "" : `, ${money(fromUnits(units), invoice.doc.currency)}${splitText(invoice)}`;
}

/** « (senza IVA, split payment)» after an amount counted as the total less the VAT the administration pays. */
export function splitText(invoice: Invoice): string {
	return invoice.splitNet === true ? " (senza IVA, split payment)" : "";
}

/** «da pagare ad Alfa», «da incassare da Beta», a credit note «di Alfa, a tuo favore», or «fornitore Alfa, cliente Beta» when the side is not known. */
export function counterparties(invoice: Invoice): string {
	if (invoice.credit && invoice.side === "passive") return `di ${partyName(invoice.supplier)}, a tuo favore`;
	if (invoice.credit && invoice.side === "active") return `a ${partyName(invoice.customer)}, a suo favore`;
	if (invoice.side === "passive") return `da pagare ${to(partyName(invoice.supplier))}`;
	if (invoice.side === "active") return `da incassare da ${partyName(invoice.customer)}`;
	return `fornitore ${partyName(invoice.supplier)}, cliente ${partyName(invoice.customer)}`;
}

/** «a Rossi», «ad Alfa». */
export function to(name: string): string {
	return /^[aàAÀ]/.test(name) ? `ad ${name}` : `a ${name}`;
}

/**
 * «fattura 2026/0153 del 15/10/2026», «nota di credito NC 2026/9 del 05/10/2026»; false leaves the
 * date out, today writes it without this year («del 05/10»).
 */
export function docLabel(invoice: Invoice, date: boolean | string = true): string {
	const day = invoice.doc.date;
	const when = date === false || day === undefined ? undefined : `del ${date === true ? italianDate(day) : dayMonth(day, date)}`;
	return joinedWords([docKind(invoice), invoice.doc.number ?? "senza numero", when], " ");
}

function docKind(invoice: Invoice): string {
	const { type } = invoice.doc;
	if (invoice.doc.credit) return "nota di credito";
	if (type === "TD06") return "parcella";
	if (type === "TD05" || type === "TD09") return "nota di debito";
	if (type !== undefined && invoice.doc.integration) return TIPO_DOCUMENTO[type] ?? "documento";
	return "fattura";
}

/** «fatt. 2026/0153» in a row; the kind in full when it is not an invoice. */
export function docShort(invoice: Invoice, today: string): string {
	const kind = docKind(invoice) === "fattura" ? "fatt." : docKind(invoice);
	const { number, date } = invoice.doc;
	if (number !== undefined) return `${kind} ${number}`;
	return `${kind} senza numero${date === undefined ? "" : ` del ${dayMonth(date, today)}`}`;
}

export function partyName(party: FatturaParty): string {
	if (party.name !== undefined) return short(party.name);
	const vat = vatOf(party);
	return vat === undefined ? (party.fiscal === undefined ? "nome non indicato" : `codice fiscale ${party.fiscal}`) : `P.IVA ${vat}`;
}

export function short(text: string): string {
	return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text;
}

export function companyText(company: Company): string {
	return joinedWords([company.name, company.vat === undefined ? undefined : `P.IVA ${company.vat}`], ", ");
}

export function capital(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function joinedWords(parts: readonly (string | undefined)[], separator = " "): string {
	return parts.filter((p): p is string => p !== undefined && p !== "").join(separator);
}
