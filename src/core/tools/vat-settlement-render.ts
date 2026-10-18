/**
 * La liquidazione IVA in the chat and in a CSV: a period (what to pay, when, with which code, the
 * figures under it), the calendar (the next F24 first), the acconto by each method, a what_if, the
 * settings, the deductibility marks, the brief's line. Every answer with an amount says it is an
 * estimate to check with the commercialista. Text for the person never names an op or a parameter:
 * what the model should do is a sentence of its own. Names of suppliers and customers come from
 * invoices and go only inside the fence of `fenced`; the period and calendar answers carry none
 * (another agente reads them). The CSV is made inert by csvFile.
 */
import { type CsvCell, csvCents, csvFile } from "../csv.ts";
import { offDayWhy } from "../dates.ts";
import { euros, n1 } from "../format-words.ts";
import { partyName } from "../invoices.ts";
import { daysBetween, MONTH_NAMES } from "../italian-calendar.ts";
import { capitalized, italianDate, withDate, withPercent } from "../italian-format.ts";
import { scaled } from "../quote-sums.ts";
import type { DeductMark, PaidMark } from "../vat.ts";
import type { LeftOut, VatDoc } from "../vat-docs.ts";
import { ACCONTO_MIN_CENTS, ANNUAL_MIN_CENTS, CREDIT_VISTO_CENTS, PARTIAL_EXAMPLES, PERIODIC_MIN_CENTS, type Periodicity, type VatPeriod } from "../vat-rules.ts";
import type { Acconto, Deadline, Liquidation, Slip } from "../vat-sums.ts";
import { fenced } from "./vat-settlement-input.ts";

/** Said with every answer that shows an amount. */
export const ESTIMATE_NOTE = "È una stima: verificala con il commercialista prima di pagare.";
const REPEAT = "Ripeti cifre e date come sono scritte, non rifare i conti a mente.";

/** «ottobre 2026», «3º trimestre 2026». */
export function periodLabel(p: VatPeriod): string {
	return p.kind === "month" ? `${MONTH_NAMES[p.n - 1]} ${p.year}` : `${p.n}º trimestre ${p.year}`;
}

/** What a paid mark's key says: «Settembre 2026», «3º trimestre 2026», «Acconto IVA 2026», «Saldo IVA 2025». */
function paidLabel(key: string): string {
	const [year, what = ""] = key.split("-");
	if (what === "acconto") return `Acconto IVA ${year}`;
	if (what === "annuale") return `Saldo IVA ${year}`;
	if (what.startsWith("T")) return `${what.slice(1)}º trimestre ${year}`;
	return capitalized(periodLabel({ year: Number(year), kind: "month", n: Number(what) }));
}

/** «di ottobre 2026», «del 3º trimestre 2026». */
export function periodOf(p: VatPeriod): string {
	return `${p.kind === "month" ? "di" : "del"} ${periodLabel(p)}`;
}

/** «a ottobre 2026», «nel 3º trimestre 2026»: when something counts. */
export function periodIn(p: VatPeriod): string {
	return `${p.kind === "month" ? "a" : "nel"} ${periodLabel(p)}`;
}

/** «il 28 dicembre 2026 (il 27 cade di domenica)», «il 2 novembre 2026 (il 31 ottobre cade di sabato)»: from the slip the deadline carries. */
export function whenText(d: { readonly due: string; readonly date: string; readonly slip?: Slip }): string {
	if (d.slip === undefined) return withDate("il", d.date);
	const was = withDate("il", d.due).replace(d.due.slice(0, 7) === d.date.slice(0, 7) ? / \S+ \d{4}$/ : / \d{4}$/, "");
	return `${withDate("il", d.date)} (${was} ${offDayWhy(d.due, d.slip.holiday)})`;
}

/** «il 16 ottobre»: a day of `today`'s year without the year; «il 29 dicembre 2025» another year's. */
const shortDay = (date: string, today: string) => (date.slice(0, 4) === today.slice(0, 4) ? withDate("il", date).replace(/ \d{4}$/, "") : withDate("il", date));

