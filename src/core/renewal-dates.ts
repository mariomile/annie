/**
 * The dates of the renewals: how often (a period in months, from the person's words), the next
 * due date as said, rolling it on by a period with the day of the month kept, the disdetta
 * deadline and when a renewal starts being said. Pure functions on YYYY-MM-DD; «today» is passed
 * in (the instance's time zone, italian-calendar.ts' todayIn).
 *
 * Choices, tested:
 * - A date without a year («il 12 marzo») is its next occurrence from today on (today included):
 *   a renewal is ahead, the opposite of a spesa. An explicit date already gone is refused: a past
 *   due date is not a next due date.
 * - A month without a day («a giugno», «ogni anno a giugno») is the month's last day, kept as the
 *   end of the month on every roll (day 31): said back, to be corrected with the day if it is
 *   another. «inizio giugno» is the 1st, «metà giugno» the 15th.
 * - Rolling adds whole periods to the due date, never to today, and keeps the anchor day: 31/01
 *   monthly is 28/02 (29 in a leap year), then 31/03 again.
 */
import { addMonths, DateError, inRange, parseMonth, readDate } from "./dates.ts";
import { addDays, daysInMonth, isoDate } from "./italian-calendar.ts";
import { italianDate } from "./italian-format.ts";
import { RENEWAL_LIMITS, type Renewal } from "./renewals.ts";
import { fold } from "./text-match.ts";

export type Problem = { readonly problem: string };

const NAMED_MONTHS: Readonly<Record<string, number>> = {
	mensile: 1,
	mensili: 1,
	mensilmente: 1,
	mese: 1,
	bimestrale: 2,
	bimestrali: 2,
	bimestre: 2,
	trimestrale: 3,
	trimestrali: 3,
	trimestre: 3,
	quadrimestrale: 4,
	quadrimestre: 4,
	semestrale: 6,
	semestrali: 6,
	semestre: 6,
	annuale: 12,
	annuali: 12,
	annuo: 12,
	annua: 12,
	annualmente: 12,
	anno: 12,
	biennale: 24,
	biennio: 24,
	triennale: 36,
	triennio: 36,
	quinquennale: 60,
	decennale: 120,
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
	un: 1,
	uno: 1,
	una: 1,
	due: 2,
	tre: 3,
	quattro: 4,
	cinque: 5,
	sei: 6,
	sette: 7,
	otto: 8,
	nove: 9,
	dieci: 10,
	undici: 11,
	dodici: 12,
	diciotto: 18,
	ventiquattro: 24,
	trentasei: 36,
};

const BAD_FREQUENCY = "frequency è mensile, bimestrale, trimestrale, semestrale, annuale, biennale, oppure «ogni N mesi» (un numero sono i mesi)";

/**
 * How many months a period is: «mensile», «al mese», «ogni mese», «trimestrale», «l'anno»,
 * «ogni anno», «biennale», «ogni 18 mesi», «ogni due anni»; a whole number is months. 1 to 120.
 */
export function parseFrequency(value: unknown): number | Problem {
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 1 || value > RENEWAL_LIMITS.maxMonths) return { problem: BAD_FREQUENCY };
		return value;
	}
	if (typeof value !== "string" || value.length > 60) return { problem: BAD_FREQUENCY };
	const t = fold(value)
		.replace(/[’`]/g, "'")
		.replace(/\buna volta\b/g, " ")
		.replace(/\b(?:rinnovo|pagamento|canone|abbonamento|cadenza|con|a|al|all'|alla|l'|il|per|ogni|ciascun|ciascuno)\b|\b(?:all|l)'/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (/^\d{1,3}$/.test(t)) return parseFrequency(Number(t));
	const named = NAMED_MONTHS[t];
	if (named !== undefined) return named;
	const m = /^(\d{1,3}|[a-z]+) (mesi|mese|anni|anno)$/.exec(t);
	if (m !== null) {
		const n = /^\d+$/.test(m[1] as string) ? Number(m[1]) : NUMBER_WORDS[m[1] as string];
		if (n !== undefined) return parseFrequency(m[2]?.startsWith("ann") === true ? n * 12 : n);
	}
	return { problem: BAD_FREQUENCY };
}

const FREQUENCY_NAMES: Readonly<Record<number, string>> = { 1: "mensile", 2: "bimestrale", 3: "trimestrale", 4: "quadrimestrale", 6: "semestrale", 12: "annuale", 24: "biennale", 36: "triennale" };

/** «mensile», «annuale», «ogni 18 mesi», «ogni 5 anni». */
export function frequencyText(months: number): string {
	return FREQUENCY_NAMES[months] ?? (months % 12 === 0 ? `ogni ${months / 12} anni` : `ogni ${months} mesi`);
}

/** What an amount of one period is per: «al mese», «all'anno», «ogni 3 mesi», «ogni 2 anni». */
export function perPeriodText(months: number): string {
	if (months === 1) return "al mese";
	if (months === 12) return "all'anno";
	return months % 12 === 0 ? `ogni ${months / 12} anni` : `ogni ${months} mesi`;
}

export type Due = {
	readonly date: string;
	/** The day of the month to keep on each roll. */
	readonly day: number;
	/** What to say back: a month without a day, placed at its end. */
	readonly note?: string;
};

const BAD_DUE = "due è la prossima scadenza: 12/03/2027, «12 marzo», «12 marzo 2027», oppure un mese («giugno»: l'ultimo giorno del mese)";

/** «a fine giugno», «inizio giugno», «metà giugno 2027», «ogni anno a giugno»: the day and the month's words; undefined when it is no month alone. */
function monthOnly(text: string, today: string): { year: number; month: number; part: "start" | "mid" | "end"; yearSaid: boolean } | undefined {
	const t = fold(text)
		.replace(/[’`]/g, "'")
		.replace(/^(?:ogni anno|tutti gli anni|ogni)\s+/, "")
		.replace(/^(?:entro|a|ad|di|in|nel mese di|il mese di)\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	const m = /^(?:(inizio|meta|fine|primi di) (?:di )?)?([a-z]+(?: (?:del )?\d{4})?)$/.exec(t);
	if (m === null) return undefined;
	let read: { year: number; month: number };
	try {
		read = parseMonth(m[2] as string, today);
	} catch (error) {
		if (error instanceof DateError) return undefined;
		throw error;
	}
	const part = m[1] === "inizio" || m[1] === "primi di" ? "start" : m[1] === "meta" ? "mid" : "end";
	return { ...read, part, yearSaid: /\d{4}/.test(m[2] as string) };
}

