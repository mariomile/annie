/**
 * A bank statement file read into movements, pure: a CSV («;» or «,», Italian or English
 * decimals, a signed amount, a sign column or Dare/Avere columns), an Excel sheet through the
 * tables reader (documents.ts), or a CAMT.053 XML through xml-tree.ts. The columns are found by
 * bank-columns.ts; rows whose date does not read (totals, notes) are skipped and counted, a «Saldo
 * finale» row is the closing balance. When the columns, the order of day and month or the decimal
 * separator are not clear the caller gets the header and the first values back, to ask the person.
 *
 * Nothing in the file is trusted: at most BANK_LIMITS.rows rows and BANK_LIMITS.cell characters a
 * cell are read, control and format characters go, and IBAN and card numbers are masked before
 * anything leaves this module (an IBAN keeps its last 4 characters, a card nothing): the header
 * and the values shown to ask about too.
 */
import { createHash } from "node:crypto";
import { BANK_LIMITS, BankError } from "./bank.ts";
import { type Columns, type ColumnsSaid, detect, type Found, norm, said } from "./bank-columns.ts";
import { spreadsheetRows } from "./documents.ts";
import { parseCsv } from "./make-xlsx.ts";
import { oneLine } from "./plain-text.ts";
import { dayOf, tableNumber } from "./tables.ts";
import { fold } from "./text-match.ts";
import { attribute, child, children, decodeXml, descendant, parseXml, xmlRoot, type XmlElement } from "./xml-tree.ts";

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
	/** Rows under the header that are no movement (totals, notes, an empty amount). */
	readonly skipped: number;
	/** Rows with an amount whose date does not read: left out, and said. */
	readonly badDates: number;
	/** Rows with both Dare and Avere filled: left out, and said. */
	readonly bothSides: number;
	/** CAMT entries (and balances) in another currency than the euro: left out, and said. */
	readonly otherCurrency: number;
	/** What was taken without asking, to say. */
	readonly assumed?: string;
	/** The file's shape: its format and its header (another export of the same account has another). */
	readonly layout: string;
};

/** Not clear: the header found (or the first row, when there is no header) and the first values under it, masked and cut, to be fenced; and why. */
export type Ask = { readonly kind: "ask"; readonly header: readonly string[]; readonly samples: readonly (readonly string[])[]; readonly noHeader: boolean; readonly why: string; readonly need: AskNeed };

/** What the person is asked: which column is which, how dates are written, or what the comma is in the amounts. */
export type AskNeed = "columns" | "day_first" | "decimal_comma";

/** A cell from the file: at most BANK_LIMITS.cell characters, on one line, without control or format characters. */
export function cleanCell(cell: string): string {
	return oneLine(cell.slice(0, BANK_LIMITS.cell * 2), BANK_LIMITS.cell);
}

const CARD_LONG = /\b(?:\d[ -]?){12,18}\d\b/g;
const CARD_MASKED = /(?:[X*•]{2,}[ -]?){1,4}\d{2,4}\b/gi;
/** An Italian IBAN by its shape (27 characters, the CIN a letter), glued to other letters or written with spaces or dashes. */
const IBAN_IT = /IT[ -]?\d{2}[ -]?[A-Z](?:[ -]?\d){10}(?:[ -]?[A-Z0-9]){12}/gi;
const IBAN_COMPACT = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;
const IBAN_GROUPED = /\b[A-Z]{2}\d{2}(?:[ -][A-Z0-9]{4}){2,7}(?:[ -][A-Z0-9]{1,4})?\b/gi;

/**
 * A text with every IBAN-like string replaced by «IBAN …1234» (its last 4 characters) and every
 * card number, whole or already masked, by «[carta]». `ibanTail` and `own` (one of the company's
 * own IBANs) of the first IBAN; the full IBAN never leaves this function.
 */
export function maskSensitive(text: string, ownIbans: readonly string[] = []): { readonly text: string; readonly ibanTail?: string; readonly own?: true } {
	let tail: string | undefined;
	let own = false;
	const owned = new Set(ownIbans.map((i) => i.replace(/[\s-]+/g, "").toUpperCase()));
	const iban = (m: string) => {
		const compact = m.replace(/[\s-]+/g, "").toUpperCase();
		if (tail === undefined) {
			tail = compact.slice(-4);
			own = owned.has(compact);
		}
		return ` IBAN …${compact.slice(-4)} `;
	};
	const masked = text.replace(IBAN_IT, iban).replace(IBAN_GROUPED, iban).replace(IBAN_COMPACT, iban).replace(CARD_MASKED, "[carta]").replace(CARD_LONG, "[carta]").replace(/ {2,}/g, " ").trim();
	return { text: masked, ...(tail === undefined ? {} : { ibanTail: tail }), ...(own ? { own: true as const } : {}) };
}

