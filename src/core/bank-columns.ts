/**
 * Which column of a statement table is which, pure: the header found among the first rows by its
 * names in Italian or English (the bank's name, the IBAN and the period above it are skipped), or
 * the columns as the person names them (a header's name, a letter or a number). When it is not
 * clear the caller gets why, to ask the person.
 */
import { fold } from "./text-match.ts";

export const ROLES = ["date", "value_date", "description", "amount", "debit", "credit", "sign", "balance"] as const;
export type Role = (typeof ROLES)[number];

/** The columns as the person names them (a header's name, a letter or a number from 1). */
export type ColumnsSaid = Partial<Record<Role, string>>;

export type Columns = {
	readonly date: number;
	readonly valueDate?: number;
	readonly description: readonly number[];
	readonly amount?: number;
	readonly debit?: number;
	readonly credit?: number;
	readonly sign?: number;
	readonly balance?: number;
	/** What was taken without asking, to say: two «Data» columns, the first the data contabile. */
	readonly assumed?: string;
};

/** The header's row and its columns; or the row to show and why the columns are not clear (noHeader: the file starts with data). */
export type Found = { readonly at: number; readonly cols: Columns } | { readonly header: readonly string[]; readonly at: number; readonly why: string; readonly noHeader?: true };

/** Header names by role, normalized (folded, single spaces); a lower rank wins between two date columns. */
const NAMES: Readonly<Record<Role, readonly (readonly [string, number])[]>> = {
	date: [["data contabile", 1], ["data contab", 1], ["data registrazione", 1], ["booking date", 1], ["posting date", 1], ["data operazione", 2], ["data op", 2], ["data movimento", 2], ["transaction date", 2], ["data", 3], ["date", 3]],
	value_date: [["data valuta", 1], ["valuta", 1], ["value date", 1], ["val", 1]],
	description: [["descrizione", 1], ["causale", 1], ["descrizione operazione", 1], ["descrizione completa", 1], ["causale descrizione", 1], ["descrizione estesa", 1], ["dettagli", 1], ["dettaglio", 1], ["operazione", 1], ["description", 1], ["details", 1], ["memo", 1], ["narrative", 1], ["reference", 1], ["beneficiario", 1], ["ordinante", 1]],
	amount: [["importo", 1], ["importo eur", 1], ["importo euro", 1], ["importo in euro", 1], ["amount", 1], ["amount eur", 1]],
	debit: [["dare", 1], ["uscite", 1], ["uscita", 1], ["addebiti", 1], ["addebito", 1], ["importo dare", 1], ["debit", 1], ["debits", 1], ["debit amount", 1], ["money out", 1], ["paid out", 1], ["withdrawals", 1]],
	credit: [["avere", 1], ["entrate", 1], ["entrata", 1], ["accrediti", 1], ["accredito", 1], ["importo avere", 1], ["credit", 1], ["credits", 1], ["credit amount", 1], ["money in", 1], ["paid in", 1], ["deposits", 1]],
	sign: [["segno", 1], ["dare avere", 1], ["d a", 1], ["cr dr", 1], ["dr cr", 1], ["debit credit", 1], ["sign", 1]],
	balance: [["saldo", 1], ["saldo contabile", 1], ["saldo progressivo", 1], ["balance", 1], ["running balance", 1]],
};

/** Any other header with one of these words is a part of the description too («Descrizione completa», «Note», «Dettagli operazione»). */
const DESCRIPTION_WORDS = /\b(?:descrizione|causale|dettagli|dettaglio|note)\b/;

export const norm = (cell: string): string =>
	fold(cell)
		.replace(/\(?\s*(?:€|eur)\s*\)?$/, " eur")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

type Hit = { readonly role: Role; readonly rank: number; readonly col: number };

/** The roles of a header row: each cell's role and rank, when its name is known. */
function rolesOf(header: readonly string[]): Hit[] {
	const out: Hit[] = [];
	header.forEach((cell, col) => {
		const n = norm(cell);
		const role = ROLES.find((r) => NAMES[r].some(([name]) => name === n));
		if (role !== undefined) out.push({ role, rank: NAMES[role].find(([name]) => name === n)?.[1] ?? 1, col });
		else if (DESCRIPTION_WORDS.test(n)) out.push({ role: "description", rank: 1, col });
	});
	return out;
}

