/**
 * The arithmetic of the ore di lavoro, exact: minutes are integers, rates and amounts bigint
 * cents, never floats. The amount of an entry is its hourly rate times its minutes over 60,
 * rounded half up to the cent, entry by entry: 45,00 €/h for 20 minutes is 15,00 €, 50,00 €/h for
 * 1 minute is 0,83 € (83,33… cents), 0,10 €/h for 5 minutes is 0,01 € (0,8333… cents up). A
 * client's rounding (to 15 or 30 minutes, always up) applies per entry, when billing only: the
 * minutes recorded never change. A billed entry keeps the rate and rounding it was billed at.
 */
import { hoursText } from "./durations.ts";
import { hourlyText } from "./invoice-sums.ts";
import { addDays } from "./italian-calendar.ts";
import { italianDate } from "./italian-format.ts";
import { spellingKey } from "./name-keys.ts";
import { inPeriod, type Period, type Span } from "./periods.ts";
import { centsDecimal, halfUp, scaled } from "./quote-sums.ts";
import { billingState, newestFirst, type RateRule, type Rounding, sameClient, type Timer, type WorkEntry } from "./timesheet.ts";

/** A canonical decimal rate («45.5») in cents. */
export function rateCents(rate: string): bigint {
	return scaled(rate, 2);
}

/** The minutes billed for an entry: rounded up to the next multiple of `rounding` (0: as recorded). */
export function billedMinutes(minutes: number, rounding: Rounding): number {
	return rounding === 0 ? minutes : Math.ceil(minutes / rounding) * rounding;
}

/** rate × minutes / 60, half up to the cent: the amount of one entry. */
export function entryAmount(rate: bigint, minutes: number): bigint {
	return halfUp(rate * BigInt(minutes), 60n);
}

/** Minutes in hundredths of an hour, half up: 50 minutes is 83 (0,83 h). */
export function hoursHundredths(minutes: number): bigint {
	return halfUp(BigInt(minutes) * 100n, 60n);
}

/** The default rule of a client (its name, legal form included) and everyone's. */
export function rulesFor(client: string, rates: readonly RateRule[]): { readonly own?: RateRule; readonly all?: RateRule } {
	const own = rates.find((r) => r.client !== undefined && sameClient(r.client, client));
	const all = rates.find((r) => r.client === undefined);
	return { ...(own === undefined ? {} : { own }), ...(all === undefined ? {} : { all }) };
}

export type Terms = { readonly rate?: string; readonly rounding: Rounding };

/** The rate and rounding an entry is billed at: frozen once billed; else its own rate, its client's, everyone's. */
export function termsOf(entry: Pick<WorkEntry, "client" | "rate" | "billed">, rates: readonly RateRule[]): Terms {
	if (entry.billed?.rate !== undefined || entry.billed?.rounding !== undefined) {
		return { ...(entry.billed.rate === undefined ? {} : { rate: entry.billed.rate }), rounding: entry.billed.rounding ?? 0 };
	}
	const { own, all } = rulesFor(entry.client, rates);
	const rate = entry.rate ?? own?.rate ?? all?.rate;
	return { ...(rate === undefined ? {} : { rate }), rounding: own?.rounding ?? all?.rounding ?? 0 };
}

export type Priced = {
	readonly entry: WorkEntry;
	/** The minutes billed: rounded when the client has a rounding. */
	readonly billed: number;
	readonly rate?: string;
	readonly rounding: Rounding;
	/** For a billable entry with a rate. */
	readonly amount?: bigint;
};

/** An entry with its amount: at its terms of now, or at `terms` given (as to_quote picked them). */
export function priced(entry: WorkEntry, rates: readonly RateRule[], terms: Terms = termsOf(entry, rates)): Priced {
	const billed = billedMinutes(entry.minutes, terms.rounding);
	const amount = entry.billable && terms.rate !== undefined ? entryAmount(rateCents(terms.rate), billed) : undefined;
	return { entry, billed, rounding: terms.rounding, ...(terms.rate === undefined ? {} : { rate: terms.rate }), ...(amount === undefined ? {} : { amount }) };
}

/** Minutes and amount of some entries: `unpriced` of them billable without a rate (their amount is not known). */
export type Part = { readonly count: number; readonly minutes: number; readonly billed: number; readonly amount: bigint; readonly unpriced: number };

export type HoursTotals = {
	readonly count: number;
	/** Minutes worked, as recorded. */
	readonly minutes: number;
	/** The billable entries: minutes recorded, minutes billed (rounded), amount. */
	readonly billable: Part;
	/** Billable and not billed at all. */
	readonly unbilled: Part;
	/** In a preventivo, no invoice reference yet. */
	readonly quoted: Part;
};

