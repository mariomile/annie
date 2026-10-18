/**
 * What the previsione di cassa reads from the person's words: a balance in euros (a minus when
 * overdrawn), an amount of a voce (more than zero, the direction apart), whether it comes in or
 * goes out, a voce's date and frequency (the rinnovi's readers: renewal-dates.ts readDue,
 * placeDue, parseFrequency) and the horizon of a forecast («fine mese», «90 giorni», «3 mesi»,
 * «fino a dicembre», «fine anno», a date).
 *
 * Choices, tested:
 * - A voce once must be today or later; a recurring one may start in the past (its anchor day),
 *   and only its payments from today on count. «ogni 15 del mese» says monthly when no frequency is.
 * - A month alone («dicembre») is its last day, as the rinnovi read it; the answer says the day used.
 * - The horizon ends on its last day, both today and that day included; at most a year and a day.
 */
import { CASHFLOW_LIMITS, DEFAULT_DAYS, type Kind } from "../cashflow.ts";
import type { Hypothetical } from "../cashflow-sources.ts";
import { addDays, daysBetween } from "../italian-calendar.ts";
import { italianLongDate as long } from "../italian-format.ts";
import { scaled } from "../quote-sums.ts";
import { rollDate } from "../recurrence.ts";
import { parseFrequency, placeDue, readDue } from "../renewal-dates.ts";
import { fold } from "../text-match.ts";
import { readEuros } from "./field-input.ts";
import { isProblem, type Problem } from "./quote-input.ts";

export type Fence = (text: string) => string;

const FOREIGN = "l'importo è in un'altra valuta: convertilo in euro con exchange_rate e passa gli euro";

/** An amount of a voce in euros: more than zero, at most the cap. */
export function readItemAmount(value: unknown, fence: Fence): string | undefined | Problem {
	return readEuros(value, {
		fence,
		max: CASHFLOW_LIMITS.maxAmount,
		foreign: FOREIGN,
		negative: "amount è sempre positivo: se sono soldi che escono, kind uscita",
		zero: "amount deve essere più di zero",
	});
}

/** A balance in euros, a minus in front when the account is overdrawn («-350,50», «− 1.200»); 0 is a balance too. */
export function readSignedEuros(value: unknown, fence: Fence, what: string): string | undefined | Problem {
	if (value === undefined) return undefined;
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
	if (said === 0 || (typeof said === "string" && /^\s*(?:€\s*)?0+(?:[.,]0{1,2})?\s*(?:€|euro?)?\s*$/i.test(said))) return "0";
	const read = readEuros(said, { fence, max: CASHFLOW_LIMITS.maxAmount, foreign: FOREIGN, negative: `${what}: un solo segno meno davanti`, zero: `${what}: dammi un numero` });
	if (read === undefined || isProblem(read)) return isProblem(read) ? { problem: `${what}: ${read.problem.replace(/^amount: /, "")}` } : read;
	return negative ? `-${read}` : read;
}

const IN_WORDS = /^(?:in|entrata|entrate|incasso|incassi|ricevo|ricevuto|ricavo|accredito|\+)$/;
const OUT_WORDS = /^(?:out|uscita|uscite|pagamento|spesa|pago|addebito|-)$/;

/** «entrata» / «uscita» (in, out, incasso, pagamento…); `fallback` when not said. */
export function readKind(value: unknown, fallback?: Kind): Kind | Problem {
	if (value === undefined || value === "") return fallback ?? { problem: "kind è entrata (soldi che arrivano) o uscita (soldi che escono)" };
	const t = typeof value === "string" ? fold(value).trim() : "";
	if (IN_WORDS.test(t)) return "in";
	if (OUT_WORDS.test(t)) return "out";
	return { problem: "kind è entrata (soldi che arrivano) o uscita (soldi che escono)" };
}

export type ItemFields = { readonly kind: Kind; readonly amount: string; readonly date: string; readonly months?: number; readonly day?: number; readonly until?: string; readonly notes: readonly string[] };

/** The date words of a voce: what readDue reads, after a few words of a voce («il», «a partire dal»). */
function dueWords(value: unknown): unknown {
	return typeof value === "string" ? value.replace(/^\s*(?:a partire dal(?:l')?|dal(?:l')?|da|a partire da)\s+/i, "") : value;
}