/** What a deadline pays for: «IVA di ottobre 2026», «acconto IVA 2026», «saldo IVA 2026». */
export function deadlineWhat(d: Deadline): string {
	if (d.kind === "acconto") return `acconto IVA ${d.year}`;
	if (d.kind === "annuale") return d.period === undefined ? `saldo IVA ${d.year}` : `saldo IVA ${d.year} con il 4º trimestre`;
	return d.period === undefined ? "IVA" : `IVA ${periodOf(d.period)}`;
}

/** «dell'IVA di settembre 2026», «dell'acconto IVA 2026», «del saldo IVA 2026». */
function f24Of(d: Deadline): string {
	if (d.kind === "acconto") return `dell'acconto IVA ${d.year}`;
	if (d.kind === "annuale") return `del ${deadlineWhat(d)}`;
	return `dell'${deadlineWhat(d)}`;
}

/** What the person's regime allows: the forfettario has no IVA; an unknown regime is asked; the periodicity is asked, with how to find it. */
export const FORFETTARIO = "Nel forfettario non addebiti l'IVA in fattura e non la versi: non c'è nessuna liquidazione IVA. Posso invece stimare quanto mettere da parte per le tasse e il prossimo F24 (con taxes).";
export const NO_REGIME = "Non so se chi ti scrive è in regime ordinario o forfettario: chiediglielo e salvalo con invoices op set_company, regime. La liquidazione IVA vale solo per l'ordinario.";
export const NO_PERIODICITY = "Non so ancora se liquidi l'IVA ogni mese o ogni trimestre: chiedilo a chi ti scrive e salvalo con vat_settlement op settings, periodicity. Se non lo sa: sugli F24 dell'IVA già pagati i codici 6001-6012 sono mensili, 6031-6033 trimestrali; o lo sa il commercialista.";

/** Where a credit goes: «dall'IVA del mese dopo», «del trimestre dopo», «dell'anno dopo». */
function nextOf(p: VatPeriod): string {
	if ((p.kind === "month" && p.n === 12) || (p.kind === "quarter" && p.n === 4)) return "dall'IVA dell'anno dopo";
	return p.kind === "month" ? "dall'IVA del mese dopo" : "dall'IVA del trimestre dopo";
}

/** The head line of a period: what to pay and when, or why nothing. */
function headLine(l: Liquidation, d: Deadline | undefined): string {
	const of = `IVA ${periodOf(l.period)}${l.partial ? " (finora)" : ""}`;
	const annual = l.period.kind === "quarter" && l.period.n === 4;
	const code = d === undefined ? "" : `, codice tributo ${d.code}`;
	const when = d === undefined ? "" : ` ${annual ? "con il saldo annuale " : ""}entro ${whenText(d)}`;
	if (l.due > 0n) return `${of}: da versare circa ${euros(l.due)}${when}${code}.`;
	if (l.under > 0n) return `${of}: ${euros(l.under)}, sotto i ${euros(annual ? ANNUAL_MIN_CENTS : PERIODIC_MIN_CENTS)} non si versa e passa ${annual ? "all'anno dopo" : "al periodo dopo"}.`;
	if (l.credit > 0n) return `${of}: niente da versare, anzi hai ${euros(l.credit)} di credito che scalo ${nextOf(l.period)}.`;
	return `${of}: niente da versare.`;
}

/** «IVA delle fatture emesse 220,00 € (1), meno IVA delle fatture ricevute 660,00 € (1).» */
function figuresLine(l: Liquidation): string {
	const f = l.figures;
	if (f.sales === 0 && f.purchases === 0) return "Nessuna fattura emessa né ricevuta nel periodo.";
	const count = (n: number) => n1(n, "1 fattura", "# fatture");
	const sold = f.sales === 0 ? "nessuna fattura emessa" : `IVA delle fatture emesse ${euros(f.debito)} (${count(f.sales)})`;
	const bought = f.purchases === 0 ? "nessuna fattura ricevuta" : `meno IVA delle fatture ricevute ${euros(f.credito)} (${count(f.purchases)})`;
	return `${capitalized(sold)}, ${bought}.`;
}

