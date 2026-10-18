/**
 * The arithmetic of the ore di lavoro, exact: minutes are integers, rates and amounts bigint
 * cents, never floats. The amount of an entry is its hourly rate times its minutes over 60,
 * rounded half up to the cent, entry by entry: 45,00 €/h for 20 minutes is 15,00 €, 50,00 €/h for
 * 1 minute is 0,83 € (83,33… cents), 0,10 €/h for 5 minutes is 0,01 € (0,8333… cents up). A
 * client's rounding (to 15 or 30 minutes, always up) applies per entry, when billing only: the
 * minutes recorded never change. A billed entry keeps the rate and rounding it was billed at.
 */
import { addDays } from "./italian-calendar.ts";
import { businessKey } from "./name-keys.ts";
import { inPeriod, type Span } from "./periods.ts";
import { halfUp, scaled } from "./quote-sums.ts";
import { newestFirst, type RateRule, type Rounding, sameClient, type Timer, type WorkEntry } from "./timesheet.ts";

/** A canonical decimal rate («45.5») in cents. */
export function rateCents(rate: string): bigint {
	return scaled(rate, 2);
}

/** Cents back to a canonical decimal: 4550n → «45.5». */
export function centsDecimal(value: bigint): string {
	const digits = (value < 0n ? -value : value).toString().padStart(3, "0");
	const fraction = digits.slice(-2).replace(/0+$/, "");
	const integer = digits.slice(0, -2);
	return `${value < 0n ? "-" : ""}${fraction === "" ? integer : `${integer}.${fraction}`}`;
}

/** The minutes billed for an entry: rounded up to the next multiple of `rounding` (0: as recorded). */
export function billedMinutes(minutes: number, rounding: Rounding): number {
	return rounding === 0 ? minutes : Math.ceil(minutes / rounding) * rounding;
}

/** rate × minutes / 60, half up to the cent: the amount of one entry. */
export function entryAmount(rate: bigint, minutes: number): bigint {
	return halfUp(rate * BigInt(minutes), 60n);
}

/** The default rule of a client (by its name without case, accents and legal form) and everyone's. */
export function rulesFor(client: string, rates: readonly RateRule[]): { readonly own?: RateRule; readonly all?: RateRule } {
	const own = rates.find((r) => r.client !== undefined && sameClient(r.client, client));
	const all = rates.find((r) => r.client === undefined);
	return { ...(own === undefined ? {} : { own }), ...(all === undefined ? {} : { all }) };
}