/** The key two loads of the same movement share: the day, the cents, the masked description folded. Not the running balance: a file with it and one without are the same movements. */
export function movementHash(date: string, cents: bigint, description: string): string {
	const key = fold(description).replace(/[^a-z0-9]+/g, " ").trim();
	return createHash("sha256").update(`${date}|${cents}|${key}`).digest("hex").slice(0, 32);
}

/** The columns said, the company's IBANs, and how the person says the file writes dates and amounts when it was asked. */
type Options = { readonly columns?: ColumnsSaid; readonly ownIbans?: readonly string[]; readonly dayFirst?: boolean; readonly decimalComma?: boolean };

/** The movements of a statement file, or what to ask about. BankError when it is no statement. */
export function parseStatement(name: string, data: Uint8Array, o: Options = {}): Parsed | Ask {
	if (data.byteLength > BANK_LIMITS.importBytes) throw new BankError(`il file è troppo grande (più di ${BANK_LIMITS.importBytes / 1024 / 1024} MB): chiedi un estratto conto più corto, per esempio di un mese`);
	if (data[0] !== 0x50 && data.includes(0)) throw new BankError("il file non è un CSV, un Excel o un CAMT.053 che so leggere");
	const head = Buffer.from(data.subarray(0, 4096)).toString("utf8");
	const root = xmlRoot(head.replace(/^﻿/, ""));
	if (root !== undefined || /\.xml$/i.test(name)) return camt(data, o.ownIbans ?? []);
	let sheet: string[][];
	let format: "csv" | "xlsx" = "csv";
	let semicolon = false;
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
		const text = new TextDecoder("utf-8").decode(data);
		sheet = parseCsv(text).map((r) => r.slice(0, 60).map(cleanCell));
		semicolon = text.split(/\r?\n/, 40).some((l) => l.includes(";"));
	}
	return table(sheet, format, semicolon, o);
}

/** What to ask about: the row shown and the first two rows with something under it, masked and cut. */
function ask(rows: readonly (readonly string[])[], f: { header: readonly string[]; at: number; why: string; noHeader?: true }, need: AskNeed = "columns"): Ask {
	const shown = (r: readonly string[]) => r.slice(0, 30).map((c) => maskSensitive(c).text.slice(0, 40));
	const below = rows.slice(f.at + (f.noHeader === true ? 0 : 1)).filter((r) => r.some((c) => c.trim() !== ""));
	return { kind: "ask", header: shown(f.header), samples: below.slice(f.noHeader === true ? 1 : 0, f.noHeader === true ? 3 : 2).map(shown), noHeader: f.noHeader === true, why: f.why, need };
}

