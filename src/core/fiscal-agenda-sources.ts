/**
 * What each register says about its deadlines, as agenda items (fiscal-agenda.ts), through its own
 * pure functions and never a rule of its own: the taxes' calendar (tax-sums.ts calendar, or its
 * plain dates without a forfettario's profile), the liquidazione IVA's (vat-sums.ts calendar), the
 * CU's deadline (withholding-rules.ts cuDeadline), the renewals' agenda (renewal-dates.ts agendaOf),
 * the scadenzario's open instalments to pay (invoices.ts), the generic rules
 * (fiscal-agenda-rules.ts) and the bollo of the fatture in uscita. Pure: the stores are read by the
 * tool and passed in, with today and the window's last day.
 */
import { dueSlip } from "./dates.ts";
import { type AgendaItem, AGENDA_LIMITS } from "./fiscal-agenda.ts";
import { bolloDeadlines, BOLLO_CENTS, genericDeadlines, type Applies, type QuarterBollo, type RuleDeadline } from "./fiscal-agenda-rules.ts";
import { payDay } from "./invoice-sums.ts";
import { type Invoice, partyName } from "./invoices.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { scaled, unitsToCents } from "./quote-sums.ts";
import { agendaOf, amountAt } from "./renewal-dates.ts";
import { type Renewal, renewalName } from "./renewals.ts";
import { salesTotals } from "./sales-invoice-sums.ts";
import { isIssued, type SalesInvoice } from "./sales-invoices.ts";
import { calendar as taxCalendar, deadlineWhat as taxWhat, dueCents, hasUnknown, PLAIN_WHAT, plainCalendar, yearIncassi } from "./tax-sums.ts";
import type { TaxProfile, YearFigures } from "./taxes.ts";
import { deadlineWhat as vatWhat } from "./vat-forecast.ts";
import { calendar as vatCalendar, type VatInputs } from "./vat-sums.ts";
import type { WithheldDoc } from "./withholding-docs.ts";
import { CU_DUE, cuDeadline } from "./withholding-rules.ts";

const yearOf = (day: string) => Number(day.slice(0, 4));

/** The days from `today` to `to`, both included; 0 when `to` is before today. */
const daysTo = (today: string, to: string) => (to < today ? 0 : daysBetween(today, to) + 1);

/** The same F24 of the IVA from the taxes' plain dates and from the liquidazione: one, by its written day. */
const ivaKey = (due: string) => `iva:${due}`;

export type TaxSource = {
	readonly profile?: TaxProfile;
	readonly figures: readonly YearFigures[];
	readonly invoices: readonly Invoice[];
	readonly dayOf: (at: string) => string;
	readonly ordinario: boolean;
	/** The ordinario said the IVA's periodicity: the liquidazione knows every F24 of the IVA, paid or not, so the plain IVA dates are left to it. */
	readonly vatSettings: boolean;
};

/**
 * The taxes: with a forfettario's profile, the calendar's F24 with their estimate (the taxes' brief
 * line says them); otherwise the plain dates without amounts: the imposte of June and November
 * and, for the ordinario without the IVA's periodicity, the annual IVA. The plain quarterly IVA is
 * left out: it would guess the periodicity, which only the liquidazione knows (vatItems); with the
 * periodicity every IVA date is the liquidazione's, which knows what is paid and what is nothing.
 */
export function taxItems(s: TaxSource, today: string, to: string): AgendaItem[] {
	const days = daysTo(today, to);
	if (days === 0) return [];
	if (s.profile !== undefined && !s.ordinario) {
		const inputs = { profile: s.profile, figures: s.figures, incassi: yearIncassi(s.invoices, today, s.dayOf), today };
		return taxCalendar(inputs, days, today).map((d): AgendaItem => {
			const cents = dueCents(d);
			return {
				source: "tasse",
				key: `tasse:${d.kind}:${d.due}`,
				due: d.due,
				date: d.date,
				...(d.slip === undefined ? {} : { slip: d.slip }),
				what: `F24 ${taxWhat(d)}`,
				...(cents > 0n ? { cents, estimate: true } : {}),
				...(hasUnknown(d) ? { partial: true } : {}),
				...(d.late === undefined ? {} : { note: `se non l'hai già pagato, con lo ${d.late.extra.replace(".", ",")}% in più` }),
				tracked: false,
				brief: false,
			};
		});
	}
	return plainCalendar(today, s.ordinario, days)
		.filter((d) => d.what !== "iva_trimestrale" && !(d.what === "iva_annuale" && s.vatSettings))
		.map((d): AgendaItem => ({
			source: "tasse",
			key: `tasse:${d.what}:${d.due}`,
			...(d.what === "iva_annuale" ? { dedup: ivaKey(d.due) } : {}),
			due: d.due,
			date: d.date,
			...(d.slip === undefined ? {} : { slip: d.slip }),
			what: `F24 ${PLAIN_WHAT[d.what]}`,
			tracked: false,
			brief: true,
		}));
}

