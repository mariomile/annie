/**
 * A bank statement file read into movements, pure: a CSV («;» or «,», Italian or English
 * decimals, a signed amount, a sign column or Dare/Avere columns), an Excel sheet through the
 * tables reader (documents.ts), or a CAMT.053 XML through xml-tree.ts. The table's header is found
 * among the first rows (the bank's name, the IBAN and the period above it are skipped), its
 * columns by their names in Italian or English; rows whose date does not read (totals, notes) are
 * skipped, a «Saldo finale» row is the closing balance. When the columns are not clear the caller
 * gets the header back, to ask the person which column is which.
 *
 * Nothing in the file is trusted: at most BANK_LIMITS.rows rows and BANK_LIMITS.cell characters a
 * cell are read, control and format characters go, and IBAN and card numbers are masked before
 * anything leaves this module (an IBAN keeps its last 4 characters, a card nothing).
 */
import { createHash } from "node:crypto";
import { BANK_LIMITS, BankError } from "./bank.ts";
import { spreadsheetRows } from "./documents.ts";
import { parseCsv } from "./make-xlsx.ts";
import { oneLine } from "./plain-text.ts";
import { dayOf, tableNumber } from "./tables.ts";
import { fold } from "./text-match.ts";
import { child, children, decodeXml, descendant, parseXml, xmlRoot, type XmlElement } from "./xml-tree.ts";

export const ROLES = ["date", "value_date", "description", "amount", "debit", "credit", "sign", "balance"] as const;
export type Role = (typeof ROLES)[number];

/** The columns as the person names them (a header's name, a letter or a number from 1). */
export type ColumnsSaid = Partial<Record<Role, string>>;

export type ParsedRow = {
	readonly date: string;
	readonly valueDate?: string;
	readonly cents: bigint;
	readonly description: string;
	readonly balance?: bigint;
	readonly ibanTail?: string;
	readonly own?: true;
	readonly hash: string;
};

export type Parsed = {
	readonly kind: "rows";
	readonly format: "csv" | "xlsx" | "camt";
	readonly rows: readonly ParsedRow[];
	readonly from: string;
	readonly to: string;
	readonly closing?: { readonly cents: bigint; readonly date: string };
	/** Rows past BANK_LIMITS.rows, left out. */
	readonly truncated: boolean;
	/** Rows under the header that are no movement (totals, notes, an amount that does not read). */
	readonly skipped: number;
};

/** The columns are not clear: the header found (cut, to be fenced) and why. */
export type Ask = { readonly kind: "ask"; readonly header: readonly string[]; readonly why: string };

type Columns = { date: number; valueDate?: number; description: number[]; amount?: number; debit?: number; credit?: number; sign?: number; balance?: number };

/** Header names by role, normalized (folded, single spaces); a lower rank wins between two date columns. */
const NAMES: Readonly<Record<Role, readonly (readonly [string, number])[]>> = {
	date: [["data contabile", 1], ["data contab", 1], ["data registrazione", 1], ["booking date", 1], ["posting date", 1], ["data operazione", 2], ["data op", 2], ["data movimento", 2], ["transaction date", 2], ["data", 3], ["date", 3]],
	value_date: [["data valuta", 1], ["valuta", 1], ["value date", 1], ["val", 1]],
	description: [["descrizione", 1], ["causale", 1], ["descrizione operazione", 1], ["causale descrizione", 1], ["descrizione estesa", 1], ["dettagli", 1], ["dettaglio", 1], ["operazione", 1], ["description", 1], ["details", 1], ["memo", 1], ["narrative", 1], ["reference", 1], ["beneficiario", 1], ["ordinante", 1]],
	amount: [["importo", 1], ["importo eur", 1], ["importo euro", 1], ["importo in euro", 1], ["amount", 1], ["amount eur", 1]],
	debit: [["dare", 1], ["uscite", 1], ["uscita", 1], ["addebiti", 1], ["addebito", 1], ["importo dare", 1], ["debit", 1], ["debits", 1], ["debit amount", 1], ["money out", 1], ["paid out", 1], ["withdrawals", 1]],
	credit: [["avere", 1], ["entrate", 1], ["entrata", 1], ["accrediti", 1], ["accredito", 1], ["importo avere", 1], ["credit", 1], ["credits", 1], ["credit amount", 1], ["money in", 1], ["paid in", 1], ["deposits", 1]],
	sign: [["segno", 1], ["dare avere", 1], ["d a", 1], ["cr dr", 1], ["dr cr", 1], ["debit credit", 1], ["sign", 1]],
	balance: [["saldo", 1], ["saldo contabile", 1], ["saldo progressivo", 1], ["balance", 1], ["running balance", 1]],
};

