/**
 * Who the clients are and what Annie knows of each, read from the registers and never written:
 * the cards the person made, the customers of the invoices issued (scadenzario), of the quotes
 * and of the timesheet. One client is one card, or else one partita IVA, codice fiscale or name
 * (the timesheet's rule: no case, accents nor punctuation, the legal form counts, so «Rossi Srl»
 * is not «Rossi SpA»). A name joins a client with a partita IVA only when it has none or the same.
 * The name shown is the card's, else the one the person wrote (quotes, timesheet), else the
 * invoice's. Amounts in euro cents, exact; other currencies are counted apart.
 */
import { unitsToCents } from "./cash-book.ts";
import { CONCENTRATION_BRIEF_DAYS, CONCENTRATION_PERCENT, CONCENTRATION_SPAN_DAYS, type ClientCard, DORMANT_INVOICED_DAYS, type FollowUp, vatKey } from "./clients.ts";
import { daysLate } from "./invoice-sums.ts";
import { countedAmount, type Invoice, openAmount, vatOf } from "./invoices.ts";
import { toUnits } from "./fattura-pa.ts";
import { addDays } from "./italian-calendar.ts";
import { spellingKey } from "./name-keys.ts";
import { halfUp } from "./quote-sums.ts";
import { latest, type Quote, quoteTotalsOf, shownStatus } from "./quotes.ts";
import type { ReminderLevel } from "./reminder-book.ts";
import type { RateRule, WorkEntry } from "./timesheet.ts";
import { priced } from "./timesheet-sums.ts";
import { partyName } from "./tools/invoice-words.ts";

export type ClientSources = {
	readonly cards: readonly ClientCard[];
	/** The register (invoices.ts register): only the issued ones (side active) count. */
	readonly invoices: readonly Invoice[];
	readonly quotes: readonly Quote[];
	readonly entries: readonly WorkEntry[];
	readonly rates: readonly RateRule[];
};

/** One client: its card when there is one, and its records in the registers. */
export type Client = {
	/** The card's id, else «vat:…», «cf:…» or «nome:…». */
	readonly key: string;
	readonly card?: ClientCard;
	readonly name: string;
	/** Where the name shown comes from: the card, the person's words (quotes, timesheet), an invoice. */
	readonly nameFrom: "card" | "person" | "file";
	readonly vat?: string;
	readonly cf?: string;
	/** Every spelling seen for it (card, aliases, quotes, timesheet, invoices), as written. */
	readonly names: readonly string[];
	readonly invoices: readonly Invoice[];
	readonly quotes: readonly Quote[];
	readonly entries: readonly WorkEntry[];
};

type Group = {
	key: string;
	card?: ClientCard;
	personName?: string;
	fileName?: string;
	vat?: string;
	cf?: string;
	names: string[];
	invoices: Invoice[];
	quotes: Quote[];
	entries: WorkEntry[];
};

