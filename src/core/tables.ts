import { CalcError, compileExpression } from "./calc.ts";
import { documentKind, spreadsheetRows } from "./documents.ts";
import { cellNumber, columnName, parseCsv } from "./make-xlsx.ts";
import { inertCell, quotedCell } from "./csv.ts";

/**
 * Questions to a table (ADR 0031): a CSV, an Excel or an OpenDocument sheet read as rows, then
 * filtered, grouped by columns or periods, totalled, sorted and cut, exactly, so the model never
 * adds up a column in its head. Runs in the document worker: a big sheet costs one worker.
 * This file is loaded by the worker from source: erasable TypeScript only.
 */

export class TableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TableError";
	}
}

export const FILTER_OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains", "not_contains", "empty", "not_empty"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const AGGREGATE_OPS = ["count", "sum", "avg", "min", "max", "median", "distinct", "share"] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];
export const PERIODS = ["day", "week", "month", "quarter", "year"] as const;
export type Period = (typeof PERIODS)[number];

export type TableFilter = { readonly column: string; readonly op: FilterOp; readonly value?: string | number | readonly (string | number)[] };
export type TableAggregate = { readonly op: AggregateOp; readonly column?: string; readonly expression?: string; readonly as?: string };
export type TableSort = { readonly column: string; readonly desc?: boolean };
export type TableQuery = {
	/** A sheet by name or number; «*» joins the sheets that share the same header. */
	readonly sheet?: string;
	readonly filters?: readonly TableFilter[];
	readonly groupBy?: readonly string[];
	readonly period?: Period;
	readonly aggregates?: readonly TableAggregate[];
	readonly columns?: readonly string[];
	readonly sort?: readonly TableSort[];
	readonly limit?: number;
};

export type TableResult = {
	/** The sheet read, for a workbook. */
	readonly sheet?: string;
	/** Every sheet of the workbook, in order. */
	readonly sheets: readonly string[];
	/** Data rows in the sheet (header, title rows and total rows left out). */
	readonly dataRows: number;
	/** Rows left after the filters. */
	readonly matched: number;
	readonly mode: "describe" | "rows" | "groups" | "totals";
	readonly header: readonly string[];
	/** Columns of numbers, aligned right when shown. */
	readonly numeric: readonly boolean[];
	/** The rows shown, as people read them. */
	readonly rows: readonly (readonly string[])[];
	/** All the rows of the answer, before the limit. */
	readonly resultRows: number;
	/** All the rows of the answer as a CSV (; and the decimal comma), to save for a chart or a document. */
	readonly csv: string;
	/** The first rows of the table, with a description. */
	readonly preview?: { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] };
	/** What was read and how, in Italian. They quote the file (column names, values): shown inside the fence. */
	readonly notes: readonly string[];
};

export const TABLE_LIMITS = {
	maxBytes: 20 * 1024 * 1024,
	maxRows: 200_000,
	maxColumns: 200,
	maxFilters: 12,
	maxGroupBy: 3,
	maxAggregates: 8,
	maxColumnsShown: 12,
	maxGroups: 20_000,
	maxInValues: 50,
	defaultShown: 50,
	maxShown: 500,
	maxCell: 120,
} as const;

type Sheet = { name: string; hidden: boolean; rows: string[][] };
type Unit = "€" | "$" | "%";
type Kind = "numero" | "data" | "testo";
type Numbers = { values: (number | undefined)[]; unit?: Unit; cents: boolean };

/** The answer to a question about a table file. */
export function queryTable(name: string, data: Uint8Array, query: TableQuery = {}): TableResult {
	if (data.byteLength > TABLE_LIMITS.maxBytes) throw new TableError(`il file è troppo grande da analizzare (più di ${TABLE_LIMITS.maxBytes / 1024 / 1024} MB)`);
	const sheets = sheetsOf(name, data);
	const workbook = sheets.length > 1 || sheets[0]?.name !== "";
	const notes: string[] = [];
	let table: Table;
	let sheetName: string | undefined;
	if (query.sheet?.trim() === "*") {
		const joined = joinSheets(sheets, notes);
		table = new Table(joined.rows, 1);
		sheetName = joined.names.join(", ");
	} else {
		const sheet = pickSheet(sheets, query.sheet);
		table = new Table(sheet.rows);
		sheetName = sheet.name;
		const others = sheets.filter((s) => s !== sheet && s.rows.length > 0).map((s) => s.name);
		if (workbook && query.sheet === undefined && others.length > 0) notes.push(`Ci sono anche i fogli ${others.map((o) => `«${o}»`).join(", ")}: sheet per leggerne un altro, sheet «*» per unire quelli con le stesse colonne.`);
	}
	notes.unshift(...table.notes);
	const base = { ...(workbook ? { sheet: sheetName } : {}), sheets: sheets.map((s) => s.name), dataRows: table.rows.length };

	const nothingAsked =
		(query.filters ?? []).length === 0 &&
		(query.groupBy ?? []).length === 0 &&
		(query.aggregates ?? []).length === 0 &&
		(query.columns ?? []).length === 0 &&
		(query.sort ?? []).length === 0 &&
		query.limit === undefined;
	if (nothingAsked) return { ...base, ...table.describe(), matched: table.rows.length, notes };

	if ((query.filters ?? []).length > TABLE_LIMITS.maxFilters) throw new TableError(`al massimo ${TABLE_LIMITS.maxFilters} filtri`);
	if ((query.groupBy ?? []).length > TABLE_LIMITS.maxGroupBy) throw new TableError(`al massimo ${TABLE_LIMITS.maxGroupBy} colonne in group_by`);
	if ((query.aggregates ?? []).length > TABLE_LIMITS.maxAggregates) throw new TableError(`al massimo ${TABLE_LIMITS.maxAggregates} calcoli`);
	const limit = Math.min(TABLE_LIMITS.maxShown, Math.max(1, Math.floor(query.limit ?? TABLE_LIMITS.defaultShown)));

	let rows = table.rows.map((_, i) => i);
	for (const filter of query.filters ?? []) {
		const before = rows;
		rows = table.filter(rows, filter);
		// A filter that leaves nothing is said, with the values the column has: «0» would read as an answer.
		if (rows.length === 0 && before.length > 0) {
			notes.push(table.emptied(before, filter));
			break;
		}
	}
	const matched = rows.length;

	let answer: Answer;
	if ((query.groupBy ?? []).length > 0 || (query.aggregates ?? []).length > 0) {
		if ((query.columns ?? []).length > 0) notes.push("Con group_by o aggregates columns non serve: la tabella ha i gruppi e i calcoli.");
		answer = table.group(rows, query.groupBy ?? [], query.period, query.aggregates ?? [], notes);
	} else {
		if (query.period !== undefined) notes.push("period serve solo con group_by su una colonna di date.");
		answer = table.list(rows, query.columns ?? [], notes);
	}
	if ((query.sort ?? []).length > 0) sortCells(answer.cells, answer.header, query.sort ?? [], answer.ops);
	notes.push(...table.renamed());

	const shown = answer.cells.slice(0, limit);
	if (answer.cells.length > shown.length) notes.push(`Mostro ${shown.length} ${shown.length === 1 ? "riga" : "righe"} su ${answer.cells.length}: save le salva tutte in un CSV.`);
	const csv = [answer.header.map(safeCsv), ...answer.cells.map((r) => r.map((c) => c.csv))].map((r) => r.map(csvField).join(";")).join("\n");
	return {
		...base,
		matched,
		mode: answer.mode,
		header: answer.header,
		numeric: answer.numeric,
		rows: shown.map((r) => r.map((c) => cut(c.text))),
		resultRows: answer.cells.length,
		csv: `${csv}\n`,
		notes,
	};
}

