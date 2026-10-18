/**
 * Who the clients are and what Annie knows of each, read from the registers and never written:
 * the cards the person made, the customers of the invoices issued (scadenzario), of the quotes
 * and of the timesheet. One client is one card, or else one partita IVA, codice fiscale or name
 * (the timesheet's rule: no case, accents nor punctuation, the legal form counts). A name with no
 * partita IVA also joins the one client whose name is the same without the legal form, when it
 * has the same legal form or none and it is the only such client: «Rossi» (a quote, the hours)
 * and «Rossi S.r.l.» (the invoices) are one client; «Rossi Srl» and «Rossi SpA» stay two. The
 * name shown is the card's, else the one the person wrote (quotes, timesheet), else the
 * invoice's. Amounts in euro cents, exact; the invoiced is the imponibile (the IVA apart, and the
 * total when an invoice does not give it); the collected is the prima nota's (cash-book.ts);
 * other currencies are counted apart.
 */
import { cashBook, unitsToCents } from "./cash-book.ts";
import { CONCENTRATION_BRIEF_DAYS, CONCENTRATION_PERCENT, CONCENTRATION_SPAN_DAYS, type ClientCard, DORMANT_INVOICED_DAYS, type FollowUp, vatKey } from "./clients.ts";
import { toUnits } from "./fattura-pa.ts";
import { daysLate } from "./invoice-sums.ts";
import { countedAmount, type Invoice, openAmount, partyName, vatOf } from "./invoices.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { businessKey, sameBusiness, spellingKey } from "./name-keys.ts";
import { halfUp } from "./quote-sums.ts";
import { latest, type Quote, quoteTotalsOf, shownStatus } from "./quotes.ts";
import type { ReminderLevel } from "./reminder-book.ts";
import type { RateRule, WorkEntry } from "./timesheet.ts";
import { priced } from "./timesheet-sums.ts";