/** The F24 of the IVA of the ordinario, with their estimate, not marked paid; one gone by up to the calendar's own days, «scaduto». The IVA's brief line says them. */
export function vatItems(inputs: VatInputs, to: string): AgendaItem[] {
	const days = daysTo(inputs.today, to);
	if (days === 0) return [];
	// Nothing to pay (under the minimum, a credit) on a period over: no F24. One under way with nothing so far: its amount is still to come.
	return vatCalendar(inputs, days, inputs.today)
		.filter((d) => d.partial || d.cents === undefined || d.cents > 0n)
		.map((d): AgendaItem => ({
			source: "iva",
			key: `iva:${d.key}`,
			dedup: ivaKey(d.due),
			due: d.due,
			date: d.date,
			...(d.slip === undefined ? {} : { slip: d.slip }),
			what: `F24 ${vatWhat(d)}`,
			...(d.cents === undefined || d.cents <= 0n ? {} : { cents: d.cents, estimate: true }),
			...(d.partial ? { partial: true } : {}),
			code: d.code,
			...(d.beforeSetup === true ? { note: "se non l'hai già versato" } : {}),
			tracked: true,
			...(d.date < inputs.today ? { overdue: true } : {}),
			brief: false,
		}));
}

/**
 * The CU the clients give by their deadline, for the years with compensi under a ritenuta (paid in
 * the year, or dated in it when not paid yet): a deadline to know, not a payment. The withholding's
 * brief line speaks only once it is gone; before, this one.
 */
export function cuItems(docs: readonly WithheldDoc[], from: string, to: string): AgendaItem[] {
	const out: AgendaItem[] = [];
	for (let year = yearOf(from) - 1; year <= yearOf(to); year++) {
		const day = cuDeadline(year);
		if (day < from || day > to) continue;
		if (!docs.some((d) => !d.credit && d.ritenuta > 0n && (d.paidOn ?? d.date).startsWith(`${year}-`))) continue;
		out.push({ source: "ritenute", key: `cu:${year}`, due: `${year + 1}-${CU_DUE}`, date: day, what: `CU dei clienti per i compensi del ${year}: devono arrivarti entro questo giorno`, tracked: false, brief: true });
	}
	return out;
}

/** One renewal's payment, at its own price. */
function renewalItem(r: Renewal, date: string, kind: string, what: string, today: string, o: { readonly amount?: boolean; readonly tracked?: boolean } = {}): AgendaItem {
	const amount = o.amount === false ? undefined : amountAt(r, date);
	return {
		source: "rinnovi",
		key: `rinnovi:${r.id}:${kind}:${date}`,
		due: date,
		date,
		what,
		name: renewalName(r),
		...(amount === undefined ? {} : { cents: scaled(amount, 2) }),
		tracked: o.tracked === true,
		...(o.tracked === true && date < today ? { overdue: true } : {}),
		brief: false,
	};
}

/** The renewals' agenda from today to `to`, each payment on its day; one gone by without the person's word is «scaduto». The renewals' brief line says them. */
export function renewalItems(renewals: readonly Renewal[], today: string, to: string): AgendaItem[] {
	if (to < today) return [];
	const a = agendaOf(renewals, today, to);
	const out: AgendaItem[] = [];
	for (const i of a.overdue) out.push(renewalItem(i.renewal, i.date, "scadenza", "rinnovo da pagare o da disdire", today, { tracked: true }));
	for (const i of a.toPay) for (const p of i.payments) out.push(renewalItem(i.renewal, p, "pagamento", "rinnovo da pagare", today, { tracked: true }));
	for (const i of a.renews) for (const p of i.payments) out.push(renewalItem(i.renewal, p, "rinnovo", "rinnovo automatico, poi da pagare", today));
	for (const i of a.charges) for (const p of i.payments) out.push(renewalItem(i.renewal, p, "addebito", "addebito automatico del rinnovo", today));
	for (const i of a.cancelBy) out.push(renewalItem(i.renewal, i.date, "disdetta", "ultimo giorno per la disdetta del rinnovo", today, { amount: false }));
	for (const i of a.trials) out.push(renewalItem(i.renewal, i.date, "prova", "fine della prova gratuita", today));
	return out;
}

/**
 * The scadenzario's open instalments to pay (the company is the customer), by the day the payment
 * can be made, up to `to`; one gone by is «scaduta, non segnata pagata». Credit notes and
 * autofatture aside; another currency without its amount.
 */
