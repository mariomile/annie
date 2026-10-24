/**
 * Excel formulas as Owni writes them (ADR 0029): the Italian way (SOMMA, `;` between arguments,
 * decimal commas) turned into the English form the file stores, and the value of the simple
 * ones worked out, so a preview that does not calculate (a phone) still shows the totals.
 */

/** Italian function names, as Excel in Italian shows them, to their stored English names. */
const ITALIAN: Record<string, string> = {
	SOMMA: "SUM",
	MEDIA: "AVERAGE",
	ARROTONDA: "ROUND",
	"ARROTONDA.PER.ECC": "ROUNDUP",
	"ARROTONDA.PER.DIF": "ROUNDDOWN",
	TRONCA: "TRUNC",
	SE: "IF",
	"SE.ERRORE": "IFERROR",
	E: "AND",
	O: "OR",
	NON: "NOT",
	"SOMMA.SE": "SUMIF",
	"SOMMA.PIÙ.SE": "SUMIFS",
	"CONTA.SE": "COUNTIF",
	"CONTA.PIÙ.SE": "COUNTIFS",
	"CONTA.VALORI": "COUNTA",
	"CONTA.NUMERI": "COUNT",
	"CONTA.VUOTE": "COUNTBLANK",
	"MEDIA.SE": "AVERAGEIF",
	"CERCA.VERT": "VLOOKUP",
	"CERCA.ORIZZ": "HLOOKUP",
	"CERCA.X": "XLOOKUP",
	INDICE: "INDEX",
	CONFRONTA: "MATCH",
	OGGI: "TODAY",
	ADESSO: "NOW",
	DATA: "DATE",
	ANNO: "YEAR",
	MESE: "MONTH",
	GIORNO: "DAY",
	ASS: "ABS",
	RADQ: "SQRT",
	POTENZA: "POWER",
	RESTO: "MOD",
	PRODOTTO: "PRODUCT",
	"MATR.SOMMA.PRODOTTO": "SUMPRODUCT",
	CONCATENA: "CONCATENATE",
	MAIUSC: "UPPER",
	MINUSC: "LOWER",
	SINISTRA: "LEFT",
	DESTRA: "RIGHT",
	"STRINGA.ESTRAI": "MID",
	LUNGHEZZA: "LEN",
	TESTO: "TEXT",
	VALORE: "VALUE",
};

/** The pieces of a formula outside its quoted strings, each changed by `change`. */
function outsideStrings(formula: string, change: (part: string) => string): string {
	return formula
		.split(/("(?:[^"]|"")*")/)
		.map((part, i) => (i % 2 === 1 ? part : change(part)))
		.join("");
}

/**
 * A formula in the form Excel stores: English names, commas between arguments, points in
 * decimals. Italian when it uses an Italian name or `;`: then `;` separates and `,` is a decimal.
 * Otherwise a decimal comma is only read as one outside function calls (`=D5*0,22`).
 */
export function normalizeFormula(formula: string): string {
	let italian = false;
	let named = outsideStrings(formula, (part) =>
		part.replace(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9.]*)(\s*\()/g, (all, name: string, open: string) => {
			const english = ITALIAN[name.toUpperCase()];
			if (english === undefined) return all;
			italian = true;
			return english + open;
		}),
	);
	outsideStrings(named, (part) => {
		if (part.includes(";")) italian = true;
		return part;
	});
	if (italian) return outsideStrings(named, (part) => part.replace(/(\d),(\d)/g, "$1.$2").replace(/;/g, ","));
	// Not Italian: a comma between digits is a decimal only at the top level, outside calls.
	let depth = 0;
	named = outsideStrings(named, (part) => {
		let out = "";
		for (let i = 0; i < part.length; i++) {
			const c = part[i] as string;
			if (c === "(") depth++;
			else if (c === ")") depth--;
			const decimal = c === "," && depth === 0 && /\d/.test(part[i + 1] ?? "") && /(^|[^A-Za-z$\d])\d+$/.test(part.slice(0, i));
			out += decimal ? "." : c;
		}
		return out;
	});
	return named;
}

export type Value = number | string | boolean | null;
type Range = { readonly range: readonly Value[] };
type Item = Value | Range;

class Unknown extends Error {}

/** Cells visited by all the formulas of a sheet together: past this, the rest stay without a value. */
export const FORMULA_BUDGET = 2_000_000;

/**
 * The value of a formula that only uses this sheet's cells, numbers, text and a few common
 * functions, or undefined when it cannot say (another function, another sheet, an error such as
 * a division by zero): then Excel works it out when the file is opened.
 * `cell(column, row)` gives a cell's value (0-based), undefined if unknown.
 */
export function evaluateFormula(formula: string, cell: (column: number, row: number) => Value | undefined, budget: { left: number }): Value | undefined {
	try {
		const parser = new Parser(formula, cell, budget);
		const value = parser.expression();
		parser.end();
		if (typeof value === "object" && value !== null) throw new Unknown();
		if (typeof value === "number" && !Number.isFinite(value)) throw new Unknown();
		return value;
	} catch (error) {
		if (error instanceof Unknown) return undefined;
		throw error;
	}
}

