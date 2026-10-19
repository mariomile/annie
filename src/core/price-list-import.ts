/**
 * A price list read from a file of the workspace (CSV, Excel .xlsx or .ods), pure: the header row
 * found by the words of its cells (nome, prezzo, unità, IVA, codice…), each row read into a voce
 * to add, or left out with its reason. Nothing in the file is trusted: at most
 * PRICE_LIST_LIMITS.importRows rows and the voce's limits a cell are read, control and format
 * characters go, a number that reads two ways («1.250») is not guessed, and every cell goes back
 * to the person only inside the listino's fence (the caller's). The plan against the listino
 * (planImport) adds only voci whose code or name is not there yet.
 */
import { spreadsheetRows } from "./documents.ts";
import { parseCsv } from "./make-xlsx.ts";
import { words } from "./name-keys.ts";
import { oneLine } from "./plain-text.ts";
import { checkOf, isCode, nameKey, PRICE_LIST_LIMITS, type PriceItem, PriceListError, unitOf } from "./price-list.ts";
import { AMBIGUOUS, eurosToCents, readDecimal, VAT_RATES, type VatRate } from "./quote-sums.ts";
import { NATURE, type Natura } from "./sales-invoice-rules.ts";

/** A voce read from a row, before its id. */
export type ImportedItem = Pick<PriceItem, "name" | "code" | "description" | "unit" | "price" | "vat" | "natura" | "includesVat">;

/** A row left out, and why (in words). */
export type Skipped = { readonly row: number; readonly name: string; readonly why: string };

/** `cut`: the rows of the file past the ones read. `prices`: whether the file's prices are with VAT (a column «Prezzo IVA inclusa»), without, or both columns. */
export type ReadFile = { readonly items: readonly (ImportedItem & { readonly row: number })[]; readonly skipped: readonly Skipped[]; readonly cut: number; readonly noVat: number; readonly prices: "gross" | "net" | "both" };

/** The rows of a file, at most PRICE_LIST_LIMITS.importRows + 20 kept, and how many there were in all. */
export type FileRows = { readonly rows: string[][]; readonly total: number };

type Column = "name" | "description" | "price" | "gross" | "unit" | "vat" | "code";

/** Header words, folded, for each column; the longest first where one holds another. */
const HEADERS: readonly (readonly [Column, readonly string[]])[] = [
	["gross", ["prezzo ivato", "prezzo con iva", "prezzo lordo", "ivato"]],
	["price", ["prezzo unitario", "prezzo netto", "prezzo", "importo", "tariffa", "costo", "euro", "eur", "imponibile", "price"]],
	["vat", ["aliquota iva", "aliquota", "iva", "vat", "natura"]],
	["unit", ["unita di misura", "unita", "um", "u m", "unit", "misura"]],
	["code", ["codice articolo", "codice", "cod", "sku", "code", "articolo"]],
	["name", ["nome", "voce", "prodotto", "servizio", "denominazione", "name", "item"]],
	["description", ["descrizione", "dettaglio", "dettagli", "note", "description"]],
];

const cell = (text: string | undefined, max: number) => oneLine((text ?? "").slice(0, max * 4), max);

/** A header of a price with VAT in it, in any words: «Prezzo IVA compresa», «Prezzo (IVA incl.)», «Importo IVA inclusa», «Totale ivato». */
const PRICE_WORDS = /^(?:prezzo|prezzi|importo|tariffa|costo|totale|euro|eur|price)$/;
function grossHeader(key: string): boolean {
	const w = key.split(" ");
	const priceLike = w.some((x) => PRICE_WORDS.test(x));
	return priceLike && ((w.includes("iva") && w.some((x) => /^(?:compres|inclus|incl$|ivat)/.test(x))) || w.some((x) => /^ivat[oaie]$/.test(x)));
}

/** The column each header cell is, by its words; undefined when none. */
function columnOf(header: string): Column | undefined {
	const key = words(header).join(" ");
	if (key === "") return undefined;
	// Before the plain price words: «Prezzo IVA inclusa» is a price with VAT, not a price nor the VAT.
	if (grossHeader(key)) return "gross";
	for (const [column, names] of HEADERS) if (names.some((n) => key === n || key.startsWith(`${n} `))) return column;
	return undefined;
}

