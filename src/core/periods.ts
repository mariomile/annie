/**
 * The periods a person asks about: a day («oggi», «ieri»), an Italian week, Monday to Sunday
 * («questa settimana», «settimana scorsa»), a month («ottobre», «2026-10»), a quarter («T3
 * 2026»), a year («2026») or the year so far («da inizio anno»), with the one before to compare against and how
 * Italian names them («di ottobre», «ad aprile», «nel 3º trimestre»). A month or a quarter without
 * a year is the latest one begun: spese and ore di lavoro are of the past. Shared by the expenses
 * and the timesheet.
 */
import { DateError, isoWeek, parseMonth } from "./dates.ts";
import { addDays, daysBetween, daysInMonth, isoDate, MONTH_NAMES, realDate, weekdayOf } from "./italian-calendar.ts";
import { italianDate } from "./italian-format.ts";
import { halfUp } from "./quote-sums.ts";
import { fold } from "./text-match.ts";

/** A period that does not read: its message is said to the person as it is. */
export class PeriodError extends Error {
	override readonly name = "PeriodError";
}

export type PeriodKind = "day" | "week" | "month" | "quarter" | "year" | "ytd";

/** A span of whole days, both ends included, with how a person names it and how a file does. */
export type Period = {
	readonly kind: PeriodKind;
	readonly from: string;
	readonly to: string;
	/** «18/10/2026», «settimana dal 12/10/2026 al 18/10/2026», «ottobre 2026», «3º trimestre 2026», «2026», «2026 fino al 18/10». */
	readonly label: string;
	/** «di ottobre 2026», «del 3º trimestre 2026», «del 2026». */
	readonly of: string;
	/** «a ottobre 2026», «ad aprile 2026», «nel 3º trimestre 2026», «nel 2026». */
	readonly in: string;
	/** «2026-10-18», «2026-S42», «2026-10», «2026-T3», «2026», «2026-inizio-anno»: digits, letters and «-» only, safe in a file name. */
	readonly slug: string;
};

/** «ad aprile», «ad agosto», «a ottobre»: «ad» only before an «a». */
const a = (word: string) => (word.startsWith("a") ? `ad ${word}` : `a ${word}`);

function dayPeriod(date: string): Period {
	const label = italianDate(date);
	return { kind: "day", from: date, to: date, label, of: `del ${label}`, in: `il ${label}`, slug: date };
}

/** The Italian week, Monday to Sunday, of `date`. */
function weekPeriod(date: string): Period {
	const from = addDays(date, -((weekdayOf(date) + 6) % 7));
	const to = addDays(from, 6);
	const label = `settimana dal ${italianDate(from)} al ${italianDate(to)}`;
	const w = isoWeek(from);
	return { kind: "week", from, to, label, of: `della ${label}`, in: `nella ${label}`, slug: `${w.year}-S${String(w.week).padStart(2, "0")}` };
}

function monthPeriod(year: number, month: number): Period {
	const label = `${MONTH_NAMES[month - 1]} ${year}`;
	return {
		kind: "month",
		from: isoDate(year, month, 1),
		to: isoDate(year, month, daysInMonth(year, month)),
		label,
		of: `di ${label}`,
		in: a(label),
		slug: `${year}-${String(month).padStart(2, "0")}`,
	};
}

function quarterPeriod(year: number, quarter: number): Period {
	const first = (quarter - 1) * 3 + 1;
	const label = `${quarter}º trimestre ${year}`;
	return { kind: "quarter", from: isoDate(year, first, 1), to: isoDate(year, first + 2, daysInMonth(year, first + 2)), label, of: `del ${label}`, in: `nel ${label}`, slug: `${year}-T${quarter}` };
}

function yearPeriod(year: number): Period {
	return { kind: "year", from: isoDate(year, 1, 1), to: isoDate(year, 12, 31), label: String(year), of: `del ${year}`, in: `nel ${year}`, slug: String(year) };
}

/** From the 1st of January to `to`. */
function yearToDate(to: string): Period {
	const year = to.slice(0, 4);
	const day = `${to.slice(8, 10)}/${to.slice(5, 7)}`;
	return { kind: "ytd", from: `${year}-01-01`, to, label: `${year} fino al ${day}`, of: `del ${year} fino al ${day}`, in: `nel ${year} fino al ${day}`, slug: `${year}-inizio-anno` };
}

