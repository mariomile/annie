import { coreProperties } from "./make-docx.ts";
import type { Block, Span } from "./markdown-blocks.ts";
import { plainText, xmlSafe } from "./markdown-blocks.ts";
import { evaluateFormula, FORMULA_BUDGET, normalizeFormula, type Value } from "./sheet-formulas.ts";
import { writeZip } from "./zip.ts";

export class SheetError extends Error {
	override readonly name = "SheetError";
}

/** `maxText`: Excel holds at most 32,767 characters in a cell. */
export const SHEET_LIMITS = { maxRows: 100_000, maxColumns: 200, maxSheets: 50, maxFormula: 8000, maxText: 32_000 } as const;

/** A row of a sheet: each cell as written in Markdown (or CSV), and whether it is a header row. */
export type SheetRow = { readonly cells: readonly (readonly Span[])[]; readonly header?: boolean };
/**
 * `table`: the first table, whose header row (`first`, from 0) stays still and has the filters;
 * `headers`: the rows (from 1) of every table's header, for formulas that count rows;
 * `csv`: the cells come from a file, so a formula that is not allowed becomes text instead of stopping the conversion.
 */
export type Sheet = {
	readonly name: string;
	readonly rows: readonly SheetRow[];
	readonly table?: { readonly first: number; readonly columns: number; readonly rows: number };
	readonly headers?: readonly number[];
	readonly csv?: boolean;
};

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * The sheets of a workbook from Markdown blocks. Each table goes in as rows with its header in
 * bold, other text as one line per row. The top level of headings starts the sheets and names
 * them (the next level when the top one is a single title at the start: then the title names
 * the file, and the sheet with any text before the first section); deeper headings are bold lines.
 */
export function sheetsOf(blocks: readonly Block[], fallbackName: string): Sheet[] {
	type Draft = { name: string; rows: SheetRow[]; table?: { first: number; columns: number; rows: number }; headers: number[]; intro?: boolean };
	const headings = blocks.filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading");
	const top = Math.min(...headings.map((h) => h.level));
	const title = headings.filter((h) => h.level === top).length === 1 && blocks[0] === headings[0] && headings.some((h) => h.level > top) ? headings[0] : undefined;
	const level = title === undefined ? top : Math.min(...headings.filter((h) => h !== title).map((h) => h.level));
	const sheets: Draft[] = [];
	let current: Draft | undefined;
	const ensure = (): Draft => {
		if (current === undefined) {
			// Text before the first section goes under the title, in a sheet named after it.
			current = title === undefined ? { name: fallbackName, rows: [], headers: [] } : { name: plainText(title.spans).trim(), rows: [], headers: [], intro: true };
			sheets.push(current);
		}
		return current;
	};
	const gap = (sheet: Draft): void => {
		if (sheet.rows.length > 0) sheet.rows.push({ cells: [] });
	};
	for (const block of blocks) {
		if (block === title) continue;
		if (block.type === "heading") {
			const name = plainText(block.spans).trim();
			if (block.level <= level && !(current?.intro === true && current.table === undefined && current.rows.length > 0)) {
				if (current !== undefined && current.rows.length === 0) current.name = name;
				else {
					current = { name, rows: [], headers: [] };
					sheets.push(current);
				}
			} else {
				const sheet = ensure();
				gap(sheet);
				sheet.rows.push({ cells: [block.spans.map((s) => ({ ...s, bold: true }))] });
			}
			continue;
		}
		const sheet = ensure();
		if (block.type === "table") {
			gap(sheet);
			if (sheet.table === undefined) sheet.table = { first: sheet.rows.length, columns: block.header.length, rows: block.rows.length + 1 };
			sheet.headers.push(sheet.rows.length + 1);
			sheet.rows.push({ cells: block.header, header: true }, ...block.rows.map((cells) => ({ cells })));
		} else if (block.type === "paragraph" || block.type === "quote") {
			gap(sheet);
			for (const line of splitLines(block.spans)) sheet.rows.push({ cells: [line] });
		} else if (block.type === "list") {
			gap(sheet);
			const counts = [block.start - 1, 0, 0];
			for (const item of block.items) {
				for (let l = item.level + 1; l < 3; l++) counts[l] = 0;
				counts[item.level] = (counts[item.level] as number) + 1;
				const mark = item.ordered ? `${counts[item.level]}. ` : "• ";
				sheet.rows.push({ cells: [[{ text: `${"   ".repeat(item.level)}${mark}` }, ...item.spans]] });
			}
		} else if (block.type === "code") {
			gap(sheet);
			for (const line of block.text.split("\n")) sheet.rows.push({ cells: [[{ text: `'${line}` }]] });
		}
	}
	return sheets.filter((s) => s.rows.length > 0);
}