const NONE: Part = { count: 0, minutes: 0, billed: 0, amount: 0n, unpriced: 0 };
const ZERO: HoursTotals = { count: 0, minutes: 0, billable: NONE, unbilled: NONE, quoted: NONE };

function add(part: Part, p: Priced): Part {
	return { count: part.count + 1, minutes: part.minutes + p.entry.minutes, billed: part.billed + p.billed, amount: part.amount + (p.amount ?? 0n), unpriced: part.unpriced + (p.rate === undefined ? 1 : 0) };
}

function plus(t: HoursTotals, p: Priced): HoursTotals {
	const e = p.entry;
	const state = billingState(e);
	return {
		count: t.count + 1,
		minutes: t.minutes + e.minutes,
		billable: e.billable ? add(t.billable, p) : t.billable,
		unbilled: e.billable && state === "unbilled" ? add(t.unbilled, p) : t.unbilled,
		quoted: e.billable && state === "quoted" ? add(t.quoted, p) : t.quoted,
	};
}

/** The totals of some priced entries. */
export function totalsOfPriced(items: readonly Priced[]): HoursTotals {
	return items.reduce(plus, ZERO);
}

export type ProjectTotals = { readonly project?: string; readonly totals: HoursTotals };
export type ClientTotals = { readonly client: string; readonly totals: HoursTotals; readonly projects: readonly ProjectTotals[] };
export type HoursSummary = { readonly totals: HoursTotals; readonly clients: readonly ClientTotals[] };

const larger = (a: { totals: HoursTotals }, b: { totals: HoursTotals }) => b.totals.minutes - a.totals.minutes;
const keyOf = (name: string) => spellingKey(name) || name;

/**
 * The totals of `entries` (dated in `span` when given), per client (by name, legal form included,
 * shown as its latest entry writes it) and per project; most hours first.
 */
export function summarize(entries: readonly WorkEntry[], rates: readonly RateRule[], span?: Span): HoursSummary {
	const within = entries.filter((e) => span === undefined || inPeriod(e.date, span)).sort(newestFirst);
	const clients = new Map<string, { client: string; totals: HoursTotals; projects: Map<string, ProjectTotals> }>();
	let totals = ZERO;
	for (const e of within) {
		const p = priced(e, rates);
		totals = plus(totals, p);
		const key = keyOf(e.client);
		const c = clients.get(key) ?? { client: e.client, totals: ZERO, projects: new Map() };
		c.totals = plus(c.totals, p);
		const pk = e.project === undefined ? "" : keyOf(e.project);
		const seen = c.projects.get(pk);
		c.projects.set(pk, { ...(seen?.project !== undefined ? { project: seen.project } : e.project === undefined ? {} : { project: e.project }), totals: plus(seen?.totals ?? ZERO, p) });
		clients.set(key, c);
	}
	return { totals, clients: [...clients.values()].map((c) => ({ client: c.client, totals: c.totals, projects: [...c.projects.values()].sort(larger) })).sort(larger) };
}

/** Unbilled hours older than this many days are said in the brief. */
export const STALE_DAYS = 30;

/** A timer running longer than this is said in the brief. */
export const BRIEF_TIMER_MINUTES = 10 * 60;

/** A client's old unbilled hours: since which day, and the amount when every entry has a rate. */
export type Stale = { readonly client: string; readonly minutes: number; readonly since: string; readonly amount?: bigint };

/** Per client, the billable entries not billed at all and dated more than STALE_DAYS ago. Most first. */
export function staleUnbilled(entries: readonly WorkEntry[], rates: readonly RateRule[], today: string): Stale[] {
	const limit = addDays(today, -STALE_DAYS);
	const byClient = new Map<string, { client: string; minutes: number; since: string; amount: bigint; unpriced: boolean }>();
	for (const e of [...entries].sort(newestFirst)) {
		if (!e.billable || e.billed !== undefined || e.date >= limit) continue;
		const p = priced(e, rates);
		const key = keyOf(e.client);
		const seen = byClient.get(key) ?? { client: e.client, minutes: 0, since: e.date, amount: 0n, unpriced: false };
		byClient.set(key, { client: seen.client, minutes: seen.minutes + e.minutes, since: e.date < seen.since ? e.date : seen.since, amount: seen.amount + (p.amount ?? 0n), unpriced: seen.unpriced || p.amount === undefined });
	}
	return [...byClient.values()].sort((a, b) => b.minutes - a.minutes).map((s) => ({ client: s.client, minutes: s.minutes, since: s.since, ...(s.unpriced ? {} : { amount: s.amount }) }));
}

