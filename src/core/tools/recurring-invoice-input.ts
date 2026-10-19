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
import { type ListSource, listLines } from "../price-list-lines.ts";
import { lineCents } from "../quote-sums.ts";
import { CADENCE_NAMES, type Cadence, type DueDay, RECURRING_LIMITS, type RecurringLine, type RecurringTerms, type Schedule } from "../recurring-invoices.ts";
import { FIELD_LIMITS, MAX_PAYMENT_DAYS, RITENUTA_CAUSALI } from "../sales-invoice-rules.ts";
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

/** The day of the month the draft is due: 1 to 28, or the last («fine mese»). */
export function readDay(value: unknown): DueDay | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const t = fold(value).replace(/\s+/g, " ").trim();
		if (/^(?:end|fine mese|a fine mese|l'ultimo|ultimo|ultimo giorno|l'ultimo giorno|ultimo del mese|l'ultimo del mese)$/.test(t)) return "end";
		if (!/^\d{1,2}$/.test(t)) return { problem: DAY_PROBLEM };
		value = Number(t);
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 28) return { problem: DAY_PROBLEM };
	return value;
}

const NONE = /^(?:mai|nessuna|nessuno|senza|senza fine|niente|no)$/;

/**
 * A month as said, «2026-10», «10/2026», «ottobre», «ottobre 2027», «2027»: the next one when no
 * year is said (it is of the future). `edge`: the period's first month (a start) or last (an end).
 * null for «mai» when `clearable`.
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

/** How many invoices in all: 1 to the limit; null for «mai» (no limit). */
export function readCount(value: unknown): number | null | undefined | Problem {
	if (value === undefined) return undefined;
	if (value === 0 || (typeof value === "string" && NONE.test(fold(value).trim()))) return null;
	const n = typeof value === "string" && /^\s*\d{1,4}\s*$/.test(value) ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > RECURRING_LIMITS.count) return { problem: `quante fatture in tutto: un numero da 1 a ${RECURRING_LIMITS.count}` };
	return n;
}

/** The longest «{periodo}» there is, to leave room for it. */
const LONGEST_LABEL = "novembre 2026 - gennaio 2027";

/** The note as said, with {mese} and {periodo} when wanted; null for «niente» (no note). */
export function readNote(value: unknown): string | null | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value === "string" && NONE.test(fold(value).trim())) return null;
	const note = cleanText(value, RECURRING_LIMITS.note, "la nota");
	if (isProblem(note) || note === undefined) return note;
	const longest = note.replaceAll("{mese}", LONGEST_LABEL).replaceAll("{periodo}", LONGEST_LABEL);
	if (!fitsLatin(longest, FIELD_LIMITS.causale)) return { problem: `la nota è troppo lunga per la fattura, con il periodo messo dentro (al massimo ${FIELD_LIMITS.causale} caratteri)` };
	return note;
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

/** Room kept in each description for «, novembre 2026 - gennaio 2027». */
export const DESCRIPTION_ROOM = FIELD_LIMITS.descrizione - RECURRING_LIMITS.label;

/**
 * The lines as said, kept as said (a voce by `item`, the rest written as sales_invoices reads
 * it), after checking that they make an invoice: a voce not in the listino or not clear is asked
 * (the listino's own question), a description leaves room for the period.
 */
export function readScheduleLines(src: ListSource, raw: unknown, terms: RecurringTerms): RecurringLine[] | { readonly ask: string } | Problem {
	if (!Array.isArray(raw) || raw.length === 0) return { problem: "mancano le voci: ognuna con descrizione e prezzo, o la voce del listino" };
	if (raw.length > RECURRING_LIMITS.lines) return { problem: `al massimo ${RECURRING_LIMITS.lines} voci in una fattura ricorrente` };
	const listed = listLines(src, raw, { kind: "invoice", descriptionMax: DESCRIPTION_ROOM, doc: { vat: terms.vat, natura: terms.natura } });
	if (listed !== undefined && "ask" in listed) return { ask: listed.ask };
	const read = readLines(listed?.lines ?? raw);
	if (isProblem(read)) return read;
	const out: RecurringLine[] = [];
	for (const [n, given] of raw.entries()) {
		const said = given as Record<string, unknown>;
		const line = read[n];
		if (line === undefined) return { problem: "le voci non si leggono" };
		if (!fitsLatin(line.description, DESCRIPTION_ROOM) && !/\{(?:mese|periodo)\}/.test(line.description)) return { problem: `riga ${n + 1}: la descrizione è troppo lunga, con il periodo da aggiungere (al massimo ${DESCRIPTION_ROOM} caratteri)` };
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

/** The amount of one period without VAT (the lines, at the listino's prices of today); undefined when it cannot be told. */
export function periodCents(src: ListSource, s: Pick<Schedule, "lines" | "terms">): bigint | undefined {
	const raw = s.lines.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)));
	const listed = listLines(src, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: s.terms.vat, natura: s.terms.natura } });
	if (listed !== undefined && "ask" in listed) return undefined;
	const read = readLines(listed?.lines ?? raw);
	if (isProblem(read)) return undefined;
	return read.reduce((n, l) => n + lineCents({ quantity: l.quantity, price: l.price, vat: 0, ...(l.discount === undefined ? {} : { discount: l.discount }) }), 0n);
}
