/**
 * Exact sums for the model (ADR 0031): an expression read by a small parser, never by eval, so a
 * quote, a VAT or a split comes out right to the cent. Lines can name a value and use it below.
 */

export class CalcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CalcError";
	}
}

export const CALC_LIMITS = { maxLength: 4000, maxLines: 50, maxDepth: 40, maxArgs: 200, maxName: 40 } as const;

export type CalcLine = { readonly name?: string; readonly expression: string; readonly value: number };

type Token = { kind: "number"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

type Fn = { min: number; max: number; run: (args: number[]) => number };

const FUNCTIONS: Record<string, Fn> = {
	round: { min: 1, max: 2, run: ([x = 0, d = 0]) => roundTo(x, d) },
	floor: { min: 1, max: 1, run: ([x = 0]) => Math.floor(x) },
	ceil: { min: 1, max: 1, run: ([x = 0]) => Math.ceil(x) },
	abs: { min: 1, max: 1, run: ([x = 0]) => Math.abs(x) },
	sqrt: { min: 1, max: 1, run: ([x = 0]) => (x < 0 ? fail("la radice di un numero negativo non esiste") : Math.sqrt(x)) },
	min: { min: 1, max: CALC_LIMITS.maxArgs, run: (a) => Math.min(...a) },
	max: { min: 1, max: CALC_LIMITS.maxArgs, run: (a) => Math.max(...a) },
	sum: { min: 1, max: CALC_LIMITS.maxArgs, run: (a) => a.reduce((s, x) => s + x, 0) },
	avg: { min: 1, max: CALC_LIMITS.maxArgs, run: (a) => a.reduce((s, x) => s + x, 0) / a.length },
	pow: { min: 2, max: 2, run: ([x = 0, y = 0]) => x ** y },
	ln: { min: 1, max: 1, run: ([x = 0]) => (x <= 0 ? fail("il logaritmo vuole un numero maggiore di zero") : Math.log(x)) },
	log: { min: 1, max: 1, run: ([x = 0]) => (x <= 0 ? fail("il logaritmo vuole un numero maggiore di zero") : Math.log10(x)) },
	exp: { min: 1, max: 1, run: ([x = 0]) => Math.exp(x) },
};
// The Italian names people and Excel use.
const ALIASES: Record<string, string> = { arrotonda: "round", tronca: "floor", arrotonda_per_difetto: "floor", arrotonda_per_eccesso: "ceil", ass: "abs", radq: "sqrt", radice: "sqrt", minimo: "min", massimo: "max", somma: "sum", media: "avg", potenza: "pow" };
const CONSTANTS: Record<string, number> = { pi: Math.PI, pigreco: Math.PI, e: Math.E };

/**
 * Each line of `text`, worked out: «iva = imponibile * 22%» names a value for the lines below.
 * Numbers take a point or a comma for decimals (1.5, 1,5, 1.234,56, 1,234.56); between the
 * arguments of a function a «;» (or, when no number uses the comma, a «,»). «%» divides by 100.
 */
export function calculate(text: string): CalcLine[] {
	if (text.length > CALC_LIMITS.maxLength) throw new CalcError(`il calcolo è troppo lungo (più di ${CALC_LIMITS.maxLength} caratteri)`);
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
	if (lines.length === 0) throw new CalcError("non c'è niente da calcolare");
	if (lines.length > CALC_LIMITS.maxLines) throw new CalcError(`al massimo ${CALC_LIMITS.maxLines} righe`);
	const names = new Map<string, number>();
	return lines.map((line, i) => {
		const spaced = /^([\p{L}_][\p{L}\p{N}_]*(?: +[\p{L}_][\p{L}\p{N}_]*)+)\s*=(?!=)/u.exec(line);
		if (spaced !== null) throw new CalcError(`${lines.length > 1 ? `riga ${i + 1}: ` : ""}un nome è una parola sola: ${(spaced[1] as string).replace(/ +/g, "_")} = …`);
		const assignment = /^([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)\s*(.+)$/u.exec(line);
		const name = assignment?.[1];
		const expression = assignment?.[2] ?? line;
		try {
			if (name !== undefined) {
				if (name.length > CALC_LIMITS.maxName) throw new CalcError(`il nome «${name.slice(0, 20)}…» è troppo lungo`);
				if (FUNCTIONS[name.toLowerCase()] !== undefined || ALIASES[name.toLowerCase()] !== undefined || CONSTANTS[name.toLowerCase()] !== undefined) throw new CalcError(`«${name}» è il nome di una funzione: scegline un altro`);
			}
			const value = new Parser(tokens(expression), names).run();
			if (name !== undefined) names.set(name.toLowerCase(), value);
			return { ...(name === undefined ? {} : { name }), expression, value };
		} catch (error) {
			if (error instanceof CalcError) throw new CalcError(lines.length > 1 ? `riga ${i + 1} (${short(line)}): ${error.message}` : error.message);
			throw error;
		}
	});
}

/**
 * One expression read once and worked out many times, with different values for its names: a
 * computed column of a table (ADR 0031). `names` are the values it needs, lower case.
 */
export function compileExpression(expression: string): { names: string[]; run: (values: Map<string, number>) => number } {
	if (expression.length > 500) throw new CalcError("l'espressione è troppo lunga (più di 500 caratteri)");
	const list = tokens(expression);
	const names = [...new Set(list.flatMap((t, i) => (t.kind === "name" && !(list[i + 1]?.kind === "op" && list[i + 1]?.value === "(") && CONSTANTS[t.value] === undefined ? [t.value] : [])))];
	return { names, run: (values) => new Parser(list, values).run() };
}

/** A result as it is read in Italy, to 12 significant digits: 1.234,5; with `decimals` exactly that many. */
export function formatResult(value: number, decimals?: number): string {
	const exact = Number(value.toPrecision(12));
	if (Math.abs(exact) >= 1e15 || (exact !== 0 && Math.abs(exact) < 1e-9)) return exact.toExponential(6).replace(".", ",");
	return new Intl.NumberFormat("it-IT", decimals === undefined ? { maximumFractionDigits: 10, useGrouping: true } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true }).format(exact);
}

function tokens(text: string): Token[] {
	const out: Token[] = [];
	// A comma is a decimal comma when the arguments are split by «;» or when no function is called.
	const callsFunction = /[\p{L}_][\p{L}\p{N}_]*\s*\(/u.test(text);
	const commaDecimal = text.includes(";") || !callsFunction;
	// somma(1,5, 2,5): two numbers with commas, or four? Asked, never guessed.
	if (!commaDecimal && /\d,\d/.test(text)) throw new CalcError("tra gli argomenti di una funzione non capisco se la virgola separa i numeri o i decimali: separa i numeri con ; (somma(1,5; 2,5)) o metti uno spazio dopo la virgola (max(3, 5))");
	let i = 0;
	while (i < text.length) {
		const ch = text[i] as string;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const number = (commaDecimal ? /^\d+(?:[.,]\d+)*/ : /^\d+(?:\.\d+)*/).exec(text.slice(i, i + 64));
		const startsNumber = /\d/.test(ch) || (ch === "." && /\d/.test(text[i + 1] ?? ""));
		if (startsNumber) {
			const raw = ch === "." ? (/^\.\d+/.exec(text.slice(i, i + 64))?.[0] ?? ".") : (number?.[0] ?? ch);
			let end = i + raw.length;
			// An exponent: 1e6, 2.5E-3.
			const exponent = /^[eE][-+]?\d+/.exec(text.slice(end, end + 8));
			if (exponent !== null) end += exponent[0].length;
			// Written out, not multiplied: 1.15e2 is exactly 115.
			const value = exponent === null ? numberOf(raw) : Number(`${numberOf(raw)}e${Number(exponent[0].slice(1))}`);
			if (!Number.isFinite(value)) throw new CalcError(`il numero ${raw}${exponent?.[0] ?? ""} è troppo grande`);
			out.push({ kind: "number", value });
			i = end;
			continue;
		}
		const word = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(i, i + CALC_LIMITS.maxName + 1));
		if (word !== null) {
			out.push({ kind: "name", value: word[0].toLowerCase() });
			i += word[0].length;
			continue;
		}
		const op = "+-*/^%(),;×÷−–·:".includes(ch) ? ch : ch === "€" || ch === "$" ? "" : undefined;
		if (op === undefined) throw new CalcError(`non so cosa sia «${ch}»`);
		if (op !== "") out.push({ kind: "op", value: op === "×" || op === "·" ? "*" : op === "÷" || op === ":" ? "/" : op === "−" || op === "–" ? "-" : op === ";" ? "," : op });
		i++;
	}
	return out;
}

/** 1234.5, 1234,5, 1.234,56, 1,234.56, 1.234.567, 1.500 (fifteen hundred): with both separators the last one is the decimal one. */
function numberOf(raw: string): number {
	const separators = raw.replace(/\d/g, "");
	let text = raw;
	if (separators.length === 0) return Number(text);
	const last = separators.at(-1) as string;
	const groups = raw.split(/[.,]/);
	if (new Set(separators).size === 2) {
		// Both: the last one is the decimal separator.
		text = raw.split(last === "," ? "." : ",").join("").replace(",", ".");
	} else if (separators.length > 1) {
		// The same separator more than once is grouping: 1.234.567.
		if (groups.slice(1).some((g) => g.length !== 3)) throw new CalcError(`non capisco il numero ${raw}`);
		text = groups.join("");
	} else if (last === "." && /^[1-9]\d{0,2}\.\d{3}$/.test(raw)) {
		// 1.500 is fifteen hundred, as Italians write it (and as table_query reads it); 1.5 and 0.125 are decimals.
		text = raw.replace(".", "");
	} else text = raw.replace(",", ".");
	const value = Number(text);
	if (!Number.isFinite(value)) throw new CalcError(`non capisco il numero ${raw}`);
	return value;
}

class Parser {
	private at = 0;
	private depth = 0;
	private readonly list: Token[];
	private readonly names: Map<string, number>;

	constructor(list: Token[], names: Map<string, number>) {
		this.list = list;
		this.names = names;
	}

	run(): number {
		if (this.list.length === 0) throw new CalcError("non c'è niente da calcolare");
		const value = this.sum();
		const next = this.list[this.at];
		if (next !== undefined) {
			const operand = next.kind !== "op" || next.value === "(";
			throw new CalcError(operand ? `manca un operatore prima di «${next.value}» (per esempio *)` : `non mi aspettavo «${next.value}»`);
		}
		return finite(value);
	}

	private peek(op: string): boolean {
		const t = this.list[this.at];
		return t !== undefined && t.kind === "op" && t.value === op;
	}

	private sum(): number {
		let value = this.product();
		while (this.peek("+") || this.peek("-")) {
			const op = (this.list[this.at++] as Token).value;
			const right = this.product();
			value = op === "+" ? value + right : value - right;
		}
		return value;
	}

	private product(): number {
		let value = this.unary();
		while (this.peek("*") || this.peek("/")) {
			const op = (this.list[this.at++] as Token).value;
			const right = this.unary();
			if (op === "/" && right === 0) throw new CalcError("divisione per zero");
			value = op === "*" ? value * right : value / right;
		}
		return value;
	}

	private unary(): number {
		if (this.peek("-") || this.peek("+")) {
			const op = (this.list[this.at++] as Token).value;
			const value = this.nested(() => this.unary());
			return op === "-" ? -value : value;
		}
		return this.power();
	}

	private power(): number {
		const base = this.postfix();
		if (!this.peek("^")) return base;
		this.at++;
		const exponent = this.nested(() => this.unary());
		const value = base ** exponent;
		if (Number.isNaN(value)) throw new CalcError("questa potenza non ha un risultato reale");
		return value;
	}

	private postfix(): number {
		let value = this.primary();
		while (this.peek("%")) {
			this.at++;
			value /= 100;
		}
		return value;
	}

	private primary(): number {
		const t = this.list[this.at];
		if (t === undefined) throw new CalcError("il calcolo finisce a metà");
		if (t.kind === "number") {
			this.at++;
			return t.value;
		}
		if (t.kind === "op" && t.value === "(") {
			this.at++;
			const value = this.nested(() => this.sum());
			if (!this.peek(")")) throw new CalcError("manca una parentesi chiusa");
			this.at++;
			return value;
		}
		if (t.kind === "name") {
			this.at++;
			if (this.peek("(")) {
				this.at++;
				const fn = FUNCTIONS[ALIASES[t.value] ?? t.value];
				if (fn === undefined) throw new CalcError(`non conosco la funzione ${t.value}: uso ${Object.keys(FUNCTIONS).join(", ")}`);
				const args: number[] = [];
				if (!this.peek(")")) {
					args.push(this.nested(() => this.sum()));
					while (this.peek(",")) {
						this.at++;
						if (args.length >= CALC_LIMITS.maxArgs) throw new CalcError(`al massimo ${CALC_LIMITS.maxArgs} numeri in una funzione`);
						args.push(this.nested(() => this.sum()));
					}
				}
				if (!this.peek(")")) throw new CalcError("manca una parentesi chiusa");
				this.at++;
				if (args.length < fn.min || args.length > fn.max) throw new CalcError(`${t.value} vuole ${fn.min === fn.max ? fn.min : `da ${fn.min} a ${fn.max}`} ${fn.max === 1 ? "numero" : "numeri"}`);
				return finite(fn.run(args));
			}
			const value = this.names.get(t.value) ?? CONSTANTS[t.value];
			if (value === undefined) throw new CalcError(`non so quanto vale «${t.value}»: dagli un valore in una riga sopra (${t.value} = …)`);
			return value;
		}
		throw new CalcError(`non mi aspettavo «${t.value}»`);
	}

	private nested(read: () => number): number {
		if (++this.depth > CALC_LIMITS.maxDepth) throw new CalcError("il calcolo ha troppe parentesi una dentro l'altra");
		try {
			return read();
		} finally {
			this.depth--;
		}
	}
}

/** Half away from zero, on the decimal digits as written: round(2.675; 2) is 2.68. */
function roundTo(x: number, digits: number): number {
	const d = Math.max(-15, Math.min(15, Math.trunc(digits)));
	const shifted = Number(`${Math.abs(x)}e${d}`);
	const rounded = Number(`${Math.round(shifted)}e${-d}`);
	const value = Number.isFinite(rounded) ? rounded : Math.round(Math.abs(x) * 10 ** d) / 10 ** d;
	return x < 0 ? -value : value;
}

function finite(value: number): number {
	if (!Number.isFinite(value)) throw new CalcError("il risultato è troppo grande");
	return value;
}

function fail(message: string): never {
	throw new CalcError(message);
}

function short(line: string): string {
	return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}