/** Every client: the cards first, then the clients without one, by the order they were met. */
export function clientsOf(src: ClientSources): Client[] {
	const groups: Group[] = [];
	const byVat = new Map<string, Group>();
	const byCf = new Map<string, Group>();
	const byName = new Map<string, Group>();
	const index = (g: Group, name?: string) => {
		if (g.vat !== undefined && !byVat.has(g.vat)) byVat.set(g.vat, g);
		if (g.cf !== undefined && !byCf.has(g.cf)) byCf.set(g.cf, g);
		const k = name === undefined ? "" : spellingKey(name);
		if (k !== "" && !byName.has(k)) byName.set(k, g);
		if (name !== undefined && !g.names.includes(name)) g.names.push(name);
	};
	/** The group of a record: by partita IVA, codice fiscale, then name (only into a client with no partita IVA or the same). */
	const find = (vat: string | undefined, cf: string | undefined, name: string | undefined): Group | undefined => {
		const v = vat === undefined ? undefined : byVat.get(vat);
		if (v !== undefined) return v;
		const c = cf === undefined ? undefined : byCf.get(cf);
		if (c !== undefined) return c;
		const k = name === undefined ? "" : spellingKey(name);
		const n = k === "" ? undefined : byName.get(k);
		if (n !== undefined && (vat === undefined || n.vat === undefined || n.vat === vat)) return n;
		return undefined;
	};
	const place = (vat: string | undefined, cf: string | undefined, name: string | undefined, person: boolean): Group | undefined => {
		if (vat === undefined && cf === undefined && (name === undefined || spellingKey(name) === "")) return undefined;
		let g = find(vat, cf, name);
		if (g === undefined) {
			g = { key: vat !== undefined ? `vat:${vat}` : cf !== undefined ? `cf:${cf}` : `nome:${spellingKey(name ?? "")}`, names: [], invoices: [], quotes: [], entries: [] };
			groups.push(g);
		}
		// A name joined to a client links it to the partita IVA it brings.
		if (g.vat === undefined && vat !== undefined) g.vat = vat;
		if (g.cf === undefined && cf !== undefined) g.cf = cf;
		if (name !== undefined && name.trim() !== "") {
			if (person) g.personName ??= name;
			else g.fileName ??= name;
		}
		index(g, name);
		return g;
	};
	for (const card of src.cards) {
		const g: Group = { key: card.id, card, names: [], invoices: [], quotes: [], entries: [], ...(card.vat === undefined ? {} : { vat: card.vat }), ...(card.cf === undefined ? {} : { cf: card.cf }) };
		groups.push(g);
		for (const n of [card.name, ...card.aliases]) index(g, n);
	}
	// The person's own words first, so their spelling is the one shown.
	for (const q of latest(src.quotes)) place(vatKey(q.customer.vat), q.customer.fiscal?.toUpperCase(), q.customer.name, true)?.quotes.push(q);
	for (const e of src.entries) place(undefined, undefined, e.client, true)?.entries.push(e);
	for (const i of src.invoices) {
		if (i.side !== "active" || i.doc.integration) continue;
		const party = i.customer;
		const vat = vatKey(vatOf(party));
		const name = party.name === undefined ? undefined : partyName(party);
		place(vat, party.fiscal?.toUpperCase(), name, false)?.invoices.push(i);
	}
	return groups.map((g) => ({
		key: g.key,
		...(g.card === undefined ? {} : { card: g.card }),
		name: g.card?.name ?? g.personName ?? g.fileName ?? g.names[0] ?? (g.vat === undefined ? g.key : `P.IVA ${g.vat}`),
		nameFrom: g.card !== undefined ? "card" : g.personName !== undefined ? "person" : "file",
		...(g.vat === undefined ? {} : { vat: g.vat }),
		...(g.cf === undefined ? {} : { cf: g.cf }),
		names: g.names,
		invoices: g.invoices,
		quotes: g.quotes,
		entries: g.entries,
	}));
}

/** What an invoice counts toward the invoiced, in cents: its total (a credit note less), euro only. Undefined: another currency or no amount. */
export function invoicedCents(i: Invoice): bigint | undefined {
	if (i.doc.currency !== "EUR") return undefined;
	const units = (i.doc.total === undefined ? undefined : toUnits(i.doc.total)) ?? countedAmount(i);
	if (units === undefined) return undefined;
	const total = unitsToCents(units < 0n ? -units : units);
	const abs = total < 0n ? -total : total;
	return i.credit ? -abs : abs;
}

/** Invoiced from `from` to `to` (both included, by the invoice's date), credit notes netted. */
export function invoicedIn(c: Pick<Client, "invoices">, from: string, to: string): bigint {
	let sum = 0n;
	for (const i of c.invoices) {
		const d = i.doc.date;
		if (d === undefined || d < from || d > to) continue;
		sum += invoicedCents(i) ?? 0n;
	}
	return sum;
}

/** Collected from `from` to `to`, by the day each instalment was marked paid (euro, credit notes aside). */
export function collectedIn(c: Pick<Client, "invoices">, from: string, to: string, dayOf: (at: string) => string): bigint {
	let sum = 0n;
	for (const i of c.invoices) {
		if (i.credit || i.doc.currency !== "EUR") continue;
		for (const r of i.instalments) {
			if (r.paid === undefined || r.extra === true || r.amount === undefined || r.amount <= 0n) continue;
			const d = dayOf(r.paid.at);
			if (d >= from && d <= to) sum += unitsToCents(r.amount);
		}
	}
	return sum;
}

export type QuoteCount = { readonly count: number; readonly total: bigint };