/**
 * The next due date as said: a date (without a year its next occurrence from today on, today
 * included), or a month alone (its last day, the 1st with «inizio», the 15th with «metà»). An
 * explicit date already gone is refused: a renewal's due date is ahead.
 */
export function readDue(value: unknown, today: string): Due | Problem {
	if (typeof value !== "string" || value.trim() === "" || value.length > 60) return { problem: BAD_DUE };
	const month = monthOnly(value, today);
	if (month !== undefined) {
		const last = daysInMonth(month.year, month.month);
		const day = month.part === "start" ? 1 : month.part === "mid" ? 15 : 31;
		let date = isoDate(month.year, month.month, Math.min(day, last));
		if (date < today && !month.yearSaid) date = rollDate(date, 12, day);
		if (date < today) return { problem: `la data ${italianDate(date)} è già passata: dammi la prossima scadenza` };
		const note = month.part === "end" ? `Ho messo la scadenza all'ultimo giorno del mese (${italianDate(date)}) e la tengo a fine mese a ogni rinnovo: se è un altro giorno, correggila con op edit (due).` : undefined;
		return { date, day, ...(note === undefined ? {} : { note }) };
	}
	let date: string;
	try {
		date = inRange(readDate(value.replace(/^\s*(?:scade|scadenza|si rinnova|rinnovo)\s+/i, ""), today, { rule: "next" }).date);
	} catch (error) {
		if (error instanceof DateError) return { problem: `${error.message}. ${BAD_DUE}` };
		throw error;
	}
	if (date < today) return { problem: `la data ${italianDate(date)} è già passata: dammi la prossima scadenza (se è scaduto e l'hai pagato, segnalo con op renewed)` };
	return { date, day: Number(date.slice(8, 10)) };
}

/** `months` after `date`, on day `day` of that month or its last day when shorter: the anchor day is kept, never drifts. */
export function rollDate(date: string, months: number, day: number): string {
	const first = addMonths(`${date.slice(0, 7)}-01`, months).date;
	const [year, month] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
	return isoDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/** The due date after this one: one period on from the due date (not from today). */
export function nextDue(r: Pick<Renewal, "due" | "months" | "day">): string {
	return rollDate(r.due, r.months, r.day);
}

/** The last day to send the disdetta: due − notice days; only for what renews by itself. */
export function noticeDeadline(r: Pick<Renewal, "due" | "autoRenew" | "noticeDays">): string | undefined {
	return r.autoRenew && r.noticeDays !== undefined ? addDays(r.due, -r.noticeDays) : undefined;
}

/**
 * Days before a date a renewal starts being said, when not set: 7 for a period of one or two
 * months, 14 up to five, 30 for six months and longer (annual, biennial).
 */
export function defaultRemindDays(months: number): number {
	return months <= 2 ? 7 : months < 6 ? 14 : 30;
}

export function remindDays(r: Pick<Renewal, "months" | "remindDays">): number {
	return r.remindDays ?? defaultRemindDays(r.months);
}

export type Agenda = {
	/** Due date gone without a payment or renewal said: soonest first. */
	readonly overdue: readonly Renewal[];
	/** Disdetta deadlines ahead within the window, with the deadline. */
	readonly cancelBy: readonly { readonly renewal: Renewal; readonly by: string }[];
	/** Rinnovo tacito due within the window: it renews by itself. */
	readonly renews: readonly Renewal[];
	/** No tacit renewal, due within the window: to pay or renew by hand. */
	readonly toPay: readonly Renewal[];
};

/**
 * What the active renewals ask for from `today` to `until` (both included): the overdue ones,
 * the disdetta deadlines, what renews by itself and what is to pay. `within` narrows each
 * renewal to its own reminder window (the brief): a date counts only from `remindDays` before it.
 */
export function agendaOf(renewals: readonly Renewal[], today: string, until: string, within?: "remind"): Agenda {
	const active = renewals.filter((r) => r.status === "active").sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
	const near = (r: Renewal, date: string) => date >= today && date <= until && (within === undefined || addDays(date, -remindDays(r)) <= today);
	const overdue = active.filter((r) => r.due < today);
	const cancelBy = active.flatMap((r) => {
		const by = noticeDeadline(r);
		return by !== undefined && r.due >= today && near(r, by) ? [{ renewal: r, by }] : [];
	});
	cancelBy.sort((a, b) => a.by.localeCompare(b.by));
	const due = active.filter((r) => near(r, r.due));
	return { overdue, cancelBy, renews: due.filter((r) => r.autoRenew), toPay: due.filter((r) => !r.autoRenew) };
}

export function agendaEmpty(a: Agenda): boolean {
	return a.overdue.length === 0 && a.cancelBy.length === 0 && a.renews.length === 0 && a.toPay.length === 0;
}