/** What the figures leave out or count apart, in short lines; no names. */
function figureNotes(l: Liquidation): string[] {
	const f = l.figures;
	const out: string[] = [];
	if (f.split !== 0n) out.push(`Split payment: ${euros(f.split)} di IVA delle fatture alla PA, la versa la PA, non tu.`);
	if (f.reverse !== 0n) out.push(`Reverse charge: ${euros(f.reverse)} di imponibile fatturato senza IVA, la versa il cliente.`);
	if (f.integration !== 0n) out.push(`Reverse charge sugli acquisti: ${euros(f.integration)} di IVA contata sia a debito sia a credito.`);
	if (f.undeducted !== 0n) out.push(`IVA non detratta per le tue indicazioni (indetraibile o in parte): ${euros(f.undeducted)}.`);
	if (f.deferred.sale !== 0n || f.deferred.purchase !== 0n) out.push(`IVA per cassa o differita non ancora pagata, non contata: ${[f.deferred.sale === 0n ? undefined : `${euros(f.deferred.sale)} a debito`, f.deferred.purchase === 0n ? undefined : `${euros(f.deferred.purchase)} a credito`].filter((x) => x !== undefined).join(", ")}; conta quando la fattura è segnata come pagata.`);
	if (f.approx > 0) out.push(`${n1(f.approx, "1 fattura ricevuta negli ultimi giorni del periodo", "# fatture ricevute negli ultimi giorni del periodo")}: le conto qui per la data della fattura; se dallo SdI è arrivata nel periodo dopo, dimmi il giorno.`);
	return out;
}

/** What could not be read, in one line. */
export function leftOutLine(left: LeftOut, unread: number): string | undefined {
	const parts = [
		left.noSide > 0 ? `${n1(left.noSide, "1 fattura", "# fatture")} senza sapere se emessa o ricevuta (mancano i dati dell'azienda)` : undefined,
		left.foreign > 0 ? `${n1(left.foreign, "1 fattura", "# fatture")} in un'altra valuta` : undefined,
		left.noDate > 0 ? `${n1(left.noDate, "1 fattura", "# fatture")} senza data` : undefined,
		left.noRows > 0 ? `${n1(left.noRows, "1 fattura", "# fatture")} senza il riepilogo IVA leggibile` : undefined,
		unread > 0 ? `${n1(unread, "1 file", "# file")} non letto ora` : undefined,
	].filter((x) => x !== undefined);
	return parts.length === 0 ? undefined : `Non contate: ${parts.join(", ")}.`;
}

/** The credit carried into a year, taken off: only the one the person said or confirmed. */
export function openingLine(year: number, cents: bigint): string {
	return `Credito IVA di inizio ${year}: ${euros(cents)}, come mi hai detto: lo scalo.`;
}

/** Last year's closing credit from the documents, proposed and never taken off until confirmed. */
export function proposalLine(year: number, cents: bigint): string {
	return `Dalle fatture che vedo il ${year - 1} chiude a credito di ${euros(cents)}: me lo confermi (è nella dichiarazione IVA)? Finché non me lo dici non lo scalo.`;
}

/** In January or the first quarter, with no credit said nor proposed. */
export function askCreditLine(year: number): string {
	return `Se a inizio ${year} avevi un credito IVA (è nella dichiarazione IVA), dimmelo e lo scalo.`;
}

/** What a period or the calendar says of the credit carried into a year: taken off as said, proposed, or asked. */
export type CreditWord = { readonly year: number; readonly said?: bigint; readonly proposed?: bigint; readonly ask?: boolean };

function creditWords(c: CreditWord | undefined): string[] {
	if (c === undefined) return [];
	if (c.said !== undefined && c.said > 0n) return [openingLine(c.year, c.said)];
	if (c.proposed !== undefined) return [proposalLine(c.year, c.proposed)];
	return c.ask === true ? [askCreditLine(c.year)] : [];
}

export type PeriodView = {
	readonly liquidation: Liquidation;
	readonly deadline?: Deadline;
	/** The deadline of the period before, still to pay. */
	readonly before?: Deadline;
	readonly left?: string;
	/** The year's IVA credit at its end, past the visto's threshold. */
	readonly bigCredit?: bigint;
	/** Last year's closing credit to confirm, or the ask in January or the first quarter. */
	readonly credit?: CreditWord;
};

