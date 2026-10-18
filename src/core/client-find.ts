/**
 * Who a person names among some clients: one rule for the clients' cards and the outgoing
 * invoices. By id (a card's CL-0001, a ricontatto's FU-0001), by partita IVA or codice fiscale,
 * then by name with the timesheet's rule (timesheet-clients.ts): the same spelling is the client;
 * a name close to one only (another legal form, a name inside the other, a slip of a letter) is
 * asked, except when exactly one client has the same name but for the legal form («Acme» for
 * «Acme Srl»), which is taken and said (FORM_NOTE).
 */
import { vatKey } from "./clients.ts";
import { sameBusiness, spellingKey } from "./name-keys.ts";
import { resolveClient } from "./timesheet-clients.ts";

export const FORM_NOTE = "Nessuno si chiama esattamente così: ho preso il cliente con lo stesso nome a meno della forma societaria, nel riquadro.";

/** One client to find: its names (the first is the one shown), tax ids and ids. */
export type Candidate<T> = { readonly item: T; readonly names: readonly string[]; readonly vat?: string; readonly cf?: string; readonly ids?: readonly string[] };

/** `respelled`: the name said is not the one shown; `form`: taken for the same name but the legal form. */
export type NamedFound<T> = { readonly kind: "exact"; readonly item: T; readonly respelled: boolean; readonly form?: true } | { readonly kind: "close"; readonly candidates: readonly T[] } | { readonly kind: "none" };

const ID = /^(?:CL|FU)-\d{4,6}$/;
const CF = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

export function findNamed<T>(candidates: readonly Candidate<T>[], said: string, maxName: number): NamedFound<T> {
	const t = said.trim();
	const id = t.toUpperCase();
	if (ID.test(id)) {
		const c = candidates.find((x) => x.ids?.includes(id) === true);
		return c === undefined ? { kind: "none" } : { kind: "exact", item: c.item, respelled: false };
	}
	const compact = t.replace(/[\s.\-/]/g, "").replace(/^(?:p\.?iva|partitaiva)[:]?/i, "").toUpperCase();
	if (/^(?:[A-Z]{2})?\d{8,12}$/.test(compact) || CF.test(compact)) {
		const v = vatKey(compact);
		const c = candidates.find((x) => (v !== undefined && x.vat === v) || x.cf === compact);
		if (c !== undefined) return { kind: "exact", item: c.item, respelled: false };
	}
	const owners = new Map<string, Candidate<T>>();
	const names: string[] = [];
	for (const c of candidates) {
		for (const n of c.names) {
			const k = spellingKey(n);
			if (k === "" || owners.has(k)) continue;
			owners.set(k, c);
			names.push(n);
		}
	}
	const r = resolveClient(t.slice(0, maxName), names);
	if (r.kind === "exact") {
		const c = owners.get(spellingKey(r.name)) as Candidate<T>;
		return { kind: "exact", item: c.item, respelled: c.names[0] !== t };
	}
	if (r.kind === "close") {
		const close = [...new Set(r.candidates.map((n) => owners.get(spellingKey(n)) as Candidate<T>))];
		// The same business but for the legal form: the one client meant; a name only contained stays close.
		const same = close.filter((c) => c.names.some((n) => sameBusiness(t, n)));
		if (same.length === 1) return { kind: "exact", item: (same[0] as Candidate<T>).item, respelled: true, form: true };
		return { kind: "close", candidates: close.map((c) => c.item) };
	}
	return { kind: "none" };
}
