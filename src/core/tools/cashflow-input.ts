/**
 * What the previsione di cassa reads from the person's words: a balance in euros (a minus when
 * overdrawn), an amount of a voce (more than zero, the direction apart), whether it comes in or
 * goes out, a voce's date and how it comes back (the rinnovi's readers: renewal-dates.ts readDue,
 * placeDue, parseFrequency; and weeks and days here) and the horizon of a forecast.
 *
 * Choices, tested:
 * - «8.400» (a dot and three digits, no comma) is eight thousand four hundred euros: nobody writes
 *   a balance or a voce to the tenth of a cent. «1,5k», «2k», «8 mila» are thousands.
 * - A voce once must be today or later; a recurring one may start in the past (its anchor day),
 *   and only its payments from today on count. «ogni 15 del mese» says monthly when no frequency
 *   is; «ogni lunedì» says weekly, from the next Monday (today when it is one).
 * - «settimanale», «ogni settimana»: every 7 days; «quindicinale», «ogni 15 giorni», «ogni due
 *   settimane»: every 14 (15 when said in days); «ogni N giorni», up to CASHFLOW_LIMITS.maxStepDays.
 * - A month alone («dicembre») is its last day, as the rinnovi read it; the answer says the day used.
 * - The horizon counts its days with today: «30 giorni» ends 29 days after today, «3 mesi» the day
 *   before the same day three months on. «fine mese» on the month's last day is next month's end,
 *   «fine anno» on 31 December next year's, «fine trimestre» on a quarter's last day the next one's.
 *   At most CASHFLOW_LIMITS.maxDays days.
 */
import { CASHFLOW_LIMITS, DEFAULT_DAYS, type Kind } from "../cashflow.ts";
import type { Hypothetical } from "../cashflow-sources.ts";
import { addDays, daysBetween, daysInMonth, isoDate, weekdayOf } from "../italian-calendar.ts";
import { withDate } from "../italian-format.ts";
import { scaled } from "../quote-sums.ts";
import { rollDate } from "../recurrence.ts";
import { parseFrequency, placeDue, readDue } from "../renewal-dates.ts";
import { fold } from "../text-match.ts";
import type { Fenced } from "../untrusted.ts";
import { readEuros } from "./field-input.ts";
import { isProblem, type Problem } from "./quote-input.ts";

const FOREIGN = "l'importo è in un'altra valuta: convertilo in euro con exchange_rate e passa gli euro";

const THOUSANDS = /^(\d{1,7}(?:[.,]\d{1,3})?)\s*(?:k|mila)$/i;
/** «1.500k», «1,250 mila»: thousands of thousands, or a decimal? Nobody can tell. */
const GROUPED_THOUSANDS = /^\d{1,3}(?:[.,]\d{3})+\s*(?:k|mila)$/i;
const DOT_GROUPED = /^\d{1,3}(?:\.\d{3})+$/;

/** The person's way of writing euros made plain: «8.400» → «8400», «1,5k» → «1500», «8 mila» → «8000»; anything else as it is. */
export function plainEuros(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const t = bare(value);
	const k = THOUSANDS.exec(t);
	if (k !== null) return String(scaled((k[1] as string).replace(",", "."), 3));
	if (DOT_GROUPED.test(t)) return t.replace(/\./g, "");
	return value;
}

function bare(value: string): string {
	return value
		.trim()
		.replace(/^(?:€|eur(?:o)?)\s*/i, "")
		.replace(/\s*(?:€|eur(?:o)?)$/i, "")
		.trim();
}

/** «1.500k» is refused: 1.500 or 1.500.000? */
function ambiguousThousands(value: unknown, what: string): Problem | undefined {
	if (typeof value !== "string" || !GROUPED_THOUSANDS.test(bare(value).replace(/^[-−–]\s*/, ""))) return undefined;
	const said = /^[\d .,€kKmila-]{1,20}$/.test(value) ? `«${value}»` : "l'importo";
	return { problem: `${what}: ${said} può voler dire migliaia o milioni. Chiedi a chi ti scrive, o passa il valore come numero JSON (1500 o 1500000)` };
}

/** An amount of a voce in euros: more than zero, at most the cap. */
export function readItemAmount(value: unknown, fence: Fenced): string | undefined | Problem {
	const ambiguous = ambiguousThousands(value, "amount");
	if (ambiguous !== undefined) return ambiguous;
	return readEuros(plainEuros(value), {
		fence,
		max: CASHFLOW_LIMITS.maxAmount,
		foreign: FOREIGN,
		negative: "amount è sempre positivo: se sono soldi che escono, kind uscita",
		zero: "amount deve essere più di zero",
	});
}