/** A period: the head line, the figures, what is apart; no names. */
export function periodAnswer(v: PeriodView): string {
	const l = v.liquidation;
	const lines = [headLine(l, v.deadline)];
	if (l.paid !== undefined) lines.push(`Segnato come pagato ${withDate("il", l.paid.date)}: ${euros(scaled(l.paid.amount, 2))}.`);
	lines.push(figuresLine(l));
	if (l.openingFrom !== undefined) lines.push(openingLine(l.period.year, l.carriedCredit));
	else {
		if (l.carriedCredit > 0n) lines.push(`Credito dal periodo prima: ${euros(l.carriedCredit)}.`);
		lines.push(...creditWords(v.credit));
	}
	if (l.carriedDue > 0n) lines.push(`Dal periodo prima, sotto il minimo e non versati: ${euros(l.carriedDue)}.`);
	if (l.acconto > 0n) lines.push(`Tolto l'acconto di dicembre versato: ${euros(l.acconto)}.`);
	if (l.accontoUnpaid !== undefined) lines.push(`L'acconto di dicembre (circa ${euros(l.accontoUnpaid)}) non lo tolgo finché non è segnato pagato: se l'hai versato dimmelo.`);
	if (l.interest > 0n) lines.push(`Compresi ${euros(l.interest)} di interessi: chi liquida ogni trimestre aggiunge l'1%.`);
	lines.push(...figureNotes(l));
	if (v.before !== undefined && v.before.cents !== undefined && v.before.cents > 0n) lines.push(`Intanto ${whenText(v.before)} scade l'F24 ${f24Of(v.before)}: circa ${euros(v.before.cents)}, codice ${v.before.code}.`);
	if (v.bigCredit !== undefined) lines.push(creditLine(v.bigCredit));
	if (v.left !== undefined) lines.push(v.left);
	lines.push(ESTIMATE_NOTE, REPEAT);
	return lines.join("\n");
}

/** A yearly credit past the visto's threshold. */
export function creditLine(credit: bigint): string {
	return `Il credito IVA dell'anno è di ${euros(credit)}: sopra ${euros(CREDIT_VISTO_CENTS)} usarlo per pagare altre imposte richiede il visto di conformità, parlane con il commercialista.`;
}

/** One deadline in a row: when (and why it moved), what, how much, the code. */
function deadlineRow(d: Deadline, today: string): string {
	const amount = d.cents === undefined ? (d.kind === "acconto" ? "importo da calcolare" : "importo a fine periodo") : d.cents === 0n ? `niente da versare${d.partial ? " finora" : ""}${confirmed(d)}` : `circa ${euros(d.cents)}${d.partial ? " finora" : ""}${confirmed(d)}`;
	if (d.date < today) return `• Scaduto ${whenText(d)}, ${notYet(d)}: ${deadlineWhat(d)}, ${amount}, codice ${d.code}.`;
	return `• ${capitalized(whenText(d))}: ${deadlineWhat(d)}, ${amount}, codice ${d.code}.`;
}

/** «se non l'hai già pagato»; an acconto of a year before Annie kept the IVA «se non l'hai già versato». */
const notYet = (d: Deadline) => (d.beforeSetup === true ? "se non l'hai già versato" : "se non l'hai già pagato");

/** «, tolto il credito confermato»: a first period of a year with the credit the person said taken off. */
const confirmed = (d: Deadline) => (d.opening !== undefined && d.opening > 0n ? ", tolto il credito confermato" : "");

/** The rows a calendar shows, `rows` at most: the latest overdue one, then the next from today by date, the headline's left out. */
function shownRows(deadlines: readonly Deadline[], today: string, rows: number, headline: Deadline | undefined): Deadline[] {
	const late = deadlines.filter((d) => d.date < today).at(-1);
	const next = deadlines.filter((d) => d.date >= today && d !== headline);
	return [...(late === undefined ? [] : [late]), ...next].slice(0, rows);
}