/** A value of the answer: as people read it, as a CSV holds it, and as it sorts. */
type Cell = { text: string; csv: string; sort: number | string };
type Answer = { mode: "rows" | "groups" | "totals"; header: string[]; numeric: boolean[]; cells: Cell[][]; ops: (AggregateOp | undefined)[] };

/** The sheets of the file: a CSV is one sheet without a name. */
function sheetsOf(name: string, data: Uint8Array): Sheet[] {
	const sheets = spreadsheetRows(name, data, TABLE_LIMITS.maxRows + 20);
	if (sheets !== undefined) return sheets.map((s) => ({ name: s.name, hidden: s.hidden, rows: s.rows }));
	if (documentKind(name, data) !== undefined) throw new TableError(`${name} non è una tabella: leggo CSV, Excel (.xlsx) e fogli OpenDocument (.ods). Per una tabella dentro un PDF o un Word leggila con file_read`);
	if (!/\.(csv|tsv|txt)$/i.test(name)) throw new TableError(`${name} non è una tabella: leggo CSV, Excel (.xlsx) e fogli OpenDocument (.ods)`);
	if (data.includes(0)) throw new TableError(`${name} non è un file di testo`);
	return [{ name: "", hidden: false, rows: parseCsv(Buffer.from(data).toString("utf8")) }];
}

function pickSheet(sheets: Sheet[], wanted: string | undefined): Sheet {
	if (sheets.length === 0) throw new TableError("il file non ha fogli da leggere");
	if (wanted !== undefined && wanted.trim() !== "") {
		const key = normal(wanted);
		// «2» is the sheet called 2, else the second sheet; a piece of a name only after that.
		const index = /^\d+$/.test(wanted.trim()) ? Number(wanted.trim()) - 1 : -1;
		const found = sheets.find((s) => normal(s.name) === key) ?? sheets[index] ?? sheets.find((s) => normal(s.name).includes(key));
		if (found === undefined) throw new TableError(`non trovo il foglio «${wanted}»: i fogli sono ${sheets.map((s) => `«${s.name}»`).join(", ")}`);
		return found;
	}
	const filled = (s: Sheet) => s.rows.some((r) => r.some((c) => c.trim() !== ""));
	return sheets.find((s) => !s.hidden && filled(s)) ?? sheets.find(filled) ?? (sheets[0] as Sheet);
}

/** The visible sheets with the header of the first one, one after the other, with a column naming the sheet. */
function joinSheets(sheets: Sheet[], notes: string[]): { rows: string[][]; names: string[] } {
	const parts = sheets.filter((s) => !s.hidden).flatMap((s) => {
		const rows = s.rows.filter((r) => filledCells(r) > 0);
		if (rows.length === 0) return [];
		const { at, hasHeader } = findHeader(rows);
		return hasHeader ? [{ name: s.name, header: rows[at] as string[], rows: rows.slice(at + 1) }] : [];
	});
	const first = parts[0];
	if (first === undefined) throw new TableError("nessun foglio ha un'intestazione da unire");
	const key = (h: string[]) => h.map(normal).join("\u0000").replace(/\u0000+$/, "");
	const same = parts.filter((p) => key(p.header) === key(first.header));
	const left = parts.filter((p) => !same.includes(p)).map((p) => `«${p.name}»`);
	if (left.length > 0) notes.push(`Ho unito i fogli con le colonne di «${first.name}»; ${left.join(", ")} ${left.length === 1 ? "ha" : "hanno"} altre colonne e ${left.length === 1 ? "è rimasto" : "sono rimasti"} fuori.`);
	const rows = [["Foglio", ...first.header]];
	for (const p of same) {
		for (const r of p.rows) {
			if (rows.length > TABLE_LIMITS.maxRows + 1) throw new TableError(`i fogli insieme hanno più di ${italianCount(TABLE_LIMITS.maxRows)} righe: per tabelle così grandi serve il computer di Owni`);
			rows.push([p.name, ...r]);
		}
	}
	return { rows, names: same.map((p) => p.name) };
}

function filledCells(r: readonly string[]): number {
	let n = 0;
	for (const c of r) if (c.trim() !== "") n++;
	return n;
}

/** A cell that reads as data, not as a name: a number or a date. A year is a name after the first column (Mese;2024;2025). */
function looksLikeData(cell: string, column: number): boolean {
	const t = cell.trim();
	if (t === "") return false;
	if (dayOf(t) !== undefined) return true;
	if (tableNumber(t, false) === undefined) return false;
	return column === 0 || !/^(19|20)\d\d$/.test(t);
}

