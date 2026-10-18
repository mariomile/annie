/**
 * The dates of the renewals: how often (a period in months, from the person's words), the next
 * due date as said, rolling it on by a period with the day of the month kept, the dates that move
 * by themselves, the disdetta deadline, what is coming up and when a renewal starts being said.
 * Pure functions on YYYY-MM-DD; «today» is passed in (the instance's time zone).
 *
 * Choices, tested:
 * - A date without a year («il 12 marzo») is its next occurrence from today on (today included).
 *   Once the frequency is known (placeDue), a date of a period shorter than a year that is gone
 *   this year rolls on by periods instead (monthly «5 ottobre» on 18/10 is 5 November); a yearly
 *   one placed almost a year ahead is said back, in case it has just expired.
 * - An explicit date already gone (up to a year back) is taken as a due date passed: overdue, or
 *   rolled on when it moves by itself. Never more than ten years ahead.
 * - A month without a day («a giugno») is the month's last day, kept as the end of the month on
 *   every roll (day 31); «inizio» is the 1st, «metà» the 15th. «fine mese» is this month's end,
 *   «il 15» / «ogni 15 del mese» the next 15th (and says monthly), «fine anno» 31 December,
 *   «tra un mese» one month from today.
 * - Rolling adds whole periods to the due date, never to today, and keeps the anchor day: 31/01
 *   monthly is 28/02 (29 in a leap year), then 31/03 again.
 * - effectiveDue: an active renewal that moves by itself (autoPay or autoRenew) rolls from its
 *   stored due by whole periods until it is today or later; a manual one stays where it is.
 *   Nothing is written when read: the store catches up on the next change (normalised).
 */
import { addMonths, DateError, inRange, parseMonth, readDate } from "./dates.ts";
import { addDays, daysBetween, daysInMonth, isoDate } from "./italian-calendar.ts";
import { italianLongDate } from "./italian-format.ts";
import { scaled } from "./quote-sums.ts";
import { datesBetween, rollDate } from "./recurrence.ts";
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

/** A number in digits or words, or undefined. */
function countOf(word: string): number | undefined {
	return /^\d{1,3}$/.test(word) ? Number(word) : NUMBER_WORDS[word];
}

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
		const n = countOf(m[1] as string);
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

/** «12 mesi», «2 anni», «1 mese». */
export function monthsText(months: number): string {
	if (months % 12 === 0) return months === 12 ? "1 anno" : `${months / 12} anni`;
	return months === 1 ? "1 mese" : `${months} mesi`;
}

export type Due = {
	readonly date: string;
	/** The day of the month to keep on each roll. */
	readonly day: number;
	/** Said without a year: its latest occurrence gone, if any (placeDue rolls a short period on from it). */
	readonly previous?: string;
	readonly yearless?: true;
	/** Said as a day of every month («ogni 15 del mese»): monthly when the frequency is not said. */
	readonly monthly?: true;
	/** Already gone (an explicit date up to a year back). */
	readonly past?: true;
	/** What to say back. */
	readonly note?: string;
};

const BAD_DUE =
	"due è la prossima scadenza: una data (12/03/2027, «12 marzo», «primo gennaio»), un giorno del mese («il 15», «ogni 15 del mese», «fine mese»), un mese («giugno»: l'ultimo giorno del mese), «fine anno» o «tra un mese»; per altre date calcolala con date_calc e passala come 12/03/2027";

/** The furthest due date: ten years from today. */
function furthest(today: string): string {
	return addMonths(today, RENEWAL_LIMITS.maxMonths).date;
}

/** The day `day` of the month of `date`, or the next month's when that is before `today`: clamped to short months. */
function nextDayOfMonth(day: number, today: string): string {
	const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
	const here = isoDate(y, m, Math.min(day, daysInMonth(y, m)));
	return here >= today ? here : rollDate(here, 1, day);
}

