/**
 * The payment reminders (solleciti) the scadenzario writes to customers who are late: which
 * customers owe what is overdue, and the mail for each, polite (1), firmer (2) or formal (3).
 * The amount asked is what is overdue less that customer's credit notes, never below zero (the
 * same netting as the totals, invoice-render.ts). Late counts from the day a payment could be
 * made: a due date on a weekend or a holiday is late only after the next working day.
 * Interest only at a rate the person gives, exact; the €40 of art. 6 D.Lgs. 231/2002 only when
 * asked, and only to a customer with a partita IVA.
 */
import { paymentSlip } from "../dates.ts";
import { type FatturaParty, fromUnits, money } from "../fattura-pa.ts";
import { validAddress } from "../google-actions.ts";
import { addTo, findInvoices, type Instalment, type Invoice, matchesParty, openAmount, partyKey, type Sums } from "../invoices.ts";
import { daysBetween } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import { nextLevel, type ReminderItem, type ReminderLevel } from "../reminder-book.ts";
import { netted, sumsText } from "./invoice-render.ts";

/** Customers reminded in one call; the rest are counted. */
export const MAX_REMINDERS = 10;
/** Invoice numbers in a subject before «e altre N». */
const MAX_SUBJECT_NUMBERS = 3;
/** The flat compensation per invoice paid late, art. 6 D.Lgs. 231/2002, in hundred-millionths. */
const COMPENSATION = 40n * 100_000_000n;
/** Days to pay asked by the firmer and the formal reminder, unless the person says otherwise. */
export const PAY_WITHIN: Readonly<Record<2 | 3, number>> = { 2: 7, 3: 15 };
export const MAX_NOTE = 500;

export const LEVEL_NAMES: Readonly<Record<ReminderLevel, string>> = { 1: "primo sollecito, cortese", 2: "secondo sollecito, più fermo", 3: "sollecito formale" };

/** One overdue instalment, and how many days late it is today. */
export type OverdueRow = { readonly invoice: Invoice; readonly instalment: Instalment; readonly days: number };

/** A customer who is late: the overdue instalments, oldest first, and its credit notes still to take off. */
export type Debtor = {
	readonly key: string;
	readonly customer: FatturaParty;
	readonly rows: readonly OverdueRow[];
	readonly credits: readonly { readonly invoice: Invoice; readonly units: bigint }[];
};

/** The day a payment due on `due` can be made: the next working day for a weekend or a holiday. */
function payDay(due: string): string {
	return paymentSlip(due)?.to ?? due;
}

/** Days late today, from the day the payment could be made; 0 or less when not late. */
export function daysLate(due: string, today: string): number {
	return daysBetween(payDay(due), today);
}

/** An invoice to collect (the company is its supplier), not a credit note nor a reverse-charge integration. */
function collectable(invoice: Invoice): boolean {
	return invoice.side === "active" && !invoice.credit && !invoice.doc.integration;
}

/**
 * The customers late today, the most owed first: every one, those `party` names, or the one of
 * `only` (an invoice the person named, whose open instalments count even if not yet late).
 */
export function debtors(invoices: readonly Invoice[], today: string, filter: { readonly party?: string; readonly only?: Invoice } = {}): Debtor[] {
	const byKey = new Map<string, { customer: FatturaParty; rows: OverdueRow[]; credits: { invoice: Invoice; units: bigint }[] }>();
	for (const invoice of invoices) {
		if (!collectable(invoice)) continue;
		if (filter.only !== undefined && invoice !== filter.only) continue;
		if (filter.party !== undefined && !matchesParty(invoice.customer, filter.party)) continue;
		for (const instalment of invoice.instalments) {
			if (instalment.paid !== undefined || instalment.extra === true || instalment.amount === undefined) continue;
			const days = instalment.due === undefined ? 0 : daysLate(instalment.due, today);
			if (days <= 0 && filter.only === undefined) continue;
			const key = partyKey(invoice.customer);
			const entry = byKey.get(key) ?? { customer: invoice.customer, rows: [], credits: [] };
			byKey.set(key, entry);
			entry.rows.push({ invoice, instalment, days });
		}
	}
	for (const invoice of invoices) {
		if (invoice.side !== "active" || !invoice.credit || invoice.paid || invoice.doc.integration) continue;
		const entry = byKey.get(partyKey(invoice.customer));
		if (entry !== undefined) entry.credits.push({ invoice, units: openAmount(invoice) });
	}
	const list = [...byKey].map(([key, d]): Debtor => ({ key, customer: d.customer, rows: d.rows.sort((a, b) => b.days - a.days || (a.invoice.doc.number ?? "").localeCompare(b.invoice.doc.number ?? "")), credits: d.credits }));
	return list.sort((a, b) => Number(eur(owed(b)) - eur(owed(a))) || (a.customer.name ?? "").localeCompare(b.customer.name ?? "", "it"));
}