/** The fields of a voce (to keep, or a hypothetical one): direction, amount, date, frequency, end. */
export function readItemFields(args: Record<string, unknown>, today: string, fence: Fence, fallbackKind?: Kind): ItemFields | Problem {
	const kind = readKind(args.kind, fallbackKind);
	if (isProblem(kind)) return kind;
	const amount = readItemAmount(args.amount, fence);
	if (isProblem(amount)) return amount;
	if (amount === undefined) return { problem: "serve amount, l'importo in euro" };
	if (args.date === undefined) return { problem: "serve date, il giorno del movimento (12/11/2026, «il 27», «ogni 27 del mese», «fine mese», «dicembre»)" };
	const due = readDue(dueWords(args.date), today);
	if (isProblem(due)) return { problem: due.problem.replace(/^due è la prossima scadenza/, "date è il giorno del movimento").replace(/ dammi la prossima scadenza$/, " dammi il giorno del movimento") };
	let months: number | undefined;
	if (args.frequency !== undefined && args.frequency !== "" && !/^(?:una volta|una tantum|mai|no|nessuna)$/i.test(String(args.frequency).trim())) {
		const read = parseFrequency(args.frequency);
		if (isProblem(read)) return read;
		months = read;
	} else if (due.monthly === true) months = 1;
	const notes: string[] = [];
	if (months === undefined && due.past === true) return { problem: `la data del ${long(due.date)} è passata: una voce una tantum va da oggi in poi` };
	const placed = months === undefined ? due : placeDue(due, months, today);
	if (due.day === 31 && !/\d/.test(String(args.date))) notes.push(`Ho messo il ${long(placed.date)}, l'ultimo giorno del mese${months === undefined ? "" : ", e lo tengo a fine mese"}: se è un altro giorno, dimmelo.`);
	let until: string | undefined;
	if (args.until !== undefined && args.until !== "") {
		if (months === undefined) return { problem: "until vale solo per una voce che si ripete (frequency)" };
		const end = readDue(dueWords(args.until), today);
		if (isProblem(end)) return { problem: `until: ${end.problem.replace(/^due è la prossima scadenza: /, "")}` };
		if (end.date < placed.date) return { problem: `until (${long(end.date)}) viene prima della data (${long(placed.date)})` };
		until = end.date;
	}
	return { kind, amount, date: placed.date, ...(months === undefined ? {} : { months, day: due.day }), ...(until === undefined ? {} : { until }), notes };
}

/** A hypothetical voce of a what_if from its fields; uscita when the direction is not said. */
export function readHypothetical(raw: unknown, today: string, fence: Fence): Hypothetical | Problem {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problem: "ogni ipotesi è un oggetto con amount, date e, se serve, kind, frequency e name" };
	const args = raw as Record<string, unknown>;
	const fields = readItemFields(args, today, fence, "out");
	if (isProblem(fields)) return fields;
	const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim().slice(0, CASHFLOW_LIMITS.name) : undefined;
	return { kind: fields.kind, cents: scaled(fields.amount, 2), date: fields.date, ...(fields.months === undefined ? {} : { months: fields.months, day: fields.day as number }), ...(name === undefined ? {} : { name }) };
}

const COUNT_WORDS: Readonly<Record<string, number>> = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12 };

const BAD_HORIZON = "horizon è fin quando guardare: «fine mese», «30 giorni», «90 giorni», «3 mesi», «6 settimane», «fino a dicembre», «fine anno» o una data (31/12/2026); oppure days, un numero di giorni";

export type Horizon = { readonly end: string; readonly days: number; readonly said: boolean };

/** The last day of the forecast: `days` from today, or the horizon's words; DEFAULT_DAYS when neither. */
export function readHorizon(horizon: unknown, days: unknown, today: string): Horizon | Problem {
	const max = CASHFLOW_LIMITS.maxDays;
	const of = (end: string, said = true): Horizon | Problem => {
		if (end < today) return { problem: `la data del ${long(end)} è già passata: ${BAD_HORIZON}` };
		const n = daysBetween(today, end);
		if (n > max) return { problem: `posso guardare al massimo ${max} giorni avanti (fino al ${long(addDays(today, max))})` };
		return { end, days: n, said };
	};
	if (days !== undefined) {
		if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > max) return { problem: `days è un numero di giorni da 1 a ${max}` };
		return of(addDays(today, days));
	}
	if (horizon === undefined || (typeof horizon === "string" && horizon.trim() === "")) return of(addDays(today, DEFAULT_DAYS), false);
	if (typeof horizon !== "string" || horizon.length > 60) return { problem: BAD_HORIZON };
	const t = fold(horizon)
		.replace(/[’`]/g, "'")
		.replace(/^(?:come sono messo |come sto )?(?:fino (?:a |al |alla |all')|entro (?:il |la |l')?|per (?:i |le )?|nei |nelle |a |al |alla |da qui a )?/, "")
		.replace(/^(?:prossim[ie] )/, "")
		.replace(/\s+/g, " ")
		.trim();
	const rel = /^(?:i |le )?(\d{1,3}|[a-z]+) (giorni|giorno|gg|settimane|settimana|mesi|mese|anni|anno)$/.exec(t);
	const n = rel === null ? undefined : /^\d+$/.test(rel[1] as string) ? Number(rel[1]) : COUNT_WORDS[rel[1] as string];
	if (rel !== null && n !== undefined) {
		if (n < 1) return { problem: BAD_HORIZON };
		const unit = rel[2] as string;
		if (unit.startsWith("g")) return of(addDays(today, n));
		if (unit.startsWith("settiman")) return of(addDays(today, 7 * n));
		const months = unit.startsWith("ann") ? 12 * n : n;
		return of(rollDate(today, months, Number(today.slice(8, 10))));
	}
	if (t === "mese" || t === "un mese") return of(rollDate(today, 1, Number(today.slice(8, 10))));
	if (t === "anno" || t === "un anno") return of(rollDate(today, 12, Number(today.slice(8, 10))));
	const due = readDue(t, today);
	if (isProblem(due)) return { problem: BAD_HORIZON };
	return of(due.date);
}
