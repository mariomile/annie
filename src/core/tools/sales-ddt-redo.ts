/**
 * A fattura differita made to the wrong customer: the credit note that reverses all of it (what is
 * left of it after the credit notes of its resi) and gives its DDTs back to bill, and the redo to
 * the right customer. Both take each DDT line as it stands now, net of every reso that came back
 * from it, at the invoice's prices: so a reso credited already is never billed or credited twice,
 * and the redo does not ask for another credit note after it.
 */
import type { Ddt } from "../ddt.ts";
import { DDT_BROKEN } from "../ddt-store.ts";
import type { SalesBook } from "../sales-invoice-store.ts";
import { CREDIT_NOTE_TYPE } from "../sales-invoice-rules.ts";
import type { IssuedInvoice, SalesLine } from "../sales-invoices.ts";
import { qtyOf, qtyText } from "../stock-sums.ts";
import { lineKey, netOf, type Returns, returnsOf } from "./sales-ddt.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";
import type { GivenLine } from "./sales-invoice-input.ts";

const QTY = /^\d{1,10}(?:\.\d{1,3})?$/;

/** An invoice line given again, with `quantity`. */
export const givenOf = (l: SalesLine, quantity = l.quantity): GivenLine => ({
	description: l.description,
	quantity,
	price: l.price,
	vat: l.vat,
	...(l.unit === undefined ? {} : { unit: l.unit }),
	...(l.discount === undefined ? {} : { discount: l.discount }),
	...(l.natura === undefined ? {} : { natura: l.natura }),
	...(l.reference === undefined ? {} : { reference: l.reference }),
	...(l.notFee === undefined ? {} : { notFee: l.notFee }),
	...(l.item === undefined ? {} : { item: l.item }),
	...(l.ddt === undefined ? {} : { ddt: l.ddt }),
});

/** The differita's lines as their DDT lines stand now: never more than billed, none when all came back. */
export function netLines(original: IssuedInvoice, ddts: readonly Ddt[], returns: Returns = returnsOf(ddts)): GivenLine[] {
	return original.lines.flatMap((l) => {
		if (l.ddt === undefined) return [givenOf(l)];
		const d = ddts.find((x) => x.id === l.ddt?.id);
		if (d === undefined || !QTY.test(l.quantity)) return [givenOf(l)];
		const net = netOf(d, l.ddt.line, returns);
		const billed = qtyOf(l.quantity);
		const qty = net < billed ? net : billed;
		return qty <= 0n ? [] : [givenOf(l, qtyText(qty))];
	});
}

/**
 * The lines of the credit note for the wrong customer: the whole invoice, or, for a differita, what
 * the credit notes of its resi left of it (a reso not credited yet stays on it: the wrong customer
 * owes nothing for it, and the redo, net of the resi, does not bill it). The answer to give when it cannot reverse all of it.
 */
export function wrongCustomerLines(env: SalesEnv, original: IssuedInvoice, book: SalesBook, replace: string | undefined): readonly GivenLine[] | string {
	const others = book.invoices.filter((i) => i.type === CREDIT_NOTE_TYPE && i.related?.id === original.id && i.id !== replace);
	if (original.ddt === undefined || original.ddt.length === 0) {
		if (others.length > 0) return `La fattura n. ${original.number} ha già una nota di credito: per cambiare cliente la nota di credito deve stornare tutta la fattura, e una parte è già stornata. Senti il commercialista su come procedere; non ho preparato niente.`;
		return original.lines.map((l) => givenOf(l));
	}
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT, e per stornare la fattura differita mi servono: non ho preparato niente.";
	const ddtBook = env.ddt.read();
	if (ddtBook.broken) return `Errore: ${DDT_BROKEN}.`;
	// Only the credit notes of its resi may be there: their goods are the resi taken off the DDT lines.
	const resi = new Set(ddtBook.ddts.filter((d) => d.causale === "reso").map((d) => d.id));
	if (others.some((c) => c.lines.some((l) => l.ddt === undefined || !resi.has(l.ddt.id)))) return `La fattura n. ${original.number} ha già una nota di credito che non viene da un reso: per cambiare cliente la nota di credito deve stornare tutta la fattura, e una parte è già stornata. Senti il commercialista su come procedere; non ho preparato niente.`;
	// Each line less what the credit notes of its DDT's resi took off it.
	const lines = original.lines.flatMap((l) => {
		const d = l.ddt === undefined ? undefined : ddtBook.ddts.find((x) => x.id === l.ddt?.id);
		const src = d?.lines.find((x) => x.n === l.ddt?.line);
		if (d === undefined || src === undefined || !QTY.test(l.quantity)) return [givenOf(l)];
		let credited = 0n;
		for (const c of others)
			for (const cl of c.lines) {
				const r = ddtBook.ddts.find((x) => x.id === cl.ddt?.id);
				const rl = r?.lines.find((x) => x.n === cl.ddt?.line);
				if (r?.of === d.id && rl !== undefined && lineKey(rl) === lineKey(src) && QTY.test(cl.quantity)) credited += qtyOf(cl.quantity);
			}
		const left = qtyOf(l.quantity) - credited;
		return left <= 0n ? [] : [givenOf(l, qtyText(left))];
	});
	if (lines.length === 0) return `La merce della fattura n. ${original.number} è tornata tutta con i resi: non resta niente da stornare per cambiare cliente.`;
	return lines;
}