/**
 * The header: among the first 15 rows, the one with the most cells of names (not numbers or dates),
 * the first on a tie, so the title and the account details above a bank statement are skipped.
 * `hasHeader` is false when that row is itself data: the columns are then named by letter.
 */
function findHeader(rows: readonly string[][]): { at: number; hasHeader: boolean } {
	let at = 0;
	let best = -1;
	rows.slice(0, 15).forEach((r, i) => {
		let names = 0;
		r.forEach((c, col) => {
			if (c.trim() !== "" && !looksLikeData(c, col)) names++;
		});
		if (names > best) {
			best = names;
			at = i;
		}
	});
	const row = rows[at] ?? [];
	return { at, hasHeader: !row.some((c, col) => looksLikeData(c, col)) };
}

/** Totals and balances already in the table: they are not data, or every sum would count twice. */
const TOTAL = /^(totale|totali|tot|subtotale|sub-totale|somma|riporto|totale generale|saldo (iniziale|finale|contabile|disponibile|precedente|al))(?=$|[\s:.\-–])|^(total|totals|grand total)$/;

class Table {
	readonly header: string[];
	readonly rows: string[][];
	readonly notes: string[] = [];
	private readonly numbers = new Map<number, Numbers>();
	private readonly days = new Map<number, (number | undefined)[]>();
	private readonly kinds = new Map<number, Kind>();
	private readonly computed = new Map<string, Numbers & { title: string }>();
	private readonly guessed = new Map<string, string>();

	/** `labelFrom`: the first column that can hold a «Totale» (1 when the first one names the sheet). */
	constructor(all: string[][], labelFrom = 0) {
		let source = all.filter((r) => filledCells(r) > 0);
		if (source.length === 0) throw new TableError("il foglio è vuoto");
		if (source.length > TABLE_LIMITS.maxRows + 1) throw new TableError(`la tabella ha più di ${italianCount(TABLE_LIMITS.maxRows)} righe: per una tabella così grande serve il computer di Owni`);
		const { at, hasHeader } = findHeader(source);
		if (at > 0) this.notes.push(`Ho saltato ${at === 1 ? "la prima riga" : `le prime ${at} righe`}, sopra l'intestazione (un titolo o i dati del conto).`);
		source = source.slice(at);
		let width = 0;
		for (const r of source) width = Math.max(width, r.length);
		if (width > TABLE_LIMITS.maxColumns) {
			this.notes.push(`Leggo le prime ${TABLE_LIMITS.maxColumns} colonne su ${width}.`);
			width = TABLE_LIMITS.maxColumns;
		}
		const first = source[0] as string[];
		const used = new Map<string, number>();
		this.header = Array.from({ length: width }, (_, i) => {
			const raw = hasHeader ? (first[i] ?? "").trim().replace(/\s+/g, " ") : "";
			const base = raw === "" ? `Colonna ${columnName(i)}` : raw;
			const seen = (used.get(normal(base)) ?? 0) + 1;
			used.set(normal(base), seen);
			return seen === 1 ? base : `${base} (${seen})`;
		});
		const body = (hasHeader ? source.slice(1) : source).map((r) => (r.length > width ? r.slice(0, width) : r));
		const labels: string[] = [];
		const rows = body.filter((r) => {
			// A total is a label without a date in its row: a movement «Saldo fattura 12» of 3 October stays.
			if (r.some((c) => dayOf(c) !== undefined)) return true;
			const label = r.slice(labelFrom).find((c) => TOTAL.test(normal(c)));
			if (label !== undefined) labels.push(label.trim());
			return label === undefined;
		});
		if (labels.length > 0) this.notes.push(`Ho lasciato fuori ${labels.length === 1 ? "la riga" : `${labels.length} righe come`} «${cut(labels[0] as string, 40)}»: i totali e i saldi li calcolo io.`);
		// A last row without a label whose numbers are the sums of the rows above: a =SOMMA() at the bottom.
		const last = rows.at(-1);
		// Two rows and their sum is a short table; a row emptier than all the others above it is a total.
		const emptier = last !== undefined && rows.slice(0, -1).every((r) => filledCells(r) > filledCells(last));
		if (last !== undefined && (rows.length > 3 || (rows.length === 3 && emptier)) && (last[labelFrom] ?? "").trim() === "") {
			const above = rows.slice(0, -1);
			let sums = 0;
			const isSum = last.every((c, col) => {
				if (c.trim() === "") return true;
				const n = tableNumber(c, false)?.value;
				if (n === undefined) return false;
				let total = 0;
				for (const r of above) total += tableNumber(r[col] ?? "", false)?.value ?? 0;
				if (n !== 0) sums++;
				return Math.abs(total - n) <= Math.max(0.005, Math.abs(n) * 1e-9);
			});
			if (isSum && sums > 0) {
				rows.pop();
				this.notes.push("Ho lasciato fuori l'ultima riga: è la somma delle altre.");
			}
		}
		this.rows = rows;
		if (this.rows.length === 0) throw new TableError("la tabella ha solo l'intestazione, senza righe di dati");
	}

	cell(row: number, column: number): string {
		return (this.rows[row]?.[column] ?? "").trim();
	}

	/** A column by its name: exact, then its letter (B, colonna B), then the only one with a word starting so. */
	column(name: string): number {
		const key = normal(name).replace(/_/g, " ");
		const names = this.header.map(normal);
		const exact = names.indexOf(key);
		if (exact >= 0) return exact;
		const letter = /^(?:colonna\s+)?([a-z]{1,2})$/i.exec(name.trim())?.[1];
		if (letter !== undefined) {
			const index = letter.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
			if (index < this.header.length) return index;
		}
		const words = names.flatMap((n, i) => (key !== "" && ` ${n.replace(/[^a-z0-9]+/g, " ")}`.includes(` ${key.replace(/[^a-z0-9]+/g, " ").trim()}`) ? [i] : []));
		if (words.length === 1) {
			const index = words[0] as number;
			this.guessed.set(name.trim(), this.header[index] as string);
			return index;
		}
		const list = this.header.slice(0, 40).map((h) => `«${cut(h, 40)}»`).join(", ");
		const more = this.header.length > 40 ? ` e altre ${this.header.length - 40}` : "";
		const which = words.length > 1 ? `«${name}» è in più colonne (${words.map((i) => `«${cut(this.header[i] as string, 40)}»`).join(", ")}), scrivi il nome intero` : `non trovo la colonna «${name}»`;
		throw new TableError(`${which}: le colonne sono ${list}${more}`);
	}