/** The calendar: the next F24 with an amount first, then a few rows; no names. */
export function calendarAnswer(deadlines: readonly Deadline[], today: string, rows: number, o: { readonly bigCredit?: bigint; readonly credit?: CreditWord } = {}): string {
	const next = deadlines.find((d) => d.date >= today && d.cents !== undefined && d.cents > 0n);
	const lines: string[] = [];
	if (next === undefined) lines.push(`Nessun${deadlines.some((d) => d.date < today) ? " altro" : ""} F24 dell'IVA con un importo da versare per ora, con le fatture che vedo.`);
	else lines.push(`Il prossimo F24 dell'IVA è ${whenText(next)}: circa ${euros(next.cents as bigint)}${next.partial ? " finora" : ""}${confirmed(next)} (${deadlineWhat(next)}, codice ${next.code}).`);
	const shown = shownRows(deadlines, today, rows, next);
	if (shown.length > 0) lines.push(next === undefined ? "Le prossime scadenze:" : "Poi:", ...shown.map((d) => deadlineRow(d, today)));
	const more = deadlines.filter((d) => d.date >= today && d !== next && !shown.includes(d)).length;
	if (more > 0) lines.push(`E altre ${more} più avanti.`);
	if (shown.some((d) => d.date < today)) lines.push("Se un F24 scaduto l'hai pagato, dimmelo; se no, parlane con il commercialista (ravvedimento operoso).");
	const deferred = [next, ...shown].find((d) => d?.alternative !== undefined);
	if (deferred?.alternative !== undefined) lines.push(`Il saldo annuale si può versare anche entro ${whenText({ due: deferred.alternative.date, date: deferred.alternative.date, ...(deferred.alternative.slip === undefined ? {} : { slip: deferred.alternative.slip }) })} con ${withPercent("il", deferred.alternative.percent)} in più: circa ${euros(deferred.alternative.cents)}.`);
	lines.push(...creditWords(o.credit));
	if (o.bigCredit !== undefined) lines.push(creditLine(o.bigCredit));
	lines.push(ESTIMATE_NOTE, REPEAT);
	return lines.join("\n");
}

const NOTHING = "Niente da segnalare sull'IVA: nel brief non scrivere niente sull'IVA.";

/** The brief's line: an F24 of the IVA within the days, with its amount, and the last one overdue in one row. No op or parameter names. */
export function briefAnswer(soon: readonly Deadline[], today: string): string {
	const rows: string[] = [];
	for (const d of soon) {
		if (d.cents === undefined || d.cents <= 0n || d.date < today) continue;
		const days = daysBetween(today, d.date);
		const inDays = days === 0 ? "oggi" : days === 1 ? "domani" : `tra ${days} giorni`;
		rows.push(`F24 ${withDate("il", d.date)} (${inDays}), circa ${euros(d.cents)}${confirmed(d)} (${deadlineWhat(d)}, codice ${d.code}), stima da verificare con il commercialista.`);
	}
	const late = soon.filter((d) => d.date < today && d.cents !== undefined && d.cents > 0n && d.paid === undefined).at(-1);
	if (late !== undefined) rows.push(`F24 ${deadlineWhat(late)} scaduto ${shortDay(late.date, today)} (circa ${euros(late.cents as bigint)}${confirmed(late)}): ${late.beforeSetup === true ? "se non l'hai già versato, parlane con il commercialista; se l'hai versato dimmelo" : "se l'hai pagato dimmelo, se no parlane con il commercialista"}.`);
	if (rows.length === 0) return NOTHING;
	return `IVA: ${rows.join(" Inoltre ")} Nel brief riporta questo in una riga.`;
}

