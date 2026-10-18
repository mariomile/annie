/**
 * The documents la liquidazione IVA counts, gathered once from what the other registers read, pure:
 *
 * - IVA a debito: the invoices issued, from the fatture in uscita (exact, from their own totals) and
 *   from the XML of the workspace where the company is the supplier. The same invoice in both (the
 *   key of the scadenzario: the supplier's partita IVA, number, date, type) counts once, as the
 *   fattura in uscita. A credit note (TD04, TD08, or a negative document) counts with the minus.
 *   Rows under split payment (EsigibilitaIVA S: the public administration pays that IVA to the
 *   State) and rows without IVA for the reverse charge (Natura N6.x) are kept apart, never due.
 * - IVA a credito: the invoices received, in the period of receipt as the person said it, else of
 *   their date (an approximation, said); credit notes received with the minus. The share deductible
 *   is the person's mark on the invoice, else on the supplier's partita IVA, else all of it.
 * - Reverse charge received: the integrazione or autofattura (TD16-TD19) counts on both sides, its
 *   IVA a debito whole, a credito at the share deductible.
 * - IVA per cassa or otherwise deferred (EsigibilitaIVA D): in the period the invoice is marked
 *   paid in the scadenzario, and until then left out and said.
 *
 * Left out and counted: documents whose side is not known (no company set), in another currency,
 * without a date, or without summary rows that read (a simplified invoice, a row that does not read).
 */
import { type FatturaDocument, type FatturaParty, toUnits } from "./fattura-pa.ts";
import { type Invoice, invoiceKey, paidDay, vatOf } from "./invoices.ts";
import { halfUpSigned } from "./quote-sums.ts";
import { salesTotals } from "./sales-invoice-sums.ts";
import { isIssued, type SalesInvoice } from "./sales-invoices.ts";
import type { DeductMark } from "./vat.ts";

export type Esigibilita = "I" | "D" | "S";

/** One summary row, in cents with its sign: a credit note's are negative. */
export type VatRow = { readonly rate: string; readonly natura?: string; readonly taxable: bigint; readonly tax: bigint; readonly esigibilita: Esigibilita };

export type VatDoc = {
	readonly key: string;
	readonly side: "sale" | "purchase";
	readonly source: "sales" | "xml";
	readonly number?: string;
	/** The invoice's date. */
	readonly date: string;
	/** A purchase: the day of receipt the person said. */
	readonly received?: string;
	/** Every instalment marked paid in the scadenzario: the last day, for the deferred rows. */
	readonly paidOn?: string;
	readonly credit: boolean;
	readonly integration: boolean;
	/** The other side: the customer of a sale, the supplier of a purchase. */
	readonly party: FatturaParty;
	readonly rows: readonly VatRow[];
	/** A purchase: the share deductible as marked (undefined: all), and whether the mark is the invoice's or the supplier's. */
	readonly percent?: string;
	readonly markedBy?: "invoice" | "supplier";
};

export type LeftOut = { readonly noSide: number; readonly foreign: number; readonly noDate: number; readonly noRows: number };

/** Hundred-millionths to cents, half up away from zero. */
const centsOf = (units: bigint): bigint => halfUpSigned(units, 1_000_000n);

const esigibilitaOf = (code: string | undefined): Esigibilita => (code === "S" || code === "D" ? code : "I");

/** The key the scadenzario gives an invoice issued by `vat` with this number, date and type. */
function salesKey(vat: string, number: string, date: string, type: string): string {
	const doc: FatturaDocument = { number, date, type, credit: false, integration: false, currency: "EUR", instalments: [] };
	return invoiceKey({ vat: { country: vat.slice(0, 2), code: vat.slice(2) } }, {}, doc, "");
}

/** The fatture in uscita issued, as documents: their rows from their own totals. */
function fromSales(sales: readonly SalesInvoice[]): VatDoc[] {
	const out: VatDoc[] = [];
	for (const i of sales) {
		if (!isIssued(i)) continue;
		const credit = i.type === "TD04";
		const sign = credit ? -1n : 1n;
		const rows = salesTotals(i).rows.map((r): VatRow => ({ rate: String(r.vat), ...(r.natura === undefined ? {} : { natura: r.natura }), taxable: sign * r.taxable, tax: sign * r.tax, esigibilita: i.splitPayment === true ? "S" : "I" }));
		const party: FatturaParty = { name: i.buyer.name, ...(i.buyer.vat === undefined ? {} : { vat: { country: i.buyer.vat.slice(0, 2), code: i.buyer.vat.slice(2) } }), ...(i.buyer.cf === undefined ? {} : { fiscal: i.buyer.cf }) };
		out.push({ key: salesKey(i.seller.vat, i.number, i.date, i.type), side: "sale", source: "sales", number: i.number, date: i.date, credit, integration: false, party, rows });
	}
	return out;
}

