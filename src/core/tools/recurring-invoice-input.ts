/**
 * What the person says of a recurring invoice, read: the cadence (the five kinds, in words too),
 * the day (1 to 28, or «fine mese»), the first and the last month, the number of invoices, the
 * note, the draft's terms and the lines. The lines and the terms are checked with sales_invoices'
 * own readers (and a voce of the listino with its own filler) when the schedule is set, so what
 * cannot make a draft is said now; each draft reads them again, as sales_invoices always does.
 */
import { validIban } from "../iban.ts";
import { fold } from "../text-match.ts";
import { PeriodError, readPeriod } from "../periods.ts";
import { forfettarioOf, type ListSource, listLines } from "../price-list-lines.ts";
import { lineCents } from "../quote-sums.ts";
import { CADENCE_NAMES, type Cadence, type DueDay, hasPlaceholder, longestFilled, longestLabel, RECURRING_LIMITS, type RecurringLine, type RecurringTerms, type Schedule } from "../recurring-invoices.ts";
import type { Natura } from "../sales-invoice-rules.ts";
import { FIELD_LIMITS, MAX_PAYMENT_DAYS, naturaWords, RITENUTA_CAUSALI } from "../sales-invoice-rules.ts";
import { cleanText, isProblem, type Problem } from "../text-input.ts";
import { fitsLatin, readCassa, readLines, readNatura, readPayment, readVatRate } from "./sales-invoice-input.ts";

export { isProblem };

const CADENCE_SAID: ReadonlyArray<readonly [RegExp, Cadence]> = [
	[/^(?:monthly|mensile|ogni mese|al mese|mese)$/, "monthly"],
	[/^(?:bimonthly|bimestrale|ogni due mesi|ogni 2 mesi|bimestre)$/, "bimonthly"],
	[/^(?:quarterly|trimestrale|ogni trimestre|ogni tre mesi|ogni 3 mesi|trimestre)$/, "quarterly"],
	[/^(?:semiannual|semestrale|ogni sei mesi|ogni 6 mesi|semestre)$/, "semiannual"],
	[/^(?:yearly|annuale|annuo|ogni anno|all'anno|anno)$/, "yearly"],
];

/** The cadence: one of the five, as named or in words. */
export function readCadence(value: unknown): Cadence | undefined | Problem {
	if (value === undefined) return undefined;
	const t = typeof value === "string" ? fold(value).replace(/\s+/g, " ").trim() : "";
	if (CADENCE_NAMES.includes(t as Cadence)) return t as Cadence;
	const found = CADENCE_SAID.find(([re]) => re.test(t));
	return found === undefined ? { problem: "ogni quanto: ogni mese, ogni due mesi, ogni trimestre, ogni sei mesi o ogni anno" } : found[1];
}

const DAY_PROBLEM = "il giorno va da 1 a 28, oppure «fine mese» (così vale anche a febbraio)";

/** A day 29 to 31: not in every month, so asked. */
export const lateDay = (n: number) => `Il ${n} non c'è in tutti i mesi: la preparo l'ultimo giorno del mese? (oppure dimmi un giorno da 1 a 28)`;

/** The day of the month the draft is due: 1 to 28, or the last («fine mese»); «il 5», «il 5 di ogni mese», «5 del mese» read too. */
export function readDay(value: unknown): DueDay | undefined | Problem | { readonly ask: string } {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const t = fold(value).replace(/\s+/g, " ").trim();
		if (/^(?:end|(?:a |il |l')?fine (?:del )?mese|(?:l')?ultimo(?: giorno)?(?: del mese| di ogni mese)?)$/.test(t)) return "end";
		const m = /^(?:ogni |il |l')?(\d{1,2})\s*[°º]?(?: (?:di ogni mese|del mese|di ogni|ogni mese))?$/.exec(t);
		if (m === null) return { problem: DAY_PROBLEM };
		value = Number(m[1]);
	}
	if (typeof value === "number" && Number.isInteger(value) && value >= 29 && value <= 31) return { ask: lateDay(value) };
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 28) return { problem: DAY_PROBLEM };
	return value;
}

const NONE = /^(?:mai|nessuna|nessuno|senza|senza fine|niente|no)$/;

/**
 * A month as said, «2026-10», «10/2026», «ottobre», «ottobre 2027», «2027»: the next one when no
 * year is said (it is of the future). `edge`: the period's first
 * month (a start) or last (an end). null for «mai» when `clearable`.
 */
export function readMonth(value: unknown, today: string, edge: "first" | "last", what: string, clearable = false): string | null | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") return { problem: `${what}: scrivilo come «ottobre», «ottobre 2027» o «2027-10»` };
	const t = value.trim().slice(0, 40);
	if (clearable && NONE.test(fold(t))) return null;
	const iso = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(t) ?? /^(0?[1-9]|1[0-2])[/.-](\d{4})$/.exec(t);
	if (iso !== null) return /^\d{4}-/.test(t) ? t : `${iso[2]}-${String(Number(iso[1])).padStart(2, "0")}`;
	try {
		const p = readPeriod(t, today, { ahead: true });
		return (edge === "first" ? p.from : p.to).slice(0, 7);
	} catch (error) {
		if (!(error instanceof PeriodError)) throw error;
		return { problem: `${what}: non lo riconosco, scrivilo come «ottobre», «ottobre 2027» o «2027-10»` };
	}
}