/** A balance in euros, a minus in front when the account is overdrawn («-350,50», «− 1.200»); 0 is a balance too. */
export function readSignedEuros(value: unknown, fence: Fenced, what: string): string | undefined | Problem {
	if (value === undefined) return undefined;
	const ambiguous = ambiguousThousands(value, what);
	if (ambiguous !== undefined) return ambiguous;
	let said: unknown = value;
	let negative = false;
	if (typeof value === "number") {
		negative = value < 0;
		said = Math.abs(value);
	} else if (typeof value === "string") {
		const m = /^\s*(?:€|eur(?:o)?)?\s*[-−–]\s*(.*)$/i.exec(value);
		if (m !== null) {
			negative = true;
			said = m[1] as string;
		}
	}
	said = plainEuros(said);
	if (said === 0 || (typeof said === "string" && /^\s*(?:€\s*)?0+(?:[.,]0{1,2})?\s*(?:€|euro?)?\s*$/i.test(said))) return "0";
	const read = readEuros(said, { fence, max: CASHFLOW_LIMITS.maxAmount, foreign: FOREIGN, negative: `${what}: un solo segno meno davanti`, zero: `${what}: dammi un numero` });
	if (read === undefined || isProblem(read)) return isProblem(read) ? { problem: `${what}: ${read.problem.replace(/^amount: /, "")}` } : read;
	return negative ? `-${read}` : read;
}

const IN_WORDS = /^(?:in|entra|entrata|entrate|incasso|incassi|ricevo|ricevuto|ricavo|accredito|\+)$/;
const OUT_WORDS = /^(?:out|esce|uscita|uscite|costo|costi|pagamento|spesa|pago|addebito|-)$/;
const BAD_KIND = "kind è entrata (soldi che arrivano) o uscita (soldi che escono)";

/** «entrata» / «uscita» (entra, esce, costo, incasso, pagamento…); `fallback` when not said. */
export function readKind(value: unknown, fallback?: Kind): Kind | Problem {
	if (value === undefined || value === "") return fallback ?? { problem: BAD_KIND };
	const t = typeof value === "string" ? fold(value).trim() : "";
	if (IN_WORDS.test(t)) return "in";
	if (OUT_WORDS.test(t)) return "out";
	return { problem: BAD_KIND };
}

const WEEKDAYS: Readonly<Record<string, number>> = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const WEEKDAY = /^(?:ogni|tutti i|tutte le|il|di) (domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domeniche|sabati)$/;

/** The weekday of «ogni lunedì», «tutti i venerdì»; undefined when it is no such phrase. */
function weekdayOfWords(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const m = WEEKDAY.exec(fold(value).replace(/\s+/g, " ").trim());
	if (m === null) return undefined;
	const word = (m[1] as string).replace(/che$/, "ca").replace(/ati$/, "ato");
	return WEEKDAYS[word];
}

const PLAIN_WEEKDAY = /^(?:(?:il|di) )?(domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato)(?: prossim[oa])?$/;

/** «lunedì», «venerdì prossimo»: the next one after today; undefined when it is no such phrase. */
function nextWeekdayOfWords(value: unknown, today: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const m = PLAIN_WEEKDAY.exec(fold(value).replace(/\s+/g, " ").trim());
	if (m === null) return undefined;
	const weekday = WEEKDAYS[m[1] as string] as number;
	return addDays(today, (weekday - weekdayOf(today) + 6) % 7 + 1);
}

/** The next `weekday` from today on (today when it is one). */
function nextWeekday(weekday: number, today: string): string {
	return addDays(today, (weekday - weekdayOf(today) + 7) % 7);
}

const ONCE = /^(?:una volta|una tantum|mai|no|nessuna|singola|una sola volta)$/;
const COUNT_WORDS: Readonly<Record<string, number>> = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, quindici: 15, venti: 20, trenta: 30 };
const BAD_FREQUENCY = "frequency è settimanale, quindicinale, «ogni N giorni», «ogni lunedì», mensile, bimestrale, trimestrale, semestrale, annuale o «ogni N mesi»; niente per una volta sola";