/** The header row (within the first ten) and where each column is; undefined when no row has a name and a price. */
function header(rows: readonly (readonly string[])[]): { readonly at: number; readonly columns: Partial<Record<Column, number>> } | undefined {
	for (let at = 0; at < Math.min(rows.length, 10); at++) {
		const columns: Partial<Record<Column, number>> = {};
		(rows[at] ?? []).forEach((h, i) => {
			const c = columnOf(h);
			if (c !== undefined && columns[c] === undefined) columns[c] = i;
		});
		// A file with only a description column names its voci by it.
		if (columns.name === undefined && columns.description !== undefined) {
			columns.name = columns.description;
			delete columns.description;
		}
		if (columns.name !== undefined && (columns.price !== undefined || columns.gross !== undefined)) return { at, columns };
	}
	return undefined;
}

/** A VAT cell: «22», «22%», «N2.2», «0 N4»; undefined when empty, a Problem-like string when it does not read. */
function vatOf(text: string): { vat: VatRate; natura?: Natura } | "empty" | "bad" {
	const t = text.trim().toUpperCase().replace(/\s+/g, "");
	if (t === "") return "empty";
	const natura = /N\d(?:\.\d)?/.exec(t)?.[0];
	if (natura !== undefined) return NATURE.includes(natura as Natura) ? { vat: 0, natura: natura as Natura } : "bad";
	const rate = readDecimal(t.replace("%", ""), 2);
	if (rate === undefined || rate === AMBIGUOUS || !VAT_RATES.includes(Number(rate) as VatRate)) return "bad";
	return Number(rate) === 0 ? "bad" : { vat: Number(rate) as VatRate };
}

/** The rows of the file: the first sheet with something in it, or the CSV. PriceListError when it is neither. */
export function fileRows(name: string, data: Uint8Array): FileRows {
	if (data.byteLength > PRICE_LIST_LIMITS.importBytes) throw new PriceListError(`il file è troppo grande (più di ${PRICE_LIST_LIMITS.importBytes / 1024 / 1024} MB)`);
	let sheets: ReturnType<typeof spreadsheetRows>;
	try {
		sheets = spreadsheetRows(name, data, PRICE_LIST_LIMITS.importRows + 20);
	} catch {
		throw new PriceListError("il foglio Excel non si legge: è rovinato o protetto");
	}
	const keep = (all: readonly (readonly string[])[]): FileRows => ({ rows: all.slice(0, PRICE_LIST_LIMITS.importRows + 20).map((r) => r.slice(0, 40)), total: all.length });
	if (sheets !== undefined) {
		const sheet = sheets.find((s) => !s.hidden && s.rows.some((r) => r.some((c) => c.trim() !== ""))) ?? sheets[0];
		return keep(sheet?.rows ?? []);
	}
	if (!/\.(?:csv|txt|tsv)$/i.test(name) || data.includes(0)) throw new PriceListError("leggo il listino da un CSV o da un foglio Excel (.xlsx, .ods)");
	return keep(parseCsv(new TextDecoder("utf-8").decode(data)));
}

/**
 * The voci of a price list's rows. `defaults`: the VAT for rows without it (or the forfettario's
 * N2.2), and whether the prices include VAT. Rows without a name or a price that reads are left
 * out with the reason; `noVat`: rows left out only because they have no VAT.
 */
