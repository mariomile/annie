/**
 * Sums of the scadenzario, shared by its answers (invoice-tools.ts) and its reminders: exact
 * amounts by currency, each party's credit notes off its own amount, never below zero, and the
 * day a payment due on a weekend or a holiday can be made.
 */
import { paymentSlip } from "./dates.ts";
import { fromUnits, money, toUnits } from "./fattura-pa.ts";
import { addTo, type Instalment, type Invoice, type Sums } from "./invoices.ts";
import { daysBetween } from "./italian-calendar.ts";

/** An open credit note and what is left of it to take off. */
export type Credit = { readonly invoice: Invoice; readonly units: bigint };

/** One party's share of a total: what it is owed, and its credit notes still to take off. */
export type Share = { readonly gross: Sums; readonly credit: Sums; readonly notes: number };

/** A total of shares: each party's credit notes come off its own amount, never below zero. */
type Netted = { readonly gross: Sums; readonly applied: Sums; readonly net: Sums; readonly left: Sums; readonly notes: number };

export function netted(shares: Iterable<Share>): Netted {
	const gross: Sums = new Map();
	const applied: Sums = new Map();
	const net: Sums = new Map();
	const left: Sums = new Map();
	let notes = 0;
	for (const share of shares) {
		notes += share.notes;
		for (const currency of new Set([...share.gross.keys(), ...share.credit.keys()])) {
			const g = share.gross.get(currency) ?? 0n;
			const c = share.credit.get(currency) ?? 0n;
			addTo(gross, currency, g);
			addTo(net, currency, g > c ? g - c : 0n);
			addTo(applied, currency, c < g ? c : g);
			if (c > g) addTo(left, currency, c - g);
		}
	}
	return { gross, applied, net, left, notes };
}

/** «1.153,50 € (1.253,50 € meno la nota di credito di 100,00 €)», with what is left to take off. */
export function nettedText(n: Netted): string {
	if (n.notes === 0) return sumsText(n.gross);
	const which = n.notes === 1 ? "la nota di credito" : "le note di credito";
	const left = isZero(n.left) ? "" : `restano ${sumsText(n.left)} di note di credito da scalare`;
	if (isZero(n.applied)) return `${sumsText(n.gross)}${left === "" ? "" : ` (${left})`}`;
	return `${sumsText(n.net)} (${sumsText(n.gross)} meno ${which} di ${sumsText(n.applied)}${left === "" ? "" : `; ${left}`})`;
}

export function sumsText(sums: Sums): string {
	const shown = [...sums].filter(([, units]) => units !== 0n).map(([currency, units]) => money(fromUnits(units), currency) as string);
	return shown.length === 0 ? "0,00 €" : shown.join(" + ");
}

export function isZero(sums: Sums): boolean {
	return [...sums.values()].every((u) => u === 0n);
}

/** The euros of a sum, for ordering. */
export function eur(sums: Sums): bigint {
	return sums.get("EUR") ?? 0n;
}

export function creditSums(credits: readonly Credit[]): Sums {
	const sums: Sums = new Map();
	for (const c of credits) addTo(sums, c.invoice.doc.currency, c.units);
	return sums;
}

/** The day a payment due on `due` can be made: the next working day for a weekend or a holiday. */
export function payDay(due: string): string {
	return paymentSlip(due)?.to ?? due;
}

/** Days late today, from the day the payment could be made; 0 or less when not late. */
export function daysLate(due: string, today: string): number {
	return daysBetween(payDay(due), today);
}

/** An amount in hundred-millionths, written: «1.220,00 €». */
/** A unit price as given, with at least two decimals: 0,0125 € or 500,00 €. */
export function priceText(price: string): string {
	return unitsText(toUnits(price) ?? 0n, "EUR");
}

export function unitsText(units: bigint, currency: string): string {
	return money(fromUnits(units), currency) as string;
}

export function amountText(instalment: Instalment, currency: string): string {
	if (instalment.amount !== undefined) return money(fromUnits(instalment.amount), currency) as string;
	return instalment.amountText === undefined ? "importo non indicato" : `importo ${instalment.amountText} (non leggibile)`;
}