/** The registers a client is read from. */
export type ClientRegisters = {
	readonly cards: readonly ClientCard[];
	/** The register (invoices.ts register): only the issued ones (side active) count. */
	readonly invoices: readonly Invoice[];
	readonly quotes: readonly Quote[];
	readonly entries: readonly WorkEntry[];
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
export function clientsOf(src: ClientRegisters): Client[] {
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
	/** The one group a name may be without its legal form (sameBusiness); undefined when none or more than one. */
	const oneBusiness = (name: string, only: (g: Group) => boolean): Group | undefined => {
		const found = new Set(groups.filter((g) => only(g) && g.names.some((n) => sameBusiness(n, name))));
		return found.size === 1 ? [...found][0] : undefined;
	};
	/** The group of a record: by partita IVA, codice fiscale, then name (only into a client with no partita IVA or the same), then the one business. */
	const find = (vat: string | undefined, cf: string | undefined, name: string | undefined): Group | undefined => {
		const v = vat === undefined ? undefined : byVat.get(vat);
		if (v !== undefined) return v;
		const c = cf === undefined ? undefined : byCf.get(cf);
		if (c !== undefined) return c;
		const k = name === undefined ? "" : spellingKey(name);
		const n = k === "" ? undefined : byName.get(k);
		if (n !== undefined && (vat === undefined || n.vat === undefined || n.vat === vat)) return n;
		if (name === undefined || k === "") return undefined;
		// A name without a partita IVA joins the one client that is the same business; a record with one joins only a client without any.
		return vat === undefined && cf === undefined ? oneBusiness(name, () => true) : oneBusiness(name, (g) => g.vat === undefined && g.cf === undefined);
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
	type Record = { vat?: string; cf?: string; name?: string; person: boolean; add: (g: Group) => void };
	const records: Record[] = [];
	// The person's own words first, so their spelling is the one shown.
	for (const q of latest(src.quotes)) records.push({ ...opt(vatKey(q.customer.vat), q.customer.fiscal?.toUpperCase(), q.customer.name), person: true, add: (g) => g.quotes.push(q) });
	for (const e of src.entries) records.push({ ...opt(undefined, undefined, e.client), person: true, add: (g) => g.entries.push(e) });
	for (const i of src.invoices) {
		if (i.side !== "active" || i.doc.integration) continue;
		const party = i.customer;
		records.push({ ...opt(vatKey(vatOf(party)), party.fiscal?.toUpperCase(), party.name === undefined ? undefined : partyName(party)), person: false, add: (g) => g.invoices.push(i) });
	}
	// The records with a tax id first: a name alone then joins the client they made.
	for (const r of [...records.filter((x) => x.vat !== undefined || x.cf !== undefined), ...records.filter((x) => x.vat === undefined && x.cf === undefined)]) {
		const g = place(r.vat, r.cf, r.name, r.person);
		if (g !== undefined) r.add(g);
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

function opt(vat: string | undefined, cf: string | undefined, name: string | undefined): { vat?: string; cf?: string; name?: string } {
	return { ...(vat === undefined ? {} : { vat }), ...(cf === undefined ? {} : { cf }), ...(name === undefined ? {} : { name }) };
}

/** The other clients with the same name without legal form, not joined (two of them, or another legal form): maybe the same, to be asked. */
export function lookalikes(clients: readonly Client[], client: Client): Client[] {
	const keys = new Set([client.name, ...client.names].map(businessKey).filter((k) => k !== ""));
	return clients.filter((c) => c.key !== client.key && [c.name, ...c.names].some((n) => keys.has(businessKey(n))));
}

/** What an invoice counts toward the invoiced, in cents (a credit note less), euro only: the imponibile, the total, and whether the imponibile is the total because the file does not give it. Undefined: another currency or no amount. */
export function invoicedCents(i: Invoice): { readonly taxable: bigint; readonly total: bigint; readonly estimated: boolean } | undefined {
	if (i.doc.currency !== "EUR") return undefined;
	const units = (i.doc.total === undefined ? undefined : toUnits(i.doc.total)) ?? countedAmount(i);
	if (units === undefined) return undefined;
	const taxUnits = i.doc.taxable === undefined ? undefined : toUnits(i.doc.taxable);
	const sign = i.credit ? -1n : 1n;
	const total = unitsToCents(units < 0n ? -units : units);
	const taxable = taxUnits === undefined ? total : unitsToCents(taxUnits < 0n ? -taxUnits : taxUnits);
	return { taxable: sign * taxable, total: sign * total, estimated: taxUnits === undefined };
}

/** What was invoiced in a span: imponibile and total (credit notes netted), the invoices counted, those whose imponibile is their total, and the credit notes. */
export type Invoiced = { readonly taxable: bigint; readonly total: bigint; readonly count: number; readonly estimated: number; readonly credits: number; readonly creditTaxable: bigint };

/** Invoiced from `from` to `to` (both included, by the invoice's date). */
export function invoicedIn(c: Pick<Client, "invoices">, from: string, to: string): Invoiced {
	let taxable = 0n;
	let total = 0n;
	let count = 0;
	let estimated = 0;
	let credits = 0;
	let creditTaxable = 0n;
	for (const i of c.invoices) {
		const d = i.doc.date;
		if (d === undefined || d < from || d > to) continue;
		const a = invoicedCents(i);
		if (a === undefined) continue;
		taxable += a.taxable;
		total += a.total;
		if (a.estimated) estimated++;
		if (i.credit) {
			credits++;
			creditTaxable -= a.taxable;
		} else count++;
	}
	return { taxable, total, count, estimated, credits, creditTaxable };
}

/** Collected from `from` to `to`: the prima nota's incassi (cash-book.ts), by the day each instalment was marked paid. */
function collected(c: Pick<Client, "invoices">, from: string, to: string, dayOf: (at: string) => string): bigint {
	return cashBook(c.invoices, [], { from, to }, dayOf).totalIn;
}

export type QuoteCount = { readonly count: number; readonly taxable: bigint };

/** What Annie knows of a client today, from every register and its card. */
export type ClientFigures = {
	readonly year: number;
	readonly thisYear: Invoiced;
	/** The same days of last year (1 January to today's date), to compare. */
	readonly samePeriodLastYear: Invoiced;
	readonly lastYear: Invoiced;
	/** Any invoice ever, to say «nessuna fattura». */
	readonly everInvoiced: number;
	readonly collectedThisYear: bigint;
	/** Open on the invoices issued, less the open credit notes, never below zero. */
	readonly outstanding: bigint;
	/** Instalments past their (working) due day, open, less the open credit notes (the oldest first): never above the outstanding. */
	readonly overdue: bigint;
	readonly overdueDays: number;
	readonly overdueCount: number;
	readonly lastReminder?: { readonly level: ReminderLevel; readonly date: string };
	/** By status, on the imponibile. */
	readonly quotes: { readonly open: QuoteCount; readonly expired: QuoteCount; readonly accepted: QuoteCount; readonly declined: QuoteCount };
	readonly unbilled: { readonly minutes: number; readonly amount: bigint; readonly unpriced: number };
	readonly lastActivity?: { readonly date: string; readonly what: Activity };
	readonly nextFollowUp?: FollowUp;
	/** Invoices in another currency or without an amount: not counted. */
	readonly uncounted: number;
};

export type Activity = "fattura" | "preventivo" | "ore" | "contatto";

const NONE: QuoteCount = { count: 0, taxable: 0n };
const plus = (q: QuoteCount, taxable: bigint): QuoteCount => ({ count: q.count + 1, taxable: q.taxable + taxable });

/** The latest activity: an invoice, a quote (made or marked), hours, a contact had or a ricontatto done. A note is not one. */
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
	for (const f of c.card?.followUps ?? []) if (f.done !== undefined) see(dayOf(f.done.at), "contatto");
	for (const e of c.card?.log ?? []) see(e.date, "contatto");
	return best;
}

/** The open ricontatti of a card, soonest first. */
export function openFollowUps(card: ClientCard | undefined): FollowUp[] {
	return (card?.followUps ?? []).filter((f) => f.done === undefined).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** The open quotes of a client today: how many and their imponibile. */
export function openQuotes(c: Pick<Client, "quotes">, today: string): QuoteCount {
	let q = NONE;
	for (const x of c.quotes) if (shownStatus(x, today) === "open") q = plus(q, quoteTotalsOf(x).taxable);
	return q;
}

export function figuresOf(c: Client, rates: readonly RateRule[], today: string, dayOf: (at: string) => string): ClientFigures {
	const year = Number(today.slice(0, 4));
	let open = 0n;
	let credits = 0n;
	let uncounted = 0;
	let everInvoiced = 0;
	let reminder: { level: ReminderLevel; at: string } | undefined;
	const late: { cents: bigint; days: number }[] = [];
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
		everInvoiced++;
		open += unitsToCents(openAmount(i));
		for (const r of i.instalments) {
			if (r.paid !== undefined || r.extra === true || r.amount === undefined || r.due === undefined) continue;
			const days = daysLate(r.due, today);
			if (days > 0) late.push({ cents: unitsToCents(r.amount), days });
		}
	}
	// The open credit notes go to the oldest overdue instalments first.
	let credit = credits;
	let overdue = 0n;
	let overdueDays = 0;
	let overdueCount = 0;
	for (const r of late.sort((a, b) => b.days - a.days)) {
		const used = credit < r.cents ? credit : r.cents;
		credit -= used;
		if (r.cents - used <= 0n) continue;
		overdue += r.cents - used;
		overdueCount++;
		if (r.days > overdueDays) overdueDays = r.days;
	}
	const quotes = { open: NONE, expired: NONE, accepted: NONE, declined: NONE };
	for (const q of c.quotes) {
		const s = shownStatus(q, today);
		const taxable = quoteTotalsOf(q).taxable;
		if (s === "open") quotes.open = plus(quotes.open, taxable);
		else if (s === "expired") quotes.expired = plus(quotes.expired, taxable);
		else if (s === "accepted") quotes.accepted = plus(quotes.accepted, taxable);
		else if (s === "declined") quotes.declined = plus(quotes.declined, taxable);
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
	const outstanding = open > credits ? open - credits : 0n;
	return {
		year,
		thisYear: invoicedIn(c, `${year}-01-01`, `${year}-12-31`),
		samePeriodLastYear: invoicedIn(c, `${year - 1}-01-01`, sameDayLastYear(today)),
		lastYear: invoicedIn(c, `${year - 1}-01-01`, `${year - 1}-12-31`),
		everInvoiced,
		collectedThisYear: collected(c, `${year}-01-01`, today, dayOf),
		outstanding,
		overdue: overdue > outstanding ? outstanding : overdue,
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

/** Today's date a year back; the 29th of February is the 28th. */
function sameDayLastYear(today: string): string {
	const day = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
	return day.endsWith("-02-29") ? `${day.slice(0, 8)}28` : day;
}

export type Ranked = { readonly client: Client; readonly cents: bigint; readonly percent: bigint };

/** Whether `part` is above the concentration threshold of `total`. */
export function concentrated(part: bigint, total: bigint): boolean {
	return total > 0n && part * 100n > total * CONCENTRATION_PERCENT;
}

/** The clients by what they were invoiced (imponibile) or paid in the span, most first, with their share of the total; zero and below left out. `estimated`: invoices counted at their total, without an imponibile. */
export function ranked(clients: readonly Client[], from: string, to: string, by: "invoiced" | "collected", dayOf: (at: string) => string): { readonly rows: readonly Ranked[]; readonly total: bigint; readonly estimated: number } {
	let estimated = 0;
	const values = clients
		.map((client) => {
			if (by === "collected") return { client, cents: collected(client, from, to, dayOf) };
			const i = invoicedIn(client, from, to);
			estimated += i.estimated;
			return { client, cents: i.taxable };
		})
		.filter((r) => r.cents > 0n);
	const total = values.reduce((n, r) => n + r.cents, 0n);
	const rows = values.map((r) => ({ ...r, percent: total === 0n ? 0n : halfUp(r.cents * 100n, total) })).sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : a.client.name.localeCompare(b.client.name, "it")));
	return { rows, total, estimated };
}

/** A client not heard from: the last activity and its days, the imponibile of the last two years, the open quotes, and a ricontatto already fixed ahead. */
export type Dormant = { readonly client: Client; readonly last: string; readonly days: number; readonly invoiced: bigint; readonly openQuotes: QuoteCount; readonly planned?: FollowUp };

/** Clients invoiced in the last two years with no activity for `days` days: the most invoiced first. */
export function dormantClients(clients: readonly Client[], days: number, today: string, dayOf: (at: string) => string): Dormant[] {
	const since = addDays(today, -DORMANT_INVOICED_DAYS);
	const limit = addDays(today, -days);
	const out: Dormant[] = [];
	for (const client of clients) {
		if (!client.invoices.some((i) => i.doc.date !== undefined && i.doc.date >= since && !i.credit)) continue;
		const last = lastActivity(client, dayOf);
		if (last === undefined || last.date >= limit) continue;
		const planned = openFollowUps(client.card).find((f) => f.date >= today);
		out.push({ client, last: last.date, days: daysBetween(last.date, today), invoiced: invoicedIn(client, since, today).taxable, openQuotes: openQuotes(client, today), ...(planned === undefined ? {} : { planned }) });
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

export type Due = { readonly client: Client; readonly followUp: FollowUp };

/** Open ricontatti up to `until` (the late ones too), with their client: the soonest first. */
export function agendaOf(clients: readonly Client[], until: string): Due[] {
	return clients
		.flatMap((client) => openFollowUps(client.card).map((followUp) => ({ client, followUp })))
		.filter((d) => d.followUp.date <= until)
		.sort((a, b) => a.followUp.date.localeCompare(b.followUp.date) || a.followUp.id.localeCompare(b.followUp.id));
}

/** The ricontatti for the brief: the late ones, and today's that have no reminder of their own (made on the phone, in a group). */
export function briefFollowUps(clients: readonly Client[], today: string): Due[] {
	return agendaOf(clients, today).filter((d) => d.followUp.date < today || d.followUp.scheduleId === undefined);
}
