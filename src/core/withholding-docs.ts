/**
 * The invoices issued with a ritenuta d'acconto, gathered once from what the other registers read,
 * pure:
 *
 * - the fatture in uscita issued with the ritenuta: its amount, base and what the client pays from
 *   their own totals (sales-invoice-sums.ts);
 * - the FatturaPA XML of the workspace where the company is the supplier, with a DatiRitenuta of
 *   type RT01 or RT02 (a ritenuta on income; RT03 to RT06 are contributions withheld, not a credit
 *   for the dichiarazione).
 *
 * The same invoice in both counts once, as the fattura in uscita, by the scadenzario's key (the
 * rule la liquidazione IVA uses, vat-docs.ts salesKey). Whether and when it was paid is the
 * scadenzario's: each instalment marked paid on its day (paidDay: the bank's day when a statement
 * confirmed it). The ritenuta and the compensi are shared over the instalments in proportion to
 * what each one pays (invoices.ts instalmentShares), so an invoice paid across two years counts
 * each share in its own year. A credit note counts with the minus, and «paid» means used.
 * Left out and counted: XML without a date or in another currency.
 */
import type { FatturaParty } from "./fattura-pa.ts";
import { toUnits } from "./fattura-pa.ts";
import { instalmentShares, type Invoice, paidAmount, paidDay, paidOnOf, partyKey } from "./invoices.ts";
import { absCents, unitsCents, unitsToCents } from "./quote-sums.ts";
import { INPS_CASSA, RITENUTA_RATE } from "./sales-invoice-rules.ts";
import { salesTotals } from "./sales-invoice-sums.ts";
import { isIssued, type SalesInvoice } from "./sales-invoices.ts";
import { salesKey } from "./vat-docs.ts";
import { integrativoFund, TAX_WITHHOLDINGS } from "./withholding-rules.ts";

/** One instalment paid (or, of a credit note, used): its day and its shares of the invoice, signed. */
export type PaidShare = { readonly day: string; readonly ritenuta: bigint; readonly compensi: bigint; readonly net: bigint };

/** One invoice with a ritenuta; amounts in cents with their sign (a credit note's are negative). */
export type WithheldDoc = {
	readonly key: string;
	readonly source: "sales" | "xml";
	readonly number?: string;
	readonly date: string;
	readonly credit: boolean;
	readonly client: FatturaParty;
	/** Who the client is, to group by client (invoices.ts partyKey). */
	readonly clientKey: string;
	/** The compensi: the imponibile less the spese escluse (Natura N1), the bollo and a cassa's contributo integrativo. */
	readonly compensi: bigint;
	/** The ritenute d'acconto (RT01, RT02). */
	readonly ritenuta: bigint;
	/** The rate as written («20», «23»), when one is. */
	readonly rate?: string;
	readonly causale?: string;
	/** The gross: the summary rows' imponibile plus imposta (ImportoTotaleDocumento without rows). */
	readonly total: bigint;
	/** What the client pays: the gross less everything withheld (contributions too) and the IVA under split payment. */
	readonly net: bigint;
	/** Every instalment marked paid: the day of the last one. */
	readonly paidOn?: string;
	/** Some instalments paid, not all. */
	readonly partly: boolean;
	/** The instalments paid, each with its shares, oldest first. */
	readonly payments: readonly PaidShare[];
	/** What the scadenzario counts as paid: its instalments' amounts (the invoice's own, never the bank's). */
	readonly received: bigint;
	/** Its file is in the workspace (the scadenzario sees it): a fattura in uscita whose XML is not there has no paid mark to read. */
	readonly inRegister: boolean;
};

export type DocsLeftOut = { readonly noDate: number; readonly foreign: number };

/** A rate as written, plain: «20.00» is «20», «11.50» is «11.5». */
const plainRate = (raw: string | undefined): string | undefined => {
	const units = raw === undefined ? undefined : toUnits(raw);
	return units === undefined ? undefined : String(Number(unitsCents(units)) / 100);
};
/** An amount as written, in cents with its sign. */
const signedCents = (raw: string | undefined): bigint => unitsCents(toUnits(raw ?? "0") ?? 0n);
const cents = (raw: string | undefined): bigint => absCents(signedCents(raw));

type Amounts = { readonly ritenuta: bigint; readonly compensi: bigint; readonly net: bigint };

/** The paid side of a document: whether, when, how much, and each paid instalment's shares. */
function paidOf(invoice: Invoice | undefined, a: Amounts, dayOf: (at: string) => string): Pick<WithheldDoc, "paidOn" | "partly" | "received" | "inRegister" | "payments"> {
	if (invoice === undefined) return { partly: false, received: 0n, inRegister: false, payments: [] };
	const paidOn = paidOnOf(invoice, dayOf);
	const r = instalmentShares(invoice, a.ritenuta);
	const c = instalmentShares(invoice, a.compensi);
	const n = instalmentShares(invoice, a.net);
	const payments: PaidShare[] = [];
	invoice.instalments.forEach((i, at) => {
		if (i.paid === undefined || i.extra === true) return;
		payments.push({ day: paidDay(i.paid, dayOf), ritenuta: r[at] ?? 0n, compensi: c[at] ?? 0n, net: n[at] ?? 0n });
	});
	payments.sort((x, y) => x.day.localeCompare(y.day));
	return { ...(paidOn === undefined ? {} : { paidOn }), partly: paidOn === undefined && payments.length > 0, received: unitsToCents(paidAmount(invoice)), inRegister: true, payments };
}