/** The share and day the person marked for a received invoice: the invoice's own mark first, then the supplier's share. */
function markOf(invoice: Invoice, marks: readonly DeductMark[]): Pick<VatDoc, "percent" | "received" | "markedBy"> {
	const own = marks.find((m) => m.invoice === invoice.key);
	const vat = vatOf(invoice.supplier);
	const supplier = vat === undefined ? undefined : marks.find((m) => m.vat === vat);
	const percent = own?.percent ?? supplier?.percent;
	return {
		...(percent === undefined ? {} : { percent, markedBy: own?.percent !== undefined ? ("invoice" as const) : ("supplier" as const) }),
		...(own?.received === undefined ? {} : { received: own.received }),
	};
}

/** The scadenzario's invoices as documents, those already among the fatture in uscita left out. */
function fromRegister(register: readonly Invoice[], known: ReadonlySet<string>, marks: readonly DeductMark[], dayOf: (at: string) => string): { docs: VatDoc[]; left: LeftOut } {
	const docs: VatDoc[] = [];
	const left = { noSide: 0, foreign: 0, noDate: 0, noRows: 0 };
	for (const i of register) {
		if (known.has(i.key)) continue;
		if (i.side === undefined) {
			left.noSide++;
			continue;
		}
		if (i.doc.currency !== "EUR") {
			left.foreign++;
			continue;
		}
		if (i.doc.date === undefined) {
			left.noDate++;
			continue;
		}
		const raw = i.doc.vatRows;
		const read = raw?.map((r) => ({ r, rate: toUnits(r.rate), taxable: toUnits(r.taxable), tax: toUnits(r.tax) }));
		if (read === undefined || read.some((x) => x.rate === undefined || x.taxable === undefined || x.tax === undefined)) {
			left.noRows++;
			continue;
		}
		const abs = (n: bigint) => (n < 0n ? -n : n);
		const signed = (n: bigint) => (i.credit ? -abs(n) : n);
		const rows = read.map(
			(x): VatRow => ({
				rate: String(Number(centsOf(x.rate as bigint)) / 100),
				...(x.r.natura === undefined ? {} : { natura: x.r.natura }),
				taxable: signed(centsOf(x.taxable as bigint)),
				tax: signed(centsOf(x.tax as bigint)),
				esigibilita: esigibilitaOf(x.r.esigibilita),
			}),
		);
		const paidDays = i.instalments.map((n) => (n.paid === undefined ? undefined : paidDay(n.paid, dayOf)));
		const paidOn = i.paid && paidDays.every((d) => d !== undefined) ? (paidDays as string[]).sort().at(-1) : undefined;
		const side = i.side === "active" && !i.doc.integration ? "sale" : "purchase";
		docs.push({
			key: i.key,
			side,
			source: "xml",
			...(i.doc.number === undefined ? {} : { number: i.doc.number }),
			date: i.doc.date,
			...(paidOn === undefined ? {} : { paidOn }),
			credit: i.credit,
			integration: i.doc.integration,
			party: side === "sale" ? i.customer : i.supplier,
			rows,
			...(side === "purchase" ? markOf(i, marks) : {}),
		});
	}
	return { docs, left };
}

/** Every document to count, each once (see above). `dayOf`: the local day of an instant, for the paid marks. */
export function vatDocs(sales: readonly SalesInvoice[], register: readonly Invoice[], marks: readonly DeductMark[], dayOf: (at: string) => string): { readonly docs: VatDoc[]; readonly left: LeftOut } {
	const own = fromSales(sales);
	const scanned = fromRegister(register, new Set(own.map((d) => d.key)), marks, dayOf);
	return { docs: [...own, ...scanned.docs], left: scanned.left };
}

/** Whether a row is a sale under the reverse charge: no IVA, nature N6.x. */
export const isReverseRow = (r: VatRow): boolean => r.natura?.startsWith("N6") === true;
