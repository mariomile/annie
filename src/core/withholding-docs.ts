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
 * scadenzario's: every instalment marked paid, on the day of the last one (paidDay: the bank's day
 * when a statement confirmed it). A credit note counts with the minus, and «paid» means used.
 * Left out and counted: XML without a date or in another currency.
 */
import type { FatturaParty } from "./fattura-pa.ts";
import { toUnits } from "./fattura-pa.ts";
import { type Invoice, paidAmount, paidOnOf, partyKey } from "./invoices.ts";
import { halfUpSigned, unitsToCents } from "./quote-sums.ts";
import { RITENUTA_RATE } from "./sales-invoice-rules.ts";
import { salesTotals } from "./sales-invoice-sums.ts";
import { isIssued, type SalesInvoice } from "./sales-invoices.ts";
import { salesKey } from "./vat-docs.ts";
import { TAX_WITHHOLDINGS } from "./withholding-rules.ts";

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
	/** The compensi: the imponibile less the spese escluse (Natura N1) and the bollo. */
	readonly compensi: bigint;
	/** The ritenute d'acconto (RT01, RT02). */
	readonly ritenuta: bigint;
	/** The rate as written («20», «23»), when one is. */
	readonly rate?: string;
	readonly causale?: string;
	/** ImportoTotaleDocumento. */
	readonly total: bigint;
	/** What the client pays: the total less everything withheld (contributions too) and the IVA under split payment. */
	readonly net: bigint;
	/** Every instalment marked paid: the day of the last one. */
	readonly paidOn?: string;
	/** Some instalments paid, not all. */
	readonly partly: boolean;
	/** What the scadenzario counts as paid: its instalments' amounts (the invoice's own, never the bank's). */
	readonly received: bigint;
	/** Its file is in the workspace (the scadenzario sees it): a fattura in uscita whose XML is not there has no paid mark to read. */
	readonly inRegister: boolean;
};

export type DocsLeftOut = { readonly noDate: number; readonly foreign: number };

const abs = (n: bigint) => (n < 0n ? -n : n);
/** Hundred-millionths to cents, half up away from zero. */
const centsOf = (units: bigint): bigint => halfUpSigned(units, 1_000_000n);
/** A rate as written, plain: «20.00» is «20», «11.50» is «11.5». */
const plainRate = (raw: string | undefined): string | undefined => {
	const units = raw === undefined ? undefined : toUnits(raw);
	if (units === undefined) return undefined;
	return String(Number(centsOf(units)) / 100);
};

function paidOf(invoice: Invoice | undefined, dayOf: (at: string) => string): Pick<WithheldDoc, "paidOn" | "partly" | "received" | "inRegister"> {
	if (invoice === undefined) return { partly: false, received: 0n, inRegister: false };
	const paidOn = paidOnOf(invoice, dayOf);
	const some = invoice.instalments.some((n) => n.paid !== undefined);
	return { ...(paidOn === undefined ? {} : { paidOn }), partly: paidOn === undefined && some, received: unitsToCents(paidAmount(invoice)), inRegister: true };
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
		const compensi = t.rows.filter((r) => r.natura?.startsWith("N1") !== true).reduce((n, r) => n + r.taxable, 0n);
		out.push({
			key,
			source: "sales",
			number: i.number,
			date: i.date,
			credit,
			client,
			clientKey: partyKey(client),
			compensi: sign * compensi,
			ritenuta: sign * t.ritenuta,
			rate: String(RITENUTA_RATE),
			causale: i.ritenuta.causale,
			total: sign * t.total,
			net: sign * t.toPay,
			...paidOf(byKey.get(key), dayOf),
		});
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
		const signed = (n: bigint) => (i.credit ? -abs(n) : abs(n));
		const ritenuta = own.reduce((n, w) => n + abs(centsOf(toUnits(w.amount) ?? 0n)), 0n);
		const withheld = (i.doc.withholdings ?? []).reduce((n, w) => n + abs(centsOf(toUnits(w.amount) ?? 0n)), 0n);
		const rows = i.doc.vatRows ?? [];
		const compensi = rows.length > 0 ? rows.filter((r) => r.natura?.startsWith("N1") !== true).reduce((n, r) => n + abs(centsOf(toUnits(r.taxable) ?? 0n)), 0n) : abs(centsOf(toUnits(i.doc.taxable ?? "0") ?? 0n));
		const total = abs(centsOf(toUnits(i.doc.total ?? "0") ?? 0n));
		const split = abs(centsOf(toUnits(i.doc.splitVat ?? "0") ?? 0n));
		const rates = [...new Set(own.map((w) => plainRate(w.rate)).filter((r) => r !== undefined))];
		const causale = own.find((w) => w.causale !== undefined)?.causale;
		docs.push({
			key: i.key,
			source: "xml",
			...(i.doc.number === undefined ? {} : { number: i.doc.number }),
			date: i.doc.date,
			credit: i.credit,
			client: i.customer,
			clientKey: partyKey(i.customer),
			compensi: signed(compensi),
			ritenuta: signed(ritenuta),
			...(rates.length === 1 ? { rate: rates[0] as string } : {}),
			...(causale === undefined ? {} : { causale }),
			total: signed(total),
			net: signed(total - withheld - split),
			...paidOf(i, dayOf),
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