	/** The columns found from a piece of their name, said in the answer so a wrong guess shows. */
	renamed(): string[] {
		if (this.guessed.size === 0) return [];
		return [`Colonne usate: ${[...this.guessed].map(([asked, found]) => `«${cut(asked, 40)}» è «${cut(found, 40)}»`).join(", ")}.`];
	}

	numbersOf(column: number): Numbers {
		const known = this.numbers.get(column);
		if (known !== undefined) return known;
		const made = readNumbers(this.rows.map((_, i) => this.cell(i, column)));
		this.numbers.set(column, made);
		return made;
	}

	daysOf(column: number): (number | undefined)[] {
		const known = this.days.get(column);
		if (known !== undefined) return known;
		const values = this.rows.map((_, i) => dayOf(this.cell(i, column)));
		this.days.set(column, values);
		return values;
	}

	/** What a column holds: numbers or dates when at least 80% of its filled cells are. */
	kind(column: number): Kind {
		const known = this.kinds.get(column);
		if (known !== undefined) return known;
		let filled = 0;
		let numbers = 0;
		let dates = 0;
		const n = this.numbersOf(column).values;
		const d = this.daysOf(column);
		this.rows.forEach((_, i) => {
			if (this.cell(i, column) === "") return;
			filled++;
			if (d[i] !== undefined) dates++;
			else if (n[i] !== undefined) numbers++;
		});
		const kind: Kind = filled === 0 ? "testo" : dates >= filled * 0.8 ? "data" : numbers >= filled * 0.8 ? "numero" : "testo";
		this.kinds.set(column, kind);
		return kind;
	}

	filter(rows: number[], filter: TableFilter): number[] {
		if (!FILTER_OPS.includes(filter.op)) throw new TableError(`il filtro «${String(filter.op)}» non esiste: usa ${FILTER_OPS.join(" ")}`);
		const column = this.column(filter.column);
		const op = filter.op;
		if (op === "empty") return rows.filter((i) => this.cell(i, column) === "");
		if (op === "not_empty") return rows.filter((i) => this.cell(i, column) !== "");
		if (op === "in" || op === "not_in") {
			const values = Array.isArray(filter.value) ? filter.value : String(filter.value ?? "").split("|");
			const wanted = values.map((v) => (typeof v === "number" ? v : String(v).trim())).filter((v) => v !== "");
			if (wanted.length === 0) throw new TableError(`il filtro su «${this.header[column]}» con ${op} vuole una lista di valori (value: ["a", "b"] oppure "a|b")`);
			if (wanted.length > TABLE_LIMITS.maxInValues) throw new TableError(`al massimo ${TABLE_LIMITS.maxInValues} valori in ${op}`);
			const inside = new Set<number>();
			for (const v of wanted) for (const i of this.filter(rows, { column: filter.column, op: "=", value: v })) inside.add(i);
			return rows.filter((i) => inside.has(i) === (op === "in"));
		}
		if (filter.value === undefined || Array.isArray(filter.value) || String(filter.value).trim() === "") throw new TableError(`il filtro su «${this.header[column]}» con ${op} vuole un valore (value)`);
		const raw = String(filter.value).trim();
		if (op === "contains" || op === "not_contains") {
			const key = normal(raw);
			return rows.filter((i) => normal(this.cell(i, column)).includes(key) === (op === "contains"));
		}
		const kind = this.kind(column);
		// Dates against a day, a month (2026-03) or a year (2026): «=» is inside, «<» before, «>» after.
		const range = kind === "data" ? rangeOf(raw) : undefined;
		if (range !== undefined) {
			const days = this.daysOf(column);
			return rows.filter((i) => {
				const d = days[i];
				if (d === undefined) return op === "!=";
				return compareRange(d, range, op);
			});
		}
		const wanted = typeof filter.value === "number" ? filter.value : tableNumber(raw, false)?.value;
		if (wanted !== undefined && kind !== "testo") {
			const values = this.numbersOf(column).values;
			return rows.filter((i) => {
				const v = values[i];
				if (v === undefined) return op === "!=";
				return compare(v - wanted, op, Math.abs(wanted) * 1e-9);
			});
		}
		const key = normal(raw);
		return rows.filter((i) => {
			const cell = normal(this.cell(i, column));
			if (op === "=" || op === "!=") return (cell === key) === (op === "=");
			if (cell === "") return false;
			return compare(TEXT.compare(cell, key), op, 0);
		});
	}

	/** Why a filter left no rows: the values the column has, or the dates it spans and how to write them. */
	emptied(rows: number[], filter: TableFilter): string {
		const column = this.column(filter.column);
		const title = this.header[column] as string;
		const asked = Array.isArray(filter.value) ? filter.value.join(" | ") : String(filter.value ?? "");
		const head = `Nessuna riga passa il filtro «${cut(title, 40)}» ${filter.op} ${cut(asked, 60)}`.trimEnd();
		if (this.kind(column) === "data") {
			const days = rows.map((i) => this.daysOf(column)[i]).filter((d): d is number => d !== undefined);
			if (days.length === 0) return `${head}.`;
			return `${head}: le date vanno dal ${isoDay(days.reduce((a, b) => (b < a ? b : a)))} al ${isoDay(days.reduce((a, b) => (b > a ? b : a)))}; un giorno si scrive 2026-03-15, un mese 2026-03, un anno 2026.`;
		}
		const seen = new Map<string, string>();
		for (const i of rows) {
			const text = this.cell(i, column);
			if (text !== "" && !seen.has(normal(text))) seen.set(normal(text), cut(text, 30));
			if (seen.size >= 10) break;
		}
		return `${head}. Alcuni valori della colonna: ${[...seen.values()].map((v) => `«${v}»`).join(", ")}${seen.size >= 10 ? "…" : ""} (contains trova un pezzo di testo).`;
	}