/**
 * The first month, and the day when it leads it: «1 novembre», «dal 1° novembre», «il 5 ottobre»
 * (the day only when the person did not say one on its own).
 */
export function readStart(value: unknown, today: string): { readonly month?: string; readonly day?: number | { readonly ask: string } } | Problem {
	if (value === undefined) return {};
	if (typeof value !== "string") return readMonthOnly(value, today);
	const m = /^\s*(?:(?:dal|da|il|a partire dal)\s+)?(\d{1,2})\s*[°º]?\s+(?!\d{4}\b)(.+)$/i.exec(value);
	if (m === null) return readMonthOnly(value.replace(/^\s*(?:dal|da|a partire da)\s+/i, ""), today);
	const n = Number(m[1]);
	const month = readMonth(m[2], today, "first", "il primo mese");
	if (isProblem(month) || month === null) return month === null ? { problem: "il primo mese: dimmi da quale mese" } : month;
	return { ...(month === undefined ? {} : { month }), day: n >= 1 && n <= 28 ? n : n <= 31 ? { ask: lateDay(n) } : { ask: DAY_PROBLEM } };
}

function readMonthOnly(value: unknown, today: string): { readonly month?: string } | Problem {
	const month = readMonth(value, today, "first", "il primo mese");
	if (isProblem(month)) return month;
	return month === undefined || month === null ? {} : { month };
}

/** How many invoices in all: 1 to the limit; null for «mai» (no limit). */
export function readCount(value: unknown): number | null | undefined | Problem {
	if (value === undefined) return undefined;
	if (value === 0 || (typeof value === "string" && NONE.test(fold(value).trim()))) return null;
	const n = typeof value === "string" && /^\s*\d{1,4}\s*$/.test(value) ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > RECURRING_LIMITS.count) return { problem: `quante fatture in tutto: un numero da 1 a ${RECURRING_LIMITS.count}` };
	return n;
}

/** The note as said, with {mese} and {periodo} when wanted; null for «niente» (no note). */
export function readNote(value: unknown): string | null | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value === "string" && NONE.test(fold(value).trim())) return null;
	const note = cleanText(value, RECURRING_LIMITS.note, "il testo della nota");
	return note;
}

/** Whether the note fits the invoice with the longest period of the cadence put in. */
export function noteProblem(note: string | undefined, cadence: Cadence): Problem | undefined {
	if (note === undefined || fitsLatin(longestFilled(note, cadence), FIELD_LIMITS.causale)) return undefined;
	return { problem: `la nota è troppo lunga per la fattura, con il periodo messo dentro (al massimo ${FIELD_LIMITS.causale} caratteri)` };
}