const norm = (cell: string) => fold(cell).replace(/\(?\s*(?:€|eur)\s*\)?$/, " eur").replace(/[^a-z0-9]+/g, " ").trim();

/** A cell from the file: at most BANK_LIMITS.cell characters, on one line, without control or format characters. */
export function cleanCell(cell: string): string {
	return oneLine(cell.slice(0, BANK_LIMITS.cell * 2), BANK_LIMITS.cell);
}

const CARD_LONG = /\b(?:\d[ -]?){12,18}\d\b/g;
const CARD_MASKED = /(?:[X*•]{2,}[ -]?){1,4}\d{2,4}\b/gi;
const IBAN_COMPACT = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;
const IBAN_GROUPED = /\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?\b/gi;

/**
 * A description with every IBAN-like string replaced by «IBAN …1234» (its last 4 characters) and
 * every card number, whole or already masked, by «[carta]». `ibanTail` and `own` (one of the
 * company's own IBANs) of the first IBAN; the full IBAN never leaves this function.
 */
export function maskSensitive(text: string, ownIbans: readonly string[] = []): { readonly text: string; readonly ibanTail?: string; readonly own?: true } {
	let tail: string | undefined;
	let own = false;
	const own2 = new Set(ownIbans.map((i) => i.replace(/\s+/g, "").toUpperCase()));
	const iban = (m: string) => {
		const compact = m.replace(/\s+/g, "").toUpperCase();
		if (tail === undefined) {
			tail = compact.slice(-4);
			own = own2.has(compact);
		}
		return `IBAN …${compact.slice(-4)}`;
	};
	const masked = text.replace(IBAN_GROUPED, iban).replace(IBAN_COMPACT, iban).replace(CARD_MASKED, "[carta]").replace(CARD_LONG, "[carta]");
	return { text: masked, ...(tail === undefined ? {} : { ibanTail: tail }), ...(own ? { own: true as const } : {}) };
}

/** The key two loads of the same movement share: the day, the cents, the masked description folded, the running balance. */
export function movementHash(date: string, cents: bigint, description: string, balance: bigint | undefined): string {
	const key = fold(description).replace(/[^a-z0-9]+/g, " ").trim();
	return createHash("sha256").update(`${date}|${cents}|${key}|${balance ?? ""}`).digest("hex").slice(0, 32);
}

/** The movements of a statement file, or the header to ask about. BankError when it is no statement. */
export function parseStatement(name: string, data: Uint8Array, o: { readonly columns?: ColumnsSaid; readonly ownIbans?: readonly string[] } = {}): Parsed | Ask {
	if (data.byteLength > BANK_LIMITS.importBytes) throw new BankError(`il file è troppo grande (più di ${BANK_LIMITS.importBytes / 1024 / 1024} MB): chiedi un estratto conto più corto, per esempio di un mese`);
	if (data[0] !== 0x50 && data.includes(0)) throw new BankError("il file non è un CSV, un Excel o un CAMT.053 che so leggere");
	const head = Buffer.from(data.subarray(0, 4096)).toString("utf8");
	const root = xmlRoot(head.replace(/^﻿/, ""));
	if (root !== undefined || /\.xml$/i.test(name)) return camt(data, o.ownIbans ?? []);
	let sheet: string[][];
	let format: "csv" | "xlsx" = "csv";
	let sheets: ReturnType<typeof spreadsheetRows>;
	try {
		sheets = spreadsheetRows(name, data, BANK_LIMITS.rows + 100);
	} catch {
		throw new BankError("il foglio Excel non si legge: è rovinato o protetto");
	}
	if (sheets !== undefined) {
		format = "xlsx";
		const visible = sheets.find((s) => !s.hidden && s.rows.some((r) => r.some((c) => c.trim() !== ""))) ?? sheets[0];
		sheet = visible?.rows.map((r) => r.map(cleanCell)) ?? [];
	} else {
		if (!/\.(?:csv|txt|tsv)$/i.test(name)) throw new BankError("leggo l'estratto conto in CSV, Excel (.xlsx) o CAMT.053 (.xml)");
		sheet = parseCsv(new TextDecoder("utf-8").decode(data)).map((r) => r.slice(0, 60).map(cleanCell));
	}
	return table(sheet, format, o);
}