	/** The rows themselves, with the columns asked for (or the first ones). */
	list(rows: number[], columns: readonly string[], notes: string[]): Answer {
		let picked = columns.length > 0 ? columns.map((c) => this.column(c)) : this.header.map((_, i) => i);
		if (picked.length > TABLE_LIMITS.maxColumnsShown && columns.length === 0) {
			notes.push(`La tabella ha ${picked.length} colonne: mostro le prime ${TABLE_LIMITS.maxColumnsShown}; columns per sceglierle.`);
			picked = picked.slice(0, TABLE_LIMITS.maxColumnsShown);
		}
		const header = picked.map((c) => this.header[c] as string);
		const numeric = picked.map((c) => this.kind(c) === "numero");
		const cells = rows.map((i) =>
			picked.map((c) => {
				const text = this.cell(i, c);
				const kind = this.kind(c);
				const sort = kind === "numero" ? this.numbersOf(c).values[i] : kind === "data" ? this.daysOf(c)[i] : undefined;
				return { text, csv: safeCsv(text), sort: sort ?? text };
			}),
		);
		return { mode: "rows", header: uniqueNames(header), numeric, cells, ops: picked.map(() => undefined) };
	}

	/** Groups by columns (dates by period), with counts, sums, averages, minimums, maximums, medians, shares. */
	group(rows: number[], by: readonly string[], period: Period | undefined, aggregates: readonly TableAggregate[], notes: string[]): Answer {
		const keys = by.map((name) => this.column(name));
		const asked: readonly TableAggregate[] = aggregates.length > 0 ? aggregates : [{ op: "count" }];
		const plans = asked.map((a) => this.plan(a, rows));
		if (period !== undefined && !keys.some((k) => this.kind(k) === "data")) notes.push("period vale solo per una colonna di date in group_by: qui non l'ho usato.");
		const groups = new Map<string, { labels: Cell[]; rows: number[] }>();
		for (const i of rows) {
			const labels = keys.map((k) => this.groupLabel(i, k, period));
			const id = labels.map((l) => normal(String(l.sort))).join("\u0000");
			let group = groups.get(id);
			if (group === undefined) {
				if (groups.size >= TABLE_LIMITS.maxGroups) throw new TableError(`più di ${italianCount(TABLE_LIMITS.maxGroups)} gruppi: raggruppa per meno colonne o per un periodo più lungo`);
				group = { labels, rows: [] };
				groups.set(id, group);
			}
			group.rows.push(i);
		}
		// Without rows passing the filters, the totals are still a row: zero rows, count 0.
		if (keys.length === 0 && groups.size === 0) groups.set("", { labels: [], rows: [] });
		const skipped = new Map<string, number>();
		const cells = [...groups.values()].map((g) => [...g.labels, ...plans.map((p) => p.compute(g.rows, skipped))]);
		for (const [title, count] of skipped) {
			notes.push(`In «${cut(title, 60)}» ${count === 1 ? "un valore non è un numero e non è contato" : `${count} valori non sono numeri e non sono contati`}.`);
		}
		if (keys.length > 0) sortCells(cells, [], keys.map((_, i) => ({ column: String(i) })), [], true);
		const header = uniqueNames([...keys.map((k) => this.header[k] as string), ...plans.map((p) => p.name)]);
		const numeric = [...keys.map((k) => this.kind(k) === "numero" && period === undefined), ...plans.map((p) => p.numeric)];
		return { mode: keys.length > 0 ? "groups" : "totals", header, numeric, cells, ops: [...keys.map(() => undefined), ...asked.map((a) => a.op)] };
	}

	private groupLabel(row: number, column: number, period: Period | undefined): Cell {
		const text = this.cell(row, column);
		if (text === "") return { text: "(vuoto)", csv: "", sort: "" };
		const kind = this.kind(column);
		if (kind === "data") {
			const day = this.daysOf(column)[row];
			if (day !== undefined) {
				const label = periodLabel(day, period ?? "day");
				return { text: label, csv: label, sort: label };
			}
		}
		if (kind === "numero") {
			const n = this.numbersOf(column).values[row];
			if (n !== undefined) return { text, csv: safeCsv(text), sort: n };
		}
		return { text, csv: safeCsv(text), sort: text };
	}