/** What a debtor owes of what is late: the rows less its credit notes, never below zero; and what the notes took off. */
export function owedDetail(debtor: Debtor): { gross: Sums; applied: Sums; net: Sums } {
	const gross: Sums = new Map();
	for (const r of debtor.rows) addTo(gross, r.invoice.doc.currency, r.instalment.amount as bigint);
	const credit: Sums = new Map();
	for (const c of debtor.credits) addTo(credit, c.invoice.doc.currency, c.units);
	const n = netted([{ gross, credit, notes: debtor.credits.length }]);
	return { gross: n.gross, applied: n.applied, net: n.net };
}

function owed(debtor: Debtor): Sums {
	return owedDetail(debtor).net;
}

function eur(sums: Sums): bigint {
	return sums.get("EUR") ?? 0n;
}

function isZero(sums: Sums): boolean {
	return [...sums.values()].every((u) => u === 0n);
}

/** The invoices of a debtor, once each, in the order of its rows. */
function invoicesOf(debtor: Debtor): Invoice[] {
	return [...new Set(debtor.rows.map((r) => r.invoice))];
}

/** A yearly rate as the person writes it («8», «8,5%», «10.15»): exact, as digits and a power of ten. */
export type Rate = { readonly digits: bigint; readonly scale: bigint; readonly text: string };

/** The rate, or why it does not read: up to 4 decimals, more than 0 and at most 100. */
export function parseRate(text: string): Rate | { problem: string } {
	const m = /^\s*(\d{1,3})(?:[.,](\d{1,4}))?\s*%?\s*$/.exec(text);
	if (m === null) return { problem: "il tasso è un numero di percentuale annua, per esempio 8 o 10,15" };
	const decimals = m[2] ?? "";
	const digits = BigInt(`${m[1]}${decimals}`);
	const scale = 10n ** BigInt(decimals.length);
	if (digits === 0n || digits > 100n * scale) return { problem: "il tasso va da più di 0 a 100" };
	const shown = `${BigInt(m[1] as string)}${decimals.replace(/0+$/, "") === "" ? "" : `,${decimals.replace(/0+$/, "")}`}`;
	return { digits, scale, text: shown };
}

/**
 * Simple interest on `units` (hundred-millionths) at `rate` a year for `days` days, on a 365-day
 * year: units × rate/100 × days/365, rounded half up to the cent, back in hundred-millionths.
 */
export function simpleInterest(units: bigint, rate: Rate, days: number): bigint {
	if (units <= 0n || days <= 0) return 0n;
	const numerator = units * rate.digits * BigInt(days);
	// Units are 1e-8 of the currency, a cent 1e-2: one cent is 1e6 units.
	const denominator = rate.scale * 100n * 365n * 1_000_000n;
	const cents = (numerator * 2n + denominator) / (denominator * 2n);
	return cents * 1_000_000n;
}

/** What the person asked to put in the reminder. */
export type ReminderTerms = {
	readonly level?: ReminderLevel;
	/** The €40 per invoice of art. 6 D.Lgs. 231/2002: only when the person asks. */
	readonly compensation?: boolean;
	readonly rate?: Rate;
	/** Days to pay, for the firmer and the formal one. */
	readonly payWithin?: number;
	/** A paragraph of the person's own. */
	readonly note?: string;
	/** The address the person gave. */
	readonly to?: string;
};

