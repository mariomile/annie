/**
 * The quote tool's arguments, read and checked: the customer (its tax id checked on paper with
 * tax-ids.ts), the lines with their amounts as digit strings, the VAT rate of every line as the
 * person said it. A missing rate is not an error to guess around: the caller asks.
 */
import { validAddress } from "../email-address.ts";
import { QUOTE_LIMITS, type QuoteCustomer, type QuoteLine } from "../quotes.ts";
import { readDecimal, VAT_RATES, type VatRate } from "../quote-sums.ts";
import { parseTaxId } from "../tax-ids.ts";

export type Problem = { readonly problem: string };

/** Lines that have no VAT rate: the caller asks the person for it. */
export type MissingVat = { readonly missingVat: number };

/** A line as given, before the quote-wide defaults. */
type GivenLine = { description: string; unit?: string; quantity: string; price: string; discount?: string; vat?: VatRate; vatNote?: string };

/** Text the person gave, with control characters and spare spaces out; newlines kept only where `lines` allows. */
export function cleanText(value: unknown, max: number, name: string, lines = false): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: `${name} è un testo` };
	const text = value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, " ")
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l !== "")
		.join(lines ? "\n" : " ");
	if (text === "") return undefined;
	if (text.length > max) return { problem: `${name} è troppo lungo (al massimo ${max} caratteri)` };
	return text;
}

export const isProblem = (v: unknown): v is Problem => typeof v === "object" && v !== null && "problem" in v;

/** A VAT rate as given: 22, «22», «22%»; undefined when not given. */
export function readVat(value: unknown, where: string): VatRate | undefined | Problem {
	if (value === undefined) return undefined;
	const text = readDecimal(typeof value === "number" || typeof value === "string" ? value : "", 2);
	const rate = text === undefined ? Number.NaN : Number(text);
	if (!VAT_RATES.includes(rate as VatRate)) return { problem: `${where}: l'aliquota IVA è una di queste: ${VAT_RATES.join(", ")} (per lo 0 serve il motivo in vat_note)` };
	return rate as VatRate;
}

/** A discount in percent, from more than 0 to 100, to 2 decimals; 0 means none. */
export function readDiscount(value: unknown, where: string): string | null | undefined | Problem {
	if (value === undefined) return undefined;
	const text = readDecimal(typeof value === "number" || typeof value === "string" ? value : "", 2);
	if (text === undefined || Number(text) > 100) return { problem: `${where}: lo sconto è una percentuale da 0 a 100, per esempio 10 o 12,5` };
	return Number(text) === 0 ? null : text;
}

function readLine(raw: unknown, n: number): GivenLine | Problem {
	const where = `riga ${n}`;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problem: `${where}: ogni voce è un oggetto con description e price` };
	const o = raw as Record<string, unknown>;
	const description = cleanText(o.description, QUOTE_LIMITS.description, `${where}, description`);
	if (isProblem(description)) return description;
	if (description === undefined) return { problem: `${where}: manca la descrizione` };
	const unit = cleanText(o.unit, QUOTE_LIMITS.unit, `${where}, unit`);
	if (isProblem(unit)) return unit;
	const quantityText = o.quantity === undefined ? "1" : readDecimal(typeof o.quantity === "number" || typeof o.quantity === "string" ? o.quantity : "", 3);
	if (quantityText === undefined || Number(quantityText) <= 0 || Number(quantityText) > QUOTE_LIMITS.maxQuantity) return { problem: `${where}: la quantità è un numero maggiore di zero, al più 3 decimali` };
	const price = o.price === undefined ? undefined : readDecimal(typeof o.price === "number" || typeof o.price === "string" ? o.price : "", 4);
	if (price === undefined || Number(price) > QUOTE_LIMITS.maxPrice) return { problem: `${where}: il prezzo unitario è un importo come 500 o 1.234,56 (al più 4 decimali), senza segno meno` };
	const discount = readDiscount(o.discount, where);
	if (isProblem(discount)) return discount;
	const vat = readVat(o.vat, where);
	if (isProblem(vat)) return vat;
	const vatNote = cleanText(o.vat_note, QUOTE_LIMITS.vatNote, `${where}, vat_note`);
	if (isProblem(vatNote)) return vatNote;
	return {
		description,
		quantity: quantityText,
		price,
		...(unit === undefined ? {} : { unit }),
		...(discount === undefined || discount === null ? {} : { discount }),
		...(vat === undefined ? {} : { vat }),
		...(vatNote === undefined ? {} : { vatNote }),
	};
}

