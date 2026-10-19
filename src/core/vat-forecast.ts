/**
 * The F24 of the IVA for la previsione di cassa, read only and pure: from what la liquidazione IVA
 * keeps (vat.json) and the documents the other registers read, the calendar's payments with an
 * amount from today to the end of the forecast. Only for the regime ordinario, and only when the
 * person said the periodicity: never guessed.
 */
import type { Invoice } from "./invoices.ts";
import { MONTH_NAMES } from "./italian-calendar.ts";
import { italianDate } from "./italian-format.ts";
import type { SalesInvoice } from "./sales-invoices.ts";
import { vatDocs } from "./vat-docs.ts";
import type { VatBook } from "./vat-store.ts";
import type { VatPeriod } from "./vat-rules.ts";
import { type Deadline, type VatInputs, type VatPayment, vatPayments } from "./vat-sums.ts";

/** «ottobre 2026», «3º trimestre 2026». */
export function periodLabel(p: VatPeriod): string {
	return p.kind === "month" ? `${MONTH_NAMES[p.n - 1]} ${p.year}` : `${p.n}º trimestre ${p.year}`;
}

/** «di ottobre 2026», «del 3º trimestre 2026». */
export function periodOf(p: VatPeriod): string {
	return `${p.kind === "month" ? "di" : "del"} ${periodLabel(p)}`;
}

/** What a deadline pays for: «IVA di ottobre 2026», «acconto IVA 2026», «saldo IVA 2026». */
export function deadlineWhat(d: Deadline): string {
	if (d.kind === "acconto") return `acconto IVA ${d.year}`;
	if (d.kind === "annuale") return d.period === undefined ? `saldo IVA ${d.year}` : `saldo IVA ${d.year} con il 4º trimestre`;
	return d.period === undefined ? "IVA" : `IVA ${periodOf(d.period)}`;
}

/**
 * «F24 IVA di ottobre 2026 (stima)», «F24 IVA del 3º trimestre 2026 (stima)», «F24 acconto IVA
 * 2026 (stima)», «F24 saldo IVA 2025 (stima)»; one gone by before `today` «F24 IVA di settembre
 * 2026, scaduto il 16/10 (stima)»; the first of a year with the credit the person confirmed taken off.
 */
export function vatWhat(d: Deadline, today?: string): string {
	const p = d.period;
	const what = d.kind === "acconto" ? `acconto IVA ${d.year}` : d.kind === "annuale" ? `saldo IVA ${d.year}` : p === undefined ? "IVA" : p.kind === "month" ? `IVA di ${MONTH_NAMES[p.n - 1]} ${p.year}` : `IVA del ${p.n}º trimestre ${p.year}`;
	const late = today !== undefined && d.date < today ? `, scaduto il ${italianDate(d.date).slice(0, 5)}` : "";
	const credit = d.opening !== undefined && d.opening > 0n ? ", tolto il credito confermato" : "";
	return `F24 ${what}${late} (stima${credit})`;
}

type VatSources = { readonly book: VatBook; readonly sales: readonly SalesInvoice[]; readonly register: readonly Invoice[]; readonly dayOf: (at: string) => string; readonly today: string };

/** What the calendar of la liquidazione IVA reads, from its store and the documents; undefined without the periodicity or with a broken store. */
export function vatInputsOf(o: VatSources): VatInputs | undefined {
	if (o.book.broken || o.book.settings === undefined) return undefined;
	const { docs } = vatDocs(o.sales, o.register, o.book.marks, o.dayOf);
	return { docs, periodicity: o.book.settings.periodicity, paid: o.book.paid, years: o.book.years, today: o.today, since: o.dayOf(o.book.settings.at) };
}

/** The estimated F24 of the IVA from `today` to `end`; none without the periodicity or with a broken store. */
export function vatForecast(o: VatSources & { readonly end: string }): VatPayment[] {
	const inputs = vatInputsOf(o);
	return inputs === undefined ? [] : vatPayments(inputs, o.end, (d) => vatWhat(d, o.today));
}
