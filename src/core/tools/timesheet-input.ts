/**
 * The timesheet tool's arguments, read and checked: the client and project (text the person
 * said), the day (day-input.ts: today when not said, «ieri», «lunedì scorso», never a day to
 * come), the duration or the clock range (durations.ts), the description, billable, the hourly
 * rate (euros, VAT excluded: the quotes' decimal rules, never another currency) and the rounding.
 *
 * Reading (readFields) is apart from applying (applyFields): an edit applies only the fields
 * given, to the entry as saved under the store's lock.
 */
import { parseDuration, parseRange } from "../durations.ts";
import { idOrder, ROUNDINGS, type Rounding, TIMESHEET_LIMITS, validRate, type WorkEntry } from "../timesheet.ts";
import { fold } from "../text-match.ts";
import { type DayWords, readPastDay } from "./day-input.ts";
import { cleanText, isProblem, type Problem, readAmount } from "./quote-input.ts";
import { fenced } from "./timesheet-render.ts";

/** What an entry holds besides its id, who recorded it, and its billing. */
export type EntryDraft = Omit<WorkEntry, "id" | "by" | "at" | "callId" | "edited" | "billed">;

/** The fields an edit may change; any of them given makes it an edit. */
const EDIT_FIELDS = ["date", "client", "project", "duration", "time", "description", "billable", "rate"] as const;

const WORK_DAY: DayWords = { field: "date è il giorno in cui hai lavorato", future: "le ore si registrano quando sono fatte" };

const FOREIGN = /\$|£|¥|\b(?:usd|gbp|chf|jpy|dollar\w*|sterlin\w*|franch\w*)\b/i;
/** «45 €/h», «45 euro l'ora», «45 all'ora»: the «per hour» goes, the amount stays. */
const PER_HOUR = /\s*(?:\/\s*(?:h|ora)|(?:l'|all'|a |per )\s*ora|orari[eo]?)\s*$/i;

/** An hourly rate in euros, VAT excluded: more than zero, at most TIMESHEET_LIMITS.maxRate, to the cent; undefined when not given. */
export function readRate(value: unknown, name = "rate"): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value === "string" && FOREIGN.test(value)) return { problem: `${name}: la tariffa è in euro; per un'altra valuta convertila con exchange_rate` };
	if ((typeof value === "number" && value < 0) || (typeof value === "string" && /^\s*(?:€|eur\w*)?\s*-/i.test(value))) return { problem: `${name}: la tariffa non può essere negativa` };
	const read = readAmount(typeof value === "string" ? value.replace(PER_HOUR, "") : value, 2, name, fenced);
	if (isProblem(read) || read === undefined) return read;
	if (Number(read) <= 0) return { problem: `${name}: la tariffa è zero. Per ore da non fatturare usa billable false` };
	if (!validRate(read)) return { problem: `${name}: la tariffa oraria è oltre ${TIMESHEET_LIMITS.maxRate.toLocaleString("it-IT")} €: ricontrollala con chi ti scrive` };
	return read;
}