export function invoiceItems(invoices: readonly Invoice[], today: string, to: string): AgendaItem[] {
	const out: AgendaItem[] = [];
	for (const invoice of invoices) {
		if (invoice.side !== "passive" || invoice.credit || invoice.doc.integration) continue;
		const count = invoice.instalments.length;
		for (const s of invoice.instalments) {
			if (s.paid !== undefined || s.extra === true || s.due === undefined) continue;
			const date = payDay(s.due);
			if (date > to) continue;
			const euro = invoice.doc.currency === "EUR" && s.amount !== undefined && s.amount > 0n;
			out.push({
				source: "fatture",
				key: `fatture:${invoice.key}:${s.n}`,
				due: s.due,
				...dueSlip(s.due),
				date,
				what: count > 1 ? `fattura da pagare, rata ${s.n} di ${count}` : "fattura da pagare",
				name: `${partyName(invoice.supplier)}${invoice.doc.number === undefined ? "" : `, n. ${invoice.doc.number}`}`,
				...(euro ? { cents: unitsToCents(s.amount as bigint) } : {}),
				tracked: true,
				...(date < today ? { overdue: true } : {}),
				brief: false,
			});
		}
	}
	return out;
}

const QUARTER_WORDS = ["1º", "2º", "3º", "4º"] as const;

/** A generic deadline in words. */
function ruleWhat(d: RuleDeadline): { readonly what: string; readonly note?: string } {
	const quarters = (d.quarters ?? []).map((q) => QUARTER_WORDS[q - 1]);
	const span = quarters.length > 1 ? `del ${quarters.slice(0, -1).join(", ")} e ${quarters.at(-1)} trimestre ${d.year}` : `del ${quarters[0] ?? ""} trimestre ${d.year}`;
	switch (d.kind) {
		case "redditi":
			return { what: `dichiarazione dei redditi ${d.year} (modello Redditi, invio online)` };
		case "iva_annuale":
			return { what: `dichiarazione IVA ${d.year}` };
		case "lipe":
			return { what: `comunicazione delle liquidazioni IVA (LIPE) ${span}`, ...(d.quarters?.includes(4) === true ? { note: "o dentro la dichiarazione IVA, se la mandi entro febbraio" } : {}) };
		case "camerale":
			return { what: `diritto annuale della Camera di Commercio ${d.year}`, note: "importo fisso della tua Camera, con l'F24 delle imposte" };
		case "bollo":
			return { what: `F24 imposta di bollo sulle fatture elettroniche ${span}`, note: `${d.count === 1 ? "1 fattura" : `${d.count} fatture`} con il bollo emesse con me${d.partial === true ? ", finora" : ""}` };
	}
}

function ruleItem(d: RuleDeadline): AgendaItem {
	const w = ruleWhat(d);
	return {
		source: "regole",
		key: d.key,
		due: d.due,
		date: d.date,
		...(d.slip === undefined ? {} : { slip: d.slip }),
		what: w.what,
		...(w.note === undefined ? {} : { note: w.note }),
		...(d.cents === undefined ? {} : { cents: d.cents, estimate: true }),
		...(d.partial === true ? { partial: true } : {}),
		...(d.code === undefined ? {} : { code: d.code }),
		tracked: false,
		brief: true,
	};
}

/** The generic deadlines as they apply, from `from` to `to` (only from today: their payment is not tracked). */
export function ruleItems(a: Applies, from: string, to: string): AgendaItem[] {
	const out: AgendaItem[] = [];
	for (let year = yearOf(from); year <= yearOf(to); year++) for (const d of genericDeadlines(year, a)) if (d.date >= from && d.date <= to) out.push(ruleItem(d));
	return out;
}

/** The bollo of the fatture in uscita issued with Annie, by the quarter of their date: 2,00 € each that bears it. */
export function bolloOf(sales: readonly SalesInvoice[], today: string): (year: number) => (quarter: 1 | 2 | 3 | 4) => QuarterBollo {
	const issued = sales.filter(isIssued).filter((i) => salesTotals(i).bollo.due);
	return (year) => (quarter) => {
		const first = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
		const next = quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(quarter * 3 + 1).padStart(2, "0")}-01`;
		const count = issued.filter((i) => i.date >= first && i.date < next).length;
		return { cents: BOLLO_CENTS * BigInt(count), count, partial: addDays(next, -1) >= today };
	};
}

/** The bollo's F24 from `from` to `to`, on the invoices issued with Annie. */
export function bolloItems(sales: readonly SalesInvoice[], today: string, from: string, to: string): AgendaItem[] {
	const of = bolloOf(sales, today);
	const out: AgendaItem[] = [];
	for (let year = yearOf(from) - 1; year <= yearOf(to); year++) for (const d of bolloDeadlines(year, of(year))) if (d.date >= from && d.date <= to) out.push(ruleItem(d));
	return out;
}

/** The overdue window of an answer: open deadlines gone by are said from here. */
export function overdueFrom(today: string, periodFrom?: string): string {
	return periodFrom ?? addDays(today, -AGENDA_LIMITS.overdueDays);
}
