/**
 * The voci of the previsione di cassa as the person names and changes them: names compared by
 * their whole words (name-keys.ts), the voce an id or a name points to, the renewals and voci a
 * new one looks like, and an edit as a patch of the fields it touches, applied onto the voce as
 * it is saved when the write happens (another change in between is kept).
 */
import { CASHFLOW_LIMITS, type CashItem, itemId, itemRecurrence, type Kind, parseItemId } from "./cashflow.ts";
import type { FatturaParty } from "./fattura-pa.ts";
import { matchesParty } from "./invoices.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { withDate } from "./italian-format.ts";
import { businessKey, keyWithin, words } from "./name-keys.ts";
import { scaled } from "./quote-sums.ts";
import { nearOccurrence, type Recurrence } from "./recurrence.ts";
import { currentAmount, effectiveDue } from "./renewal-dates.ts";
import { type Renewal, renewalName } from "./renewals.ts";
import { readItemAmount } from "./money-input.ts";
import { readFrequency, readItemFields, readKind, readUntil } from "./tools/cashflow-input.ts";
import { isProblem } from "./text-input.ts";
import type { Fenced } from "./untrusted.ts";

/** Amounts within this percentage are «the same» for duplicates. */
export const SAME_AMOUNT_PERCENT = 5n;
/** Days within which two payments are the same one. */
export const NEAR_DAYS = 5;
/** Two voci once, further apart than this, are two payments. */
export const ONCE_APART_DAYS = 14;

/** Within SAME_AMOUNT_PERCENT of each other. */
export function sameAmount(a: bigint, b: bigint): boolean {
	const big = a > b ? a : b;
	const diff = a > b ? a - b : b - a;
	return diff * 100n <= big * SAME_AMOUNT_PERCENT;
}

const STOP_WORDS = new Set(["del", "della", "dei", "delle", "per", "con", "dal", "alla", "allo", "agli", "the", "mensile", "annuale", "pagamento", "spesa", "costo", "voce", "rata", "srl", "srls", "spa", "snc", "sas"]);