export function readRows(file: FileRows, defaults: { readonly vat?: { vat: VatRate; natura?: Natura }; readonly includesVat?: boolean }): ReadFile | { readonly header: readonly string[] } {
	const { rows } = file;
	const h = header(rows);
	if (h === undefined) return { header: (rows.find((r) => r.some((c) => c.trim() !== "")) ?? []).slice(0, 12).map((c) => cell(c, 40)) };
	const c = h.columns;
	const body = rows.slice(h.at + 1);
	const items: (ImportedItem & { row: number })[] = [];
	const skipped: Skipped[] = [];
	let noVat = 0;
	const seen = new Set<string>();
	const take = Math.min(body.length, PRICE_LIST_LIMITS.importRows);
	for (let n = 0; n < take; n++) {
		const r = body[n] ?? [];
		const row = h.at + n + 2;
		if (r.every((x) => x.trim() === "")) continue;
		const name = cell(r[c.name as number], PRICE_LIST_LIMITS.name);
		const skip = (why: string) => skipped.push({ row, name: name === "" ? "(senza nome)" : name, why });
		if (name === "") {
			skip("manca il nome");
			continue;
		}
		const gross = c.gross !== undefined && (r[c.gross] ?? "").trim() !== "";
		const priceText = cell(gross ? r[c.gross as number] : r[c.price as number], 30);
		const price = readDecimal(priceText.replace(/€|eur(?:o)?/gi, "").trim(), 2);
		if (price === AMBIGUOUS) {
			skip("il prezzo può voler dire migliaia o decimali");
			continue;
		}
		if (price === undefined || eurosToCents(price) <= 0n || Number(price) > PRICE_LIST_LIMITS.maxPrice) {
			skip("il prezzo non si legge");
			continue;
		}
		const vatCell = c.vat === undefined ? "empty" : vatOf(r[c.vat] ?? "");
		if (vatCell === "bad") {
			skip("l'IVA non si legge (un'aliquota 22, 10, 5, 4 o una natura come N2.2)");
			continue;
		}
		const vat = vatCell === "empty" ? defaults.vat : vatCell;
		if (vat === undefined) {
			noVat++;
			skip("manca l'IVA");
			continue;
		}
		const codeText = c.code === undefined ? "" : cell(r[c.code], PRICE_LIST_LIMITS.code).replace(/\s+/g, "");
		const code = codeText !== "" && isCode(codeText) ? codeText : undefined;
		if (codeText !== "" && code === undefined) {
			skip("il codice ha caratteri che non tengo (solo lettere, cifre e . _ / -, e non come LS-0001)");
			continue;
		}
		const key = nameKey(name);
		if (key === "" || seen.has(key) || (code !== undefined && seen.has(`code:${code.toUpperCase()}`))) {
			skip(key === "" ? "il nome non ha lettere né cifre" : "ripetuta nel file");
			continue;
		}
		seen.add(key);
		if (code !== undefined) seen.add(`code:${code.toUpperCase()}`);
		const description = c.description === undefined ? "" : cell(r[c.description], PRICE_LIST_LIMITS.description);
		const unitText = c.unit === undefined ? "" : unitOf(cell(r[c.unit], 30));
		const includes = (gross || defaults.includesVat === true) && vat.vat > 0;
		items.push({
			row,
			name,
			price,
			vat: vat.vat,
			...(vat.natura === undefined ? {} : { natura: vat.natura }),
			...(code === undefined ? {} : { code }),
			...(description === "" || description === name ? {} : { description }),
			...(unitText === "" || unitText.length > PRICE_LIST_LIMITS.unit ? {} : { unit: unitText }),
			...(includes ? { includesVat: true as const } : {}),
		});
	}
	// Every row of the file past the header that was not read: those beyond the rows kept count too.
	const prices = c.gross === undefined ? (defaults.includesVat === true ? "gross" : "net") : c.price === undefined ? "gross" : "both";
	return { items, skipped, cut: Math.max(0, file.total - (h.at + 1) - take), noVat, prices };
}

/** What an import would do: the voci to add, those already in the listino (by code or name, kept as they are). */
/** `refused`: rows whose code is another voce's name, or whose name is another voce's code (a phrase would name two). */
export type ImportPlan = { readonly add: readonly (ImportedItem & { readonly row: number })[]; readonly known: readonly { readonly row: number; readonly name: string; readonly id: string; readonly samePrice: boolean }[]; readonly refused: readonly Skipped[]; readonly check: string };

export function planImport(read: ReadFile, listino: readonly PriceItem[]): ImportPlan {
	const add: (ImportedItem & { row: number })[] = [];
	const known: { row: number; name: string; id: string; samePrice: boolean }[] = [];
	const refused: Skipped[] = [];
	const names = new Set(listino.map((x) => nameKey(x.name)));
	const codes = new Set(listino.flatMap((x) => (x.code === undefined ? [] : [nameKey(x.code)])));
	for (const i of read.items) {
		const same = listino.find((x) => (i.code !== undefined && x.code?.toUpperCase() === i.code.toUpperCase()) || nameKey(x.name) === nameKey(i.name));
		if (same !== undefined) {
			known.push({ row: i.row, name: i.name, id: same.id, samePrice: same.price === i.price && same.vat === i.vat && (same.includesVat === true) === (i.includesVat === true) });
			continue;
		}
		const taken = [...add.map((a) => nameKey(a.name)), ...names];
		const takenCodes = [...add.flatMap((a) => (a.code === undefined ? [] : [nameKey(a.code)])), ...codes];
		if ((i.code !== undefined && taken.includes(nameKey(i.code))) || takenCodes.includes(nameKey(i.name))) {
			refused.push({ row: i.row, name: i.name, why: "il codice è il nome di un'altra voce, o il nome è il codice di un'altra: detto così non si saprebbe quale delle due è" });
			continue;
		}
		add.push(i);
	}
	// What the person saw is what is added: the yes names this check.
	return { add, known, refused, check: checkOf(add.map(({ row: _r, ...rest }) => rest)) };
}