/** Whole minutes a timer has run at `now`, half up; never below zero. */
export function timerMinutes(timer: Pick<Timer, "startedAt">, now: Date): number {
	const ms = now.getTime() - Date.parse(timer.startedAt);
	return ms <= 0 ? 0 : Math.floor((ms + 30_000) / 60_000);
}

export const QUOTE_GROUPS = ["project", "total", "entry"] as const;
export type QuoteGroup = (typeof QUOTE_GROUPS)[number];

/** A line for a preventivo: hours × rate, or a lump sum when that does not come out to the cent. */
export type HoursLine = { readonly description: string; readonly quantity: number; readonly unit?: string; readonly price: number };

/** How the lines are worded, by the caller: a group's description (its project and activities), an entry's, a lump sum's tail. */
export type LineWords = {
	readonly group: (project: string | undefined, activities: readonly string[]) => string;
	readonly entry: (e: WorkEntry) => string;
	readonly lump: (minutes: number, rate: string) => string;
};

/**
 * The quote's lines from priced entries, all with a rate: one per project (and rate), one in all
 * (per rate), or one per entry. A line is hours × hourly rate («ora» for one hour, «ore» else)
 * when its billed minutes are hours with at most two decimals (a multiple of 3 minutes) and the
 * quote's own rounding of quantity × price gives the same cents as the entries' amounts added up;
 * otherwise it is a lump sum, a corpo, with the hours and the rate in its description, so the
 * quote's total is always the timesheet's.
 */
export function hoursLines(items: readonly Priced[], group: QuoteGroup, words: LineWords, maxLength: number): HoursLine[] {
	const groups = new Map<string, { project?: string; entries: WorkEntry[]; rate: string; billed: number; amount: bigint }>();
	for (const p of items) {
		const rate = p.rate as string;
		const project = group === "project" ? p.entry.project : undefined;
		const key = group === "entry" ? p.entry.id : `${project === undefined ? "" : keyOf(project)}|${rate}`;
		const seen = groups.get(key) ?? { ...(project === undefined ? {} : { project }), entries: [], rate, billed: 0, amount: 0n };
		groups.set(key, { ...seen, entries: [...seen.entries, p.entry], billed: seen.billed + p.billed, amount: seen.amount + (p.amount ?? 0n) });
	}
	const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
	return [...groups.values()].map((g) => {
		const activities = [...new Map(g.entries.flatMap((e) => (e.description === undefined ? [] : [[spellingKey(e.description), e.description.replace(/\n/g, " ")] as const]))).values()];
		const description = group === "entry" ? words.entry(g.entries[0] as WorkEntry) : words.group(g.project, activities);
		if (g.billed % 3 === 0 && entryAmount(rateCents(g.rate), g.billed) === g.amount) {
			return { description: cut(description, maxLength), quantity: g.billed / 60, unit: g.billed === 60 ? "ora" : "ore", price: Number(g.rate) };
		}
		const tail = words.lump(g.billed, g.rate);
		return { description: `${cut(description, maxLength - tail.length)}${tail}`, quantity: 1, price: Number(centsDecimal(g.amount)) };
	});
}

/** Activities named in a line for a project, at most; each cut to this length. */
const MAX_ACTIVITIES = 3;
const ACTIVITY_LENGTH = 40;

/** The words of the quote's lines: a project's hours with a few of its activities, an entry's day and description, a lump sum's hours and rate. */
export function lineWords(period: Period): LineWords {
	const short = (t: string) => (t.length > ACTIVITY_LENGTH ? `${t.slice(0, ACTIVITY_LENGTH - 1)}…` : t);
	return {
		group: (project, activities) => {
			const named = activities.slice(0, MAX_ACTIVITIES).map(short).join("; ");
			const what = activities.length === 0 ? "" : ` (attività: ${named}${activities.length > MAX_ACTIVITIES ? "…" : ""})`;
			return `Ore di lavoro${project === undefined ? "" : ` – ${project}`}, ${period.label}${what}`;
		},
		entry: (e) => {
			const project = e.project === undefined ? "" : ` – ${e.project}`;
			return e.description === undefined ? `Ore di lavoro del ${italianDate(e.date)}${project}` : `${italianDate(e.date)}${project}: ${e.description.replace(/\n/g, " ")}`;
		},
		lump: (minutes, rate) => ` (${hoursText(minutes)} a ${hourlyText(rate)})`,
	};
}