/** The words of a name that tell it apart: whole words, three letters or more, not filler nor a legal form. */
export function nameTokens(text: string): string[] {
	return words(text).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Two names share a whole word («Affitto» and «Affitto ufficio»; never «Sky» and «Skyline»). */
export function similarName(a: string, b: string): boolean {
	const x = new Set(nameTokens(a));
	return nameTokens(b).some((w) => x.has(w));
}

/** A party is a renewal's provider: by partita IVA when the provider is one, else its whole name in the party's. */
export function providerMatches(party: FatturaParty, provider: string): boolean {
	const compact = provider.replace(/[\s.-]+/g, "").toUpperCase();
	if (/^(?:[A-Z]{2})?\d{11}$/.test(compact)) return matchesParty(party, provider);
	return party.name !== undefined && keyWithin(businessKey(provider), businessKey(party.name));
}

/** A renewal's payment series: its due date, every so many months, before and after. */
export function renewalSeries(r: Renewal, today: string): { readonly first: string; readonly recurrence: Recurrence } {
	return { first: effectiveDue(r, today), recurrence: { months: r.months, day: r.day } };
}

export type Found = { readonly item: CashItem } | { readonly error: string } | { readonly missing: string };

/** The voce an id or a name names: by id; by name when exactly one has all its words; else the candidates, or why not. */
export function findItem(args: { readonly id?: unknown; readonly name?: unknown }, items: readonly CashItem[], line: (i: CashItem) => string, fence: Fenced): Found {
	if (typeof args.id === "string" && args.id.trim() !== "") {
		const n = parseItemId(args.id);
		if (n === undefined) return { error: "l'id di una voce è come C-0001" };
		const item = items.find((i) => i.id === itemId(n));
		return item === undefined ? { missing: itemId(n) } : { item };
	}
	if (typeof args.name === "string" && args.name.trim() !== "") {
		const said = words(args.name);
		const matches = items.filter((i) => {
			const name = words(i.name);
			return said.length > 0 && said.every((w) => name.includes(w));
		});
		if (matches.length === 1) return { item: matches[0] as CashItem };
		if (matches.length === 0) return { error: "nessuna voce ha questo nome. Guarda l'elenco con op list_items e indica l'id" };
		return { error: `più voci hanno questo nome; quale? Indica l'id.\n${fence(matches.slice(0, 15).map(line).join("\n"))}` };
	}
	return { error: "indica la voce con id (C-0001) o con name" };
}

/** A new voce, as read: what lookalikes compares. */
export type NewVoce = { readonly name: string; readonly kind: Kind; readonly cents: bigint; readonly date: string; readonly recurrence?: Recurrence };

/** Whether two series of dates (each once or recurring) have a payment within NEAR_DAYS; two voci once must be under ONCE_APART_DAYS apart. */
function nearDates(a: { date: string; recurrence?: Recurrence }, b: { date: string; recurrence?: Recurrence }): boolean {
	if (a.recurrence === undefined && b.recurrence === undefined) return Math.abs(daysBetween(a.date, b.date)) < ONCE_APART_DAYS;
	if (b.recurrence !== undefined) return nearOccurrence(b.date, b.recurrence, a.date, NEAR_DAYS, true) !== undefined;
	return nearOccurrence(a.date, a.recurrence, b.date, NEAR_DAYS, true) !== undefined;
}

/** The active renewals and the voci a new voce looks like: about the same amount, a word of the name in common, payments near in time. */
export function lookalikes(v: NewVoce, items: readonly CashItem[], renewals: readonly Renewal[], today: string, line: (i: CashItem) => string, euros: (c: bigint) => string): string[] {
	const out: string[] = [];
	if (v.kind === "out") {
		for (const r of renewals) {
			const price = r.status === "active" ? currentAmount(r, today) : undefined;
			if (price === undefined || !sameAmount(scaled(price, 2), v.cents)) continue;
			if (!similarName(v.name, r.name) && !(r.provider !== undefined && similarName(v.name, r.provider))) continue;
			const s = renewalSeries(r, today);
			if (!nearDates(v, { date: s.first, recurrence: s.recurrence })) continue;
			out.push(`• rinnovo ${r.id}: ${renewalName(r)}, ${euros(scaled(price, 2))}`);
		}
	}
	for (const i of items) {
		if (i.kind !== v.kind || !sameAmount(scaled(i.amount, 2), v.cents) || !similarName(v.name, i.name)) continue;
		const r = itemRecurrence(i);
		if (nearDates(v, { date: i.date, ...(r === undefined ? {} : { recurrence: r }) })) out.push(line(i));
	}
	return out;
}

/** What an edit changes: the fields it sets and those it removes. Applied onto the voce as saved at the write. */
export type Patch = { readonly set: Readonly<Partial<Record<keyof CashItem, unknown>>>; readonly unset: readonly (keyof CashItem)[] };

/** The voce with the patch, and what follows from it: a voce once has no end nor new amount; an end or a new amount before the date goes. */
export function applyPatch(current: CashItem, patch: Patch): CashItem {
	const next: Record<string, unknown> = { ...current };
	for (const k of patch.unset) delete next[k];
	Object.assign(next, patch.set);
	const recurring = next.months !== undefined || next.everyDays !== undefined;
	if (!recurring) {
		delete next.until;
		delete next.amountFrom;
	}
	if (typeof next.until === "string" && next.until < (next.date as string)) delete next.until;
	const from = next.amountFrom as CashItem["amountFrom"];
	if (from !== undefined && from.from <= (next.date as string)) delete next.amountFrom;
	return next as CashItem;
}

const TEXT = (value: unknown, max: number, what: string): string | undefined | { problem: string } => {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: `${what} è un testo` };
	const t = value.trim();
	return t.length > max ? { problem: `${what} è al massimo ${max} caratteri` } : t;
};