/** The acconto: the amount by the method that costs least, each method under it. */
export function accontoAnswer(a: Acconto, d: Deadline, periodicity: Periodicity): string {
	const last: VatPeriod = periodicity === "mensile" ? { year: a.year - 1, kind: "month", n: 12 } : { year: a.year - 1, kind: "quarter", n: 4 };
	const head = `Acconto IVA ${a.year} entro ${whenText(d)}, codice ${d.code}`;
	const lines: string[] = [];
	if (a.paid !== undefined) lines.push(`Acconto IVA ${a.year} segnato come pagato ${withDate("il", a.paid.date)}: ${euros(scaled(a.paid.amount, 2))}.`);
	const partial = a.analitico?.partial === true ? a.analitico : undefined;
	if (a.cents === undefined) {
		// No amount: the analitico is not final (or there are no documents of the year yet), and the storico's base is not known.
		lines.push(`${head}. L'importo non posso ancora dirtelo: l'analitico si chiude il 20 dicembre, e per lo storico mi serve l'IVA ${periodOf(last)}.`);
	} else if (a.belowMin) lines.push(`${head}: niente da versare, sotto i ${euros(ACCONTO_MIN_CENTS)} non è dovuto.`);
	else {
		lines.push(`${head}: circa ${euros(a.cents)} con il metodo ${a.method ?? "storico"}.`);
		if (partial !== undefined) lines.push(`L'analitico ora darebbe ${euros(partial.cents)}, ma è definitivo solo dal 20 dicembre: te lo ricalcolo allora.`);
	}
	if (a.storico !== undefined) lines.push(`• Storico: 88% dell'IVA ${periodOf(last)} prima dell'acconto (${euros(a.storico.base)}, ${a.storico.from === "detto" ? "come mi hai detto" : "dalle fatture"}): ${euros(a.storico.cents)}.`);
	if (a.analitico !== undefined && partial === undefined) lines.push(`• Analitico: l'IVA ${periodicity === "mensile" ? "dal 1º" : "dal 1º ottobre"} al 20 dicembre: ${euros(a.analitico.cents)}.`);
	if (a.previsionale !== undefined) lines.push(`• Previsionale: 88% di quanto prevedi (${euros(a.previsionale.expected)}): ${euros(a.previsionale.cents)}. Attenzione: se a consuntivo risulta troppo basso, la differenza si paga con sanzioni e interessi.`);
	lines.push(`Si può scegliere il metodo che dà l'acconto più basso. Sotto i ${euros(ACCONTO_MIN_CENTS)} non si versa.`, ESTIMATE_NOTE, REPEAT);
	return lines.join("\n");
}

/** The settings in a line. */
export function settingsLine(periodicity: Periodicity): string {
	return periodicity === "mensile" ? "Liquidi l'IVA ogni mese: si versa entro il 16 del mese dopo." : "Liquidi l'IVA ogni trimestre, con l'1% di interessi: entro il 16 maggio, il 20 agosto, il 16 novembre e, per il 4º trimestre, con il saldo annuale entro il 16 marzo.";
}

/** A received invoice in words, for the fence: «fattura 12 del 3 ottobre 2026 di Fornitore Srl (P.IVA …), IVA 220,00 €». */
export function docText(d: VatDoc): string {
	const tax = d.rows.reduce((n, r) => n + r.tax, 0n);
	return `${d.credit ? "nota di credito" : "fattura"} ${d.number ?? "senza numero"} ${withDate("del", d.date)} di ${partyName(d.party)}, IVA ${euros(tax)}`;
}

/** The deductibility marks in words, with the names the scadenzario gives them, inside the fence. */
export function marksAnswer(marks: readonly DeductMark[], nameOf: (m: DeductMark) => string): string {
	if (marks.length === 0) return `Nessuna indicazione: conto detraibile tutta l'IVA delle fatture ricevute. Si può indicare un fornitore o una fattura come indetraibile o in parte (per esempio ${PARTIAL_EXAMPLES}), e il giorno in cui una fattura è arrivata dallo SdI.`;
	const rows = marks.map((m) => {
		const share = m.percent === undefined ? undefined : m.percent === "0" ? "indetraibile" : `detraibile ${withPercent("al", m.percent)}`;
		const received = m.received === undefined ? undefined : `ricevuta ${withDate("il", m.received)}`;
		return `• ${nameOf(m)}: ${[share, received].filter((x) => x !== undefined).join(", ")}`;
	});
	return ["Le tue indicazioni sull'IVA delle fatture ricevute:", fenced(rows.join("\n"))].join("\n");
}


type CsvView = { readonly year: number; readonly docs: readonly VatDoc[]; readonly periods: readonly Liquidation[]; readonly deadlines: readonly Deadline[]; readonly paid: readonly PaidMark[] };