function table(rows: string[][], format: "csv" | "xlsx", semicolon: boolean, o: Options): Parsed | Ask {
	const found: Found = o.columns !== undefined && Object.keys(o.columns).length > 0 ? said(rows, o.columns) : detect(rows);
	if ("why" in found) return ask(rows, found);
	const { at } = found;
	let cols: Columns = found.cols;
	const body = rows.slice(at + 1);
	const whyAsk = (why: string, need: AskNeed = "columns") => ask(rows, { header: rows[at] ?? [], at, why }, need);
	const amountCells = [cols.amount, cols.debit, cols.credit].flatMap((c) => (c === undefined ? [] : body.map((r) => r[c] ?? "")));
	const dates = o.dayFirst === undefined ? dateOrder(body.map((r) => r[cols.date] ?? "")) : o.dayFirst ? "dmy" : "mdy";
	if (dates === "ask") return whyAsk("nella colonna della data alcune date sembrano giorno/mese e altre mese/giorno", "day_first");
	// Every date could be either way: an English header with nothing Italian in the amounts does not decide.
	if (dates === "open" && cols.dateEnglish === true && !amountCells.some(italianAmount)) return whyAsk("le date possono essere giorno/mese o mese/giorno e niente nel file lo dice", "day_first");
	const order = dates === "mdy" ? "mdy" : "dmy";
	const styles = new Map<number, "it" | "en">();
	for (const c of [cols.amount, cols.debit, cols.credit]) {
		if (c === undefined) continue;
		const s = o.decimalComma === undefined ? decimalStyle(body.map((r) => r[c] ?? ""), semicolon) : o.decimalComma ? "it" : "en";
		if (s === "ask") return whyAsk("non capisco se negli importi la virgola separa i decimali o le migliaia", "decimal_comma");
		styles.set(c, s);
	}
	if (cols.balance !== undefined) {
		// A running balance that does not read clearly is only left out: it is not needed for the movements.
		const s = o.decimalComma === undefined ? decimalStyle(body.map((r) => r[cols.balance as number] ?? ""), semicolon) : o.decimalComma ? "it" : "en";
		if (s === "ask") cols = { ...cols, balance: undefined };
		else styles.set(cols.balance, s);
	}
	const num = (r: readonly string[], c: number | undefined): bigint | undefined | null => {
		if (c === undefined) return undefined;
		const t = (r[c] ?? "").trim();
		if (t === "" || /^[-\u2013\u2014]$/.test(t)) return undefined;
		const n = tableNumber(t, styles.get(c) === "en");
		if (n === undefined || (n.unit !== undefined && n.unit !== "€") || !Number.isFinite(n.value) || Math.abs(n.value) > BANK_LIMITS.maxAmount) return null;
		return BigInt(Math.round(n.value * 100));
	};
	const out: ParsedRow[] = [];
	let skipped = 0;
	let badDates = 0;
	let bothSides = 0;
	let truncated = false;
	let closing: { cents: bigint; date: string } | undefined;
	for (const r of body) {
		if (r.every((c) => c.trim() === "")) continue;
		const day = isoOf(r[cols.date] ?? "", order);
		if (day === undefined) {
			const c = closingOf(r, order);
			if (c !== undefined) closing = c;
			else if ((r[cols.date] ?? "").trim() !== "" && [cols.amount, cols.debit, cols.credit].some((k) => typeof num(r, k) === "bigint") && !/\btotal/i.test(r.join(" "))) badDates++;
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
			if (typeof d === "bigint" && typeof c === "bigint" && d !== 0n && c !== 0n) {
				bothSides++;
				continue;
			}
			// A Dare is money out whatever its sign; an Avere as written: negative, it is money out too.
			cents = d === null || c === null ? null : d === undefined && c === undefined ? undefined : (c ?? 0n) - (d === undefined ? 0n : d < 0n ? -d : d);
		}
		const balance = num(r, cols.balance);
		if (cents === null || cents === undefined || cents === 0n || balance === null) {
			skipped++;
			continue;
		}
		const value = cols.valueDate === undefined ? undefined : isoOf(r[cols.valueDate] ?? "", order);
		out.push(row(day, value, cents, descriptionOf(cols.description.map((c) => r[c] ?? "")), balance, o.ownIbans ?? []));
	}
	if (out.length === 0) return whyAsk("sotto l'intestazione non trovo movimenti con una data e un importo che so leggere");
	if (closing === undefined && cols.balance !== undefined) closing = lastBalance(out);
	const shape = at >= 0 ? (rows[at] ?? []).map(norm).join("|") : `colonne ${JSON.stringify(cols)}`;
	const layout = `${format}:${createHash("sha256").update(shape).digest("hex").slice(0, 12)}`;
	return finish(format, out, closing, { truncated, skipped, badDates, bothSides, otherCurrency: 0, layout, ...(cols.assumed === undefined ? {} : { assumed: cols.assumed }) });
}

/** The description's columns joined, a part another one holds already left out («Descrizione» in «Descrizione completa»). */
function descriptionOf(parts: readonly string[]): string {
	const filled = parts.map((p) => p.trim()).filter((p) => p !== "");
	const key = (p: string) => fold(p).replace(/[^a-z0-9]+/g, " ").trim();
	return filled.filter((p, i) => !filled.some((q, j) => j !== i && key(q).includes(key(p)) && (key(q) !== key(p) || j < i))).join(" ");
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
		hash: movementHash(date, cents, description),
	};
}

type Counts = Pick<Parsed, "truncated" | "skipped" | "badDates" | "bothSides" | "otherCurrency" | "assumed" | "layout">;