const TOKEN = /\s*(?:("(?:[^"]|"")*")|(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+)|(\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?)(?![A-Za-z0-9_.(!])|([A-Za-z][A-Za-z0-9.]*)\s*\(|(TRUE|FALSE)\b|(<=|>=|<>|[-+*/^&=<>%(),]))/iy;

type Token = { kind: "string" | "number" | "ref" | "call" | "bool" | "op"; text: string };

class Parser {
	private readonly tokens: Token[] = [];
	private at = 0;
	private readonly cell: (column: number, row: number) => Value | undefined;
	private readonly budget: { left: number };

	constructor(formula: string, cell: (column: number, row: number) => Value | undefined, budget: { left: number }) {
		this.cell = cell;
		this.budget = budget;
		TOKEN.lastIndex = 0;
		while (TOKEN.lastIndex < formula.length) {
			if (formula.slice(TOKEN.lastIndex).trim() === "") break;
			const m = TOKEN.exec(formula);
			if (m === null) throw new Unknown();
			const kinds: Token["kind"][] = ["string", "number", "ref", "call", "bool", "op"];
			const index = m.slice(1).findIndex((g) => g !== undefined);
			this.tokens.push({ kind: kinds[index] as Token["kind"], text: m[index + 1] as string });
		}
	}

	end(): void {
		if (this.at !== this.tokens.length) throw new Unknown();
	}

	private peek(): Token | undefined {
		return this.tokens[this.at];
	}

	private isOp(text: string): boolean {
		const t = this.peek();
		return t !== undefined && t.kind === "op" && t.text === text;
	}

	private expect(text: string): void {
		if (!this.isOp(text)) throw new Unknown();
		this.at++;
	}

	expression(): Item {
		let left = this.concat();
		while (["=", "<>", "<", ">", "<=", ">="].some((o) => this.isOp(o))) {
			const op = (this.tokens[this.at++] as Token).text;
			const right = this.concat();
			left = compare(scalar(left), scalar(right), op);
		}
		return left;
	}

	private concat(): Item {
		let left = this.additive();
		while (this.isOp("&")) {
			this.at++;
			left = text(scalar(left)) + text(scalar(this.additive()));
		}
		return left;
	}

	private additive(): Item {
		let left = this.multiplicative();
		while (this.isOp("+") || this.isOp("-")) {
			const op = (this.tokens[this.at++] as Token).text;
			const right = number(scalar(this.multiplicative()));
			left = op === "+" ? number(scalar(left)) + right : number(scalar(left)) - right;
		}
		return left;
	}

	private multiplicative(): Item {
		let left = this.power();
		while (this.isOp("*") || this.isOp("/")) {
			const op = (this.tokens[this.at++] as Token).text;
			const right = number(scalar(this.power()));
			if (op === "/" && right === 0) throw new Unknown();
			left = op === "*" ? number(scalar(left)) * right : number(scalar(left)) / right;
		}
		return left;
	}

	private power(): Item {
		let left = this.unary();
		while (this.isOp("^")) {
			this.at++;
			left = number(scalar(left)) ** number(scalar(this.unary()));
		}
		return left;
	}

	private unary(): Item {
		if (this.isOp("-")) {
			this.at++;
			return -number(scalar(this.unary()));
		}
		if (this.isOp("+")) {
			this.at++;
			return this.unary();
		}
		let value = this.primary();
		while (this.isOp("%")) {
			this.at++;
			value = number(scalar(value)) / 100;
		}
		return value;
	}

	private primary(): Item {
		const token = this.tokens[this.at++];
		if (token === undefined) throw new Unknown();
		if (token.kind === "number") return Number(token.text);
		if (token.kind === "string") return token.text.slice(1, -1).replace(/""/g, '"');
		if (token.kind === "bool") return token.text.toUpperCase() === "TRUE";
		if (token.kind === "ref") return this.reference(token.text);
		if (token.kind === "call") {
			const args: Item[] = [];
			if (!this.isOp(")")) {
				args.push(this.expression());
				while (this.isOp(",")) {
					this.at++;
					args.push(this.expression());
				}
			}
			this.expect(")");
			return call(token.text.toUpperCase(), args);
		}
		if (token.text === "(") {
			const value = this.expression();
			this.expect(")");
			return value;
		}
		throw new Unknown();
	}

	private reference(text: string): Item {
		const [from, to] = text.replace(/\$/g, "").toUpperCase().split(":") as [string, string | undefined];
		const a = position(from);
		if (to === undefined) return known(this.cell(a.column, a.row));
		const b = position(to);
		const values: Value[] = [];
		const [c1, c2] = [Math.min(a.column, b.column), Math.max(a.column, b.column)];
		const [r1, r2] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
		this.budget.left -= (c2 - c1 + 1) * (r2 - r1 + 1);
		if (this.budget.left < 0) throw new Unknown();
		for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) values.push(known(this.cell(c, r)));
		return { range: values };
	}
}