/** A reminder written: the mail, its recipient when known, what to record once it is sent, what to tell the person. */
export type ReminderDraft = {
	readonly debtor: Debtor;
	readonly level: ReminderLevel;
	readonly items: readonly ReminderItem[];
	readonly subject: string;
	readonly body: string;
	readonly to?: string;
	readonly toFrom?: "given" | "email" | "pec";
	/** What the amount asked is, for the person. */
	readonly net: Sums;
	/** Remarks for the person: no address, a PEC, compensation left out, sent already today. */
	readonly notes: readonly string[];
	/** The interest lines with their inputs, when a rate was given. */
	readonly interest?: readonly string[];
};

/** «del 10%», «dell'8%», «dell'11%»: the article as the number is said. */
function ofRate(rate: Rate): string {
	return /^(?:8|11(?!\d)|1(?!\d))/.test(rate.text) ? `dell'${percentText(rate)}` : `del ${percentText(rate)}`;
}

/** «8,5%». */
function percentText(rate: Rate): string {
	return `${rate.text}%`;
}

function amount(units: bigint, currency: string): string {
	return money(fromUnits(units), currency) as string;
}

/** A name from the files on one line, at most 80 characters (FatturaPA's own limit). */
function oneLine(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function nameOf(party: FatturaParty): string {
	return party.name === undefined || party.name.trim() === "" ? "Cliente" : oneLine(party.name);
}

function numberOf(invoice: Invoice): string {
	return invoice.doc.number === undefined ? "senza numero" : oneLine(invoice.doc.number, 40);
}

/** «n. B-77 del 01/10/2026». */
function invoiceRef(invoice: Invoice): string {
	return `n. ${numberOf(invoice)}${invoice.doc.date === undefined ? "" : ` del ${italianDate(invoice.doc.date)}`}`;
}

/** «- fattura n. B-77 del 01/10/2026, rata 1/2, scaduta il 31/10/2026 (12 giorni di ritardo): 99,90 €». */
function rowLine(row: OverdueRow): string {
	const { invoice, instalment, days } = row;
	const count = invoice.instalments.length;
	const rata = count > 1 ? `, rata ${instalment.n}/${count}` : "";
	const due = instalment.due === undefined ? "" : days > 0 ? `, scaduta il ${italianDate(instalment.due)} (${days === 1 ? "un giorno" : `${days} giorni`} di ritardo)` : `, in scadenza il ${italianDate(instalment.due)}`;
	return `- fattura ${invoiceRef(invoice)}${rata}${due}: ${amount(instalment.amount as bigint, invoice.doc.currency)}`;
}

/** The address: the one given, else the customer's email in the newest invoice, else its PEC. */
function recipient(debtor: Debtor, given: string | undefined): { to?: string; from?: "given" | "email" | "pec"; bad?: true } {
	if (given !== undefined) return { to: given.trim().toLowerCase(), from: "given" };
	const newest = [...invoicesOf(debtor)].sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? ""));
	let bad = false;
	for (const [field, from] of [
		["email", "email"],
		["pec", "pec"],
	] as const) {
		for (const invoice of newest) {
			const raw = field === "email" ? invoice.customer.email : invoice.pec;
			if (raw === undefined) continue;
			const address = raw.trim().toLowerCase();
			if (validAddress(address)) return { to: address, from };
			bad = true;
		}
	}
	return bad ? { bad: true } : {};
}

/** The level: the one asked, else one past the reminders recorded for its invoices (the highest). */
function levelOf(debtor: Debtor, asked: ReminderLevel | undefined): ReminderLevel {
	if (asked !== undefined) return asked;
	return invoicesOf(debtor).reduce<ReminderLevel>((top, i) => {
		const next = nextLevel(i.reminders);
		return next > top ? next : top;
	}, 1);
}

/** The subject: what it is, and the invoices («fatture n. 12, 15 e altre 2»). */
function subjectOf(level: ReminderLevel, invoices: readonly Invoice[]): string {
	const numbers = invoices.slice(0, MAX_SUBJECT_NUMBERS).map(numberOf);
	const more = invoices.length - numbers.length;
	const which = invoices.length === 1 ? `fattura n. ${numbers[0]}` : `fatture n. ${numbers.join(", ")}${more > 0 ? ` e altre ${more}` : ""}`;
	const head = level === 1 ? "Promemoria di pagamento" : level === 2 ? "Secondo sollecito di pagamento" : "Sollecito formale di pagamento";
	return `${head}: ${which}`;
}

