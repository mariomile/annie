/**
 * The quote tool's arguments, read and checked: the customer (its tax id checked on paper with
 * tax-ids.ts), the lines with their amounts as digit strings, the VAT rate of every line as the
 * person said it, the cassa and the acconto. A missing rate is not guessed: the caller asks. An
 * amount that reads two ways («1.250») is refused, never guessed either.
 */
import { validAddress } from "../email-address.ts";
import { FORFETTARIO_NOTE, QUOTE_LIMITS, type QuoteCustomer, type QuoteLine } from "../quotes.ts";
import { AMBIGUOUS, CASSA_KINDS, type Cassa, type CassaKind, decimalText, readDecimal, VAT_RATES, type VatRate } from "../quote-sums.ts";
import { CONTROL_CHARS } from "../plain-text.ts";
import { parseTaxId } from "../tax-ids.ts";
import { fenced } from "./quote-render.ts";

export type Problem = { readonly problem: string };

export const isProblem = (v: unknown): v is Problem => typeof v === "object" && v !== null && "problem" in v;

/** A line as given, before the quote-wide defaults; `own`: given in this call (not kept from the version before). */
export type GivenLine = { description: string; unit?: string; quantity: string; price: string; discount?: string; vat?: VatRate; vatNote?: string; own: boolean };

const TAX_LABEL = /^\s*(?:p\.?\s*iva|partita\s+iva|c\.?\s*f\.?|codice\s+fiscale)\s*[:.]?\s*/i;

/** Text the person gave, with control characters and spare spaces out; newlines kept only where `lines` allows. */
export function cleanText(value: unknown, max: number, name: string, lines = false): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: `${name} è un testo` };
	const text = value
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_CHARS, " ")
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l !== "")
		.join(lines ? "\n" : " ");
	if (text === "") return undefined;
	if (text.length > max) return { problem: `${name} è troppo lungo (al massimo ${max} caratteri)` };
	return text;
}

/** A decimal as given, or why not: «1.250» reads two ways and is asked, not guessed. */
export function readAmount(value: unknown, decimals: number, what: string): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "number" && typeof value !== "string") return { problem: `${what}: dammi un numero` };
	const read = readDecimal(value, decimals);
	// Echoed as written only when it is digits and separators; anything else inside the fence.
	const text = String(value);
	const said = /^[\d .,€%-]{1,20}$/.test(text) ? `«${text}»` : fenced(text.slice(0, 20));
	if (read === AMBIGUOUS) return { problem: `${what}: ${said} può voler dire migliaia o decimali. Chiedi a chi ti scrive, o passa il valore come numero JSON (1250 o 1.25)` };
	if (read === undefined) return { problem: `${what}: ${said} non è un numero che so leggere (al più ${decimals} decimali, senza segno meno)` };
	return read;
}

/** A VAT rate as given: 22, «22», «22%»; undefined when not given. */
export function readVat(value: unknown, where: string): VatRate | undefined | Problem {
	const read = readAmount(value, 2, where);
	if (read === undefined || isProblem(read)) return read;
	if (!VAT_RATES.includes(Number(read) as VatRate)) return { problem: `${where}: l'aliquota IVA è una di queste: ${VAT_RATES.join(", ")} (per lo 0 serve il motivo in vat_note)` };
	return Number(read) as VatRate;
}

/** A percent from more than 0 to less than 100; 0 means none, given back as null. */
export function readPercent(value: unknown, where: string): string | null | undefined | Problem {
	const read = readAmount(value, 2, where);
	if (read === undefined || isProblem(read)) return read;
	if (Number(read) === 0) return null;
	if (Number(read) >= 100) return { problem: `${where}: la percentuale va da 0 a meno di 100` };
	return read;
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
	const quantity = o.quantity === undefined ? "1" : readAmount(o.quantity, 3, `${where}, quantità`);
	if (isProblem(quantity)) return quantity;
	if (quantity === undefined || Number(quantity) <= 0 || Number(quantity) > QUOTE_LIMITS.maxQuantity) return { problem: `${where}: la quantità è un numero maggiore di zero, al più 3 decimali` };
	const price = readAmount(o.price, 4, `${where}, prezzo`);
	if (isProblem(price)) return price;
	if (price === undefined || Number(price) > QUOTE_LIMITS.maxPrice) return { problem: `${where}: manca il prezzo unitario, un importo come 500 o 1.234,56` };
	// A free line is refused, not drawn: an «omaggio» belongs in the notes, so no line reads 0,00 € by mistake.
	if (Number(price) === 0) return { problem: `${where}: il prezzo è zero. Una voce in omaggio scrivila nelle note (notes), non come riga` };
	const discount = readPercent(o.discount, `${where}, sconto`);
	if (isProblem(discount)) return { problem: `${discount.problem}. Una voce gratis scrivila nelle note (notes)` };
	const vat = readVat(o.vat, where);
	if (isProblem(vat)) return vat;
	const vatNote = cleanText(o.vat_note, QUOTE_LIMITS.vatNote, `${where}, vat_note`);
	if (isProblem(vatNote)) return vatNote;
	return {
		description,
		quantity,
		price,
		own: true,
		...(unit === undefined ? {} : { unit }),
		...(discount === undefined || discount === null ? {} : { discount }),
		...(vat === undefined ? {} : { vat }),
		...(vatNote === undefined ? {} : { vatNote }),
	};
}