	/**
	 * A computed column: an expression of other columns («Quantità * Prezzo», «[Avere] - [Dare]»),
	 * worked out per row with calculate's parser; a row where a column is not a number has no value.
	 */
	private expression(expression: string): Numbers & { title: string } {
		const known = this.computed.get(expression);
		if (known !== undefined) return known;
		const columns = new Map<string, number>();
		let placeholders = 0;
		const text = expression.replace(/\[([^\]]{1,200})\]/g, (_, name: string) => {
			const id = `colonna_${placeholders++}_`;
			columns.set(id, this.column(name));
			return id;
		});
		let compiled: ReturnType<typeof compileExpression>;
		try {
			compiled = compileExpression(text);
			for (const name of compiled.names) if (!columns.has(name)) columns.set(name, this.column(name));
			// Written wrong is said once, not as a column without values: a trial with every column at 1.
			try {
				compiled.run(new Map(compiled.names.map((n) => [n, 1])));
			} catch (error) {
				if (!(error instanceof CalcError) || error.message !== "divisione per zero") throw error;
			}
		} catch (error) {
			if (error instanceof CalcError) throw new TableError(`nell'espressione «${cut(expression, 60)}»: ${error.message}`);
			throw error;
		}
		const sources = [...columns].map(([name, column]) => ({ name, column, ...this.numbersOf(column) }));
		const values = this.rows.map((_, i) => {
			const vars = new Map<string, number>();
			for (const s of sources) {
				// An empty cell is zero, as in a spreadsheet (Avere - Dare on a row with only Dare); text is not a number.
				const v = this.cell(i, s.column) === "" ? 0 : s.values[i];
				if (v === undefined) return undefined;
				vars.set(s.name, v);
			}
			try {
				return compiled.run(vars);
			} catch (error) {
				if (error instanceof CalcError) return undefined;
				throw error;
			}
		});
		// Money in, money out (Quantità * Prezzo); percentages and mixed units are plain numbers.
		const units = new Set(sources.map((s) => s.unit).filter((u) => u !== undefined));
		const unit = units.size === 1 && !units.has("%") ? ([...units][0] as Unit) : undefined;
		const made = { values, ...(unit === undefined ? {} : { unit }), cents: unit !== undefined || sources.every((s) => s.cents), title: expression.trim() };
		this.computed.set(expression, made);
		return made;
	}

	private plan(aggregate: TableAggregate, all: number[]): { name: string; numeric: boolean; compute: (rows: number[], skipped: Map<string, number>) => Cell } {
		const op = aggregate.op;
		if (!AGGREGATE_OPS.includes(op)) throw new TableError(`il calcolo «${String(op)}» non esiste: usa ${AGGREGATE_OPS.join(" ")}`);
		const label = typeof aggregate.as === "string" && aggregate.as.trim() !== "" ? aggregate.as.trim() : undefined;
		const expression = typeof aggregate.expression === "string" && aggregate.expression.trim() !== "" ? aggregate.expression : undefined;
		const hasColumn = aggregate.column !== undefined && aggregate.column.trim() !== "";
		if (expression !== undefined && hasColumn) throw new TableError(`il calcolo ${op} vuole column oppure expression, non tutti e due`);
		if (op === "count" && !hasColumn && expression === undefined) {
			return { name: label ?? "Righe", numeric: true, compute: (rows) => countCell(rows.length) };
		}
		if (!hasColumn && expression === undefined) throw new TableError(`il calcolo ${op} vuole una colonna (column) o un'espressione (expression)`);
		const column = expression === undefined ? this.column(aggregate.column as string) : undefined;
		if (column !== undefined && (op === "count" || op === "distinct")) {
			const title = this.header[column] as string;
			if (op === "count") return { name: label ?? `Valori di ${title}`, numeric: true, compute: (rows) => countCell(rows.filter((i) => this.cell(i, column) !== "").length) };
			return { name: label ?? `${title} diversi`, numeric: true, compute: (rows) => countCell(new Set(rows.map((i) => normal(this.cell(i, column))).filter((v) => v !== "")).size) };
		}
		if (column !== undefined && (op === "min" || op === "max") && this.kind(column) === "data") {
			const title = this.header[column] as string;
			const days = this.daysOf(column);
			return {
				name: label ?? `${op === "min" ? "Prima" : "Ultima"} ${title}`,
				numeric: false,
				compute: (rows) => {
					let best: number | undefined;
					for (const i of rows) {
						const d = days[i];
						if (d !== undefined && (best === undefined || (op === "min" ? d < best : d > best))) best = d;
					}
					const text = best === undefined ? "" : isoDay(best);
					return { text, csv: text, sort: best ?? Number.NEGATIVE_INFINITY };
				},
			};
		}
		const source = column === undefined ? this.expression(expression as string) : { ...this.numbersOf(column), title: this.header[column] as string };
		const { values, unit, cents, title } = source;
		if (!values.some((v) => v !== undefined)) {
			throw new TableError(column === undefined ? `l'espressione «${cut(title, 60)}» non dà un numero in nessuna riga: le colonne che usa devono avere numeri` : `la colonna «${title}» non ha numeri: per contarne i valori usa count o distinct`);
		}
		const names: Record<string, string> = { sum: "Somma", avg: "Media", min: "Minimo", max: "Massimo", median: "Mediana", count: "Righe con", distinct: "Valori diversi di", share: "Quota" };
		const shown = column === undefined ? `(${title})` : title;
		// Share: each group's sum over the sum of every row that passed the filters.
		const whole = op === "share" ? kahan(all.flatMap((i) => (values[i] === undefined ? [] : [values[i] as number]))) : 0;
		return {
			name: label ?? `${names[op]} ${shown}`,
			numeric: true,
			compute: (rows, skipped) => {
				const found: number[] = [];
				let bad = 0;
				for (const i of rows) {
					const v = values[i];
					if (v !== undefined) found.push(v);
					else if (column === undefined || this.cell(i, column) !== "") bad++;
				}
				if (bad > 0) skipped.set(title, (skipped.get(title) ?? 0) + bad);
				if (op === "count") return countCell(found.length);
				if (op === "distinct") return countCell(new Set(found).size);
				if (found.length === 0) return op === "sum" ? numberCell(0, unit, cents) : { text: "", csv: "", sort: Number.NEGATIVE_INFINITY };
				let value: number;
				if (op === "share") {
					if (whole === 0) return { text: "", csv: "", sort: Number.NEGATIVE_INFINITY };
					return numberCell((kahan(found) / whole) * 100, "%", false);
				}
				if (op === "sum" || op === "avg") value = op === "sum" ? kahan(found) : kahan(found) / found.length;
				else if (op === "min") value = found.reduce((a, b) => (b < a ? b : a));
				else if (op === "max") value = found.reduce((a, b) => (b > a ? b : a));
				else {
					const sorted = found.sort((a, b) => a - b);
					const mid = Math.floor(sorted.length / 2);
					value = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
				}
				return numberCell(value, unit, cents);
			},
		};
	}

	/** Each column: what it holds, how many cells are filled and a summary; then the first rows. */
	describe(): Pick<TableResult, "mode" | "header" | "numeric" | "rows" | "resultRows" | "csv" | "preview"> {
		const rows = this.header.map((name, c) => {
			const kind = this.kind(c);
			let filled = 0;
			for (let i = 0; i < this.rows.length; i++) if (this.cell(i, c) !== "") filled++;
			let summary = "";
			if (kind === "numero") {
				const { values, unit, cents } = this.numbersOf(c);
				const found = values.filter((v): v is number => v !== undefined);
				if (found.length > 0) {
					const sum = kahan(found);
					const show = (v: number) => readable(v, unit, cents);
					summary = `somma ${show(sum)}; min ${show(found.reduce((a, b) => (b < a ? b : a)))}; max ${show(found.reduce((a, b) => (b > a ? b : a)))}; media ${show(sum / found.length)}`;
				}
			} else if (kind === "data") {
				const found = this.daysOf(c).filter((v): v is number => v !== undefined);
				if (found.length > 0) summary = `dal ${isoDay(found.reduce((a, b) => (b < a ? b : a)))} al ${isoDay(found.reduce((a, b) => (b > a ? b : a)))}`;
			} else {
				const counts = new Map<string, { text: string; n: number }>();
				for (let i = 0; i < this.rows.length; i++) {
					const text = this.cell(i, c);
					if (text === "") continue;
					const key = normal(text);
					const seen = counts.get(key);
					if (seen === undefined) counts.set(key, { text, n: 1 });
					else seen.n++;
				}
				const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 3);
				summary = `${counts.size} ${counts.size === 1 ? "valore" : "valori diversi"}${top.length > 0 && top[0] !== undefined && top[0].n > 1 ? `; più frequenti: ${top.map((t) => `${cut(t.text, 30)} (${t.n})`).join(", ")}` : ""}`;
			}
			return [cut(name), kind, String(filled), summary];
		});
		const shown = Math.min(this.header.length, TABLE_LIMITS.maxColumnsShown);
		const preview = { header: this.header.slice(0, shown).map((h) => cut(h)), rows: this.rows.slice(0, 5).map((r) => this.header.slice(0, shown).map((_, c) => cut((r[c] ?? "").trim()))) };
		const header = ["Colonna", "Tipo", "Celle piene", "Riepilogo"];
		const csv = [header, ...rows].map((r) => r.map((c) => csvField(safeCsv(c))).join(";")).join("\n");
		return { mode: "describe", header, numeric: [false, false, true, false], rows, resultRows: rows.length, csv: `${csv}\n`, preview };
	}
}