/** What Annie knows of a client today, from every register and its card. */
export type ClientFigures = {
	readonly year: number;
	readonly invoicedThisYear: bigint;
	readonly invoicedLastYear: bigint;
	readonly collectedThisYear: bigint;
	/** Open on the invoices issued, less the open credit notes, never below zero. */
	readonly outstanding: bigint;
	/** Instalments past their (working) due day, open; the oldest's days late. */
	readonly overdue: bigint;
	readonly overdueDays: number;
	readonly overdueCount: number;
	readonly lastReminder?: { readonly level: ReminderLevel; readonly date: string };
	readonly quotes: { readonly open: QuoteCount; readonly expired: QuoteCount; readonly accepted: QuoteCount; readonly declined: QuoteCount };
	readonly unbilled: { readonly minutes: number; readonly amount: bigint; readonly unpriced: number };
	readonly lastActivity?: { readonly date: string; readonly what: Activity };
	readonly nextFollowUp?: FollowUp;
	/** Invoices in another currency or without an amount: not counted. */
	readonly uncounted: number;
};

export type Activity = "fattura" | "preventivo" | "ore" | "nota" | "contatto";

const NONE: QuoteCount = { count: 0, total: 0n };
const plus = (q: QuoteCount, total: bigint): QuoteCount => ({ count: q.count + 1, total: q.total + total });

/** The latest activity: an invoice, a quote (made or marked), hours, a note, a ricontatto done. */
export function lastActivity(c: Client, dayOf: (at: string) => string): { readonly date: string; readonly what: Activity } | undefined {
	let best: { date: string; what: Activity } | undefined;
	const see = (date: string | undefined, what: Activity) => {
		if (date !== undefined && (best === undefined || date > best.date)) best = { date, what };
	};
	for (const i of c.invoices) see(i.doc.date, "fattura");
	for (const q of c.quotes) {
		see(q.date, "preventivo");
		if (q.statusMark !== undefined) see(dayOf(q.statusMark.at), "preventivo");
	}
	for (const e of c.entries) see(e.date, "ore");
	for (const n of c.card?.notes ?? []) see(n.date, "nota");
	for (const f of c.card?.followUps ?? []) if (f.done !== undefined) see(dayOf(f.done.at), "contatto");
	return best;
}

/** The open ricontatti of a card, soonest first. */
export function openFollowUps(card: ClientCard | undefined): FollowUp[] {
	return (card?.followUps ?? []).filter((f) => f.done === undefined).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function figuresOf(c: Client, rates: readonly RateRule[], today: string, dayOf: (at: string) => string): ClientFigures {
	const year = Number(today.slice(0, 4));
	let open = 0n;
	let credits = 0n;
	let overdue = 0n;
	let overdueDays = 0;
	let overdueCount = 0;
	let uncounted = 0;
	let reminder: { level: ReminderLevel; at: string } | undefined;
	for (const i of c.invoices) {
		if (invoicedCents(i) === undefined) {
			uncounted++;
			continue;
		}
		for (const m of i.reminders ?? []) if (reminder === undefined || m.at > reminder.at) reminder = { level: m.level, at: m.at };
		if (i.credit) {
			if (!i.paid) credits += unitsToCents(openAmount(i));
			continue;
		}
		open += unitsToCents(openAmount(i));
		for (const r of i.instalments) {
			if (r.paid !== undefined || r.extra === true || r.amount === undefined || r.due === undefined) continue;
			const late = daysLate(r.due, today);
			if (late <= 0) continue;
			overdue += unitsToCents(r.amount);
			overdueCount++;
			if (late > overdueDays) overdueDays = late;
		}
	}
	const quotes = { open: NONE, expired: NONE, accepted: NONE, declined: NONE };
	for (const q of c.quotes) {
		const s = shownStatus(q, today);
		const total = quoteTotalsOf(q).total;
		if (s === "open") quotes.open = plus(quotes.open, total);
		else if (s === "expired") quotes.expired = plus(quotes.expired, total);
		else if (s === "accepted") quotes.accepted = plus(quotes.accepted, total);
		else if (s === "declined") quotes.declined = plus(quotes.declined, total);
	}
	let minutes = 0;
	let amount = 0n;
	let unpriced = 0;
	for (const e of c.entries) {
		if (!e.billable || e.billed !== undefined) continue;
		const p = priced(e, rates);
		minutes += e.minutes;
		if (p.amount === undefined) unpriced++;
		else amount += p.amount;
	}
	const activity = lastActivity(c, dayOf);
	const next = openFollowUps(c.card)[0];
	return {
		year,
		invoicedThisYear: invoicedIn(c, `${year}-01-01`, `${year}-12-31`),
		invoicedLastYear: invoicedIn(c, `${year - 1}-01-01`, `${year - 1}-12-31`),
		collectedThisYear: collectedIn(c, `${year}-01-01`, today, dayOf),
		outstanding: open > credits ? open - credits : 0n,
		overdue,
		overdueDays,
		overdueCount,
		...(reminder === undefined ? {} : { lastReminder: { level: reminder.level, date: dayOf(reminder.at) } }),
		quotes,
		unbilled: { minutes, amount, unpriced },
		...(activity === undefined ? {} : { lastActivity: activity }),
		...(next === undefined ? {} : { nextFollowUp: next }),
		uncounted,
	};
}

export type Ranked = { readonly client: Client; readonly cents: bigint; readonly percent: bigint };

/** Whether `part` is above the concentration threshold of `total`. */
export function concentrated(part: bigint, total: bigint): boolean {
	return total > 0n && part * 100n > total * CONCENTRATION_PERCENT;
}

/** The clients by what they were invoiced (or paid) in the span, most first, with their share of the total; zero and below left out. */
export function ranked(clients: readonly Client[], from: string, to: string, by: "invoiced" | "collected", dayOf: (at: string) => string): { readonly rows: readonly Ranked[]; readonly total: bigint } {
	const values = clients.map((client) => ({ client, cents: by === "invoiced" ? invoicedIn(client, from, to) : collectedIn(client, from, to, dayOf) })).filter((r) => r.cents > 0n);
	const total = values.reduce((n, r) => n + r.cents, 0n);
	const rows = values.map((r) => ({ ...r, percent: total === 0n ? 0n : halfUp(r.cents * 100n, total) })).sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : a.client.name.localeCompare(b.client.name, "it")));
	return { rows, total };
}