function table(rows: string[][], format: "csv" | "xlsx", o: { readonly columns?: ColumnsSaid; readonly ownIbans?: readonly string[] }): Parsed | Ask {
	const found = o.columns !== undefined && Object.keys(o.columns).length > 0 ? said(rows, o.columns) : detect(rows);
	if ("why" in found) return { kind: "ask", header: found.header.slice(0, 30), why: found.why };
	const { at, cols } = found;
	const body = rows.slice(at + 1);
	const amountCols = [cols.amount, cols.debit, cols.credit, cols.balance].filter((c) => c !== undefined) as number[];
	const intl = new Map(amountCols.map((c) => [c, international(body.map((r) => r[c] ?? ""))]));
	const num = (r: readonly string[], c: number | undefined): bigint | undefined | null => {
		if (c === undefined) return undefined;
		const t = (r[c] ?? "").trim();
		if (t === "") return undefined;
		const n = tableNumber(t, intl.get(c) === true);
		if (n === undefined || (n.unit !== undefined && n.unit !== "€") || !Number.isFinite(n.value) || Math.abs(n.value) > BANK_LIMITS.maxAmount) return null;
		return BigInt(Math.round(n.value * 100));
	};
	const out: ParsedRow[] = [];
	let skipped = 0;
	let truncated = false;
	let closing: { cents: bigint; date: string } | undefined;
	for (const r of body) {
		if (r.every((c) => c.trim() === "")) continue;
		const day = isoOf(r[cols.date] ?? "");
		if (day === undefined) {
			const c = closingOf(r);
			if (c !== undefined) closing = c;
			else skipped++;
			continue;
		}
		if (out.length >= BANK_LIMITS.rows) {
			truncated = true;
			break;
		}
		let cents: bigint | undefined | null;
		if (cols.amount !== undefined) {
			cents = num(r, cols.amount);
			const s = cols.sign === undefined ? undefined : signOf(r[cols.sign] ?? "");
			if (typeof cents === "bigint" && s !== undefined) cents = s * (cents < 0n ? -cents : cents);
		} else {
			const d = num(r, cols.debit);
			const c = num(r, cols.credit);
			cents = d === null || c === null ? null : d === undefined && c === undefined ? undefined : (c === undefined ? 0n : c < 0n ? -c : c) - (d === undefined ? 0n : d < 0n ? -d : d);
		}
		const balance = num(r, cols.balance);
		if (cents === null || cents === undefined || cents === 0n || balance === null) {
			skipped++;
			continue;
		}
		const value = cols.valueDate === undefined ? undefined : isoOf(r[cols.valueDate] ?? "");
		const text = cols.description.map((c) => r[c] ?? "").filter((t) => t.trim() !== "").join(" ");
		out.push(row(day, value, cents, text, balance, o.ownIbans ?? []));
	}
	if (out.length === 0) return { kind: "ask", header: (rows[at] ?? []).slice(0, 30), why: "sotto l'intestazione non trovo movimenti con una data e un importo che so leggere" };
	if (closing === undefined && cols.balance !== undefined) closing = lastBalance(out);
	return finish(format, out, closing, truncated, skipped);
}