/** The items as given in `name`: 1 to QUOTE_LIMITS.lines objects. */
export function readItems(value: unknown, name = "items"): GivenLine[] | Problem {
	if (!Array.isArray(value) || value.length === 0) return { problem: `${name} è l'elenco delle voci, almeno una, ognuna con description e price` };
	if (value.length > QUOTE_LIMITS.lines) return { problem: `al massimo ${QUOTE_LIMITS.lines} voci in un preventivo` };
	const lines: GivenLine[] = [];
	for (const [i, raw] of value.entries()) {
		const line = readLine(raw, i + 1);
		if (isProblem(line)) return line;
		lines.push(line);
	}
	return lines;
}

export type Wide = { readonly vat?: VatRate; readonly vatNote?: string; readonly discount?: string | null };

/**
 * The lines with the quote-wide rate, reason and discount applied. A line's own values win and the
 * quote's fill the rest; on lines kept from the version before (`own` false) the quote's replace
 * them, as when a quote is redone «con lo sconto del 10%». With `forfettario`, a line without a
 * rate is at 0% with the regime's note. A reason given for a line, or for the quote, that ends on
 * no 0% line is refused, never dropped. `missing`: the lines that still have no rate.
 */
export function withDefaults(given: readonly GivenLine[], wide: Wide, forfettario: boolean): QuoteLine[] | { missing: string[] } | Problem {
	const missing: string[] = [];
	const out: QuoteLine[] = [];
	for (const [i, line] of given.entries()) {
		const pick = <T>(own: T | undefined, quote: T | undefined): T | undefined => (line.own ? (own ?? quote) : (quote ?? own));
		let vat = pick(line.vat, wide.vat);
		let vatNote = pick(line.vatNote, wide.vatNote);
		if (vat === undefined && forfettario) {
			vat = 0;
			vatNote ??= FORFETTARIO_NOTE;
		}
		if (vat === undefined) {
			missing.push(line.description);
			continue;
		}
		if (vat !== 0 && line.own && line.vatNote !== undefined) return { problem: `riga ${i + 1}: vat_note serve solo per le righe a IVA 0, questa è al ${vat}%` };
		if (vat !== 0) vatNote = undefined;
		if (vat === 0 && vatNote === undefined) return { problem: `riga ${i + 1}: con IVA 0 serve il motivo come lo dice chi ti scrive (vat_note), per esempio esente o esclusa con il suo articolo; per il regime forfettario usa questa dicitura: «${FORFETTARIO_NOTE}». Non sceglierlo tu: chiedilo` };
		const discount = wide.discount === null ? undefined : pick(line.discount, wide.discount);
		const { vat: _v, vatNote: _n, discount: _d, own: _o, ...rest } = line;
		out.push({ ...rest, vat, ...(vatNote === undefined ? {} : { vatNote }), ...(discount === undefined ? {} : { discount }) });
	}
	if (missing.length > 0) return { missing };
	if (wide.vatNote !== undefined && !out.some((l) => l.vat === 0)) return { problem: "vat_note serve solo se almeno una voce è a IVA 0: nessuna lo è" };
	return out;
}

/** The cassa as given: kind, rate (more than 0, at most 10) and an optional label. */
export function readCassa(value: unknown): Cassa | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "cassa è un oggetto con kind e rate" };
	const o = value as Record<string, unknown>;
	if (!CASSA_KINDS.includes(o.kind as CassaKind)) return { problem: `cassa.kind è ${CASSA_KINDS.join(" o ")}` };
	const rate = readAmount(o.rate, 2, "cassa.rate");
	if (isProblem(rate)) return rate;
	if (rate === undefined || Number(rate) <= 0 || Number(rate) > 10) return { problem: "cassa.rate è la percentuale detta da chi ti scrive, da più di 0 a 10" };
	const label = cleanText(o.label, QUOTE_LIMITS.cassaLabel, "cassa.label");
	if (isProblem(label)) return label;
	const kind = o.kind as CassaKind;
	return { kind, rate, label: label ?? `${kind === "rivalsa_inps" ? "Rivalsa INPS" : "Contributo integrativo"} ${decimalText(rate)}%` };
}

/** A customer's tax id checked on paper: a partita IVA, a body's numeric codice fiscale or a person's codice fiscale. */
export function readTaxId(value: unknown): { vat?: string; fiscal?: string } | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") return { problem: "tax_id è la partita IVA o il codice fiscale del cliente" };
	const id = parseTaxId(value.replace(TAX_LABEL, ""));
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

/** The customer from the arguments, over `old` (the version before, or a past quote to the same customer). */
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
	const finalName = name ?? old?.name;
	if (finalName === undefined) return { problem: "manca il cliente (customer): chiedi a chi ti scrive per chi è il preventivo" };
	const ids = tax ?? (old === undefined ? {} : { ...(old.vat === undefined ? {} : { vat: old.vat }), ...(old.fiscal === undefined ? {} : { fiscal: old.fiscal }) });
	const addr = address ?? old?.address;
	const mail = email ?? old?.email;
	return { name: finalName, ...ids, ...(addr === undefined ? {} : { address: addr }), ...(mail === undefined ? {} : { email: mail }) };
}

/** A safe piece of a file name from a customer's name: ASCII letters and digits joined by «-», at most 40. */
export function fileSlug(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}