/**
 * The numbers of a column. The decimal separator is decided for the whole column: when its
 * unambiguous cells write decimals with a point (1.25, 1,234.50) and none with a comma, 0.500
 * is half and 1,234 is a thousand and more; otherwise the Italian way (1.500 is fifteen hundred).
 * `cents`: most numbers are written with two decimals, so the results are shown with two too.
 */
function readNumbers(cells: readonly string[]): Numbers {
	let dot = 0;
	let comma = 0;
	for (const cell of cells) {
		const digits = /\d[\d.,]*/.exec(cell)?.[0]?.replace(/[.,]$/, "");
		if (digits === undefined) continue;
		if (/^\d{1,3}(,\d{3})+\.\d+$/.test(digits) || /^\d+\.(\d{1,2}|\d{4,})$/.test(digits)) dot++;
		else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(digits) || /^\d+,(\d{1,2}|\d{4,})$/.test(digits)) comma++;
	}
	const international = dot > comma;
	const units = new Map<string, number>();
	let count = 0;
	let twoDecimals = 0;
	const values = cells.map((cell) => {
		const n = tableNumber(cell, international);
		if (n === undefined) return undefined;
		count++;
		if (/\d[.,]\d\d(?!\d)/.test(cell)) twoDecimals++;
		if (n.unit !== undefined) units.set(n.unit, (units.get(n.unit) ?? 0) + 1);
		return n.value;
	});
	// The column's unit when nearly every number carries it.
	const [unit, times] = [...units.entries()].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
	const withUnitToo = unit !== undefined && times >= count * 0.8;
	return { values, ...(withUnitToo ? { unit: unit as Unit } : {}), cents: (withUnitToo && unit !== "%") || (count > 0 && twoDecimals >= count * 0.8) };
}

/**
 * A number in a cell, the way exports write them: 1.234,56, € 30, 25%, +150,00, and negatives
 * as -5, 1.000,00- or (1.000,00). `international`: a point for decimals and commas for thousands.
 */
export function tableNumber(text: string, international: boolean): { value: number; unit?: Unit } | undefined {
	let t = text.trim();
	if (t === "" || t.length > 40) return undefined;
	let negative = false;
	const brackets = /^\((.+)\)$/.exec(t);
	if (brackets !== null) {
		t = (brackets[1] as string).trim();
		negative = true;
	} else if (/\d\s*-$/.test(t)) {
		t = t.slice(0, -1).trim();
		negative = true;
	}
	if (t.startsWith("+")) t = t.slice(1).trim();
	if (international) t = t.replace(/\d[\d.,]*/, (m) => m.replace(/,/g, "").replace(/\./g, ","));
	const n = cellNumber(t);
	if (n === undefined || (negative && n.value < 0)) return undefined;
	const unit = n.unit as Unit | undefined;
	return { value: negative ? -n.value : n.value, ...(unit === undefined ? {} : { unit }) };
}

const TEXT = new Intl.Collator("it", { sensitivity: "base", numeric: true });

function compare(difference: number, op: FilterOp, tolerance: number): boolean {
	const equal = Math.abs(difference) <= tolerance;
	if (op === "=") return equal;
	if (op === "!=") return !equal;
	if (op === ">") return difference > 0 && !equal;
	if (op === ">=") return difference > 0 || equal;
	if (op === "<") return difference < 0 && !equal;
	return difference < 0 || equal;
}

function compareRange(day: number, [from, to]: [number, number], op: FilterOp): boolean {
	if (op === "=") return day >= from && day <= to;
	if (op === "!=") return day < from || day > to;
	if (op === ">") return day > to;
	if (op === ">=") return day >= from;
	if (op === "<") return day < from;
	return day <= to;
}

/**
 * Answer rows in order: by the columns named (or by position, for the group keys), numbers as
 * numbers. A calculation can also be named by its op (sum) when only one is that op.
 */
