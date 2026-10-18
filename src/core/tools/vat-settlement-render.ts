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

/** «il 16 novembre 2026 (il 15 cade di domenica)»: from the slip the deadline carries. */
function whenText(d: { readonly due: string; readonly date: string; readonly slip?: Slip }): string {
	if (d.slip === undefined) return withDate("il", d.date);
	return `${withDate("il", d.date)} (${withDate("il", d.due).replace(/ \d{4}$/, "")} ${offDayWhy(d.due, d.slip.holiday)})`;
}

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

/** What the person's regime allows: the forfettario has no IVA; an unknown regime is asked. */
export const FORFETTARIO = "Nel forfettario non addebiti l'IVA in fattura e non la versi: non c'è nessuna liquidazione IVA da fare. Per le tasse del forfettario posso stimare quanto mettere da parte e il prossimo F24. Per le tasse usa taxes.";
export const NO_REGIME = "Non so se chi ti scrive è in regime ordinario o forfettario: chiediglielo e salvalo nei dati dell'azienda con invoices. La liquidazione IVA vale solo per l'ordinario.";
export const NO_PERIODICITY = "Non so ancora se liquidi l'IVA ogni mese o ogni trimestre: chiedi a chi ti scrive quale delle due, e salvala.";

/** The head line of a period: what to pay and when, or why nothing. */
function headLine(l: Liquidation, d: Deadline | undefined): string {
	const of = `IVA ${periodOf(l.period)}${l.partial ? " (finora)" : ""}`;
	const annual = l.period.kind === "quarter" && l.period.n === 4;
	const code = d === undefined ? "" : `, codice tributo ${d.code}`;
	const when = d === undefined ? "" : ` ${annual ? "con il saldo annuale " : ""}entro ${whenText(d)}`;
	if (l.due > 0n) return `${of}: da versare circa ${euros(l.due)}${when}${code}.`;
	if (l.under > 0n) return `${of}: ${euros(l.under)}, sotto i ${euros(annual ? ANNUAL_MIN_CENTS : PERIODIC_MIN_CENTS)} non si versa e passa ${annual ? "all'anno dopo" : "al periodo dopo"}.`;
	if (l.credit > 0n) return `${of}: a credito di ${euros(l.credit)}, che passa ${annual ? "all'anno dopo" : "al periodo dopo"}.`;
	return `${of}: niente da versare.`;
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
	if (f.approx > 0) out.push(`${n1(f.approx, "1 fattura ricevuta senza data di ricezione", "# fatture ricevute senza data di ricezione")}: uso la data della fattura, è un'approssimazione. Se la data di ricezione SdI è un'altra, dimmela.`);
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

export type PeriodView = {
	readonly liquidation: Liquidation;
	readonly deadline?: Deadline;
	/** The deadline of the period before, still to pay. */
	readonly before?: Deadline;
	readonly left?: string;
	/** Last year's credit from the documents, when the person did not say the year's. */
	readonly lastYearCredit?: bigint;
	/** The year's IVA credit at its end, past the visto's threshold. */
	readonly bigCredit?: bigint;
};

/** A period: the head line, the figures, what is apart; no names. */
export function periodAnswer(v: PeriodView): string {
	const l = v.liquidation;
	const f = l.figures;
	const lines = [headLine(l, v.deadline)];
	if (l.paid !== undefined) lines.push(`Segnato come pagato ${withDate("il", l.paid.date)}: ${euros(scaled(l.paid.amount, 2))}.`);
	lines.push(`IVA a debito ${euros(f.debito)} (${n1(f.sales, "1 fattura emessa", "# fatture emesse")}), a credito ${euros(f.credito)} (${n1(f.purchases, "1 fattura ricevuta", "# fatture ricevute")}).`);
	if (l.carriedCredit > 0n) lines.push(`Credito dal periodo prima: ${euros(l.carriedCredit)}.`);
	if (l.carriedDue > 0n) lines.push(`Dal periodo prima, sotto il minimo e non versati: ${euros(l.carriedDue)}.`);
	if (l.acconto > 0n) lines.push(`Tolto l'acconto di dicembre: ${euros(l.acconto)}${l.accontoAssumed ? " (lo conto versato: se non l'hai versato, o hai versato un'altra cifra, dimmelo)" : ""}.`);
	if (l.interest > 0n) lines.push(`Compresi ${euros(l.interest)} di interessi dell'1% del trimestrale.`);
	lines.push(...figureNotes(l));
	if (v.before !== undefined && v.before.cents !== undefined && v.before.cents > 0n) lines.push(`Intanto ${whenText(v.before)} scade l'F24 ${f24Of(v.before)}: circa ${euros(v.before.cents)}, codice ${v.before.code}.`);
	if (v.lastYearCredit !== undefined && v.lastYearCredit > 0n) lines.push(`Dalle fatture l'anno scorso chiude a credito di ${euros(v.lastYearCredit)}: se il credito della dichiarazione è un altro, dimmelo e uso quello.`);
	if (v.bigCredit !== undefined) lines.push(creditLine(v.bigCredit));
	if (v.left !== undefined) lines.push(v.left);
	lines.push(ESTIMATE_NOTE, REPEAT);
	return lines.join("\n");
}

/** A yearly credit past the visto's threshold. */
export function creditLine(credit: bigint): string {
	return `Il credito IVA dell'anno è di ${euros(credit)}: sopra ${euros(CREDIT_VISTO_CENTS)} usarlo per pagare altre imposte richiede il visto di conformità, parlane con il commercialista.`;
}

/** One deadline in a row: when, what, how much, the code. */
function deadlineRow(d: Deadline, today: string): string {
	const amount = d.cents === undefined ? (d.kind === "acconto" ? "importo da calcolare" : "importo a fine periodo") : d.cents === 0n ? `niente da versare${d.partial ? " finora" : ""}` : `circa ${euros(d.cents)}${d.partial ? " finora" : ""}`;
	if (d.date < today) return `• Scaduto ${whenText(d)}, se non l'hai già pagato: ${deadlineWhat(d)}, ${amount}, codice ${d.code}.`;
	return `• ${capitalized(whenText(d))}: ${deadlineWhat(d)}, ${amount}, codice ${d.code}.`;
}

/** The calendar: the next F24 with an amount first, then the next rows; no names. */
export function calendarAnswer(deadlines: readonly Deadline[], today: string, rows: number, bigCredit?: bigint): string {
	const next = deadlines.find((d) => d.date >= today && d.cents !== undefined && d.cents > 0n);
	const lines: string[] = [];
	if (next === undefined) lines.push(`Nessun${deadlines.some((d) => d.date < today) ? " altro" : ""} F24 dell'IVA con un importo da versare per ora, con le fatture che vedo.`);
	else lines.push(`Il prossimo F24 dell'IVA è ${whenText(next)}: circa ${euros(next.cents as bigint)}${next.partial ? " finora" : ""} (${deadlineWhat(next)}, codice ${next.code}).`);
	const shown = deadlines.slice(0, rows);
	if (shown.length > 0) lines.push("Le prossime scadenze:", ...shown.map((d) => deadlineRow(d, today)));
	if (deadlines.length > rows) lines.push(`E altre ${deadlines.length - rows} più avanti.`);
	if (shown.some((d) => d.date < today)) lines.push("Se un F24 scaduto l'hai pagato, dimmelo; se no, parlane con il commercialista (ravvedimento operoso).");
	const deferred = shown.find((d) => d.alternative !== undefined);
	if (deferred?.alternative !== undefined) lines.push(`Il saldo annuale si può versare anche entro ${whenText({ due: deferred.alternative.date, date: deferred.alternative.date, ...(deferred.alternative.slip === undefined ? {} : { slip: deferred.alternative.slip }) })} con ${withPercent("il", deferred.alternative.percent)} in più: circa ${euros(deferred.alternative.cents)} (da verificare).`);
	if (shown.some((d) => d.slip !== undefined)) lines.push("Le scadenze di sabato, domenica o festivi slittano al primo giorno lavorativo.");
	if (bigCredit !== undefined) lines.push(creditLine(bigCredit));
	lines.push(ESTIMATE_NOTE, REPEAT);
	return lines.join("\n");
}

const NOTHING = "Niente da segnalare sull'IVA: nel brief non scrivere niente sull'IVA.";

/** The brief's line: an F24 of the IVA within the days, with its amount. No op or parameter names. */
export function briefAnswer(soon: readonly Deadline[], today: string): string {
	const rows: string[] = [];
	for (const d of soon) {
		if (d.cents === undefined || d.cents <= 0n || d.date < today) continue;
		const days = daysBetween(today, d.date);
		const inDays = days === 0 ? "oggi" : days === 1 ? "domani" : `tra ${days} giorni`;
		rows.push(`F24 ${withDate("il", d.date)} (${inDays}), circa ${euros(d.cents)} (${deadlineWhat(d)}, codice ${d.code}), stima da verificare con il commercialista.`);
	}
	if (rows.length === 0) return NOTHING;
	return `IVA: ${rows.join(" Inoltre ")} Nel brief riporta questo in una riga.`;
}

/** The acconto by each method, the smaller allowed. */
export function accontoAnswer(a: Acconto, d: Deadline, periodicity: Periodicity): string {
	const last = periodicity === "mensile" ? `dicembre ${a.year - 1}` : `4º trimestre ${a.year - 1}`;
	const lines: string[] = [];
	if (a.paid !== undefined) lines.push(`Acconto IVA ${a.year} segnato come pagato ${withDate("il", a.paid.date)}.`);
	if (a.cents === undefined) lines.push(`Acconto IVA ${a.year} entro ${whenText(d)} (codice ${d.code}): non ho ancora i dati per calcolarlo.`);
	else if (a.belowMin) lines.push(`Acconto IVA ${a.year}: niente da versare, sotto i ${euros(ACCONTO_MIN_CENTS)} non è dovuto.`);
	else lines.push(`Acconto IVA ${a.year} entro ${whenText(d)} (codice ${d.code}): circa ${euros(a.cents)}, con il metodo che costa meno.`);
	if (a.storico !== undefined) lines.push(`• Storico: 88% dell'IVA di ${last} prima dell'acconto (${euros(a.storico.base)}, ${a.storico.from === "detto" ? "come mi hai detto" : "dalle fatture"}): ${euros(a.storico.cents)}.`);
	else lines.push(`• Storico: mi serve l'IVA di ${last} prima dell'acconto (è nel registro o nella liquidazione di quel periodo): dimmela e lo calcolo.`);
	if (a.analitico !== undefined) lines.push(`• Analitico: l'IVA ${periodicity === "mensile" ? "dal 1º" : "dal 1º ottobre"} al 20 dicembre${a.analitico.partial ? ", finora" : ""}: ${euros(a.analitico.cents)}${a.analitico.partial ? " (fino al 20 dicembre può cambiare)" : ""}.`);
	else lines.push(`• Analitico: si calcola sulle fatture ${periodicity === "mensile" ? "dal 1º" : "dal 1º ottobre"} al 20 dicembre, te lo dico da allora.`);
	if (a.previsionale !== undefined) lines.push(`• Previsionale: 88% di quanto prevedi (${euros(a.previsionale.expected)}): ${euros(a.previsionale.cents)}. Attenzione: se a consuntivo risulta troppo basso, la differenza si paga con sanzioni e interessi.`);
	lines.push(`Si può scegliere il metodo che dà l'acconto più basso. Sotto i ${euros(ACCONTO_MIN_CENTS)} non si versa.`, ESTIMATE_NOTE, REPEAT);
	return lines.join("\n");
}

/** The settings in a line. */
export function settingsLine(periodicity: Periodicity): string {
	return periodicity === "mensile" ? "Liquidi l'IVA ogni mese: si versa entro il 16 del mese dopo." : "Liquidi l'IVA ogni trimestre: si versa entro il 16 maggio, il 20 agosto e il 16 novembre con l'1% di interessi, il 4º trimestre con il saldo annuale entro il 16 marzo.";
}

/** A received invoice in words, for the fence: «fattura 12 del 03/10/2026 di Fornitore Srl (P.IVA …), IVA 220,00 €». */
export function docText(d: VatDoc): string {
	const tax = d.rows.reduce((n, r) => n + r.tax, 0n);
	return `${d.credit ? "nota di credito" : "fattura"} ${d.number ?? "senza numero"} del ${italianDate(d.date)} di ${partyName(d.party)}, IVA ${euros(tax)}`;
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
		if (l.carriedCredit > 0n) add("Liquidazione", label, "", "Credito dal periodo prima", undefined, l.carriedCredit, "");
		if (l.carriedDue > 0n) add("Liquidazione", label, "", "Sotto il minimo dal periodo prima", undefined, l.carriedDue, "");
		if (l.acconto > 0n) add("Liquidazione", label, "", "Acconto di dicembre", undefined, l.acconto, l.accontoAssumed ? "contato versato" : "segnato pagato");
		if (l.interest > 0n) add("Liquidazione", label, "", "Interessi 1% trimestrale", undefined, l.interest, "");
		add("Liquidazione", label, "", l.due > 0n ? "Da versare" : l.credit > 0n ? "A credito" : "Sotto il minimo, al periodo dopo", undefined, l.due > 0n ? l.due : l.credit > 0n ? l.credit : l.under, "stimato");
	}
	for (const d of v.deadlines.filter((x) => x.cents !== 0n || x.paid !== undefined)) add("F24", d.period === undefined ? "" : capitalized(periodLabel(d.period)), italianDate(d.date), `${capitalized(deadlineWhat(d))}, codice ${d.code}`, undefined, d.cents, d.cents === undefined ? "da calcolare" : "stimato");
	for (const p of v.paid) add("F24 pagati", paidLabel(p.key), italianDate(p.date), "F24 pagato", undefined, scaled(p.amount, 2), "detto");
	add("Nota", "", "", "Stima da verificare con il commercialista", undefined, undefined, "");
	return { csv: csvFile(["Sezione", "Periodo", "Data", "Voce", "Imponibile", "IVA", "Note"], rows), rows: rows.length };
}