/** The period of `today`'s month. */
export function currentMonth(today: string): Period {
	return monthPeriod(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
}

const quarterOf = (date: string) => Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;

const QUARTER = /^(?:(\d{4})\s*[- ]?\s*)?(?:t|q|trim(?:estre)?\.?\s*)\s*([1-4])(?:\s*[- /]?\s*(\d{4}))?$/;
const QUARTER_WORDS = /^(primo|secondo|terzo|quarto|[1-4]\s*(?:o|°|º)?)\s+trimestre(?:\s+(?:del\s+)?(\d{4}))?$/;
const ORDINALS: Readonly<Record<string, number>> = { primo: 1, secondo: 2, terzo: 3, quarto: 4 };
/** «10/25», «10-25»: a month and a two-digit year. */
const MONTH_SHORT_YEAR = /^(\d{1,2})[/.-](\d{2})$/;

/** The text, back in an error only when it is plain: letters, digits, spaces and a few signs. */
const PERIOD_WORD = new RegExp(`\\b(?:settimana|mese|trimestre|anno|${MONTH_NAMES.join("|")})\\b`);

/** The text, back in an error only when it is plain and looks like a period: a digit, or a month, «mese», «trimestre», «anno». */
function said(text: string): string {
	const t = text.trim();
	const plain = t.length > 0 && t.length <= 40 && /^[\p{L}\p{N} '/.°º-]+$/u.test(t);
	return plain && (/\d/.test(t) || PERIOD_WORD.test(fold(t))) ? ` «${t}»` : "";
}

/**
 * A period as a person writes it: «oggi», «ieri», «questa settimana», «settimana scorsa», «ottobre», «ottobre 2025», «ottobre 25», «2026-10», «10/2026»,
 * «10/25», «T3 2026», «Q3», «3° trimestre», «terzo trimestre 2026», «2026», «mese», «mese
 * scorso», «trimestre», «trimestre scorso», «ultimo trimestre», «anno», «anno scorso», «da inizio
 * anno». A month or a quarter without a year is the latest one begun (this one or before).
 * PeriodError otherwise.
 */
export function readPeriod(text: string, today: string): Period {
	const t = fold(text).replace(/\s+/g, " ").trim();
	const year = Number(today.slice(0, 4));
	const thisQuarter = quarterPeriod(year, quarterOf(today));
	if (t === "oggi") return dayPeriod(today);
	if (t === "ieri") return dayPeriod(addDays(today, -1));
	if (t === "settimana" || t === "questa settimana" || t === "settimana corrente") return weekPeriod(today);
	if (t === "settimana scorsa" || t === "la settimana scorsa" || t === "scorsa settimana" || t === "ultima settimana") return weekPeriod(addDays(today, -7));
	if (t === "" || t === "mese" || t === "questo mese" || t === "mese corrente") return currentMonth(today);
	if (t === "mese scorso" || t === "ultimo mese") return previousPeriod(currentMonth(today));
	if (t === "trimestre" || t === "questo trimestre" || t === "trimestre corrente") return thisQuarter;
	if (t === "trimestre scorso" || t === "ultimo trimestre") return previousPeriod(thisQuarter);
	if (t === "anno" || t === "quest'anno" || t === "anno corrente") return yearPeriod(year);
	if (t === "anno scorso") return yearPeriod(year - 1);
	if (/^(?:da|dall'?) ?inizio (?:d(?:ell)?'? ?)?anno$/.test(t)) return yearToDate(today);
	const yearOnly = /^(?:anno )?(\d{4})$/.exec(t);
	if (yearOnly !== null) return yearPeriod(checkedYear(Number(yearOnly[1]), text));
	const q = QUARTER.exec(t);
	const w = q === null ? QUARTER_WORDS.exec(t) : null;
	if (q !== null || w !== null) {
		const quarter = q !== null ? Number(q[2]) : (ORDINALS[(w as RegExpExecArray)[1] as string] ?? Number.parseInt((w as RegExpExecArray)[1] as string, 10));
		const written = q !== null ? (q[1] ?? q[3]) : (w as RegExpExecArray)[2];
		const y = written === undefined ? (quarter > quarterOf(today) ? year - 1 : year) : Number(written);
		return quarterPeriod(checkedYear(y, text), quarter);
	}
	const short = MONTH_SHORT_YEAR.exec(t);
	if (short !== null) {
		const month = Number(short[1]);
		if (month < 1 || month > 12) throw new PeriodError(`non riconosco il periodo${said(text)}: ${month} non è un mese`);
		const y = 2000 + Number(short[2]);
		// «12-99» is no 2099; a month to come has no expenses: said, with how to write it.
		if (y > year || (y === year && month > Number(today.slice(5, 7)))) throw new PeriodError(`il periodo${said(text)} non è ancora cominciato: scrivi il mese con l'anno per intero, come 10/${year} o ottobre ${year}`);
		return monthPeriod(y, month);
	}
	try {
		const parsed = parseMonth(text, today);
		// With a year written (four digits or two), that one; without, the latest month begun.
		const y = /\d/.test(t) ? parsed.year : parsed.month <= Number(today.slice(5, 7)) ? year : year - 1;
		return monthPeriod(checkedYear(y, text), parsed.month);
	} catch (error) {
		if (error instanceof DateError) throw new PeriodError(`non riconosco il periodo${said(text)}: scrivilo come «ottobre», «ottobre 2026», «T3 2026», «2026», «da inizio anno» o «settimana scorsa»`);
		throw error;
	}
}

function checkedYear(year: number, text: string): number {
	if (year < 2000 || year > 2100) throw new PeriodError(`l'anno nel periodo${said(text)} non va: dal 2000 al 2100`);
	return year;
}

/** The period before, of the same kind: September for October, T2 for T3, 2025 for 2026, the same days of last year for the year so far. */
export function previousPeriod(p: Period): Period {
	const year = Number(p.from.slice(0, 4));
	const month = Number(p.from.slice(5, 7));
	if (p.kind === "day") return dayPeriod(addDays(p.from, -1));
	if (p.kind === "week") return weekPeriod(addDays(p.from, -7));
	if (p.kind === "ytd") {
		const same = `${year - 1}${p.to.slice(4)}`;
		return yearToDate(realDate(same) ? same : `${year - 1}-02-28`);
	}
	if (p.kind === "year") return yearPeriod(year - 1);
	if (p.kind === "quarter") return quarterOf(p.from) === 1 ? quarterPeriod(year - 1, 4) : quarterPeriod(year, quarterOf(p.from) - 1);
	return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
}

/** «del giorno prima», «della settimana prima», «del mese prima», «del trimestre prima», «dell'anno prima». */
export function unitBefore(p: Period): string {
	const words: Readonly<Record<PeriodKind, string>> = { day: "del giorno prima", week: "della settimana prima", month: "del mese prima", quarter: "del trimestre prima", year: "dell'anno prima", ytd: "dell'anno prima" };
	return words[p.kind];
}

/** The period of a tool's `period` argument: this month when not given. PeriodError when it is no text or does not read. */
export function periodOf(value: unknown, today: string): Period {
	if (value !== undefined && typeof value !== "string") throw new PeriodError("period è un testo, come «ottobre» o «T3 2026»");
	return typeof value === "string" ? readPeriod(value.slice(0, 40), today) : currentMonth(today);
}

export function inPeriod(date: string, p: Pick<Period, "from" | "to">): boolean {
	return date >= p.from && date <= p.to;
}

/** Whether the period is still under way: today is in it and not its last day. */
export function underWay(p: Period, today: string): boolean {
	return inPeriod(today, p) && today !== p.to;
}

/** A span of days: the period, or the part of it up to today. */
export type Span = { readonly from: string; readonly to: string };

/**
 * What a period is compared with. A period that is over: the whole period before. One under way
 * (today inside it): its days up to today, against as many days of the one before, from its start
 * and never past its end («dal 1 al 18 ottobre» against «dal 1 al 18 settembre»).
 */
export function comparedSpans(p: Period, today: string): { readonly now: Span; readonly before: Span; readonly partial: boolean } {
	const prev = previousPeriod(p);
	if (!underWay(p, today)) return { now: { from: p.from, to: p.to }, before: { from: prev.from, to: prev.to }, partial: false };
	const days = daysBetween(p.from, today);
	const end = addDays(prev.from, days);
	return { now: { from: p.from, to: today }, before: { from: prev.from, to: end > prev.to ? prev.to : end }, partial: true };
}

/** «+12,5%» or «-3%» from `before` to `now`, to one decimal, half away from zero; undefined when before is zero. */
export function percentChange(now: bigint, before: bigint): string | undefined {
	if (before === 0n) return undefined;
	const diff = now - before;
	const abs = diff < 0n ? -diff : diff;
	const tenths = halfUp(abs * 1000n, before);
	const text = `${tenths / 10n}${tenths % 10n === 0n ? "" : `,${tenths % 10n}`}`;
	return `${diff < 0n ? "-" : "+"}${text}%`;
}