/** «a fine giugno», «inizio giugno», «metà giugno 2027», «ogni anno a giugno»; undefined when it is no month alone. */
function monthOnly(t: string, today: string): Due | Problem | undefined {
	const s = t
		.replace(/^(?:ogni anno|tutti gli anni|ogni)\s+/, "")
		.replace(/^(?:entro|a|ad|di|in|nel mese di|il mese di)\s+/, "")
		.trim();
	const m = /^(?:(inizio|meta|fine|primi di) (?:di )?)?([a-z]+(?: (?:del )?\d{4})?)$/.exec(s);
	if (m === null) return undefined;
	let read: { year: number; month: number };
	try {
		read = parseMonth(m[2] as string, today);
	} catch (error) {
		if (error instanceof DateError) return undefined;
		throw error;
	}
	const yearSaid = /\d{4}/.test(m[2] as string);
	const day = m[1] === "inizio" || m[1] === "primi di" ? 1 : m[1] === "meta" ? 15 : 31;
	let date = isoDate(read.year, read.month, Math.min(day, daysInMonth(read.year, read.month)));
	let previous: string | undefined;
	if (date < today && !yearSaid) {
		previous = date;
		date = rollDate(date, 12, day);
	} else if (!yearSaid) {
		const before = rollDate(date, -12, day);
		if (before < today) previous = before;
	}
	if (date < today) return { problem: `la data del ${italianLongDate(date)} è già passata: dammi la prossima scadenza` };
	const note = day === 31 ? `Ho messo la scadenza all'ultimo giorno del mese (${italianLongDate(date)}) e la tengo a fine mese a ogni rinnovo: se è un altro giorno, correggila con op edit (due).` : undefined;
	return { date, day, ...(yearSaid ? {} : { yearless: true as const }), ...(previous === undefined ? {} : { previous }), ...(note === undefined ? {} : { note }) };
}