/** The draft's terms said now, over the ones kept: checked with sales_invoices' readers. */
export function readTerms(args: Record<string, unknown>, kept: RecurringTerms = {}): RecurringTerms | Problem {
	const out: Record<string, unknown> = { ...kept };
	if (args.vat !== undefined) {
		const vat = readVatRate(args.vat, "l'IVA");
		if (isProblem(vat)) return vat;
		out.vat = String(vat);
	}
	if (args.natura !== undefined) {
		const natura = readNatura(args.natura, "le voci senza IVA");
		if (isProblem(natura)) return natura;
		out.natura = natura;
	}
	if (args.reference !== undefined) {
		const reference = cleanText(args.reference, FIELD_LIMITS.riferimentoNormativo, "il riferimento normativo");
		if (isProblem(reference)) return reference;
		out.reference = reference;
	}
	if (args.ritenuta !== undefined) {
		if (typeof args.ritenuta === "boolean") out.ritenuta = args.ritenuta;
		else {
			const causale = typeof args.ritenuta === "string" ? args.ritenuta.trim().toUpperCase() : "";
			if (!RITENUTA_CAUSALI.some((c) => c === causale)) return { problem: `la ritenuta è sì, no, o la sua causale (${RITENUTA_CAUSALI.join(", ")})` };
			out.ritenuta = causale;
		}
	}
	if (args.cassa !== undefined) {
		const cassa = readCassa(args.cassa);
		if (isProblem(cassa)) return cassa;
		if (cassa !== undefined && "missing" in cassa) return { problem: "della cassa professionale serve il codice, da TC01 a TC21 (come TC01 avvocati o TC04 Inarcassa)" };
		const said = args.cassa as Record<string, unknown>;
		out.cassa = { kind: String(said.kind), ...(said.type === undefined ? {} : { type: String(said.type).trim().toUpperCase() }), ...(cassa === undefined ? {} : { rate: cassa.rate }) };
	}
	for (const key of ["bollo_to_client", "split_payment", "end_of_month"] as const) {
		if (args[key] === undefined) continue;
		if (typeof args[key] !== "boolean") return { problem: `${key === "bollo_to_client" ? "il bollo al cliente" : key === "split_payment" ? "la scissione dei pagamenti" : "fine mese"} è sì o no` };
		out[key] = args[key];
	}
	if (args.payment_days !== undefined || args.method !== undefined || args.iban !== undefined) {
		const payment = readPayment({ ...(args.payment_days === undefined ? {} : { payment_days: args.payment_days }), ...(args.method === undefined ? {} : { method: args.method }), ...(args.iban === undefined ? {} : { iban: args.iban }) }, []);
		if (isProblem(payment)) return payment;
		if (args.payment_days !== undefined) {
			if (typeof args.payment_days !== "number" || args.payment_days > MAX_PAYMENT_DAYS) return { problem: `i giorni di pagamento vanno da 0 a ${MAX_PAYMENT_DAYS}` };
			out.payment_days = args.payment_days;
		}
		if (args.method !== undefined) out.method = String(args.method).trim().slice(0, 20);
		if (args.iban !== undefined) out.iban = validIban(String(args.iban));
	}
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as RecurringTerms;
}

/** The longest description a line may have so that «, <the longest period>» still fits. */
export const descriptionRoom = (cadence: Cadence): number => FIELD_LIMITS.descrizione - longestLabel(cadence).length - 2;

/** A description with the period of the cadence put in at its longest (added, or in place of {mese} and {periodo}). */
const longestDescription = (description: string, cadence: Cadence) => (hasPlaceholder(description) ? longestFilled(description, cadence) : `${description}, ${longestLabel(cadence)}`);

/**
 * The lines as said, kept as said (a voce by `item`, the rest written as sales_invoices reads
 * it), after checking that they make an invoice: a voce not in the listino or not clear is asked
 * (the listino's own question), a description leaves room for the longest period of the cadence.
 */
