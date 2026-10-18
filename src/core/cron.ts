/**
 * Five-field cron expressions (minute hour day-of-month month weekday) evaluated in an
 * IANA time zone, so "30 8 * * 1-5" means 8:30 in Rome also across daylight saving time.
 * Supports `*`, numbers, ranges `a-b`, lists `a,b` and steps `*\/n` or `a-b/n`; weekday 0
 * and 7 are Sunday. When both day-of-month and weekday are restricted, either matches.
 */
export type Cron = {
	readonly source: string;
	readonly minute: ReadonlySet<number>;
	readonly hour: ReadonlySet<number>;
	readonly day: ReadonlySet<number>;
	readonly month: ReadonlySet<number>;
	readonly weekday: ReadonlySet<number>;
	readonly dayRestricted: boolean;
	readonly weekdayRestricted: boolean;
};

const FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "weekday", min: 0, max: 7 },
] as const;

export function parseCron(source: string): Cron {
	const parts = source.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`Cron "${source}": expected 5 fields (minute hour day month weekday)`);
	const sets = parts.map((part, i) => parseField(part, FIELDS[i] as (typeof FIELDS)[number], source));
	const weekday = new Set([...(sets[4] as Set<number>)].map((d) => (d === 7 ? 0 : d)));
	return {
		source,
		minute: sets[0] as Set<number>,
		hour: sets[1] as Set<number>,
		day: sets[2] as Set<number>,
		month: sets[3] as Set<number>,
		weekday,
		dayRestricted: parts[2] !== "*",
		weekdayRestricted: parts[4] !== "*",
	};
}

const DAY_NAMES = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
const and = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`);

/**
 * The schedule in Italian words, for the people who read it in the console: "dal lunedì al
 * venerdì alle 9:00". Only the shapes people actually use; anything else is undefined and the
 * cron itself is shown.
 */
export function describeCron(source: string): string | undefined {
	try {
		parseCron(source);
	} catch {
		return undefined;
	}
	const [minute, hour, day, month, weekday] = source.trim().split(/\s+/) as [string, string, string, string, string];
	if (month !== "*") return undefined;
	const number = /^\d+$/;
	const every = (part: string) => /^\*\/(\d+)$/.exec(part)?.[1];
	if (day === "*" && weekday === "*") {
		if (hour === "*" && minute === "0") return "ogni ora";
		if (hour === "*" && every(minute) !== undefined) return `ogni ${every(minute)} minuti`;
		if (minute === "0" && every(hour) !== undefined) return `ogni ${every(hour)} ore`;
	}
	const hours = hour.split(",");
	if (!number.test(minute) || !hours.every((h) => number.test(h))) return undefined;
	const at = and(hours.map((h) => `alle ${Number(h)}:${minute.padStart(2, "0")}`));
	if (day === "*" && weekday === "*") return `ogni giorno ${at}`;
	if (day === "*" && weekday === "1-5") return `dal lunedì al venerdì ${at}`;
	if (day === "*" && weekday.split(",").every((d) => number.test(d))) {
		const days = [...new Set(weekday.split(",").map((d) => (Number(d) === 0 ? 7 : Number(d))))].sort((a, b) => a - b);
		return days.length === 1 ? `ogni ${DAY_NAMES[days[0] as number]} ${at}` : `${and(days.map((d) => DAY_NAMES[d] as string))} ${at}`;
	}
	if (number.test(day) && weekday === "*") return `ogni mese il ${Number(day)} ${at}`;
	return undefined;
}

function parseField(part: string, field: (typeof FIELDS)[number], source: string): Set<number> {
	const out = new Set<number>();
	for (const item of part.split(",")) {
		const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
		if (m === null) throw new Error(`Cron "${source}": invalid ${field.name} "${item}"`);
		const step = m[4] === undefined ? 1 : Number(m[4]);
		const from = m[1] === "*" ? field.min : Number(m[2]);
		const to = m[1] === "*" ? field.max : m[3] === undefined ? (m[4] === undefined ? from : field.max) : Number(m[3]);
		if (step < 1 || from < field.min || to > field.max || from > to) throw new Error(`Cron "${source}": ${field.name} out of range in "${item}" (${field.min}-${field.max})`);
		for (let v = from; v <= to; v += step) out.add(v);
	}
	return out;
}

type Local = { month: number; day: number; hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function local(date: Date, timeZone: string): Local {
	let f = formatters.get(timeZone);
	if (f === undefined) {
		f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
		formatters.set(timeZone, f);
	}
	const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
	return { month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday as string] ?? 0 };
}

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

/** The local wall-clock minute of `date` in `timeZone`, e.g. "2026-10-25 02:30". */
export function localMinute(date: Date, timeZone: string): string {
	let f = keyFormatters.get(timeZone);
	if (f === undefined) {
		f = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
		keyFormatters.set(timeZone, f);
	}
	return f.format(date);
}

/**
 * The next run after `from` that is not the same local wall-clock minute as `previous`: when
 * clocks go back, 02:30 happens twice, and a daily 02:30 must run once.
 */
export function nextDistinctRun(cron: Cron, from: Date, timeZone: string, previous: Date | undefined): Date {
	let next = nextRun(cron, from, timeZone);
	if (previous !== undefined && localMinute(next, timeZone) === localMinute(previous, timeZone)) next = nextRun(cron, next, timeZone);
	return next;
}

/** Throws for an unknown time zone. */
export function assertTimeZone(timeZone: string): void {
	local(new Date(), timeZone);
}

const MINUTE = 60_000;

/** The first time strictly after `from` that matches, in `timeZone`. */
export function nextRun(cron: Cron, from: Date, timeZone: string): Date {
	let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
	const limit = t + 4 * 366 * 24 * 60 * MINUTE;
	while (t < limit) {
		const l = local(new Date(t), timeZone);
		const dayOk =
			cron.dayRestricted && cron.weekdayRestricted ? cron.day.has(l.day) || cron.weekday.has(l.weekday) : cron.day.has(l.day) && cron.weekday.has(l.weekday);
		if (!cron.month.has(l.month) || !dayOk) {
			// Jump towards the next local midnight, stopping an hour early: on a daylight saving
			// day a full jump could land past midnight and skip a 00:xx run.
			t += Math.max(60 - l.minute, (23 - l.hour) * 60 + (60 - l.minute) - 60) * MINUTE;
			continue;
		}
		if (!cron.hour.has(l.hour)) {
			t += (60 - l.minute) * MINUTE;
			continue;
		}
		if (!cron.minute.has(l.minute)) {
			t += MINUTE;
			continue;
		}
		return new Date(t);
	}
	throw new Error(`Cron "${cron.source}" never runs`);
}