const DATE_CELL = /^\s*(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/;

/** The header among the first 30 rows: the first whose names give a date and an amount; otherwise the one with most known names, to ask about. */
export function detect(rows: readonly (readonly string[])[]): Found {
	let best: { at: number; hits: number } = { at: 0, hits: -1 };
	for (let at = 0; at < Math.min(rows.length, 30); at++) {
		const roles = rolesOf(rows[at] as string[]);
		if (roles.length > best.hits) best = { at, hits: roles.length };
		const cols = columnsOf(roles);
		if (typeof cols === "string") {
			if (roles.some((r) => r.role === "date") && roles.some((r) => r.role === "amount" || r.role === "debit" || r.role === "credit")) return { header: rows[at] as string[], at, why: cols };
			continue;
		}
		return { at, cols };
	}
	if (best.hits <= 0) {
		// No names at all: when the first row with something is already a movement, the file has no header.
		const first = rows.findIndex((r) => r.some((c) => c.trim() !== ""));
		const row = rows[first] ?? [];
		if (row.some((c) => DATE_CELL.test(c))) return { header: row, at: first, why: "il file non ha i nomi delle colonne", noHeader: true };
		return { header: row, at: Math.max(first, 0), why: "non riconosco i nomi delle colonne" };
	}
	return { header: rows[best.at] ?? [], at: best.at, why: "non capisco quale colonna è la data e quale l'importo" };
}

export const LABELS: Readonly<Record<Role, string>> = { date: "la data", value_date: "la data valuta", description: "la descrizione", amount: "l'importo", debit: "le uscite (Dare)", credit: "le entrate (Avere)", sign: "il segno", balance: "il saldo" };

/** The columns of the roles found, or why they are not clear. */
function columnsOf(roles: readonly Hit[]): Columns | string {
	const of = (role: Role) => roles.filter((r) => r.role === role);
	const dates = of("date");
	if (dates.length === 0) return "manca la colonna della data";
	const top = Math.min(...dates.map((d) => d.rank));
	const first = dates.filter((d) => d.rank === top);
	const one = (role: Role): number | undefined | string => {
		const list = of(role);
		if (list.length > 1) return `ci sono più colonne che possono essere ${LABELS[role]}`;
		return list[0]?.col;
	};
	let value = one("value_date");
	let assumed: string | undefined;
	if (first.length > 1) {
		// Two plain «Data» columns and no «Valuta»: the first is the data contabile, the second the valuta, as Italian banks write them.
		if (first.length !== 2 || top !== 3 || value !== undefined) return "ci sono più colonne di date con lo stesso nome";
		value = (first[1] as Hit).col;
		assumed = "Ci sono due colonne «Data»: ho preso la prima come data dell'operazione (contabile) e la seconda come data valuta.";
	}
	const amount = one("amount");
	const debit = one("debit");
	const credit = one("credit");
	const sign = one("sign");
	const balance = one("balance");
	for (const v of [amount, debit, credit, sign, balance, value]) if (typeof v === "string") return v;
	if (amount === undefined && (debit === undefined || credit === undefined)) return debit === undefined && credit === undefined ? "manca la colonna dell'importo" : "c'è solo una delle colonne Dare/Avere (Entrate/Uscite)";
	if (amount !== undefined && (debit !== undefined || credit !== undefined)) return "ci sono sia una colonna Importo sia le colonne Dare/Avere";
	const description = of("description").map((d) => d.col);
	if (description.length === 0) return "manca la colonna della descrizione (o causale)";
	const n = (key: string, v: number | string | undefined) => (typeof v === "number" ? { [key]: v } : {});
	return { date: (first[0] as Hit).col, description, ...n("valueDate", value), ...n("amount", amount), ...n("debit", debit), ...n("credit", credit), ...n("sign", sign), ...n("balance", balance), ...(assumed === undefined ? {} : { assumed }) };
}

const isRef = (v: string) => /^\s*(?:[A-Za-z]{1,2}|\d{1,2})\s*$/.test(v);

/** The columns the person named: by header name, letter or number; the header is the first row with every name given. */
export function said(rows: readonly (readonly string[])[], given: ColumnsSaid): Found {
	const at0 = Math.max(
		rows.findIndex((r) => r.some((c) => c.trim() !== "")),
		0,
	);
	const header0 = rows[at0] ?? [];
	const named = Object.values(given).filter((v): v is string => typeof v === "string" && !isRef(v));
	let at = -1;
	if (named.length > 0) at = rows.slice(0, 30).findIndex((r) => named.every((n) => r.some((c) => norm(c) === norm(n))));
	if (named.length > 0 && at < 0) return { header: header0, at: at0, why: "non trovo un'intestazione con i nomi di colonna indicati" };
	const header = at < 0 ? [] : (rows[at] as string[]);
	const index = (v: string | undefined): number | undefined | null => {
		if (v === undefined) return undefined;
		if (isRef(v)) {
			const t = v.trim().toUpperCase();
			return /^\d+$/.test(t) ? Number(t) - 1 : [...t].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
		}
		const i = header.findIndex((c) => norm(c) === norm(v));
		return i < 0 ? null : i;
	};
	const roles: Hit[] = [];
	for (const role of ROLES) {
		const i = index(given[role]);
		if (i === null) return { header, at, why: `non trovo la colonna indicata per ${LABELS[role]}` };
		if (i !== undefined) roles.push({ role, rank: 1, col: i });
	}
	const cols = columnsOf(roles);
	if (typeof cols === "string") return header.length > 0 ? { header, at, why: cols } : { header: header0, at: at0, why: cols };
	// Without names, the header is the row before the first that reads as a movement.
	if (at < 0) at = rows.findIndex((r) => DATE_CELL.test(r[cols.date] ?? "")) - 1;
	return { at: Math.max(at, -1), cols };
}