export type Dormant = { readonly client: Client; readonly last: string; readonly days: number; readonly invoiced: bigint };

/** Clients invoiced in the last two years with no activity for `days` days: the most invoiced first. */
export function dormantClients(clients: readonly Client[], days: number, today: string, dayOf: (at: string) => string): Dormant[] {
	const since = addDays(today, -DORMANT_INVOICED_DAYS);
	const limit = addDays(today, -days);
	const out: Dormant[] = [];
	for (const client of clients) {
		const invoiced = invoicedIn(client, since, today);
		if (!client.invoices.some((i) => i.doc.date !== undefined && i.doc.date >= since && !i.credit)) continue;
		const last = lastActivity(client, dayOf);
		if (last === undefined || last.date >= limit) continue;
		out.push({ client, last: last.date, days: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last.date}T00:00:00Z`)) / 86_400_000), invoiced });
	}
	return out.sort((a, b) => (b.invoiced > a.invoiced ? 1 : b.invoiced < a.invoiced ? -1 : a.last.localeCompare(b.last)));
}

/**
 * A client that crossed the concentration threshold within the last CONCENTRATION_BRIEF_DAYS:
 * above it on the last CONCENTRATION_SPAN_DAYS today, not above it on the same span ending then.
 */
export function newConcentration(clients: readonly Client[], today: string, dayOf: (at: string) => string): Ranked | undefined {
	const now = ranked(clients, addDays(today, -(CONCENTRATION_SPAN_DAYS - 1)), today, "invoiced", dayOf);
	const top = now.rows[0];
	if (top === undefined || !concentrated(top.cents, now.total)) return undefined;
	const then = addDays(today, -CONCENTRATION_BRIEF_DAYS);
	const before = ranked(clients, addDays(then, -(CONCENTRATION_SPAN_DAYS - 1)), then, "invoiced", dayOf);
	if (before.total === 0n) return undefined;
	const was = before.rows.find((r) => r.client.key === top.client.key);
	return was !== undefined && concentrated(was.cents, before.total) ? undefined : top;
}

/** Ricontatti due today or before, open, with their client: the oldest first. */
export function dueFollowUps(clients: readonly Client[], today: string): { readonly client: Client; readonly followUp: FollowUp }[] {
	return clients
		.flatMap((client) => openFollowUps(client.card).map((followUp) => ({ client, followUp })))
		.filter((d) => d.followUp.date <= today)
		.sort((a, b) => a.followUp.date.localeCompare(b.followUp.date) || a.followUp.id.localeCompare(b.followUp.id));
}