function position(ref: string): { column: number; row: number } {
	const m = /^([A-Z]+)(\d+)$/.exec(ref) as RegExpExecArray;
	let column = 0;
	for (const ch of m[1] as string) column = column * 26 + (ch.charCodeAt(0) - 64);
	return { column: column - 1, row: Number(m[2]) - 1 };
}

function known(value: Value | undefined): Value {
	if (value === undefined) throw new Unknown();
	return value;
}

function scalar(item: Item): Value {
	if (item !== null && typeof item === "object") throw new Unknown();
	return item;
}

function number(value: Value): number {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value === null) return 0;
	const parsed = Number(value);
	if (value.trim() === "" || !Number.isFinite(parsed)) throw new Unknown();
	return parsed;
}

function text(value: Value): string {
	if (value === null) return "";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	return String(value);
}

function compare(a: Value, b: Value, op: string): boolean {
	const x = typeof a === "string" ? a.toLowerCase() : a === null ? (typeof b === "string" ? "" : 0) : a;
	const y = typeof b === "string" ? b.toLowerCase() : b === null ? (typeof a === "string" ? "" : 0) : b;
	if (typeof x !== typeof y) throw new Unknown();
	switch (op) {
		case "=":
			return x === y;
		case "<>":
			return x !== y;
		case "<":
			return (x as number) < (y as number);
		case ">":
			return (x as number) > (y as number);
		case "<=":
			return (x as number) <= (y as number);
		default:
			return (x as number) >= (y as number);
	}
}

/** Numbers among the arguments: from ranges only the numbers, given directly any value that is one. */
function numbers(args: readonly Item[]): number[] {
	const out: number[] = [];
	for (const arg of args) {
		if (arg !== null && typeof arg === "object") {
			for (const v of arg.range) if (typeof v === "number") out.push(v);
		} else out.push(number(arg));
	}
	return out;
}

/** Rounding half away from zero, as Excel does, on the decimal digits written (1.005 to 1.01). */
function round(value: number, digits: number, mode: "near" | "up" | "down"): number {
	const d = Math.trunc(digits);
	const shift = (v: number, by: number) => Number(`${v}e${by}`);
	const abs = Math.abs(value);
	const scaled = shift(abs, d);
	const whole = mode === "near" ? Math.round(scaled) : mode === "up" ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9);
	return Math.sign(value) * shift(whole, -d);
}

function call(name: string, args: readonly Item[]): Value {
	const arg = (i: number) => scalar(args[i] === undefined ? null : (args[i] as Item));
	switch (name) {
		case "SUM":
			return numbers(args).reduce((a, b) => a + b, 0);
		case "PRODUCT":
			return numbers(args).reduce((a, b) => a * b, 1);
		case "AVERAGE": {
			const list = numbers(args);
			if (list.length === 0) throw new Unknown();
			return list.reduce((a, b) => a + b, 0) / list.length;
		}
		case "MIN":
		case "MAX": {
			const list = numbers(args);
			return list.length === 0 ? 0 : name === "MIN" ? Math.min(...list) : Math.max(...list);
		}
		case "COUNT":
			return args.reduce<number>((n, a) => n + (a !== null && typeof a === "object" ? a.range.filter((v) => typeof v === "number").length : typeof a === "number" ? 1 : 0), 0);
		case "COUNTA":
			return args.reduce<number>((n, a) => n + (a !== null && typeof a === "object" ? a.range.filter((v) => v !== null && v !== "").length : 1), 0);
		case "ROUND":
		case "ROUNDUP":
		case "ROUNDDOWN":
			return round(number(arg(0)), number(arg(1)), name === "ROUND" ? "near" : name === "ROUNDUP" ? "up" : "down");
		case "TRUNC":
			return round(number(arg(0)), number(arg(1)), "down");
		case "INT":
			return Math.floor(number(arg(0)));
		case "ABS":
			return Math.abs(number(arg(0)));
		case "SQRT": {
			const v = number(arg(0));
			if (v < 0) throw new Unknown();
			return Math.sqrt(v);
		}
		case "POWER":
			return number(arg(0)) ** number(arg(1));
		case "MOD": {
			const d = number(arg(1));
			if (d === 0) throw new Unknown();
			const v = number(arg(0));
			return v - d * Math.floor(v / d);
		}
		case "IF": {
			if (args.length < 2 || args.length > 3) throw new Unknown();
			return number(arg(0)) !== 0 ? arg(1) : args.length === 3 ? arg(2) : false;
		}
		case "AND":
			return args.every((a) => number(scalar(a)) !== 0);
		case "OR":
			return args.some((a) => number(scalar(a)) !== 0);
		case "NOT":
			return number(arg(0)) === 0;
		default:
			throw new Unknown();
	}
}