/** How a voce comes back, from the frequency's words: every so many days, or months; "once"; undefined when not said. */
export function readFrequency(value: unknown): { readonly days: number } | { readonly months: number } | "once" | undefined | Problem {
	if (value === undefined || value === "" || value === null) return undefined;
	if (typeof value === "string") {
		const t = fold(value).replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
		if (ONCE.test(t)) return "once";
		if (/^(?:due|2) volte al mese$|^bimensile$/.test(t)) return { problem: "due volte al mese non sta in una voce: aggiungine due mensili, una per ciascun giorno (per esempio il 1º e il 15)" };
		if (weekdayOfWords(t) !== undefined || /^(?:settimanale|settimanalmente|ogni settimana|a settimana|alla settimana|una volta a settimana|una volta alla settimana)$/.test(t)) return { days: 7 };
		if (/^(?:quindicinale|ogni quindici giorni|ogni due settimane|ogni 2 settimane)$/.test(t)) return { days: 14 };
		const n = /^ogni (\d{1,3}|[a-z]+) (giorni|settimane)$/.exec(t);
		if (n !== null) {
			const count = /^\d+$/.test(n[1] as string) ? Number(n[1]) : COUNT_WORDS[n[1] as string];
			const days = count === undefined ? undefined : n[2] === "settimane" ? count * 7 : count;
			if (days === undefined || days < 1 || days > CASHFLOW_LIMITS.maxStepDays) return { problem: `ogni quanti giorni: da 1 a ${CASHFLOW_LIMITS.maxStepDays}; più di così, in mesi` };
			return { days };
		}
		if (/^(?:ogni giorno|giornaliera|giornaliero|al giorno|tutti i giorni)$/.test(t)) return { days: 1 };
	}
	const months = parseFrequency(value);
	if (isProblem(months)) return { problem: BAD_FREQUENCY };
	return { months };
}

export type ItemFields = {
	readonly kind: Kind;
	readonly amount: string;
	readonly date: string;
	readonly months?: number;
	readonly day?: number;
	readonly everyDays?: number;
	readonly until?: string;
	readonly notes: readonly string[];
};

/** The date words of a voce: what readDue reads, after a few words of a voce («a partire dal»). */
function dueWords(value: unknown): unknown {
	return typeof value === "string" ? value.replace(/^\s*(?:a partire dal(?:l')?|dal(?:l')?|da|a partire da)\s+/i, "") : value;
}

/** The day of a voce, as said: a weekday phrase, or what readDue reads. */
function readDay(value: unknown, today: string): ReturnType<typeof readDue> {
	const weekday = weekdayOfWords(value);
	const plain = nextWeekdayOfWords(value, today);
	if (weekday !== undefined || plain !== undefined) {
		const date = plain ?? nextWeekday(weekday as number, today);
		return { date, day: Number(date.slice(8, 10)) };
	}
	const due = readDue(dueWords(value), today);
	if (isProblem(due)) return { problem: due.problem.replace(/^due è la prossima scadenza/, "date è il giorno del movimento").replace(/ dammi la prossima scadenza$/, " dammi il giorno del movimento") };
	return due;
}

/** The last day of a recurring voce. */
export function readUntil(value: unknown, today: string, start: string): string | Problem {
	const end = readDue(dueWords(value), today);
	if (isProblem(end)) return { problem: `until: ${end.problem.replace(/^due è la prossima scadenza: /, "")}` };
	if (end.date < start) return { problem: `until (${withDate("il", end.date)}) viene prima della data (${withDate("il", start)})` };
	return end.date;
}

const everyDaysOf = (r: { days: number } | { months: number } | undefined): number | undefined => (r !== undefined && "days" in r ? r.days : undefined);