export function readScheduleLines(src: ListSource, raw: unknown, terms: RecurringTerms, cadence: Cadence): RecurringLine[] | { readonly ask: string } | Problem {
	if (!Array.isArray(raw) || raw.length === 0) return { problem: "mancano le voci: ognuna con descrizione e prezzo, o la voce del listino" };
	if (raw.length > RECURRING_LIMITS.lines) return { problem: `al massimo ${RECURRING_LIMITS.lines} voci in una fattura ricorrente` };
	const listed = listLines(src, raw, { kind: "invoice", descriptionMax: descriptionRoom(cadence), doc: { vat: terms.vat, natura: terms.natura } });
	if (listed !== undefined && "ask" in listed) return { ask: listed.ask };
	const read = readLines(listed?.lines ?? raw);
	if (isProblem(read)) return read;
	const out: RecurringLine[] = [];
	for (const [n, given] of raw.entries()) {
		const said = given as Record<string, unknown>;
		const line = read[n];
		if (line === undefined) return { problem: "le voci non si leggono" };
		if (!fitsLatin(longestDescription(line.description, cadence), FIELD_LIMITS.descrizione)) return { problem: `riga ${n + 1}: la descrizione è troppo lunga, con il periodo da aggiungere (al massimo ${descriptionRoom(cadence)} caratteri)` };
		const item = said.item === undefined ? undefined : String(said.item).trim().slice(0, 120);
		const kept: Record<string, unknown> = {
			...(item === undefined ? {} : { item }),
			...(said.description === undefined ? {} : { description: line.description }),
			...(said.quantity === undefined ? {} : { quantity: line.quantity }),
			...(said.unit === undefined ? {} : { unit: line.unit }),
			...(said.price === undefined ? {} : { price: line.price }),
			...(said.discount === undefined || line.discount === undefined ? {} : { discount: line.discount }),
			...(said.vat === undefined || said.advance === true ? {} : { vat: String(line.vat) }),
			...(said.natura === undefined || said.advance === true ? {} : { natura: line.natura }),
			...(said.reference === undefined || said.advance === true ? {} : { reference: line.reference }),
			...(said.advance === true ? { advance: true } : {}),
		};
		out.push(Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)) as RecurringLine);
	}
	return out;
}

/** The amount of one period without VAT and the VAT in words («IVA 22%», a nature, the forfettario's none). */
export type Amount = { readonly cents: bigint; readonly tax?: string };

/** The amount of one period (the lines, at the listino's prices of today); undefined when it cannot be told. */
export function periodAmount(src: ListSource, s: Pick<Schedule, "lines" | "terms">): Amount | undefined {
	const raw = s.lines.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)));
	const listed = listLines(src, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: s.terms.vat, natura: s.terms.natura } });
	if (listed !== undefined && "ask" in listed) return undefined;
	const read = readLines(listed?.lines ?? raw);
	if (isProblem(read)) return undefined;
	const cents = read.reduce((n, l) => n + lineCents({ quantity: l.quantity, price: l.price, vat: 0, ...(l.discount === undefined ? {} : { discount: l.discount }) }), 0n);
	if (forfettarioOf(src)) return { cents, tax: "senza IVA (regime forfettario)" };
	const wide = s.terms.vat === undefined ? undefined : Number(s.terms.vat);
	const keyOf = (l: (typeof read)[number]) => {
		const rate = l.vat ?? wide;
		const natura = l.natura ?? s.terms.natura;
		if (rate === undefined) return natura === undefined ? "?" : `0|${natura}`;
		return rate === 0 ? `0|${natura ?? ""}` : String(rate);
	};
	const rates = new Set(read.map(keyOf));
	if (rates.size !== 1) return { cents, tax: "+ IVA" };
	const only = [...rates][0] as string;
	if (only === "?") return { cents, tax: "+ IVA" };
	if (only.startsWith("0|")) {
		const natura = only.slice(2);
		return { cents, tax: natura === "" ? "senza IVA" : `senza IVA, ${naturaWords(natura as Natura)}` };
	}
	return { cents, tax: `+ IVA ${only}%` };
}