function row(date: string, valueDate: string | undefined, cents: bigint, text: string, balance: bigint | undefined, ownIbans: readonly string[]): ParsedRow {
	const masked = maskSensitive(oneLine(text, BANK_LIMITS.cell), ownIbans);
	const description = oneLine(masked.text, BANK_LIMITS.description) || "(senza descrizione)";
	return {
		date,
		...(valueDate === undefined || valueDate === date ? {} : { valueDate }),
		cents,
		description,
		...(balance === undefined ? {} : { balance }),
		...(masked.ibanTail === undefined ? {} : { ibanTail: masked.ibanTail }),
		...(masked.own === true ? { own: true as const } : {}),
		hash: movementHash(date, cents, description, balance),
	};
}

function finish(format: Parsed["format"], rows: ParsedRow[], closing: { cents: bigint; date: string } | undefined, truncated: boolean, skipped: number): Parsed {
	const days = rows.map((r) => r.date).sort();
	return { kind: "rows", format, rows, from: days[0] as string, to: days.at(-1) as string, ...(closing === undefined ? {} : { closing }), truncated, skipped };
}

/** The running balance of the latest movement: the file lists newest first or last, and says which by its order. */
function lastBalance(rows: readonly ParsedRow[]): { cents: bigint; date: string } | undefined {
	const first = rows[0] as ParsedRow;
	const last = rows.at(-1) as ParsedRow;
	const newestFirst = first.date > last.date;
	const max = rows.reduce((d, r) => (r.date > d ? r.date : d), first.date);
	const sameDay = rows.filter((r) => r.date === max && r.balance !== undefined);
	const pick = newestFirst ? sameDay[0] : sameDay.at(-1);
	return pick?.balance === undefined ? undefined : { cents: pick.balance, date: max };
}

const CLOSING = /\bsaldo\s+(?:finale|contabile(?:\s+finale)?|al\b|disponibile|liquido|di\s+chiusura)|\bclosing\s+balance\b/;