/** The fields of a voce (to keep, or a hypothetical one): direction, amount, date, recurrence, end. */
export function readItemFields(args: Record<string, unknown>, today: string, fence: Fenced, fallbackKind?: Kind): ItemFields | Problem {
	const kind = readKind(args.kind, fallbackKind);
	if (isProblem(kind)) return kind;
	const amount = readItemAmount(args.amount, fence);
	if (isProblem(amount)) return amount;
	if (amount === undefined) return { problem: "serve amount, l'importo in euro" };
	const weekday = weekdayOfWords(args.frequency) ?? weekdayOfWords(args.date);
	// «ogni 2 settimane», «ogni giorno» said as the date: the recurrence, from today.
	const dateAsFrequency = args.frequency === undefined && weekday === undefined ? readFrequency(args.date) : undefined;
	const fromToday = dateAsFrequency !== undefined && typeof dateAsFrequency === "object" && "days" in dateAsFrequency ? dateAsFrequency : undefined;
	if (dateAsFrequency !== undefined && isProblem(dateAsFrequency) && /volte al mese|bimensile/.test(String(args.date))) return dateAsFrequency;
	const frequency = fromToday ?? readFrequency(args.frequency);
	if (isProblem(frequency)) return frequency;
	const recurrence = frequency === "once" ? undefined : (frequency ?? (weekday !== undefined ? { days: 7 } : undefined));
	const notes: string[] = [];
	let due: ReturnType<typeof readDue>;
	if (fromToday !== undefined) due = { date: today, day: Number(today.slice(8, 10)) };
	else if (args.date !== undefined && args.date !== "") due = readDay(args.date, today);
	else if (weekday !== undefined) {
		const date = nextWeekday(weekday, today);
		due = { date, day: Number(date.slice(8, 10)) };
	} else if (recurrence !== undefined && "days" in recurrence) due = { date: today, day: Number(today.slice(8, 10)) };
	else return { problem: "serve date, il giorno del movimento (12/11/2026, «il 27», «ogni 27 del mese», «ogni lunedì», «fine mese», «dicembre»)" };
	if (isProblem(due)) return due;
	const dateWords = args.date;
	if (everyDaysOf(recurrence) === 14 && /quindicinal/.test(fold(`${String(args.frequency ?? "")} ${String(args.date ?? "")}`))) notes.push("Quindicinale: la metto ogni 14 giorni; se sono due giorni fissi del mese, sono due voci mensili.");
	const months = recurrence !== undefined && "months" in recurrence ? recurrence.months : recurrence === undefined && frequency !== "once" && "monthly" in due && due.monthly === true ? 1 : undefined;
	const everyDays = recurrence !== undefined && "days" in recurrence ? recurrence.days : undefined;
	if (months === undefined && everyDays === undefined && "past" in due && due.past === true) return { problem: `la data (${withDate("il", due.date)}) è passata: una voce una tantum va da oggi in poi` };
	const placed = months === undefined ? due : placeDue(due, months, today);
	if (due.day === 31 && everyDays === undefined && !/\d/.test(String(dateWords))) notes.push(`Ho messo ${withDate("il", placed.date)}, l'ultimo giorno del mese${months === undefined ? "" : ", e lo tengo a fine mese"}: se è un altro giorno, dimmelo.`);
	let until: string | undefined;
	if (args.until !== undefined && args.until !== "") {
		if (months === undefined && everyDays === undefined) return { problem: "until vale solo per una voce che si ripete (frequency)" };
		const end = readUntil(args.until, today, placed.date);
		if (isProblem(end)) return end;
		until = end;
	}
	return {
		kind,
		amount,
		date: placed.date,
		...(months === undefined ? {} : { months, day: due.day }),
		...(everyDays === undefined ? {} : { everyDays }),
		...(until === undefined ? {} : { until }),
		notes,
	};
}

/** A hypothetical voce of a what_if from its fields; uscita when the direction is not said. */
export function readHypothetical(raw: unknown, today: string, fence: Fenced): Hypothetical | Problem {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problem: "ogni ipotesi è un oggetto con amount, date e, se serve, kind, frequency e name" };
	const args = raw as Record<string, unknown>;
	const fields = readItemFields(args, today, fence, "out");
	if (isProblem(fields)) return fields;
	const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim().slice(0, CASHFLOW_LIMITS.name) : undefined;
	return {
		kind: fields.kind,
		cents: scaled(fields.amount, 2),
		date: fields.date,
		...(fields.months === undefined ? {} : { months: fields.months, day: fields.day as number }),
		...(fields.everyDays === undefined ? {} : { everyDays: fields.everyDays }),
		...(name === undefined ? {} : { name }),
	};
}

const BAD_HORIZON = "horizon è fin quando guardare: «fine mese», «il mese prossimo», «fine trimestre», «fine semestre», «prossima settimana», «30 giorni», «90 giorni», «3 mesi», «6 settimane», «fino a dicembre», «fine anno» o una data (31/12/2026); oppure days, un numero di giorni";

/** The last day of the forecast and its days, today included; `said` false for the default. */
export type Horizon = { readonly end: string; readonly days: number; readonly said: boolean };

function monthEnd(year: number, month: number): string {
	return isoDate(year, month, daysInMonth(year, month));
}

/** The end of the month `ahead` months from today's; on this month's last day «fine mese» is the next one's. */
function endOfMonth(today: string, ahead: number): string {
	const first = rollDate(`${today.slice(0, 7)}-01`, ahead, 1);
	const end = monthEnd(Number(first.slice(0, 4)), Number(first.slice(5, 7)));
	return ahead === 0 && end === today ? endOfMonth(today, 1) : end;
}

function endOfQuarter(today: string): string {
	const year = Number(today.slice(0, 4));
	const month = Math.ceil(Number(today.slice(5, 7)) / 3) * 3;
	const end = monthEnd(year, month);
	return end === today ? (month === 12 ? monthEnd(year + 1, 3) : monthEnd(year, month + 3)) : end;
}

