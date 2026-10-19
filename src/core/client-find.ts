/**
 * Who a person names among some clients: one rule for the clients' cards and the outgoing
 * invoices, and the suppliers' cards (supplier-sums.ts) with their own ids. By id (a card's CL-0001, a ricontatto's FU-0001), by partita IVA or codice fiscale,
 * then by name with the timesheet's rule (timesheet-clients.ts): the same spelling is the client;
 * a name close to one only (another legal form, a name inside the other, a slip of a letter) is
 * asked, except when exactly one client has the same name but for the legal form («Acme» for
 * «Acme Srl»), which is taken and said (FORM_NOTE).
 */
import { vatKey } from "./clients.ts";
import { sameBusiness, spellingKey } from "./name-keys.ts";
import { resolveClient } from "./timesheet-clients.ts";

export const FORM_NOTE = "Nessuno si chiama esattamente così: ho preso il cliente con lo stesso nome a meno della forma societaria, nel riquadro.";

/**
 * How a party taken by its name but for the legal form is said, for a side that words it so
 * (the suppliers: `party` «fornitore»). `without`: the name said has a legal form the party's
 * name has not. The clients keep FORM_NOTE, which their answers already give.
 */
export function formNote(party: string, without = false): string {
	return without ? `Ho preso il ${party} che si chiama così senza la forma societaria, nel riquadro.` : `Ho preso il ${party} che si chiama così con la forma societaria (S.r.l., SpA…), nel riquadro.`;
}

/** One client to find: its names (the first is the one shown), tax ids and ids. */
export type Candidate<T> = { readonly item: T; readonly names: readonly string[]; readonly vat?: string; readonly cf?: string; readonly ids?: readonly string[] };

/**
 * `respelled`: the name said is not the one shown; `form`: taken for the same name but the legal
 * form; `same`: close because several clients have exactly the name said (told apart by their tax ids).
 */
export type NamedFound<T> = { readonly kind: "exact"; readonly item: T; readonly respelled: boolean; readonly form?: true } | { readonly kind: "close"; readonly candidates: readonly T[]; readonly same?: true } | { readonly kind: "none" };

const ID = /^(?:CL|FU)-\d{4,6}$/;
const CF = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** A tax id as said: the partita IVA's key (clients.ts vatKey) and the codice fiscale (a company's is its 11 digits). */
export type TaxId = { readonly vat?: string; readonly cf?: string };

/**
 * A partita IVA or a codice fiscale as a person writes it («P.IVA IT 000…», «cf XQZ…», labels,
 * spaces and dots out); undefined when `said` is neither.
 */
export function taxIdOf(said: string): TaxId | undefined {
	const compact = said.trim().replace(/[\s.\-/]/g, "").replace(/^(?:piva|partitaiva|cf|codicefiscale):?/i, "").toUpperCase();
	if (CF.test(compact)) return { cf: compact };
	if (!/^(?:[A-Z]{2})?\d{8,12}$/.test(compact)) return undefined;
	const vat = vatKey(compact);
	const cf = /^\d{11}$/.test(compact) ? compact : undefined;
	return vat === undefined && cf === undefined ? undefined : { ...(vat === undefined ? {} : { vat }), ...(cf === undefined ? {} : { cf }) };
}

/** `ids`: what a card's id looks like (the clients' CL-0001 and FU-0001 by default; the suppliers' FO-0001). */
export function findNamed<T>(candidates: readonly Candidate<T>[], said: string, maxName: number, ids: RegExp = ID): NamedFound<T> {
	const t = said.trim();
	const id = t.toUpperCase();
	if (ids.test(id)) {
		const c = candidates.find((x) => x.ids?.includes(id) === true);
		return c === undefined ? { kind: "none" } : { kind: "exact", item: c.item, respelled: false };
	}
	const tax = taxIdOf(t);
	if (tax !== undefined) {
		const c = candidates.find((x) => (tax.vat !== undefined && x.vat === tax.vat) || (tax.cf !== undefined && x.cf === tax.cf));
		if (c !== undefined) return { kind: "exact", item: c.item, respelled: false };
	}
	// A name may belong to more than one client (the same name, other tax ids): all of them are kept.
	const owners = new Map<string, Candidate<T>[]>();
	const names: string[] = [];
	for (const c of candidates) {
		for (const n of c.names) {
			const k = spellingKey(n);
			if (k === "") continue;
			const list = owners.get(k);
			if (list === undefined) {
				owners.set(k, [c]);
				names.push(n);
			} else if (!list.includes(c)) list.push(c);
		}
	}
	const r = resolveClient(t.slice(0, maxName), names);
	if (r.kind === "exact") {
		const all = owners.get(spellingKey(r.name)) as Candidate<T>[];
		if (all.length > 1) return { kind: "close", candidates: all.map((c) => c.item), same: true };
		const c = all[0] as Candidate<T>;
		return { kind: "exact", item: c.item, respelled: c.names[0] !== t };
	}
	if (r.kind === "close") {
		const close = [...new Set(r.candidates.flatMap((n) => owners.get(spellingKey(n)) as Candidate<T>[]))];
		// The same business but for the legal form: the one client meant; a name only contained stays close.
		const same = close.filter((c) => c.names.some((n) => sameBusiness(t, n)));
		if (same.length === 1) return { kind: "exact", item: (same[0] as Candidate<T>).item, respelled: true, form: true };
		return { kind: "close", candidates: close.map((c) => c.item) };
	}
	return { kind: "none" };
}