/** A footer row with the closing balance: its words, a date (in a cell or in the words), the last amount. */
function closingOf(r: readonly string[]): { cents: bigint; date: string } | undefined {
	const words = fold(r.join(" "));
	if (!CLOSING.test(words) || /\biniziale\b|\bopening\b/.test(words)) return undefined;
	let cents: bigint | undefined;
	let date: string | undefined;
	for (const c of r) {
		const t = c.trim();
		const d = isoOf(t) ?? isoOf(/(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/.exec(t)?.[1] ?? "");
		if (d !== undefined) date = d;
		const n = tableNumber(t, international([t]));
		if (n !== undefined && dayOf(t) === undefined && Math.abs(n.value) <= BANK_LIMITS.maxAmount) cents = BigInt(Math.round(n.value * 100));
	}
	return cents === undefined || date === undefined ? undefined : { cents, date };
}

function signOf(cell: string): bigint | undefined {
	const t = fold(cell).trim();
	if (/^(?:d|dare|-|dbit|dr|debit|debito|addebito|u|uscita)$/.test(t)) return -1n;
	if (/^(?:a|c|avere|\+|crdt|cr|credit|credito|accredito|e|entrata)$/.test(t)) return 1n;
	return undefined;
}

/** Whether a column writes amounts the English way (1,234.56) rather than the Italian (1.234,56). */
function international(cells: readonly string[]): boolean {
	let it = 0;
	let en = 0;
	for (const c of cells) {
		const t = c.replace(/[^\d.,]/g, "");
		if (/\d\.\d{3},\d/.test(t) || /\d,\d{1,2}$/.test(t)) it++;
		else if (/\d,\d{3}\.\d/.test(t) || /\d\.\d{1,2}$/.test(t)) en++;
	}
	return en > it;
}

function isoOf(text: string): string | undefined {
	const d = dayOf(text);
	return d === undefined ? undefined : new Date(d * 86_400_000).toISOString().slice(0, 10);
}

type Found = { at: number; cols: Columns } | { header: string[]; why: string };

/** The roles of a header row: each cell's role and rank, when its name is known. */
function rolesOf(header: readonly string[]): { role: Role; rank: number; col: number }[] {
	const out: { role: Role; rank: number; col: number }[] = [];
	header.forEach((cell, col) => {
		const n = norm(cell);
		for (const role of ROLES) {
			const hit = NAMES[role].find(([name]) => name === n);
			if (hit !== undefined) {
				out.push({ role, rank: hit[1], col });
				break;
			}
		}
	});
	return out;
}

/** The header among the first 30 rows: the first whose names give a date and an amount; otherwise the one with most known names, to ask about. */
function detect(rows: readonly string[][]): Found {
	let best: { at: number; hits: number } = { at: 0, hits: -1 };
	for (let at = 0; at < Math.min(rows.length, 30); at++) {
		const roles = rolesOf(rows[at] as string[]);
		if (roles.length > best.hits) best = { at, hits: roles.length };
		const cols = columnsOf(roles);
		if (typeof cols === "string") {
			if (roles.some((r) => r.role === "date") && roles.some((r) => r.role === "amount" || r.role === "debit" || r.role === "credit")) return { header: rows[at] as string[], why: cols };
			continue;
		}
		return { at, cols };
	}
	const header = rows[best.at] ?? [];
	return { header, why: best.hits <= 0 ? "non riconosco i nomi delle colonne" : "non capisco quale colonna è la data e quale l'importo" };
}

/** The columns of the roles found, or why they are not clear. */
function columnsOf(roles: readonly { role: Role; rank: number; col: number }[]): Columns | string {
	const of = (role: Role) => roles.filter((r) => r.role === role);
	const dates = of("date");
	if (dates.length === 0) return "manca la colonna della data";
	const top = Math.min(...dates.map((d) => d.rank));
	const first = dates.filter((d) => d.rank === top);
	if (first.length > 1) return "ci sono più colonne di date con lo stesso nome";
	const one = (role: Role): number | undefined | string => {
		const list = of(role);
		if (list.length > 1) return `ci sono più colonne che possono essere ${LABELS[role]}`;
		return list[0]?.col;
	};
	const amount = one("amount");
	const debit = one("debit");
	const credit = one("credit");
	const sign = one("sign");
	const balance = one("balance");
	const value = one("value_date");
	for (const v of [amount, debit, credit, sign, balance, value]) if (typeof v === "string") return v;
	if (amount === undefined && (debit === undefined || credit === undefined)) return debit === undefined && credit === undefined ? "manca la colonna dell'importo" : "c'è solo una delle colonne Dare/Avere (Entrate/Uscite)";
	if (amount !== undefined && (debit !== undefined || credit !== undefined)) return "ci sono sia una colonna Importo sia le colonne Dare/Avere";
	const description = of("description").map((d) => d.col);
	if (description.length === 0) return "manca la colonna della descrizione (o causale)";
	const date = (first[0] as { col: number }).col;
	const valueDate = value as number | undefined;
	return { date, description, ...(valueDate === undefined ? {} : { valueDate }), ...num("amount", amount), ...num("debit", debit), ...num("credit", credit), ...num("sign", sign), ...num("balance", balance) };
}

const num = (key: string, v: number | string | undefined) => (typeof v === "number" ? { [key]: v } : {});

const LABELS: Readonly<Record<Role, string>> = { date: "la data", value_date: "la data valuta", description: "la descrizione", amount: "l'importo", debit: "le uscite (Dare)", credit: "le entrate (Avere)", sign: "il segno", balance: "il saldo" };

/** The columns the person named: by header name, letter or number; the header is the first row with every name given. */
function said(rows: readonly string[][], given: ColumnsSaid): Found {
	const header0 = rows.find((r) => r.some((c) => c.trim() !== "")) ?? [];
	const named = Object.values(given).filter((v): v is string => typeof v === "string" && !isRef(v));
	let at = -1;
	if (named.length > 0) at = rows.slice(0, 30).findIndex((r) => named.every((n) => r.some((c) => norm(c) === norm(n))));
	if (named.length > 0 && at < 0) return { header: header0, why: "non trovo un'intestazione con i nomi di colonna indicati" };
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
	const roles: { role: Role; rank: number; col: number }[] = [];
	for (const role of ROLES) {
		const i = index(given[role]);
		if (i === null) return { header, why: `non trovo la colonna indicata per ${LABELS[role]}` };
		if (i !== undefined) roles.push({ role, rank: 1, col: i });
	}
	const cols = columnsOf(roles);
	if (typeof cols === "string") return { header: header.length > 0 ? header : header0, why: cols };
	// Without names, the header is the row before the first that reads as a movement.
	if (at < 0) at = rows.findIndex((r) => isoOf(r[cols.date] ?? "") !== undefined) - 1;
	return { at: Math.max(at, -1), cols };
}

const isRef = (v: string) => /^\s*(?:[A-Za-z]{1,2}|\d{1,2})\s*$/.test(v);

/** A CAMT.053 statement: its entries (Ntry) and the closing booked balance (CLBD). */
function camt(data: Uint8Array, ownIbans: readonly string[]): Parsed {
	let doc: XmlElement;
	try {
		doc = parseXml(decodeXml(data), { maxElements: 300_000, maxDepth: 40 });
	} catch (error) {
		throw new BankError(error instanceof Error ? error.message : "il file XML non si legge");
	}
	const report = child(doc, "BkToCstmrStmt");
	if (doc.name !== "Document" || report === undefined) throw new BankError("questo XML non è un estratto conto CAMT.053");
	const out: ParsedRow[] = [];
	let closing: { cents: bigint; date: string } | undefined;
	let skipped = 0;
	let truncated = false;
	const amount = (el: XmlElement | undefined, indicator: string | undefined): bigint | undefined => {
		const t = (el?.text ?? "").trim();
		if (!/^\d{1,12}(?:\.\d{1,5})?$/.test(t) || Number(t) > BANK_LIMITS.maxAmount) return undefined;
		const cents = BigInt(Math.round(Number(t) * 100));
		return indicator === "DBIT" ? -cents : cents;
	};
	const day = (el: XmlElement | undefined) => isoOf((descendant(el, "Dt")?.text ?? descendant(el, "DtTm")?.text ?? "").trim().slice(0, 10));
	for (const stmt of children(report, "Stmt")) {
		for (const bal of children(stmt, "Bal")) {
			if (descendant(bal, "Tp/CdOrPrtry/Cd")?.text.trim() !== "CLBD") continue;
			const cents = amount(child(bal, "Amt"), child(bal, "CdtDbtInd")?.text.trim());
			const date = day(child(bal, "Dt"));
			if (cents !== undefined && date !== undefined && (closing === undefined || date >= closing.date)) closing = { cents, date };
		}
		for (const entry of children(stmt, "Ntry")) {
			if (out.length >= BANK_LIMITS.rows) {
				truncated = true;
				break;
			}
			const indicator = child(entry, "CdtDbtInd")?.text.trim();
			const cents = amount(child(entry, "Amt"), indicator);
			const date = day(child(entry, "BookgDt")) ?? day(child(entry, "ValDt"));
			if (cents === undefined || cents === 0n || date === undefined || (indicator !== "DBIT" && indicator !== "CRDT")) {
				skipped++;
				continue;
			}
			const tx = descendant(entry, "NtryDtls/TxDtls");
			const party = indicator === "CRDT" ? descendant(tx, "RltdPties/Dbtr/Nm") : descendant(tx, "RltdPties/Cdtr/Nm");
			const account = indicator === "CRDT" ? descendant(tx, "RltdPties/DbtrAcct/Id/IBAN") : descendant(tx, "RltdPties/CdtrAcct/Id/IBAN");
			const texts = [party?.text, ...children(child(tx, "RmtInf"), "Ustrd").map((u) => u.text), child(entry, "AddtlNtryInf")?.text, account === undefined ? undefined : account.text].filter((t): t is string => t !== undefined && t.trim() !== "");
			out.push(row(date, day(child(entry, "ValDt")), cents, cleanCell(texts.join(" ")), undefined, ownIbans));
		}
	}
	if (out.length === 0) throw new BankError("nel CAMT.053 non trovo movimenti");
	return finish("camt", out, closing, truncated, skipped);
}