function endOfHalf(today: string): string {
	const year = Number(today.slice(0, 4));
	const end = Number(today.slice(5, 7)) <= 6 ? `${year}-06-30` : `${year}-12-31`;
	return end !== today ? end : end.endsWith("06-30") ? `${year}-12-31` : `${year + 1}-06-30`;
}

function endOfYear(today: string): string {
	const year = Number(today.slice(0, 4));
	const end = `${year}-12-31`;
	return end === today ? `${year + 1}-12-31` : end;
}

/** The Sunday of this week (on a Sunday, next week's: «fine settimana» rolls as «fine mese»), or the Sunday of next week. */
function endOfWeek(today: string, next: boolean): string {
	const sunday = addDays(today, (7 - weekdayOf(today)) % 7);
	if (next) return addDays(sunday, 7);
	return sunday === today ? addDays(today, 7) : sunday;
}

/** The last day of the forecast: `days` from today (today the first), or the horizon's words; DEFAULT_DAYS when neither. */
export function readHorizon(horizon: unknown, days: unknown, today: string): Horizon | Problem {
	const max = CASHFLOW_LIMITS.maxDays;
	const of = (end: string, said = true): Horizon | Problem => {
		if (end < today) return { problem: `la data (${withDate("il", end)}) è già passata: ${BAD_HORIZON}` };
		const n = daysBetween(today, end) + 1;
		if (n > max) return { problem: `posso guardare al massimo ${max} giorni (fino ${withDate("al", addDays(today, max - 1))})` };
		return { end, days: n, said };
	};
	const ahead = (n: number) => addDays(today, n - 1);
	// The same day n months on, less one; on a day that month has not, its last day (31/10 → 30/11).
	const months = (n: number) => {
		const day = Number(today.slice(8, 10));
		const rolled = rollDate(today, n, day);
		return Number(rolled.slice(8, 10)) < day ? rolled : addDays(rolled, -1);
	};
	if (days !== undefined) {
		if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > max) return { problem: `days è un numero di giorni da 1 a ${max}` };
		return of(ahead(days));
	}
	if (horizon === undefined || (typeof horizon === "string" && horizon.trim() === "")) return of(ahead(DEFAULT_DAYS), false);
	if (typeof horizon !== "string" || horizon.length > 60) return { problem: BAD_HORIZON };
	const t = fold(horizon)
		.replace(/[’`]/g, "'")
		.replace(/^(?:come sono messo |come sto )?(?:fino (?:a |al |alla |all')|entro (?:il |la |l')?|per (?:i |le )?|nei |nelle |a |al |alla |da qui a )?/, "")
		.replace(/^(?:la |il )?/, "")
		.replace(/^(?:prossim[ie] )/, "")
		.replace(/\bdell'/g, "")
		.replace(/\b(?:del|della) /g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (/^fine mese$/.test(t)) return of(endOfMonth(today, 0));
	if (/^(?:fine )?(?:mese prossimo|prossimo mese)$/.test(t)) return of(endOfMonth(today, 1));
	if (/^fine (?:trimestre|questo trimestre)$/.test(t)) return of(endOfQuarter(today));
	if (/^fine anno$/.test(t)) return of(endOfYear(today));
	if (/^fine (?:semestre|questo semestre)$/.test(t)) return of(endOfHalf(today));
	if (/^(?:prossima settimana|settimana prossima)$/.test(t)) return of(endOfWeek(today, true));
	if (/^(?:fine settimana|questa settimana)$/.test(t)) return of(endOfWeek(today, false));
	const rel = /^(?:i |le )?(\d{1,3}|[a-z]+) (giorni|giorno|gg|settimane|settimana|mesi|mese|anni|anno)$/.exec(t);
	const n = rel === null ? undefined : /^\d+$/.test(rel[1] as string) ? Number(rel[1]) : COUNT_WORDS[rel[1] as string];
	if (rel !== null && n !== undefined) {
		if (n < 1) return { problem: BAD_HORIZON };
		const unit = rel[2] as string;
		if (unit.startsWith("g")) return of(ahead(n));
		if (unit.startsWith("settiman")) return of(ahead(7 * n));
		return of(months(unit.startsWith("ann") ? 12 * n : n));
	}
	if (t === "mese" || t === "un mese") return of(months(1));
	if (t === "anno" || t === "un anno") return of(months(12));
	const due = readDue(t, today);
	if (isProblem(due)) return { problem: BAD_HORIZON };
	return of(due.date);
}