/** Spans split at their line breaks. */
function splitLines(spans: readonly Span[]): Span[][] {
	const lines: Span[][] = [[]];
	for (const span of spans) {
		span.text.split("\n").forEach((part, i) => {
			if (i > 0) lines.push([]);
			if (part !== "") (lines[lines.length - 1] as Span[]).push({ ...span, text: part });
		});
	}
	return lines.filter((l) => l.length > 0);
}

/** One sheet from CSV text: the first row as the header. */
export function sheetOfCsv(text: string, name: string): Sheet {
	const rows = parseCsv(text);
	if (rows.length === 0) throw new SheetError("il CSV è vuoto");
	const columns = Math.max(...rows.map((r) => r.length));
	return { name, rows: rows.map((r, i) => ({ cells: r.map((c) => [{ text: c }]), ...(i === 0 ? { header: true } : {}) })), table: { first: 0, columns, rows: rows.length }, headers: [1], csv: true };
}

/**
 * The separator of a CSV: the one found the same number of times on most of the first lines, so a
 * title line above the table or decimal commas in the numbers do not mislead. Ties go to «;», then tab.
 */
function csvSeparator(text: string): string {
	const lines = [];
	for (let from = 0; lines.length < 20 && from < text.length; ) {
		const end = text.indexOf("\n", from);
		const line = text.slice(from, end === -1 ? text.length : end);
		if (line.trim() !== "") lines.push(line.replace(/"[^"]*"/g, ""));
		from = end === -1 ? text.length : end + 1;
	}
	let best = ",";
	let bestScore = 0;
	for (const c of [";", "\t", ","]) {
		const counts = new Map<number, number>();
		for (const line of lines) {
			const n = line.split(c).length - 1;
			if (n > 0) counts.set(n, (counts.get(n) ?? 0) + 1);
		}
		const score = Math.max(0, ...counts.values());
		if (score > bestScore) {
			best = c;
			bestScore = score;
		}
	}
	return best;
}

/** CSV with commas, semicolons (as Italian Excel writes it) or tabs, and quotes. */
export function parseCsv(text: string): string[][] {
	const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	const separator = csvSeparator(clean);
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < clean.length; i++) {
		const c = clean[i] as string;
		if (quoted) {
			if (c === '"' && clean[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === separator) {
			row.push(cell);
			cell = "";
		} else if (c === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

type Cell =
	| { readonly kind: "empty" }
	| { readonly kind: "text"; readonly text: string; readonly bold: boolean }
	| { readonly kind: "number"; readonly value: number; readonly style: number; readonly bold?: boolean }
	| { readonly kind: "formula"; readonly formula: string; readonly bold?: boolean };

/** Styles (cellXfs) in STYLES, by index. */
const STYLE = { plain: 0, bold: 1, header: 2, decimal: 3, thousands: 4, percent: 5, percentDecimal: 6, date: 7, euro: 8, dollar: 9, wrap: 10 } as const;

/** The same number format in bold: 3 to 9 have their bold twin 8 places on. */
function bolder(style: number): number {
	return style === STYLE.plain ? STYLE.bold : style >= STYLE.decimal && style <= STYLE.dollar ? style + 8 : style;
}

/**
 * The functions a formula may use: calculation, statistics, text, dates, logic and lookups in the
 * workbook. Anything else is not written, because a cell's text can come from a web page or a
 * mail, and the file is opened in someone's Excel: no function that calls the web, a cloud service
 * (COPILOT, TRANSLATE, STOCKHISTORY), another file or program (INDIRECT, CALL, DDE), and no
 * references to other workbooks (`[`), programs (`|`) or `@`.
 */
const ALLOWED = new Set(
	(
		"SUM SUMIF SUMIFS SUMPRODUCT PRODUCT AVERAGE AVERAGEIF AVERAGEIFS MIN MAX MINIFS MAXIFS MEDIAN MODE STDEV VAR LARGE SMALL RANK COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS " +
		"ROUND ROUNDUP ROUNDDOWN TRUNC INT ABS SQRT POWER MOD CEILING FLOOR SIGN PI EXP LN LOG LOG10 " +
		"IF IFS IFERROR IFNA AND OR NOT XOR TRUE FALSE CHOOSE VLOOKUP HLOOKUP XLOOKUP INDEX MATCH XMATCH " +
		"TODAY NOW DATE YEAR MONTH DAY WEEKDAY WEEKNUM EDATE EOMONTH DATEDIF NETWORKDAYS WORKDAY DAYS HOUR MINUTE SECOND TIME " +
		"CONCATENATE CONCAT TEXTJOIN UPPER LOWER PROPER LEFT RIGHT MID LEN TRIM SUBSTITUTE REPLACE FIND SEARCH TEXT VALUE REPT " +
		"ISBLANK ISNUMBER ISTEXT ISERROR ISNA PMT FV PV NPV IRR RATE NPER"
	).split(" "),
);

/** Functions newer than Excel 2010, stored with the prefix Excel expects (without it they show #NAME?). */
const NEWER = new Set(["IFS", "IFNA", "XOR", "CONCAT", "TEXTJOIN", "XLOOKUP", "XMATCH", "MINIFS", "MAXIFS", "DAYS"]);

/** The formula as stored, or why it is not written. */
function checkedFormula(formula: string): { formula: string } | { refused: string } {
	const stored = normalizeFormula(formula);
	const outside = stored.replace(/"(?:[^"]|"")*"/g, '""');
	if (/[[|@]/.test(outside)) return { refused: "rimanda ad altri file o programmi" };
	for (const m of outside.matchAll(/([A-Za-z_][A-Za-z0-9._]*)\s*\(/g)) {
		const name = (m[1] as string).toUpperCase();
		if (!ALLOWED.has(name)) return { refused: `usa ${name}, una funzione che non scrivo (scrivo quelle di calcolo, testo, date, logica e ricerca nel foglio)` };
	}
	return { formula: outsideOf(stored, (part) => part.replace(/([A-Za-z][A-Za-z0-9.]*)(\s*\()/g, (all, name: string, open: string) => (NEWER.has(name.toUpperCase()) ? `_xlfn.${name.toUpperCase()}${open}` : all))) };
}

function outsideOf(formula: string, change: (part: string) => string): string {
	return formula
		.split(/("(?:[^"]|"")*")/)
		.map((part, i) => (i % 2 === 1 ? part : change(part)))
		.join("");
}

/** How a cell's text goes into Excel: a number (Italian or international), a date, a percentage, an amount, a formula or text. */
export function cellOf(spans: readonly Span[], fromFile = false): Cell {
	const raw = plainText(spans);
	const text = raw.trim();
	if (text === "") return { kind: "empty" };
	const bold = spans.length > 0 && spans.every((s) => s.bold || s.text.trim() === "");
	if (text.startsWith("'")) return { kind: "text", text: text.slice(1), bold };
	// A line of = (an underline) is text.
	if (text.startsWith("=") && !/^=+$/.test(text)) {
		const formula = text.slice(1);
		if (formula.length > SHEET_LIMITS.maxFormula) throw new SheetError(`una formula è più lunga di ${SHEET_LIMITS.maxFormula} caratteri`);
		const checked = checkedFormula(formula);
		if ("formula" in checked) return { kind: "formula", formula: checked.formula, bold };
		if (fromFile) return { kind: "text", text, bold };
		throw new SheetError(`la formula =${formula.slice(0, 60)} ${checked.refused}. Se è testo, comincia la cella con un apostrofo`);
	}
	const number = numberOf(text);
	if (number !== undefined) return { kind: "number", ...number, ...(bold ? { bold } : {}) };
	return { kind: "text", text: raw.trim(), bold };
}

/** A number written in a cell, for a chart (ADR 0030): its value and the unit it was written with; dates are not numbers here. */
export function cellNumber(text: string): { value: number; unit?: "€" | "$" | "%" } | undefined {
	const n = numberOf(text.trim());
	if (n === undefined || n.style === STYLE.date) return undefined;
	if (n.style === STYLE.percent || n.style === STYLE.percentDecimal) return { value: Number((n.value * 100).toPrecision(12)), unit: "%" };
	if (n.style === STYLE.euro) return { value: n.value, unit: "€" };
	if (n.style === STYLE.dollar) return { value: n.value, unit: "$" };
	return { value: n.value };
}

function numberOf(text: string): { value: number; style: number } | undefined {
	// Codes with leading zeros (a CAP, an article code) and long digit strings stay text.
	const date = dateOf(text);
	if (date !== undefined) return { value: date, style: STYLE.date };
	let t = text.replace(/[\u00a0\u202f]/g, " ");
	// A minus before the currency sign: -€ 2,00.
	const negative = /^-\s*(€|EUR|\$)/i.test(t);
	if (negative) t = t.replace(/^-\s*/, "");
	let style: number = STYLE.plain;
	const money = /^(€|EUR)\s*|\s*(€|EUR)$/i;
	const dollars = /^\$\s*|\s*\$$/;
	if (money.test(t)) {
		t = t.replace(money, "");
		style = STYLE.euro;
	} else if (dollars.test(t)) {
		t = t.replace(dollars, "");
		style = STYLE.dollar;
	}
	let percent = false;
	if (t.endsWith("%")) {
		t = t.slice(0, -1).trim();
		percent = true;
	}
	t = t.replace(/^-\s+/, "-");
	if (negative) t = t.startsWith("-") ? "" : `-${t}`;
	let value: number;
	let grouped = false;
	let decimals = false;
	if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) || /^-?\d+,\d+$/.test(t)) {
		// Italian: 1.234,56 or 12,5
		grouped = t.includes(".");
		decimals = t.includes(",");
		value = Number(t.replace(/\./g, "").replace(",", "."));
	} else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
		// International with grouping: 1,234.56
		grouped = true;
		decimals = t.includes(".");
		value = Number(t.replace(/,/g, ""));
	} else if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) {
		decimals = t.includes(".");
		value = Number(t);
	} else return undefined;
	const digits = t.replace(/\D/g, "");
	if (/^-?0\d/.test(t) || digits.length > 15 || !Number.isFinite(value)) return undefined;
	if (percent) return { value: value / 100, style: decimals ? STYLE.percentDecimal : STYLE.percent };
	if (style !== STYLE.plain) return { value, style };
	return { value, style: decimals && grouped ? STYLE.decimal : grouped ? STYLE.thousands : STYLE.plain };
}

/** 2026-10-17 or 17/10/2026 as an Excel date (days since 30 December 1899). */
function dateOf(text: string): number | undefined {
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	const italian = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
	const parts = iso !== null ? [iso[1], iso[2], iso[3]] : italian !== null ? [italian[3], italian[2], italian[1]] : undefined;
	if (parts === undefined) return undefined;
	const [y, m, d] = parts.map(Number) as [number, number, number];
	const when = Date.UTC(y, m - 1, d);
	const check = new Date(when);
	if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d || y < 1900) return undefined;
	return Math.round((when - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** Column letters: 0 is A, 26 is AA. */
export function columnName(index: number): string {
	let n = index + 1;
	let name = "";
	while (n > 0) {
		const r = (n - 1) % 26;
		name = String.fromCharCode(65 + r) + name;
		n = Math.floor((n - 1) / 26);
	}
	return name;
}

/** A sheet name Excel accepts: at most 31 characters (whole ones), none of []:*?/\\ or what XML cannot hold, unique in the workbook. */
function sheetNames(sheets: readonly Sheet[]): string[] {
	const used = new Set<string>();
	// At most `max` UTF-16 units, as Excel counts, never half a character.
	const cut = (name: string, max: number) => {
		let out = "";
		for (const char of name) {
			if (out.length + char.length > max) break;
			out += char;
		}
		return out;
	};
	const clean = (name: string) => cut(name.replace(/[[\]:*?/\\\u0000-\u001f\ufffe\uffff]|[\ud800-\udfff]/gu, " ").replace(/^'+|'+$/g, "").replace(/\s+/g, " ").trim(), 31).trim();
	return sheets.map((sheet, i) => {
		let base = clean(sheet.name) || `Foglio${i + 1}`;
		if (base.toLowerCase() === "history") base = "History 1";
		let name = base;
		for (let n = 2; used.has(name.toLowerCase()); n++) name = `${cut(base, 31 - String(n).length - 1)} ${n}`;
		used.add(name.toLowerCase());
		return name;
	});
}

/**
 * An Excel workbook (.xlsx) (ADR 0029). Formulas are recalculated when the file is opened; the
 * simple ones also carry their value, for previews that do not calculate. `notes`: what Owni
 * should say (cells cut short, tables that do not start at row 1 in a sheet with formulas).
 */
export function makeXlsx(sheets: readonly Sheet[], options: { readonly title?: string; readonly now: Date }): { data: Buffer; notes: string[] } {
	if (sheets.length === 0) throw new SheetError("non c'è niente da mettere nel foglio: servono righe o una tabella");
	if (sheets.length > SHEET_LIMITS.maxSheets) throw new SheetError(`al massimo ${SHEET_LIMITS.maxSheets} fogli`);
	const total = sheets.reduce((n, s) => n + s.rows.length, 0);
	if (total > SHEET_LIMITS.maxRows) throw new SheetError(`al massimo ${SHEET_LIMITS.maxRows} righe in tutto`);
	const names = sheetNames(sheets);
	const notes: string[] = [];
	let cut = 0;
	const parts = sheets.map((sheet, i) => {
		const part = worksheet(sheet);
		cut += part.cut;
		const headers = sheet.headers ?? [];
		if (part.formulas && headers.some((h, k) => h !== k + 1 || k > 0) && headers.length > 0) {
			const rows = headers.length === 1 ? `alla riga ${headers[0]}` : `alle righe ${headers.slice(0, -1).join(", ")} e ${headers[headers.length - 1]}`;
			notes.push(`Nel foglio «${names[i]}» ${headers.length === 1 ? "la tabella ha l'intestazione" : "le tabelle hanno l'intestazione"} ${rows} (i dati dalla riga dopo): controlla che le formule contino le righe così.`);
		}
		return part.xml;
	});
	if (cut > 0) notes.push(`${cut === 1 ? "Una cella aveva" : `${cut} celle avevano`} più di ${SHEET_LIMITS.maxText} caratteri, più di quanti Excel ne tiene: l'ho accorciata.`);
	const filters = sheets
		.map((sheet, i) =>
			sheet.table === undefined || sheet.table.rows < 2
				? ""
				: `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlSafe((names[i] as string).replace(/'/g, "''"))}'!$A$${sheet.table.first + 1}:$${columnName(sheet.table.columns - 1)}$${sheet.table.first + sheet.table.rows}</definedName>`,
		)
		.join("");
	const workbook =
		`${XML}<workbook xmlns="${MAIN}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>` +
		names.map((name, i) => `<sheet name="${xmlSafe(name)}" sheetId="${i + 1}" r:id="rIdSheet${i + 1}"/>`).join("") +
		`</sheets>${filters === "" ? "" : `<definedNames>${filters}</definedNames>`}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
	const types =
		`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
		'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
		sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
		"</Types>";
	const data = writeZip([
		{ name: "[Content_Types].xml", data: types },
		{
			name: "_rels/.rels",
			data: `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
		},
		{ name: "docProps/core.xml", data: coreProperties(options.title, options.now) },
		{ name: "xl/workbook.xml", data: workbook },
		{
			name: "xl/_rels/workbook.xml.rels",
			data: `${XML}<Relationships xmlns="${REL}">${sheets.map((_, i) => `<Relationship Id="rIdSheet${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
		},
		{ name: "xl/styles.xml", data: STYLES },
		...parts.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
	]);
	return { data, notes };
}

function worksheet(sheet: Sheet): { xml: string; formulas: boolean; cut: number } {
	let cut = 0;
	const grid: Cell[][] = sheet.rows.map((row) => {
		if (row.cells.length > SHEET_LIMITS.maxColumns) throw new SheetError(`al massimo ${SHEET_LIMITS.maxColumns} colonne`);
		return row.cells.map((spans) => {
			const cell = cellOf(spans, sheet.csv === true);
			if (cell.kind !== "text" || cell.text.length <= SHEET_LIMITS.maxText) return cell;
			cut++;
			return { ...cell, text: `${[...cell.text].slice(0, SHEET_LIMITS.maxText).join("")}…` };
		});
	});
	// A formula takes the number format most used in its column (€, percentages), unless the column has none.
	const columnStyle: number[] = [];
	const tally = new Map<number, Map<number, number>>();
	grid.forEach((row) =>
		row.forEach((cell, c) => {
			if (cell.kind !== "number" || cell.style === STYLE.plain) return;
			const counts = tally.get(c) ?? new Map<number, number>();
			counts.set(cell.style, (counts.get(cell.style) ?? 0) + 1);
			tally.set(c, counts);
		}),
	);
	for (const [c, counts] of tally) columnStyle[c] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? STYLE.plain;
	// The values of the formulas, each worked out once; a loop or anything unknown leaves it to Excel.
	const values = new Map<string, Value | undefined>();
	const budget = { left: FORMULA_BUDGET };
	const valueAt = (column: number, row: number, depth: number): Value | undefined => {
		const cell = grid[row]?.[column];
		if (cell === undefined || cell.kind === "empty") return null;
		if (cell.kind === "number") return cell.value;
		if (cell.kind === "text") return cell.text;
		const key = `${column}:${row}`;
		if (values.has(key)) return values.get(key);
		if (depth > 200) return undefined;
		values.set(key, undefined); // while working it out: a loop finds it unknown
		const value = evaluateFormula(cell.formula, (c, r) => valueAt(c, r, depth + 1), budget);
		values.set(key, value);
		return value;
	};
	const widths: number[] = [];
	const rows: string[] = [];
	let formulas = false;
	grid.forEach((row, r) => {
		const cells: string[] = [];
		const header = sheet.rows[r]?.header === true;
		row.forEach((cell, c) => {
			const ref = `${columnName(c)}${r + 1}`;
			const length = cell.kind === "text" ? Math.max(...cell.text.split("\n").map((l) => l.length)) : cell.kind === "empty" ? 0 : 12;
			// A lone line of text (a title, a note) does not widen its column.
			if (row.length > 1 || header) widths[c] = Math.max(widths[c] ?? 0, Math.min(60, length + 2));
			const attr = (style: number) => (style === STYLE.plain ? "" : ` s="${style}"`);
			if (cell.kind === "empty") return;
			if (cell.kind === "number") cells.push(`<c r="${ref}"${attr(cell.bold ? bolder(cell.style) : cell.style)}><v>${cell.value}</v></c>`);
			else if (cell.kind === "formula") {
				formulas = true;
				const value = valueAt(c, r, 0);
				const base = columnStyle[c] ?? STYLE.plain;
				const style = typeof value === "number" || value === undefined ? (cell.bold ? bolder(base) : base) : cell.bold ? STYLE.bold : STYLE.plain;
				const cached =
					typeof value === "number"
						? { type: "", v: `<v>${value}</v>` }
						: typeof value === "boolean"
							? { type: ' t="b"', v: `<v>${value ? 1 : 0}</v>` }
							: typeof value === "string"
								? { type: ' t="str"', v: `<v>${xmlSafe(value)}</v>` }
								: { type: "", v: "" };
				cells.push(`<c r="${ref}"${attr(style)}${cached.type}><f>${xmlSafe(cell.formula)}</f>${cached.v}</c>`);
			} else {
				const style = header ? STYLE.header : cell.bold ? STYLE.bold : cell.text.includes("\n") ? STYLE.wrap : STYLE.plain;
				cells.push(`<c r="${ref}" t="inlineStr"${attr(style)}><is><t xml:space="preserve">${xmlSafe(cell.text)}</t></is></c>`);
			}
		});
		if (cells.length > 0) rows.push(`<row r="${r + 1}">${cells.join("")}</row>`);
	});
	const cols = widths
		.map((w, i) => (w === undefined ? "" : `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, w)}" customWidth="1"/>`))
		.filter((c) => c !== "")
		.join("");
	const table = sheet.table;
	const below = table === undefined ? 0 : table.first + 1;
	const view =
		table === undefined
			? '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
			: `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${below}" topLeftCell="A${below + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>`;
	const filter = table === undefined || table.rows < 2 ? "" : `<autoFilter ref="A${table.first + 1}:${columnName(table.columns - 1)}${table.first + table.rows}"/>`;
	return {
		xml: `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${R}">${view}<sheetFormatPr defaultRowHeight="15"/>${cols === "" ? "" : `<cols>${cols}</cols>`}<sheetData>${rows.join("")}</sheetData>${filter}</worksheet>`,
		formulas,
		cut,
	};
}

const STYLES =
	`${XML}<styleSheet xmlns="${MAIN}">` +
	'<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="[$€-410]\\ #,##0.00"/><numFmt numFmtId="166" formatCode="[$$-409]#,##0.00"/></numFmts>' +
	'<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
	'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>' +
	'<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="18">' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
	'<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
	'<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
	[4, 3, 9, 10, 164, 165, 166].map((format) => `<xf numFmtId="${format}" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`).join("") +
	"</cellXfs>" +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
	"</styleSheet>";
