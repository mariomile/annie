/**
 * CSV files for Excel in Italy: «;» between cells, the decimal comma, CRLF lines, UTF-8 with a
 * BOM (without it Excel reads the accents as Latin-1). Text from people or files is made inert
 * for a spreadsheet: a cell starting with = + - @, a tab or a CR gets a ' in front, so it is never
 * run as a formula. Amounts this code writes itself (csvCents) are numbers, not text, and go as
 * they are, the minus sign included.
 */

/** A cell the sheet may read as a number: an amount written here, never text from outside. */
export type CsvNumber = { readonly number: string };

export type CsvCell = string | CsvNumber;

const FORMULA_START = /^[=+\-@\t\r]/;

/** Text made inert for a spreadsheet, then quoted when it holds «;», a quote or a line break. */
export function csvText(text: string): string {
	const safe = FORMULA_START.test(text) ? `'${text}` : text;
	return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Cents as Excel reads them in Italy: «-1234,50», no thousands separator. */
export function csvCents(cents: bigint): CsvNumber {
	const abs = cents < 0n ? -cents : cents;
	const digits = abs.toString().padStart(3, "0");
	return { number: `${cents < 0n ? "-" : ""}${digits.slice(0, -2)},${digits.slice(-2)}` };
}

export function csvLine(cells: readonly CsvCell[]): string {
	return cells.map((c) => (typeof c === "string" ? csvText(c) : c.number)).join(";");
}

/** The whole file: the BOM, the header and the rows, CRLF after each line. */
export function csvFile(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
	return `﻿${[header, ...rows].map((r) => `${csvLine(r)}\r\n`).join("")}`;
}