/** The year's documents, liquidazioni, deadlines and payments as a CSV for Excel; names made inert by csvFile. */
export function vatCsv(v: CsvView): { readonly csv: string; readonly rows: number } {
	const rows: CsvCell[][] = [];
	const add = (section: string, period: string, date: string, what: string, taxable: bigint | undefined, tax: bigint | undefined, note: string) => rows.push([section, period, date, what, taxable === undefined ? "" : csvCents(taxable), tax === undefined ? "" : csvCents(tax), note]);
	const ofYear = v.docs.filter((d) => (d.side === "purchase" ? (d.received ?? d.date) : d.date).startsWith(`${v.year}-`)).sort((a, b) => a.date.localeCompare(b.date));
	for (const d of ofYear) {
		const taxable = d.rows.reduce((n, r) => n + r.taxable, 0n);
		const tax = d.rows.reduce((n, r) => n + r.tax, 0n);
		const what = `${d.credit ? "Nota di credito" : "Fattura"} ${d.number ?? "senza numero"}, ${partyName(d.party)}`;
		const notes = [
			d.side === "sale" && d.source === "sales" ? "fattura emessa con Annie" : undefined,
			d.rows.some((r) => r.esigibilita === "S") ? "split payment" : undefined,
			d.rows.some((r) => r.natura?.startsWith("N6") === true) && !d.integration ? "reverse charge" : undefined,
			d.rows.some((r) => r.esigibilita === "D") ? "IVA differita" : undefined,
			d.integration ? "integrazione reverse charge, a debito e a credito" : undefined,
			d.percent !== undefined ? `detraibile ${d.percent}%` : undefined,
			d.side === "purchase" ? (d.received === undefined ? "data fattura, ricezione non nota" : `ricevuta il ${italianDate(d.received)}`) : undefined,
		].filter((x) => x !== undefined);
		add(d.side === "sale" ? "Vendite" : "Acquisti", "", italianDate(d.date), what, taxable, tax, notes.join("; "));
	}
	for (const l of v.periods) {
		// A period with nothing in it and nothing carried says nothing.
		if (!l.begun || (l.figures.debito === 0n && l.figures.credito === 0n && l.carriedCredit === 0n && l.carriedDue === 0n && l.acconto === 0n && l.paid === undefined)) continue;
		const label = capitalized(periodLabel(l.period)) + (l.partial ? " (finora)" : "");
		add("Liquidazione", label, "", "IVA a debito", undefined, l.figures.debito, "stimato");
		add("Liquidazione", label, "", "IVA a credito", undefined, l.figures.credito, "stimato");
		if (l.carriedCredit > 0n && l.openingFrom === undefined) add("Liquidazione", label, "", "Credito dal periodo prima", undefined, l.carriedCredit, "");
		if (l.carriedDue > 0n) add("Liquidazione", label, "", "Sotto il minimo dal periodo prima", undefined, l.carriedDue, "");
		if (l.acconto > 0n) add("Liquidazione", label, "", "Acconto di dicembre", undefined, l.acconto, "segnato pagato");
		if (l.accontoUnpaid !== undefined) add("Liquidazione", label, "", "Acconto di dicembre non segnato pagato, non tolto", undefined, l.accontoUnpaid, "stimato");
		if (l.openingFrom !== undefined) add("Liquidazione", label, "", "Credito di inizio anno", undefined, l.carriedCredit, "detto");
		if (l.interest > 0n) add("Liquidazione", label, "", "Interessi 1% trimestrale", undefined, l.interest, "");
		add("Liquidazione", label, "", l.due > 0n ? "Da versare" : l.credit > 0n ? "A credito" : "Sotto il minimo, al periodo dopo", undefined, l.due > 0n ? l.due : l.credit > 0n ? l.credit : l.under, "stimato");
	}
	for (const d of v.deadlines.filter((x) => x.cents !== 0n || x.paid !== undefined)) add("F24", d.period === undefined ? "" : capitalized(periodLabel(d.period)), italianDate(d.date), `${capitalized(deadlineWhat(d))}, codice ${d.code}`, undefined, d.cents, d.cents === undefined ? "da calcolare" : "stimato");
	for (const p of v.paid) add("F24 pagati", paidLabel(p.key), italianDate(p.date), "F24 pagato", undefined, scaled(p.amount, 2), "detto");
	add("Nota", "", "", "Stima da verificare con il commercialista", undefined, undefined, "");
	return { csv: csvFile(["Sezione", "Periodo", "Data", "Voce", "Imponibile", "IVA", "Note"], rows), rows: rows.length };
}