/** The items as given: 1 to QUOTE_LIMITS.lines objects. */
export function readItems(value: unknown): GivenLine[] | Problem {
	if (!Array.isArray(value) || value.length === 0) return { problem: "items è l'elenco delle voci, almeno una, ognuna con description e price" };
	if (value.length > QUOTE_LIMITS.lines) return { problem: `al massimo ${QUOTE_LIMITS.lines} voci in un preventivo` };
	const lines: GivenLine[] = [];
	for (const [i, raw] of value.entries()) {
		const line = readLine(raw, i + 1);
		if (isProblem(line)) return line;
		lines.push(line);
	}
	return lines;
}

/**
 * The lines with the quote-wide rate, reason and discount applied: a line's own values win, the
 * quote's fill the rest (`override`: the quote's replace the lines', as when a quote is redone
 * «con lo sconto del 10%»). A line at 0% needs its reason; a reason on another rate is refused.
 */
export function withDefaults(given: readonly GivenLine[], quote: { vat?: VatRate; vatNote?: string; discount?: string | null }, override: boolean): QuoteLine[] | MissingVat | Problem {
	const pick = <T>(own: T | undefined, wide: T | undefined): T | undefined => (override ? (wide ?? own) : (own ?? wide));
	let missing = 0;
	const out: QuoteLine[] = [];
	for (const [i, line] of given.entries()) {
		const vat = pick(line.vat, quote.vat);
		if (vat === undefined) {
			missing++;
			continue;
		}
		// A reason only belongs to the 0% lines: the quote's reason never lands on a 22% line.
		const vatNote = vat === 0 ? pick(line.vatNote, quote.vatNote) : undefined;
		if (vat !== 0 && line.vatNote !== undefined && !override) return { problem: `riga ${i + 1}: vat_note serve solo per le righe a IVA 0` };
		if (vat === 0 && vatNote === undefined) return { problem: `riga ${i + 1}: con IVA 0 serve il motivo come lo dice chi ti scrive (vat_note), per esempio «operazione in franchigia da IVA, art. 1 c. 54-89 L. 190/2014» per il forfettario, o esente o esclusa con il suo articolo. Non sceglierlo tu: chiedilo` };
		const discount = quote.discount === null ? undefined : pick(line.discount, quote.discount);
		const { vat: _v, vatNote: _n, discount: _d, ...rest } = line;
		out.push({ ...rest, vat, ...(vatNote === undefined ? {} : { vatNote }), ...(discount === undefined ? {} : { discount }) });
	}
	return missing > 0 ? { missingVat: missing } : out;
}

/** A customer's tax id checked on paper: a partita IVA, a body's numeric codice fiscale or a person's codice fiscale. */
export function readTaxId(value: unknown): { vat?: string; fiscal?: string } | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") return { problem: "tax_id è la partita IVA o il codice fiscale del cliente" };
	const id = parseTaxId(value.replace(/^\s*(?:p\.?\s*iva|partita\s+iva|c\.?\s*f\.?|codice\s+fiscale)\s*[:.]?\s*/i, ""));
	const wrong = (why: string) => ({ problem: `la partita IVA o il codice fiscale del cliente non va: ${why}. Ricontrollalo con chi ti scrive, o togli tax_id` });
	switch (id.kind) {
		case "vat":
			return id.problem === undefined ? { vat: id.country === "IT" ? id.number : `${id.country}${id.number}` } : wrong(id.problem);
		case "ente":
			return { fiscal: id.number };
		case "codice_fiscale":
			return "problem" in id.checked ? wrong(id.checked.problem) : { fiscal: id.code };
		case "outside_vies":
		case "unknown":
			return wrong(id.problem);
	}
}

/** The customer from the arguments, over `old` when a quote is redone. */
export function readCustomer(args: Record<string, unknown>, old?: QuoteCustomer): QuoteCustomer | Problem {
	const name = cleanText(args.customer, QUOTE_LIMITS.name, "customer");
	if (isProblem(name)) return name;
	const address = cleanText(args.address, QUOTE_LIMITS.address, "address");
	if (isProblem(address)) return address;
	const email = cleanText(args.email, QUOTE_LIMITS.email, "email");
	if (isProblem(email)) return email;
	if (email !== undefined && !validAddress(email)) return { problem: "l'indirizzo email del cliente non sembra valido" };
	const tax = readTaxId(args.tax_id);
	if (isProblem(tax)) return tax;
	const base = old;
	const finalName = name ?? base?.name;
	if (finalName === undefined) return { problem: "manca il cliente (customer): chiedi a chi ti scrive per chi è il preventivo" };
	const ids = tax ?? (base === undefined ? {} : { ...(base.vat === undefined ? {} : { vat: base.vat }), ...(base.fiscal === undefined ? {} : { fiscal: base.fiscal }) });
	const addr = address ?? base?.address;
	const mail = email ?? base?.email;
	return { name: finalName, ...ids, ...(addr === undefined ? {} : { address: addr }), ...(mail === undefined ? {} : { email: mail }) };
}

/** A safe piece of a file name from a customer's name: ASCII letters and digits joined by «-», at most 40. */
export function fileSlug(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}