/** The phrases of a due date that are not a date: fine mese, il 15, fine anno, tra un mese. Undefined when it is none. */
function phrase(t: string, today: string): Due | undefined {
	const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
	if (/^(?:(?:ogni|a|alla|entro) )?(?:la )?fine (?:del |di questo |di ogni |di ciascun )?mese$/.test(t)) {
		return { date: isoDate(y, m, daysInMonth(y, m)), day: 31, ...(/\bogni\b|\bciascun\b/.test(t) ? { monthly: true as const } : {}) };
	}
	const dom = /^(?:(ogni) |il |l')?(\d{1,2})(?: (?:(del|di ogni|di ciascun) mese))?$/.exec(t);
	if (dom !== null && (dom[1] !== undefined || dom[3] !== undefined || /^(?:il |l')/.test(t))) {
		const day = Number(dom[2]);
		if (day < 1 || day > 31) return undefined;
		const monthly = dom[1] !== undefined || dom[3] !== undefined;
		return { date: nextDayOfMonth(day, today), day, ...(monthly ? { monthly: true as const } : {}) };
	}
	if (/^(?:(?:a|alla|entro) )?(?:la )?fine (?:dell'|d'|di quest'|del)?\s?anno$/.test(t)) return { date: isoDate(y, 12, 31), day: 31 };
	const rel = /^(?:tra|fra) (un|una|uno|\d{1,3}|[a-z]+) (giorno|giorni|settimana|settimane|mese|mesi|anno|anni)$/.exec(t);
	if (rel !== null) {
		const n = countOf(rel[1] as string);
		if (n === undefined) return undefined;
		const unit = rel[2] as string;
		if (unit.startsWith("giorn")) return { date: addDays(today, n), day: Number(addDays(today, n).slice(8, 10)) };
		if (unit.startsWith("settiman")) return { date: addDays(today, 7 * n), day: Number(addDays(today, 7 * n).slice(8, 10)) };
		const months = unit.startsWith("mes") ? n : n * 12;
		const day = Number(today.slice(8, 10));
		return { date: rollDate(today, months, day), day };
	}
	return undefined;
}

/**
 * The next due date as said (see the choices above): a phrase, a month alone, or a date. An
 * explicit date gone up to a year back is a due date passed (`past`); further back, or more than
 * ten years ahead, it is refused. placeDue places a date without a year once the frequency is known.
 */
export function readDue(value: unknown, today: string): Due | Problem {
	if (typeof value !== "string" || value.trim() === "" || value.length > 60) return { problem: BAD_DUE };
	const t = fold(value)
		.replace(/[’`]/g, "'")
		.replace(/(\d)\s*[°ºª]/g, "$1")
		.replace(/\bprimo\b/g, "1")
		.replace(/^\s*(?:scade|scadenza|si rinnova|rinnovo|il giorno)\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	let due = phrase(t, today) ?? monthOnly(t, today);
	if (due === undefined) {
		let date: string;
		let yearless: boolean;
		try {
			const read = readDate(t, today, { rule: "next" });
			date = inRange(read.date);
			yearless = read.yearless;
		} catch (error) {
			if (error instanceof DateError) return { problem: BAD_DUE };
			throw error;
		}
		let previous: string | undefined;
		if (yearless) {
			try {
				const before = readDate(t, today, { rule: "past" }).date;
				if (before < today) previous = before;
			} catch (error) {
				if (!(error instanceof DateError)) throw error;
			}
		}
		if (date < today) {
			if (daysBetween(date, today) > 366) return { problem: `la data del ${italianLongDate(date)} è passata da più di un anno: dammi la prossima scadenza` };
			due = { date, day: Number(date.slice(8, 10)), past: true };
		} else due = { date, day: Number(date.slice(8, 10)), ...(yearless ? { yearless: true as const } : {}), ...(previous === undefined ? {} : { previous }) };
	}
	if ("problem" in due) return due;
	if (due.date > furthest(today)) return { problem: `la scadenza è oltre ${RENEWAL_LIMITS.maxMonths / 12} anni da oggi: ricontrollala` };
	return due;
}

/**
 * A due date placed with its frequency: a date said without a year, of a period shorter than a
 * year, rolls on from its latest occurrence gone by periods until it is today or later (never
 * further than its next occurrence); a yearly one placed almost a year ahead is said back.
 */
export function placeDue(due: Due, months: number, today: string): Due {
	if (due.yearless !== true || due.previous === undefined) return due;
	if (months < 12) {
		let date = due.previous;
		for (let i = 0; date < today && i < 1000; i++) date = rollDate(date, months, due.day);
		const { previous: _p, note: _n, ...rest } = due;
		return { ...rest, date: date < due.date ? date : due.date, ...(due.note === undefined || date < due.date ? {} : { note: due.note }) };
	}
	if (daysBetween(today, due.date) > 300) {
		const said = `Ho messo il ${italianLongDate(due.date)}. Se invece è scaduto il ${italianLongDate(due.previous)} e va ancora pagato, dimmelo e lo correggo.`;
		return { ...due, note: `${due.note === undefined ? "" : `${due.note} `}Di' a chi ti scrive: «${said}» Se è così, correggi con op edit e due ${due.previous.split("-").reverse().join("/")}.` };
	}
	return due;
}

export { rollDate };

/** The due date after this one: one period on from the due date (not from today). */
export function nextDue(r: Pick<Renewal, "due" | "months" | "day">): string {
	return rollDate(r.due, r.months, r.day);
}

/** Rolled on by periods from `date` until it is `today` or later. */
function caughtUp(date: string, months: number, day: number, today: string): string {
	let d = date;
	for (let i = 0; d < today && i < 2000; i++) d = rollDate(d, months, day);
	return d;
}

/** Whether a renewal's dates move by themselves: active, and paid or renewed automatically. */
export function movesBySelf(r: Renewal): boolean {
	return r.status === "active" && (r.autoPay === true || r.autoRenew);
}

/** The next due date as of today: rolled on by whole periods for what moves by itself; the stored one otherwise. */
export function effectiveDue(r: Renewal, today: string): string {
	return movesBySelf(r) ? caughtUp(r.due, r.months, r.day, today) : r.due;
}

/** The months of the contract's term: its own, or how often one pays. */
export function termMonthsOf(r: Pick<Renewal, "termMonths" | "months">): number {
	return r.termMonths ?? r.months;
}

/** The day of the month a term end keeps when it rolls: as first said, else the stored end's. */
function termDayOf(r: Renewal): number {
	return r.termDay ?? (r.termEnd === undefined ? r.day : Number(r.termEnd.slice(8, 10)));
}

/** The end of the current term as of today: rolled on when it renews by itself, on the day first said. */
export function effectiveTermEnd(r: Renewal, today: string): string {
	if (r.termMonths === undefined || r.termEnd === undefined) return effectiveDue(r, today);
	return r.status === "active" && r.autoRenew ? caughtUp(r.termEnd, r.termMonths, termDayOf(r), today) : r.termEnd;
}

/** Whether a disdetta deadline is worth an alert: a notice, a tacit renewal and a term of three months or more. */
export function noticeAlerts(r: Renewal): boolean {
	return r.autoRenew && (r.noticeDays !== undefined || r.noticeMonths !== undefined) && termMonthsOf(r) >= 3;
}

/** The last day to send the disdetta for the term ending on `end`: the end less the notice (days, or the same day N months before). */
export function deadlineFor(r: Pick<Renewal, "noticeDays" | "noticeMonths">, end: string): string {
	if (r.noticeMonths !== undefined) return rollDate(end, -r.noticeMonths, Number(end.slice(8, 10)));
	return addDays(end, -(r.noticeDays ?? 0));
}

/**
 * The next disdetta deadline from today on: the one of the term ending next, or, once that one is
 * gone, the one of the term after (that term renews: renewal-tools says so).
 */
export function noticeDeadline(r: Renewal, today: string): string | undefined {
	if (!noticeAlerts(r)) return undefined;
	const end = effectiveTermEnd(r, today);
	const by = deadlineFor(r, end);
	if (by >= today) return by;
	return deadlineFor(r, rollDate(end, termMonthsOf(r), termDayOf(r)));
}

/** «30 giorni», «3 mesi»; undefined without a notice. */
export function noticeText(r: Pick<Renewal, "noticeDays" | "noticeMonths">): string | undefined {
	if (r.noticeMonths !== undefined) return r.noticeMonths === 1 ? "1 mese" : `${r.noticeMonths} mesi`;
	if (r.noticeDays !== undefined) return r.noticeDays === 1 ? "1 giorno" : `${r.noticeDays} giorni`;
	return undefined;
}

/** The amount of the payment due on `date`: the new one from its date on. */
export function amountAt(r: Pick<Renewal, "amount" | "amountFrom">, date: string): string | undefined {
	return r.amountFrom !== undefined && date >= r.amountFrom.from ? r.amountFrom.amount : r.amount;
}

/** The amount of the next payment as of today: what every read shows, the same before and after a write. */
export function currentAmount(r: Renewal, today: string): string | undefined {
	return amountAt(r, effectiveDue(r, today));
}

/** The payment before the due date (one period back): the last one a past charge or roll can be about. */
export function previousDue(r: Pick<Renewal, "due" | "months" | "day">): string {
	return rollDate(r.due, -r.months, r.day);
}

/**
 * The last charge of an autoPay renewal up to today: its effective due when that is today, else
 * the one before it; undefined when that is before the first charge known (none has left yet).
 */
export function lastCharge(r: Renewal, today: string): string | undefined {
	const next = effectiveDue(r, today);
	const charge = next <= today ? next : rollDate(next, -r.months, r.day);
	return charge > today || charge < (r.start ?? r.due) ? undefined : charge;
}

/**
 * The renewal with its moving dates written down as of today, for the next write: an autoPay
 * due caught up (the trial over once its first charge is gone), the term end caught up, a new
 * amount in force once the payment before the due date reached it.
 */
export function normalised(r: Renewal, today: string): Renewal {
	let next = r;
	if (r.status === "active" && r.autoPay === true) {
		const due = effectiveDue(r, today);
		if (due !== r.due) {
			const { trial: _t, ...rest } = next;
			next = { ...rest, due };
		}
	}
	if (next.termMonths !== undefined && next.termEnd !== undefined) {
		const end = effectiveTermEnd(next, today);
		if (end !== next.termEnd) next = { ...next, termEnd: end };
	}
	// The new price written in only once the payment before the due date has it too: an expense
	// of that payment (the last charge, a roll of today) still costs what it cost then.
	if (next.amountFrom !== undefined && previousDue(next) >= next.amountFrom.from) {
		const { amountFrom, ...rest } = next;
		next = { ...rest, amount: amountFrom.amount };
	}
	return next;
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

/** The payment dates of a renewal from `from` to `until` (both included), stepping by its period from `first`. */
export function occurrences(r: Pick<Renewal, "months" | "day">, first: string, from: string, until: string): string[] {
	return datesBetween(first, r.months, r.day, from, until);
}

/** A renewal in a bucket: the date that puts it there, and its payments in the window with their total. */
export type AgendaItem = {
	readonly renewal: Renewal;
	readonly date: string;
	readonly payments: readonly string[];
	readonly total?: bigint;
	/** To pay since `date`: renewed by itself, the payment not confirmed. */
	readonly since?: true;
};

export type Agenda = {
	/** Neither paid nor renewed automatically, due date gone without a word: «l'hai rinnovato o lasciato scadere?». */
	readonly overdue: readonly AgendaItem[];
	/** Disdetta deadlines ahead within the window (terms of three months or more). */
	readonly cancelBy: readonly AgendaItem[];
	/** Free trials ending within the window. */
	readonly trials: readonly AgendaItem[];
	/** autoPay charges within the window. */
	readonly charges: readonly AgendaItem[];
	/** autoRenew without autoPay: renewing by itself within the window, then to pay. */
	readonly renews: readonly AgendaItem[];
	/** To pay: a manual due within the window, or an autoRenew payment not confirmed since its date. */
	readonly toPay: readonly AgendaItem[];
};

/**
 * What the active renewals ask for from `today` to `until` (both included). `brief` narrows each
 * renewal to its own reminder window (a date counts from `remindDays` before it) and leaves out
 * the charges of autoPay renewals of less than six months, which need nothing from the person.
 */
export function agendaOf(renewals: readonly Renewal[], today: string, until: string, brief = false): Agenda {
	const active = renewals.filter((r) => r.status === "active");
	const near = (r: Renewal, date: string) => date >= today && date <= until && (!brief || addDays(date, -remindDays(r)) <= today);
	const item = (r: Renewal, date: string, payments: readonly string[]): AgendaItem => {
		let total: bigint | undefined = 0n;
		for (const p of payments) {
			const amount = amountAt(r, p);
			if (amount === undefined) total = undefined;
			else if (total !== undefined) total += scaled(amount, 2);
		}
		return { renewal: r, date, payments, ...(total === undefined ? {} : { total }) };
	};
	const overdue: AgendaItem[] = [];
	const cancelBy: AgendaItem[] = [];
	const trials: AgendaItem[] = [];
	const charges: AgendaItem[] = [];
	const renews: AgendaItem[] = [];
	const toPay: AgendaItem[] = [];
	for (const r of active) {
		const autoPay = r.autoPay === true;
		const due = effectiveDue(r, today);
		const by = noticeDeadline(r, today);
		if (by !== undefined && near(r, by)) cancelBy.push(item(r, by, []));
		if (r.trial === true && r.due >= today) {
			if (near(r, r.due)) trials.push(item(r, r.due, [r.due]));
			continue;
		}
		const inWindow = occurrences(r, due, today, until);
		if (autoPay) {
			if (inWindow.length > 0 && near(r, due) && (!brief || r.months >= 6)) charges.push(item(r, due, inWindow));
		} else if (r.autoRenew) {
			if (r.due < today) toPay.push({ ...item(r, r.due, [...occurrences(r, r.due, r.due, addDays(today, -1)), ...(brief ? [] : inWindow)]), since: true });
			else if (inWindow.length > 0 && near(r, due)) renews.push(item(r, due, inWindow));
		} else if (r.due < today) overdue.push(item(r, r.due, [r.due]));
		else if (inWindow.length > 0 && near(r, due)) toPay.push(item(r, due, inWindow));
	}
	const byDate = (a: AgendaItem, b: AgendaItem) => a.date.localeCompare(b.date) || a.renewal.id.localeCompare(b.renewal.id);
	return { overdue: overdue.sort(byDate), cancelBy: cancelBy.sort(byDate), trials: trials.sort(byDate), charges: charges.sort(byDate), renews: renews.sort(byDate), toPay: toPay.sort(byDate) };
}

export function agendaEmpty(a: Agenda): boolean {
	return [a.overdue, a.cancelBy, a.trials, a.charges, a.renews, a.toPay].every((b) => b.length === 0);
}