function finish(format: Parsed["format"], rows: ParsedRow[], closing: { cents: bigint; date: string } | undefined, counts: Counts): Parsed {
	const days = rows.map((r) => r.date).sort();
	return { kind: "rows", format, rows, from: days[0] as string, to: days.at(-1) as string, ...(closing === undefined ? {} : { closing }), ...counts };
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
function closingOf(r: readonly string[], order: "dmy" | "mdy"): { cents: bigint; date: string } | undefined {
	const words = fold(r.join(" "));
	if (!CLOSING.test(words) || /\biniziale\b|\bopening\b/.test(words)) return undefined;
	let cents: bigint | undefined;
	let date: string | undefined;
	for (const c of r) {
		const t = c.trim();
		const d = isoOf(t, order) ?? isoOf(/(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/.exec(t)?.[1] ?? "", order);
		if (d !== undefined) date = d;
		const style = decimalStyle([t], false);
		const n = tableNumber(t, style === "en");
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

/** An amount written the Italian way: «1.234,56», «45,5». */
const italianAmount = (cell: string) => {
	const t = cell.replace(/[^\d.,]/g, "");
	return /\d\.\d{3},\d/.test(t) || /\d,\d{1,2}$/.test(t);
};

/**
 * How a column writes its amounts: the Italian way (1.234,56), the English (1,234.56), or not
 * clear. «-1,200» alone reads as English thousands when nothing in the column is Italian, except
 * in a file separated by «;» (an Italian export, where it may be 1,2 written with three decimals);
 * with Italian amounts beside it, or both ways in one column, it is asked.
 */
export function decimalStyle(cells: readonly string[], semicolon: boolean): "it" | "en" | "ask" {
	let it = 0;
	let en = 0;
	let commaThousands = 0;
	let dotThousands = 0;
	for (const c of cells) {
		const t = c.replace(/[^\d.,]/g, "");
		if (/\d\.\d{3},\d/.test(t) || /\d,\d{1,2}$/.test(t)) it++;
		else if (/\d,\d{3}\.\d/.test(t) || /\d\.\d{1,2}$/.test(t)) en++;
		else if (/^\d{1,3}(?:,\d{3})+$/.test(t)) commaThousands++;
		else if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) dotThousands++;
	}
	if (it > 0 && en > 0) return "ask";
	if (en > 0) return dotThousands > 0 ? "ask" : "en";
	if (it > 0) return commaThousands > 0 ? "ask" : "it";
	if (commaThousands > 0) return dotThousands > 0 || semicolon ? "ask" : "en";
	return "it";
}

const SLASHED = /^\s*(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})\b/;

/**
 * Day/month (Italian) when a value has its first part over 12, month/day (as English files write
 * it) when one has its second part over 12; both: not clear (ask); written as day/month or
 * month/day but none decides: open; none written that way (ISO dates): dmy.
 */
export function dateOrder(cells: readonly string[]): "dmy" | "mdy" | "ask" | "open" {
	let dmy = false;
	let mdy = false;
	let slashed = false;
	for (const c of cells) {
		const m = SLASHED.exec(c);
		if (m === null) continue;
		slashed = true;
		if (Number(m[1]) > 12) dmy = true;
		if (Number(m[3]) > 12) mdy = true;
	}
	return dmy && mdy ? "ask" : mdy ? "mdy" : dmy || !slashed ? "dmy" : "open";
}

function isoOf(text: string, order: "dmy" | "mdy" = "dmy"): string | undefined {
	const swapped = order === "mdy" ? text.replace(SLASHED, (_all, a: string, sep: string, b: string, y: string) => `${b}${sep}${a}${sep}${y}`) : text;
	const d = dayOf(swapped);
	return d === undefined ? undefined : new Date(d * 86_400_000).toISOString().slice(0, 10);
}

/** A CAMT.053 statement: its entries (Ntry) and the closing booked balance (CLBD), in euros only. */
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
	let otherCurrency = 0;
	let truncated = false;
	const euro = (el: XmlElement | undefined) => {
		const ccy = attribute(el, "Ccy");
		return ccy === undefined || ccy.trim().toUpperCase() === "EUR";
	};
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
			// A balance in another currency is never the euro account's balance.
			if (!euro(child(bal, "Amt"))) {
				otherCurrency++;
				continue;
			}
			const cents = amount(child(bal, "Amt"), child(bal, "CdtDbtInd")?.text.trim());
			const date = day(child(bal, "Dt"));
			if (cents !== undefined && date !== undefined && (closing === undefined || date >= closing.date)) closing = { cents, date };
		}
		for (const entry of children(stmt, "Ntry")) {
			if (out.length >= BANK_LIMITS.rows) {
				truncated = true;
				break;
			}
			if (!euro(child(entry, "Amt"))) {
				otherCurrency++;
				continue;
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
	if (out.length === 0) throw new BankError(otherCurrency > 0 ? "nel CAMT.053 ci sono solo movimenti in una valuta diversa dall'euro: non li leggo" : "nel CAMT.053 non trovo movimenti");
	return finish("camt", out, closing, { truncated, skipped, badDates: 0, bothSides: 0, otherCurrency, layout: "camt" });
}