/** The patch `args` asks for on `item` (read now), checked against it; an error to say otherwise. With an id, `name` renames. */
export function editPatch(item: CashItem, args: Record<string, unknown>, today: string, fence: Fenced): { readonly patch: Patch; readonly notes: readonly string[] } | string {
	const set: Record<string, unknown> = {};
	const unset: (keyof CashItem)[] = [];
	const notes: string[] = [];
	const renames = args.id !== undefined && args.name !== undefined;
	const keys = ["amount", "date", "until", "note", "frequency", "kind", "new_amount", "new_amount_from"];
	if (!renames && !keys.some((k) => args[k] !== undefined)) return "Errore: dimmi cosa cambiare: name (con id), amount, date, until, note, frequency, kind, o new_amount con new_amount_from.";
	if (renames) {
		const name = TEXT(args.name, CASHFLOW_LIMITS.name, "name");
		if (typeof name === "object") return `Errore: ${name.problem}.`;
		if (name === undefined || name === "") return "Errore: name non può essere vuoto.";
		set.name = name;
	}
	const kind = args.kind === undefined ? item.kind : readKind(args.kind);
	if (isProblem(kind)) return `Errore: ${kind.problem}.`;
	if (args.kind !== undefined) set.kind = kind;
	let amount = item.amount;
	if (args.amount !== undefined) {
		const a = readItemAmount(args.amount, fence);
		if (a === undefined || isProblem(a)) return `Errore: ${a === undefined ? "amount" : a.problem}.`;
		amount = a;
		set.amount = a;
	}
	if (args.note !== undefined) {
		const note = TEXT(args.note, CASHFLOW_LIMITS.note, "note");
		if (typeof note === "object") return `Errore: ${note.problem}.`;
		if (note === undefined || note === "") unset.push("note");
		else set.note = note;
	}
	let date = item.date;
	let recurring = itemRecurrence(item) !== undefined;
	if (args.date !== undefined) {
		// A new date reads with the recurrence, as add_item reads it: the one said, or the voce's.
		const frequency = args.frequency !== undefined ? args.frequency : item.everyDays !== undefined ? `ogni ${item.everyDays} giorni` : (item.months ?? "una volta");
		const fields = readItemFields({ kind: kind === "in" ? "entrata" : "uscita", amount, date: args.date, frequency }, today, fence);
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		unset.push("months", "day", "everyDays");
		set.date = fields.date;
		date = fields.date;
		if (fields.months !== undefined) Object.assign(set, { months: fields.months, day: fields.day });
		if (fields.everyDays !== undefined) set.everyDays = fields.everyDays;
		recurring = fields.months !== undefined || fields.everyDays !== undefined;
		notes.push(...fields.notes);
	} else if (args.frequency !== undefined) {
		// Only the recurrence: the date and its day stay.
		const r = readFrequency(args.frequency);
		if (r === undefined) return "Errore: frequency: dimmi ogni quanto, o «una volta».";
		if (isProblem(r)) return `Errore: ${r.problem}.`;
		unset.push("months", "day", "everyDays");
		if (r !== "once") Object.assign(set, "days" in r ? { everyDays: r.days } : { months: r.months, day: item.day ?? Number(item.date.slice(8, 10)) });
		recurring = r !== "once";
	}
	if (args.until !== undefined) {
		if (args.until === "") unset.push("until");
		else {
			if (!recurring) return "Errore: until vale solo per una voce che si ripete.";
			const end = readUntil(args.until, today, date);
			if (isProblem(end)) return `Errore: ${end.problem}.`;
			set.until = end;
		}
	}
	if (args.new_amount !== undefined) {
		if (args.new_amount === "") unset.push("amountFrom");
		else {
			if (!recurring) return "Errore: new_amount vale solo per una voce che si ripete: per una voce una volta sola cambia amount.";
			const a = readItemAmount(args.new_amount, fence);
			if (a === undefined || isProblem(a)) return `Errore: new_amount: ${a === undefined ? "dammi l'importo" : a.problem}.`;
			if (args.new_amount_from === undefined || args.new_amount_from === "") return "Errore: con new_amount serve new_amount_from, il giorno da cui vale.";
			const from = readUntil(args.new_amount_from, today, addDays(date, 1));
			if (isProblem(from)) return `Errore: ${from.problem.replace(/^until/, "new_amount_from")}.`;
			set.amountFrom = { amount: a, from };
		}
	} else if (args.new_amount_from !== undefined) return "Errore: new_amount_from va con new_amount.";
	if (!recurring) {
		if (item.until !== undefined || item.amountFrom !== undefined) notes.push("Ora è una voce una volta sola: tolti la fine e il nuovo importo.");
		if (date < today && (args.date !== undefined || args.frequency !== undefined)) return `Errore: la data (${withDate("il", date)}) è passata: una voce una tantum va da oggi in poi.`;
	}
	return { patch: { set, unset }, notes };
}