/** The rate and rounding an entry is billed at: frozen once billed; else its own rate, its client's, everyone's. */
export function termsOf(entry: Pick<WorkEntry, "client" | "rate" | "billed">, rates: readonly RateRule[]): { readonly rate?: string; readonly rounding: Rounding } {
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

export function priced(entry: WorkEntry, rates: readonly RateRule[]): Priced {
	const terms = termsOf(entry, rates);
	const billed = billedMinutes(entry.minutes, terms.rounding);
	const amount = entry.billable && terms.rate !== undefined ? entryAmount(rateCents(terms.rate), billed) : undefined;
	return { entry, billed, rounding: terms.rounding, ...(terms.rate === undefined ? {} : { rate: terms.rate }), ...(amount === undefined ? {} : { amount }) };
}

export type HoursTotals = {
	readonly count: number;
	/** Minutes worked, as recorded. */
	readonly minutes: number;
	readonly billableMinutes: number;
	/** The billable amounts, at the minutes billed. */
	readonly amount: bigint;
	/** Billable and not billed yet. */
	readonly unbilledMinutes: number;
	readonly unbilledAmount: bigint;
	/** Billable entries without any rate: their amount is not known. */
	readonly unpriced: number;
};

const ZERO: HoursTotals = { count: 0, minutes: 0, billableMinutes: 0, amount: 0n, unbilledMinutes: 0, unbilledAmount: 0n, unpriced: 0 };

function plus(t: HoursTotals, p: Priced): HoursTotals {
	const e = p.entry;
	const amount = p.amount ?? 0n;
	const open = e.billable && e.billed === undefined;
	return {
		count: t.count + 1,
		minutes: t.minutes + e.minutes,
		billableMinutes: t.billableMinutes + (e.billable ? e.minutes : 0),
		amount: t.amount + amount,
		unbilledMinutes: t.unbilledMinutes + (open ? e.minutes : 0),
		unbilledAmount: t.unbilledAmount + (open ? amount : 0n),
		unpriced: t.unpriced + (e.billable && p.rate === undefined ? 1 : 0),
	};
}

export type ProjectTotals = { readonly project?: string; readonly totals: HoursTotals };
export type ClientTotals = { readonly client: string; readonly totals: HoursTotals; readonly projects: readonly ProjectTotals[] };
export type HoursSummary = { readonly totals: HoursTotals; readonly clients: readonly ClientTotals[] };

const larger = (a: { totals: HoursTotals }, b: { totals: HoursTotals }) => b.totals.minutes - a.totals.minutes;

/**
 * The totals of the entries dated in `span`, per client (by name without case, accents and legal
 * form, shown as its latest entry writes it) and per project; most hours first.
 */
export function summarize(entries: readonly WorkEntry[], rates: readonly RateRule[], span: Span): HoursSummary {
	const within = entries.filter((e) => inPeriod(e.date, span)).sort(newestFirst);
	const clients = new Map<string, { client: string; totals: HoursTotals; projects: Map<string, ProjectTotals> }>();
	let totals = ZERO;
	for (const e of within) {
		const p = priced(e, rates);
		totals = plus(totals, p);
		const key = businessKey(e.client) || e.client;
		const c = clients.get(key) ?? { client: e.client, totals: ZERO, projects: new Map() };
		c.totals = plus(c.totals, p);
		const pk = e.project === undefined ? "" : businessKey(e.project) || e.project;
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

export type Stale = { readonly client: string; readonly minutes: number; readonly since: string };

/** Per client, the billable entries not billed and dated more than STALE_DAYS ago: how many minutes, since which day. Most first. */
export function staleUnbilled(entries: readonly WorkEntry[], today: string): Stale[] {
	const limit = addDays(today, -STALE_DAYS);
	const byClient = new Map<string, { client: string; minutes: number; since: string }>();
	for (const e of [...entries].sort(newestFirst)) {
		if (!e.billable || e.billed !== undefined || e.date >= limit) continue;
		const key = businessKey(e.client) || e.client;
		const seen = byClient.get(key) ?? { client: e.client, minutes: 0, since: e.date };
		byClient.set(key, { client: seen.client, minutes: seen.minutes + e.minutes, since: e.date < seen.since ? e.date : seen.since });
	}
	return [...byClient.values()].sort((a, b) => b.minutes - a.minutes);
}

/** Whole minutes a timer has run at `now`, half up; never below zero. */
export function timerMinutes(timer: Pick<Timer, "startedAt">, now: Date): number {
	const ms = now.getTime() - Date.parse(timer.startedAt);
	return ms <= 0 ? 0 : Math.floor((ms + 30_000) / 60_000);
}

export const QUOTE_GROUPS = ["project", "total", "entry"] as const;
export type QuoteGroup = (typeof QUOTE_GROUPS)[number];

/** A line for quotes op create: hours × rate, or a lump sum when that does not come out to the cent. */
export type HoursLine = { readonly description: string; readonly quantity: number; readonly unit?: string; readonly price: number };

/**
 * The quote's lines from priced entries, all with a rate: one per project (and rate), one in all
 * (per rate), or one per entry. A line is hours × hourly rate when its billed minutes are hours
 * with at most two decimals (a multiple of 3 minutes) and the quote's own rounding of quantity ×
 * price gives the same cents as the entries' amounts added up; otherwise it is a lump sum, a
 * corpo, with the hours and the rate in its description, so the quote's total is always the
 * timesheet's. `label(entry or group)` gives the descriptions.
 */
export function hoursLines(items: readonly Priced[], group: QuoteGroup, label: { readonly group: (project: string | undefined) => string; readonly entry: (e: WorkEntry) => string }, maxLength: number): HoursLine[] {
	const groups = new Map<string, { description: string; rate: string; billed: number; amount: bigint }>();
	for (const p of items) {
		const rate = p.rate as string;
		const project = group === "project" ? p.entry.project : undefined;
		const key = group === "entry" ? p.entry.id : `${project === undefined ? "" : businessKey(project) || project}|${rate}`;
		const seen = groups.get(key) ?? { description: group === "entry" ? label.entry(p.entry) : label.group(project), rate, billed: 0, amount: 0n };
		groups.set(key, { ...seen, billed: seen.billed + p.billed, amount: seen.amount + (p.amount ?? 0n) });
	}
	return [...groups.values()].map((g) => {
		const cut = (text: string) => (text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text);
		if (g.billed % 3 === 0 && entryAmount(rateCents(g.rate), g.billed) === g.amount) {
			return { description: cut(g.description), quantity: g.billed / 60, unit: "ore", price: Number(g.rate) };
		}
		const h = `${Math.floor(g.billed / 60)}:${String(g.billed % 60).padStart(2, "0")}`;
		const said = ` (${h} h a ${g.rate.replace(".", ",")} €/h)`;
		return { description: `${cut(g.description).slice(0, maxLength - said.length)}${said}`, quantity: 1, price: Number(centsDecimal(g.amount)) };
	});
}