function sortCells(cells: Cell[][], header: readonly string[], sort: readonly TableSort[], ops: readonly (AggregateOp | undefined)[], byIndex = false): void {
	const keys = sort.map((s) => {
		let index: number;
		if (byIndex) index = Number(s.column);
		else {
			const key = normal(s.column);
			const names = header.map(normal);
			index = names.indexOf(key);
			if (index < 0) {
				const byOp = ops.flatMap((op, i) => (op === key ? [i] : []));
				const near = names.flatMap((n, i) => (key !== "" && n.includes(key) ? [i] : []));
				const found = byOp.length === 1 ? byOp : near;
				if (found.length !== 1) throw new TableError(`non posso ordinare per «${s.column}»: le colonne della risposta sono ${header.map((h) => `«${cut(h, 40)}»`).join(", ")}`);
				index = found[0] as number;
			}
		}
		return { index, desc: s.desc === true };
	});
	cells.sort((a, b) => {
		for (const { index, desc } of keys) {
			const x = a[index]?.sort ?? "";
			const y = b[index]?.sort ?? "";
			// Empty values last, whichever the direction.
			const xe = x === "" || x === Number.NEGATIVE_INFINITY;
			const ye = y === "" || y === Number.NEGATIVE_INFINITY;
			if (xe !== ye) return xe ? 1 : -1;
			const order = typeof x === "number" && typeof y === "number" ? x - y : TEXT.compare(String(x), String(y));
			if (order !== 0) return desc ? -order : order;
		}
		return 0;
	});
}

/** Kahan: a long column of cents adds up to the cent. */
function kahan(values: readonly number[]): number {
	let sum = 0;
	let carry = 0;
	for (const v of values) {
		const y = v - carry;
		const t = sum + y;
		carry = t - sum - y;
		sum = t;
	}
	return sum;
}

function italianCount(n: number): string {
	return n.toLocaleString("it-IT", { useGrouping: true });
}

function countCell(n: number): Cell {
	return { text: italianCount(n), csv: String(n), sort: n };
}

function numberCell(value: number, unit: Unit | undefined, cents: boolean): Cell {
	const exact = Number(value.toPrecision(12));
	return { text: readable(exact, unit, cents), csv: withUnit(String(exact).replace(".", ","), unit), sort: exact };
}

/** A number as people read it in Italy, grouped from the thousands: 1.234,56, 1.234,50 €, $1.234,50, 25,5%. */
export function readable(value: number, unit?: Unit, cents = false): string {
	const money = cents || unit === "€" || unit === "$";
	const decimals = money ? 2 : Math.abs(value) >= 1 ? 2 : 4;
	const text = new Intl.NumberFormat("it-IT", { maximumFractionDigits: decimals, minimumFractionDigits: money ? 2 : 0, useGrouping: true }).format(Number(value.toPrecision(12)));
	return withUnit(text, unit);
}

function withUnit(text: string, unit: Unit | undefined): string {
	if (unit === "€") return `${text} €`;
	if (unit === "$") return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
	if (unit === "%") return `${text}%`;
	return text;
}

function uniqueNames(names: string[]): string[] {
	const used = new Map<string, number>();
	return names.map((name) => {
		const seen = (used.get(normal(name)) ?? 0) + 1;
		used.set(normal(name), seen);
		return seen === 1 ? name : `${name} (${seen})`;
	});
}

/** Text a spreadsheet would run as a formula gets a ' in front (csv.ts), but a number or a day the table holds («-5», «-1,5») stays a value. */
function safeCsv(text: string): string {
	return tableNumber(text, false) !== undefined || dayOf(text) !== undefined ? text : inertCell(text);
}

const csvField = quotedCell;

function cut(text: string, max: number = TABLE_LIMITS.maxCell): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Names compared as people mean them: no case, no accents, one space. */
function normal(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const DAY = 86_400_000;

/**
 * A date cell as days since 1970: 2026-10-17 (with a time too), 17/10/2026, 17-10-2026,
 * 17.10.2026, and with two digits for the year 17/10/26 (00-69 are 2000-2069).
 */
export function dayOf(text: string): number | undefined {
	const t = text.trim();
	if (t.length > 40) return undefined;
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
	const italian = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?: \d{1,2}:\d{2}(?::\d{2})?)?$/.exec(t);
	let parts: [number, number, number] | undefined;
	if (iso !== null) parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
	else if (italian !== null) {
		const year = Number(italian[4]);
		parts = [(italian[4] as string).length === 2 ? (year < 70 ? 2000 + year : 1900 + year) : year, Number(italian[3]), Number(italian[1])];
	}
	if (parts === undefined) return undefined;
	const [y, m, d] = parts;
	const when = Date.UTC(y, m - 1, d);
	const check = new Date(when);
	if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d || y < 1900 || y > 2200) return undefined;
	return Math.round(when / DAY);
}

/** A day, a month (2026-03, 03/2026) or a year (2026) as its first and last day. */
function rangeOf(text: string): [number, number] | undefined {
	const day = dayOf(text);
	if (day !== undefined) return [day, day];
	const iso = /^(\d{4})-(\d{1,2})$/.exec(text);
	const italian = /^(\d{1,2})\/(\d{4})$/.exec(text);
	const month = iso !== null ? [Number(iso[1]), Number(iso[2])] : italian !== null ? [Number(italian[2]), Number(italian[1])] : undefined;
	if (month !== undefined) {
		const [y, m] = month as [number, number];
		if (m < 1 || m > 12) return undefined;
		return [Math.round(Date.UTC(y, m - 1, 1) / DAY), Math.round(Date.UTC(y, m, 1) / DAY) - 1];
	}
	if (/^(19|20|21)\d\d$/.test(text)) {
		const y = Number(text);
		return [Math.round(Date.UTC(y, 0, 1) / DAY), Math.round(Date.UTC(y + 1, 0, 1) / DAY) - 1];
	}
	return undefined;
}

function isoDay(day: number): string {
	return new Date(day * DAY).toISOString().slice(0, 10);
}

/** The period a day falls in, written so that the labels sort in time: 2026-10-17, 2026-S42, 2026-10, 2026-T4, 2026. */
export function periodLabel(day: number, period: Period): string {
	const date = new Date(day * DAY);
	const y = date.getUTCFullYear();
	const m = date.getUTCMonth() + 1;
	if (period === "day") return isoDay(day);
	if (period === "month") return `${y}-${String(m).padStart(2, "0")}`;
	if (period === "quarter") return `${y}-T${Math.ceil(m / 3)}`;
	if (period === "year") return String(y);
	// ISO week: the week of the Thursday, Monday first.
	const weekday = (date.getUTCDay() + 6) % 7;
	const thursday = new Date((day - weekday + 3) * DAY);
	const year = thursday.getUTCFullYear();
	const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
	return `${year}-S${String(week).padStart(2, "0")}`;
}