/** The open IBANs of the late invoices, once each, at most two. */
function ibansOf(debtor: Debtor): string[] {
	return [...new Set(debtor.rows.map((r) => r.instalment.iban).filter((i): i is string => i !== undefined).map((i) => i.replace(/\s+/g, "")))].slice(0, 2);
}

/**
 * The reminder for one debtor. `sender` signs it (the company's name, else the supplier's on the
 * invoices); `today` is where the instance is; `madeToday` says which invoices were already
 * reminded today.
 */
export function composeReminder(debtor: Debtor, terms: ReminderTerms, context: { readonly today: string; readonly sender?: string; readonly remindedToday: (invoice: Invoice) => boolean }): ReminderDraft {
	const level = levelOf(debtor, terms.level);
	const invoices = invoicesOf(debtor);
	const currency = debtor.rows[0]?.invoice.doc.currency ?? "EUR";
	const { gross, applied, net } = owedDetail(debtor);
	const notes: string[] = [];
	const lines = debtor.rows.map(rowLine);
	const credits = debtor.credits.filter((c) => c.units > 0n);
	let total = `Totale da saldare: ${sumsText(net)}`;
	if (credits.length > 0 && !isZero(applied)) {
		const which = credits.length === 1 ? `la nota di credito ${invoiceRef(credits[0]?.invoice as Invoice)}` : `le note di credito ${credits.map((c) => `n. ${numberOf(c.invoice)}`).join(", ")}`;
		total += ` (${sumsText(gross)} meno ${which}, ${sumsText(applied)})`;
	}
	const extras: string[] = [];
	let extraUnits = 0n;
	let interest: string[] | undefined;
	if (terms.rate !== undefined) {
		const rate = terms.rate;
		interest = debtor.rows
			.filter((r) => r.days > 0)
			.map((r) => {
				const units = simpleInterest(r.instalment.amount as bigint, rate, r.days);
				extraUnits += units;
				return `- fattura n. ${numberOf(r.invoice)}${r.invoice.instalments.length > 1 ? ` rata ${r.instalment.n}` : ""}: ${amount(r.instalment.amount as bigint, currency)} × ${percentText(rate)} × ${r.days}/365 = ${amount(units, currency)}`;
			});
		if (interest.length > 0) {
			extras.push("", `Interessi di mora al tasso ${ofRate(rate)} annuo, calcolati in modo semplice sui giorni di ritardo a oggi (importo × tasso × giorni/365):`, ...interest);
		} else notes.push("nessuna rata è ancora in ritardo: niente interessi");
		if (interest.length > 0 && !isZero(applied)) notes.push("gli interessi sono calcolati sulle rate, prima di scalare le note di credito");
	}
	if (terms.compensation === true) {
		if (debtor.customer.vat === undefined) {
			notes.push("il cliente non ha partita IVA in fattura: il forfait di 40 € vale solo tra imprese o con la pubblica amministrazione, non l'ho messo");
		} else {
			const late = invoices.filter((i) => debtor.rows.some((r) => r.invoice === i && r.days > 0)).length;
			if (late > 0) {
				const units = COMPENSATION * BigInt(late);
				extraUnits += units;
				const per = late === 1 ? "per la fattura in ritardo" : `per ${late} fatture in ritardo, 40,00 € × ${late}`;
				extras.push("", `Ai sensi dell'art. 6 del D.Lgs. 231/2002 ci spetta inoltre un importo forfettario di 40,00 € per ogni fattura pagata in ritardo, a titolo di risarcimento dei costi di recupero: ${per} = ${amount(units, currency)}.`);
			}
		}
	}
	if (extraUnits > 0n) extras.push("", `In tutto: ${sumsText(new Map([[currency, (net.get(currency) ?? 0n) + extraUnits]]))}.`);
	const ibans = ibansOf(debtor);
	const pay = ibans.length === 0 ? [] : ["", `Potete pagare con bonifico ${ibans.length === 1 ? `all'IBAN ${ibans[0]}` : `a uno di questi IBAN: ${ibans.join(", ")}`}.`];
	const within = level === 1 ? undefined : (terms.payWithin ?? PAY_WITHIN[level]);
	const note = terms.note === undefined || terms.note.trim() === "" ? [] : ["", terms.note.trim()];
	const name = nameOf(debtor.customer);
	const what = debtor.rows.length === 1 ? "risulta ancora da saldare il pagamento seguente" : "risultano ancora da saldare i pagamenti seguenti";
	let opening: string[];
	let closing: string[];
	if (level === 1) {
		opening = [`Gentili ${name},`, "", `vi scriviamo per ricordarvi che ${what}:`];
		closing = ["", "Vi chiediamo cortesemente di provvedere al pagamento.", "", "Se avete già pagato, non tenete conto di questo messaggio, e grazie.", "", "Cordiali saluti"];
	} else if (level === 2) {
		opening = [`Gentili ${name},`, "", `nonostante il nostro precedente sollecito, ${what}:`];
		closing = ["", `Vi chiediamo di provvedere al pagamento entro ${within} giorni dal ricevimento di questa mail.`, "", "Se avete già pagato, non tenete conto di questo messaggio e mandateci gli estremi del pagamento.", "", "Cordiali saluti"];
	} else {
		opening = [`Spettabile ${name},`, "", `con la presente vi invitiamo formalmente a pagare quanto ancora dovuto, già sollecitato in precedenza:`];
		closing = [
			"",
			`Il pagamento va eseguito entro ${within} giorni dal ricevimento della presente, che vale come costituzione in mora ai sensi dell'art. 1219 del Codice civile.`,
			"Trascorso questo termine senza pagamento, ci riserviamo di tutelare i nostri diritti nelle sedi opportune.",
			"",
			"Se avete già pagato, non tenete conto di questa comunicazione e mandateci gli estremi del pagamento.",
			"",
			"Distinti saluti",
		];
	}
	const sender = context.sender === undefined || context.sender.trim() === "" ? [] : [oneLine(context.sender)];
	const body = [...opening, ...lines, "", `${total}.`, ...extras, ...pay, ...note, ...closing, ...sender].join("\n");
	const address = recipient(debtor, terms.to);
	if (address.to === undefined) notes.push(address.bad === true ? "l'indirizzo scritto in fattura non è valido: chiedilo a chi ti scrive" : "in fattura non c'è un indirizzo email o PEC del cliente: chiedilo a chi ti scrive");
	if (address.from === "pec") notes.push("l'indirizzo è la PEC del cliente: una mail normale verso una PEC può essere rifiutata");
	if (invoices.some(context.remindedToday)) notes.push("un sollecito per queste fatture è già annotato oggi");
	const items = invoices.map((i): ReminderItem => ({ invoice: i.key, level }));
	return {
		debtor,
		level,
		items,
		subject: subjectOf(level, invoices),
		body,
		...(address.to === undefined ? {} : { to: address.to, toFrom: address.from as "given" | "email" | "pec" }),
		net,
		notes,
		...(interest === undefined ? {} : { interest }),
	};
}

/** Whether a draft asks for anything: the credit notes may cover what is late. */
export function asksSomething(draft: ReminderDraft): boolean {
	return !isZero(draft.net);
}

/** The invoice a person named, among those to collect: one, or why not. */
export function namedInvoice(invoices: readonly Invoice[], query: { readonly number?: string; readonly party?: string; readonly path?: string }): Invoice | { problem: "none" | "many" | "not_active" | "credit" | "paid"; found: readonly Invoice[] } {
	const found = findInvoices(invoices, query);
	if (found.length === 0) return { problem: "none", found };
	if (found.length > 1) return { problem: "many", found };
	const invoice = found[0] as Invoice;
	if (invoice.credit || invoice.doc.integration) return { problem: "credit", found };
	if (invoice.side !== "active") return { problem: "not_active", found };
	if (invoice.paid) return { problem: "paid", found };
	return invoice;
}