/** A rounding as said: 0 / «nessuno», 15 / «quarto d'ora», 30 / «mezz'ora»; undefined when not given. */
export function readRounding(value: unknown): Rounding | undefined | Problem {
	if (value === undefined) return undefined;
	const t = typeof value === "number" ? String(value) : typeof value === "string" ? fold(value).replace(/\s+/g, " ").trim() : "";
	if (/^(?:0|no|none|nessun[oa]?|senza)(?: arrotondamento)?$/.test(t)) return 0;
	if (/^15(?: ?(?:min|minuti|m))?$|quarto d'? ?ora/.test(t)) return 15;
	if (/^30(?: ?(?:min|minuti|m))?$|mezz'? ?ora|mezza ora/.test(t)) return 30;
	return { problem: `rounding è uno di questi: ${ROUNDINGS.join(", ")} minuti (0 = nessun arrotondamento)` };
}

/** The minutes, and the range when one was said: from duration, time, or both when they agree. */
function readTime(duration: unknown, time: unknown): { minutes: number; start?: string; end?: string } | undefined | Problem {
	// A range given as duration («9-12:30») is a range.
	const asRange = typeof duration === "string" && time === undefined && /\d\s*(?:-|–|—|alle)\s*\d|^\s*dall?[e']/i.test(duration) && !/^\s*\d{1,2}:\d{2}\s*$/.test(duration);
	const rangeText = asRange ? duration : time;
	const durationValue = asRange ? undefined : duration;
	const range = rangeText === undefined ? undefined : parseRange(rangeText);
	if (range !== undefined && "problem" in range) return range;
	const minutes = durationValue === undefined ? undefined : parseDuration(durationValue);
	if (minutes !== undefined && typeof minutes !== "number") return minutes;
	if (range !== undefined && minutes !== undefined && range.minutes !== minutes) return { problem: "la durata e l'orario non tornano: dammene uno solo, o ricontrollali" };
	if (range !== undefined) return { minutes: range.minutes, start: range.start, end: range.end };
	return minutes === undefined ? undefined : { minutes };
}

/** The fields given: a value, null for «""» in an edit (removes it), undefined when not given. */
export type Fields = {
	readonly date?: string;
	/** Said with the answer: a date without a year placed almost a year back. */
	readonly dateNote?: string;
	readonly client?: string;
	readonly project?: string | null;
	readonly time?: { readonly minutes: number; readonly start?: string; readonly end?: string };
	readonly description?: string | null;
	readonly billable?: boolean;
	readonly rate?: string | null;
};

/** The arguments read and checked, nothing applied yet. In an edit «""» removes project, description or rate. */
export function readFields(args: Record<string, unknown>, o: { today: string; editing: boolean }): Fields | Problem {
	const out: Record<string, unknown> = {};
	const removed = (name: string) => o.editing && args[name] === "";
	if (args.date !== undefined || !o.editing) {
		const date = readPastDay(args.date, o.today, WORK_DAY);
		if (isProblem(date)) return date;
		out.date = date.date;
		if (date.note !== undefined) out.dateNote = date.note;
	}
	const client = cleanText(args.client, TIMESHEET_LIMITS.client, "client");
	if (isProblem(client)) return client;
	if (client !== undefined) out.client = client;
	const texts = [
		["project", TIMESHEET_LIMITS.project, false],
		["description", TIMESHEET_LIMITS.description, true],
	] as const;
	for (const [name, max, lines] of texts) {
		if (removed(name)) out[name] = null;
		else {
			const text = cleanText(args[name], max, name, lines);
			if (isProblem(text)) return text;
			if (text !== undefined) out[name] = text;
		}
	}
	const time = readTime(args.duration, args.time);
	if (isProblem(time)) return time;
	if (time !== undefined) out.time = time;
	if (args.billable !== undefined) {
		if (typeof args.billable !== "boolean") return { problem: "billable è true o false" };
		out.billable = args.billable;
	}
	if (removed("rate")) out.rate = null;
	else {
		const rate = readRate(args.rate);
		if (isProblem(rate)) return rate;
		if (rate !== undefined) out.rate = rate;
	}
	return out as Fields;
}

/**
 * The fields applied: on nothing for a new entry (client and duration are needed), or on `old`,
 * the entry as saved now, changing only what is given. An edit never moves an entry to another
 * year: its id is of its year. A new duration without a range drops the old range.
 */
export function applyFields(f: Fields, old?: WorkEntry): { draft: EntryDraft; notes: string[] } | Problem {
	const notes: string[] = f.dateNote === undefined ? [] : [f.dateNote];
	const client = f.client ?? old?.client;
	if (client === undefined) return { problem: "manca il cliente (client): chiedi a chi ti scrive per chi ha lavorato" };
	const time = f.time ?? (old === undefined ? undefined : { minutes: old.minutes, ...(old.start === undefined ? {} : { start: old.start, end: old.end }) });
	if (time === undefined) return { problem: "manca quanto hai lavorato: passa duration («3 ore», «2h30», «90 minuti») o time («9-12:30»)" };
	const date = f.date ?? old?.date;
	if (date === undefined) return { problem: "manca la data" };
	if (old !== undefined && f.date !== undefined && Number(f.date.slice(0, 4)) !== idOrder(old.id)[0]) {
		return { problem: `la voce ${old.id} è del ${idOrder(old.id)[0]}: per cambiare anno toglila e registrala di nuovo` };
	}
	const pick = <T>(given: T | null | undefined, before: T | undefined): T | undefined => (given === null ? undefined : (given ?? before));
	const optional = { project: pick(f.project, old?.project), start: time.start, end: time.end, description: pick(f.description, old?.description), rate: pick(f.rate, old?.rate) };
	const draft = { date, client, minutes: time.minutes, billable: f.billable ?? old?.billable ?? true, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) } as EntryDraft;
	return { draft, notes };
}

/** Whether an edit's arguments change anything at all. */
export function editsSomething(args: Record<string, unknown>): boolean {
	return EDIT_FIELDS.some((k) => args[k] !== undefined);
}