/** The fatture in uscita issued with a ritenuta. */
function fromSales(sales: readonly SalesInvoice[], byKey: ReadonlyMap<string, Invoice>, dayOf: (at: string) => string): WithheldDoc[] {
	const out: WithheldDoc[] = [];
	for (const i of sales) {
		if (!isIssued(i) || i.ritenuta === undefined) continue;
		const t = salesTotals(i);
		if (t.ritenuta === 0n) continue;
		const credit = i.type === "TD04";
		const sign = credit ? -1n : 1n;
		const key = salesKey(i.seller.vat, i.number, i.date, i.type);
		const client: FatturaParty = { name: i.buyer.name, ...(i.buyer.vat === undefined ? {} : { vat: { country: i.buyer.vat.slice(0, 2), code: i.buyer.vat.slice(2) } }), ...(i.buyer.cf === undefined ? {} : { fiscal: i.buyer.cf }) };
		// A cassa's contributo integrativo is not a compenso; the rivalsa INPS is.
		const integrativo = i.cassa !== undefined && i.cassa.type !== INPS_CASSA ? t.cassaTotal : 0n;
		const compensi = t.rows.filter((r) => r.natura?.startsWith("N1") !== true).reduce((n, r) => n + r.taxable, 0n) - integrativo;
		const amounts = { ritenuta: sign * t.ritenuta, compensi: sign * compensi, net: sign * t.toPay };
		out.push({ key, source: "sales", number: i.number, date: i.date, credit, client, clientKey: partyKey(client), ...amounts, rate: String(RITENUTA_RATE), causale: i.ritenuta.causale, total: sign * t.total, ...paidOf(byKey.get(key), amounts, dayOf) });
	}
	return out;
}

/** The XML of the workspace issued by the company with a ritenuta on income, those already among the fatture in uscita left out. */
function fromRegister(register: readonly Invoice[], known: ReadonlySet<string>, dayOf: (at: string) => string): { docs: WithheldDoc[]; left: DocsLeftOut } {
	const docs: WithheldDoc[] = [];
	const left = { noDate: 0, foreign: 0 };
	for (const i of register) {
		if (known.has(i.key) || i.side !== "active" || i.doc.integration) continue;
		const own = (i.doc.withholdings ?? []).filter((w) => w.type !== undefined && TAX_WITHHOLDINGS.includes(w.type));
		if (own.length === 0) continue;
		if (i.doc.currency !== "EUR") {
			left.foreign++;
			continue;
		}
		if (i.doc.date === undefined) {
			left.noDate++;
			continue;
		}
		const signed = (n: bigint) => (i.credit ? -absCents(n) : absCents(n));
		const ritenuta = own.reduce((n, w) => n + cents(w.amount), 0n);
		const withheld = (i.doc.withholdings ?? []).reduce((n, w) => n + cents(w.amount), 0n);
		const rows = i.doc.vatRows ?? [];
		const integrativo = (i.doc.funds ?? []).filter((f) => integrativoFund(f.type)).reduce((n, f) => n + cents(f.amount), 0n);
		// The rows with their sign (a discount row is negative); `signed` takes the document's sign once.
		const taxable = rows.length > 0 ? absCents(rows.filter((r) => r.natura?.startsWith("N1") !== true).reduce((n, r) => n + signedCents(r.taxable), 0n)) : cents(i.doc.taxable);
		// The gross from the summary rows: an ImportoTotaleDocumento may be written already net of the ritenuta.
		const total = rows.length > 0 ? absCents(rows.reduce((n, r) => n + signedCents(r.taxable) + signedCents(r.tax), 0n)) : cents(i.doc.total);
		const split = cents(i.doc.splitVat);
		const rates = [...new Set(own.map((w) => plainRate(w.rate)).filter((r) => r !== undefined))];
		const causale = own.find((w) => w.causale !== undefined)?.causale;
		const amounts = { ritenuta: signed(ritenuta), compensi: signed(taxable - integrativo), net: signed(total - withheld - split) };
		docs.push({
			key: i.key,
			source: "xml",
			...(i.doc.number === undefined ? {} : { number: i.doc.number }),
			date: i.doc.date,
			credit: i.credit,
			client: i.customer,
			clientKey: partyKey(i.customer),
			...amounts,
			...(rates.length === 1 ? { rate: rates[0] as string } : {}),
			...(causale === undefined ? {} : { causale }),
			total: signed(total),
			...paidOf(i, amounts, dayOf),
		});
	}
	return { docs, left };
}

/** Every invoice with a ritenuta, each once (see above), oldest first. `dayOf`: the local day of an instant, for the paid marks. */
export function withheldDocs(sales: readonly SalesInvoice[], register: readonly Invoice[], dayOf: (at: string) => string): { readonly docs: WithheldDoc[]; readonly left: DocsLeftOut } {
	const byKey = new Map(register.map((i) => [i.key, i]));
	const own = fromSales(sales, byKey, dayOf);
	const scanned = fromRegister(register, new Set(own.map((d) => d.key)), dayOf);
	const docs = [...own, ...scanned.docs].sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? "").localeCompare(b.number ?? "", "it", { numeric: true }));
	return { docs, left: scanned.left };
}

/** A document's shares paid in `year`, added up; undefined when none was. */
export function sharesIn(d: WithheldDoc, year: number): Amounts | undefined {
	const y = String(year);
	const list = d.payments.filter((p) => p.day.startsWith(y));
	if (list.length === 0) return undefined;
	return { ritenuta: list.reduce((n, p) => n + p.ritenuta, 0n), compensi: list.reduce((n, p) => n + p.compensi, 0n), net: list.reduce((n, p) => n + p.net, 0n) };
}

/** A document's shares paid in a span of days, added up (zero when none). */
export function ritenutaBetween(d: WithheldDoc, from: string, to: string): bigint {
	return d.payments.filter((p) => p.day >= from && p.day <= to).reduce((n, p) => n + p.ritenuta, 0n);
}
