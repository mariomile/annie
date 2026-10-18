/**
 * The sales invoices tool's arguments, read and checked: the lines (descriptions up to
 * FatturaPA's 1000 characters, amounts as digit strings, «1.250» refused as ambiguous), the VAT
 * rate or the nature of each line as the person says it (in the forfettario every line is N2.2 by
 * itself), the payment terms, the ritenuta, the cassa, the customer's own fields, a public
 * administration's order. Nothing is guessed: what is missing comes back to be asked.
 */
import { validAddress } from "../email-address.ts";
import { validIban } from "../iban.ts";
import type { QuoteLine } from "../quotes.ts";
import {
	BOLLO_REFERENCE,
	CASSA_TYPES,
	DEFAULT_METHOD,
	DEFAULT_PAYMENT_DAYS,
	FIELD_LIMITS,
	FORFETTARIO_NATURA,
	INPS_CASSA,
	INPS_RATE,
	INTEGRATIVO_RATE,
	MAX_CASSA_RATE,
	MAX_PAYMENT_DAYS,
	NATURE,
	NOT_FEE_NATURA,
	type Natura,
	PA_CODE,
	PAYMENT_METHODS,
	PRIVATE_CODE,
	type RegimeCode,
	REGIME_FORFETTARIO,
	RITENUTA_CAUSALE,
	RITENUTA_CAUSALI,
	SALES_VAT_RATES,
	type SalesVatRate,
} from "../sales-invoice-rules.ts";
import { buyerCf, type BuyerKind, buyerVat, type Cassa, type Order, type Payment, type Ritenuta, ritenutaType, SALES_LIMITS, type SalesLine } from "../sales-invoices.ts";
import { latin1 } from "../plain-text.ts";
import { fold } from "../text-match.ts";
import { cleanText, isProblem, type Problem, readAmount as readNumber, readPercent as readShare } from "../text-input.ts";
import { fenced } from "./sales-invoice-render.ts";

export { isProblem, type Problem };

const readAmount = (value: unknown, decimals: number, what: string) => readNumber(value, decimals, what, fenced);
const readPercent = (value: unknown, where: string) => readShare(value, where, fenced);

/** A line as given, before the invoice-wide rate and nature. */
export type GivenLine = { description: string; quantity: string; unit?: string; price: string; discount?: string; vat?: SalesVatRate; natura?: Natura; reference?: string; notFee?: true };

/** Whether text fits a field of `max` characters as the XML writes it (latin1 may lengthen «…» or «€»). */
export function fitsLatin(text: string, max: number): boolean {
	return latin1(text).length <= max;
}

/** A nature as said: «N2.2», «n4»; undefined when not given. */
export function readNatura(value: unknown, where: string): Natura | undefined | Problem {
	if (value === undefined) return undefined;
	const said = typeof value === "string" ? value.trim().toUpperCase().replace(/\s+/g, "") : "";
	if (NATURE.includes(said as Natura)) return said as Natura;
	return { problem: `${where}: la natura è un codice come N2.2, N4 o N6.3, come lo dice chi ti scrive o il suo commercialista` };
}

export function readVatRate(value: unknown, where: string): SalesVatRate | undefined | Problem {
	const read = readAmount(value, 2, where);
	if (read === undefined || isProblem(read)) return read;
	if (!SALES_VAT_RATES.includes(Number(read) as SalesVatRate)) return { problem: `${where}: l'aliquota IVA è una di queste: ${SALES_VAT_RATES.join(", ")}` };
	return Number(read) as SalesVatRate;
}

function readLine(raw: unknown, n: number): GivenLine | Problem {
	const where = `riga ${n}`;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problem: `${where}: ogni voce ha una descrizione e un prezzo` };
	const o = raw as Record<string, unknown>;
	const description = cleanText(o.description, FIELD_LIMITS.descrizione, `${where}, la descrizione`);
	if (isProblem(description)) return description;
	if (description === undefined) return { problem: `${where}: manca la descrizione` };
	if (!fitsLatin(description, FIELD_LIMITS.descrizione)) return { problem: `${where}: la descrizione è troppo lunga per la fattura (al massimo ${FIELD_LIMITS.descrizione} caratteri)` };
	const unit = cleanText(o.unit, FIELD_LIMITS.unitaMisura, `${where}, l'unità di misura`);
	if (isProblem(unit)) return unit;
	const quantity = o.quantity === undefined ? "1" : readAmount(o.quantity, 3, `${where}, quantità`);
	if (isProblem(quantity)) return quantity;
	if (quantity === undefined || Number(quantity) <= 0 || Number(quantity) > SALES_LIMITS.maxQuantity) return { problem: `${where}: la quantità è un numero maggiore di zero, al più 3 decimali` };
	const price = readAmount(o.price, 8, `${where}, prezzo`);
	if (isProblem(price)) return price;
	if (price === undefined || Number(price) > SALES_LIMITS.maxPrice) return { problem: `${where}: manca il prezzo unitario, senza IVA` };
	if (Number(price) === 0) return { problem: `${where}: il prezzo è zero; una voce gratuita scrivila nelle note` };
	const discount = readPercent(o.discount, `${where}, sconto`);
	if (isProblem(discount)) return discount;
	const vat = readVatRate(o.vat, where);
	if (isProblem(vat)) return vat;
	const natura = readNatura(o.natura, where);
	if (isProblem(natura)) return natura;
	const reference = cleanText(o.reference, FIELD_LIMITS.riferimentoNormativo, `${where}, il riferimento normativo`);
	if (isProblem(reference)) return reference;
	if (o.advance !== undefined && typeof o.advance !== "boolean") return { problem: `${where}: spesa anticipata è sì o no` };
	if (o.advance === true) {
		// A spesa anticipata in nome e per conto del cliente: outside VAT (N1), not a fee.
		if ((vat !== undefined && vat !== 0) || (natura !== undefined && natura !== NOT_FEE_NATURA)) return { problem: `${where}: una spesa anticipata per conto del cliente è senza IVA (natura N1)` };
		return { description, quantity, price, ...(unit === undefined ? {} : { unit }), vat: 0, natura: NOT_FEE_NATURA, reference: reference ?? BOLLO_REFERENCE, notFee: true };
	}
	return {
		description,
		quantity,
		price,
		...(unit === undefined ? {} : { unit }),
		...(discount === undefined || discount === null ? {} : { discount }),
		...(vat === undefined ? {} : { vat }),
		...(natura === undefined ? {} : { natura }),
		...(reference === undefined ? {} : { reference }),
	};
}

/** The lines as given: 1 to SALES_LIMITS.lines objects. */
export function readLines(value: unknown): GivenLine[] | Problem {
	if (!Array.isArray(value) || value.length === 0) return { problem: "mancano le voci della fattura, ognuna con descrizione e prezzo" };
	if (value.length > SALES_LIMITS.lines) return { problem: `al massimo ${SALES_LIMITS.lines} voci in una fattura` };
	const out: GivenLine[] = [];
	for (const [i, raw] of value.entries()) {
		const line = readLine(raw, i + 1);
		if (isProblem(line)) return line;
		out.push(line);
	}
	return out;
}

/** A quote's line as a given line: its rate as the quote has it; a 0% line's nature still to say (its note is free text). */
export function quoteLine(l: QuoteLine): GivenLine {
	return { description: l.description, quantity: l.quantity, price: l.price, vat: l.vat, ...(l.unit === undefined ? {} : { unit: l.unit }), ...(l.discount === undefined ? {} : { discount: l.discount }) };
}

export type Wide = { readonly vat?: SalesVatRate; readonly natura?: Natura; readonly reference?: string };

/**
 * The lines with the invoice-wide rate and nature. In the forfettario every line is at 0% with
 * nature N2.2, and a line with VAT is refused. In the ordinario a line without a rate, or at 0%
 * without a nature, comes back in `missing` to ask.
 */
export function withRates(given: readonly GivenLine[], wide: Wide, regime: RegimeCode): SalesLine[] | { readonly missing: "vat" | "natura" } | Problem {
	const out: SalesLine[] = [];
	for (const [i, line] of given.entries()) {
		const { vat: ownVat, natura: ownNatura, reference: ownReference, notFee: _, ...rest } = line;
		if (ownNatura === NOT_FEE_NATURA) {
			// A spesa anticipata (N1) in either regime: never a fee.
			if (ownVat !== undefined && ownVat !== 0) return { problem: `riga ${i + 1}: la natura N1 è per le righe senza IVA` };
			out.push({ ...rest, vat: 0, natura: NOT_FEE_NATURA, ...(ownReference === undefined ? {} : { reference: ownReference }), notFee: true });
			continue;
		}
		if (regime === REGIME_FORFETTARIO) {
			if ((ownVat ?? wide.vat ?? 0) !== 0) return { problem: `riga ${i + 1}: in regime forfettario la fattura è senza IVA. Se chi ti scrive è passato all'ordinario, va aggiornato prima il regime nei dati dell'azienda` };
			out.push({ ...rest, vat: 0, natura: FORFETTARIO_NATURA });
			continue;
		}
		const vat = ownVat ?? wide.vat;
		if (vat === undefined) return { missing: "vat" };
		if (vat !== 0) {
			if (ownNatura !== undefined) return { problem: `riga ${i + 1}: la natura serve solo per le righe senza IVA, questa è al ${vat}%` };
			out.push({ ...rest, vat });
			continue;
		}
		const natura = ownNatura ?? wide.natura;
		if (natura === undefined) return { missing: "natura" };
		const reference = ownReference ?? wide.reference;
		out.push({ ...rest, vat: 0, natura, ...(reference === undefined ? {} : { reference }), ...(natura === NOT_FEE_NATURA ? { notFee: true as const } : {}) });
	}
	return out;
}

/** The payment: days (default 30), fine mese, the method (bonifico by default), the IBAN given or the first one saved. */
export function readPayment(args: Record<string, unknown>, saved: readonly string[], fallback?: { readonly days: number; readonly endOfMonth: boolean }): Payment | Problem {
	const days = args.payment_days ?? fallback?.days ?? DEFAULT_PAYMENT_DAYS;
	if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_PAYMENT_DAYS) return { problem: `i giorni di pagamento vanno da 0 (a vista) a ${MAX_PAYMENT_DAYS}` };
	if (args.end_of_month !== undefined && typeof args.end_of_month !== "boolean") return { problem: "fine mese è sì o no" };
	const endOfMonth = args.end_of_month === true || (args.end_of_month === undefined && fallback?.endOfMonth === true);
	let method = DEFAULT_METHOD;
	if (args.method !== undefined) {
		const key = typeof args.method === "string" ? Object.keys(PAYMENT_METHODS).find((k) => fold(args.method as string).replace(/[^a-z]/g, "").startsWith(k)) : undefined;
		if (key === undefined) return { problem: `il pagamento è uno di questi: ${Object.keys(PAYMENT_METHODS).join(", ")}` };
		method = PAYMENT_METHODS[key] as string;
	}
	let iban = saved[0];
	if (args.iban !== undefined) {
		iban = typeof args.iban === "string" ? validIban(args.iban) : undefined;
		if (iban === undefined) return { problem: "l'IBAN non è valido: le cifre di controllo non tornano" };
	}
	return { days, endOfMonth, method, ...(iban === undefined || method !== DEFAULT_METHOD ? {} : { iban }) };
}

/** «bonifico a 60 giorni fine mese» in a quote's terms: the days and fine mese, when written; undefined otherwise. */
export function paymentTermsOf(text: string | undefined): { readonly days: number; readonly endOfMonth: boolean } | undefined {
	if (text === undefined) return undefined;
	const t = fold(text);
	const endOfMonth = /\bfine\s+mese\b|\bf\.?\s?m\.?(?=\s|$|,)/.test(t);
	if (/\ba\s+vista\b|\bvista\s+fattura\b/.test(t)) return { days: 0, endOfMonth: false };
	const m = /\b(\d{1,3})\s*(?:gg|giorni|gg\.)/.exec(t);
	if (m === null) return endOfMonth ? { days: 0, endOfMonth } : undefined;
	const days = Number(m[1]);
	return days <= MAX_PAYMENT_DAYS ? { days, endOfMonth } : undefined;
}

/**
 * The ritenuta d'acconto when asked (true, or the causale): never in the forfettario, and only to a
 * customer that withholds it (a company or a public office). RT01 or RT02 from the seller's codice fiscale.
 */
export function readRitenuta(value: unknown, regime: RegimeCode, sellerCf: string | undefined, buyer: BuyerKind): Ritenuta | undefined | Problem {
	if (value === undefined || value === false) return undefined;
	if (regime === REGIME_FORFETTARIO) return { problem: "in regime forfettario i compensi non hanno la ritenuta d'acconto (L. 190/2014, art. 1, comma 67): non la metto" };
	if (buyer === "private") return { problem: "un privato non è sostituto d'imposta, quindi non trattiene la ritenuta d'acconto: la fattura va senza" };
	if (buyer === "foreign") return { problem: "un cliente estero non è sostituto d'imposta in Italia, quindi non trattiene la ritenuta d'acconto: la fattura va senza" };
	const causale = value === true ? RITENUTA_CAUSALE : typeof value === "string" ? value.trim().toUpperCase() : "";
	if (!RITENUTA_CAUSALI.some((c) => c === causale)) return { problem: `la causale della ritenuta è una di queste: ${RITENUTA_CAUSALI.join(", ")} (A per i professionisti)` };
	return { type: ritenutaType(sellerCf), causale };
}

/**
 * The cassa when asked: the rivalsa INPS (4%, TC22, in the ritenuta's base) or the contributo
 * integrativo of a cassa (its code TC01 to TC21 needed, 4% unless said, outside the base).
 * `missing`: which cassa it is, to ask.
 */
export function readCassa(value: unknown): Cassa | undefined | { readonly missing: "type" } | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "la cassa ha un tipo (rivalsa INPS o contributo integrativo) e la percentuale" };
	const o = value as Record<string, unknown>;
	if (o.kind !== "rivalsa_inps" && o.kind !== "contributo_integrativo") return { problem: "la cassa è la rivalsa INPS o il contributo integrativo di una cassa professionale" };
	const rate = o.rate === undefined ? (o.kind === "rivalsa_inps" ? INPS_RATE : INTEGRATIVO_RATE) : readAmount(o.rate, 2, "la percentuale della cassa");
	if (isProblem(rate)) return rate;
	if (rate === undefined || Number(rate) <= 0 || Number(rate) > MAX_CASSA_RATE) return { problem: `la percentuale della cassa va da più di 0 a ${MAX_CASSA_RATE}` };
	if (o.kind === "rivalsa_inps") return { type: INPS_CASSA, rate, subject: true };
	if (o.type === undefined) return { missing: "type" };
	const type = typeof o.type === "string" ? o.type.trim().toUpperCase() : "";
	if (!CASSA_TYPES.includes(type)) return { problem: `la cassa è un codice da TC01 a TC21 (per esempio TC01 avvocati, TC04 Inarcassa)` };
	return { type, rate, subject: false };
}

/** The customer's own fields as said: partita IVA, codice fiscale, address, codice destinatario, PEC, country. */
export type BuyerFields = { vat?: string; cf?: string; address?: string; code?: string; pec?: string; country?: string };

export function readBuyerFields(args: Record<string, unknown>): BuyerFields | Problem {
	const out: BuyerFields = {};
	if (args.vat_number !== undefined) {
		const v = typeof args.vat_number === "string" ? buyerVat(args.vat_number) : { problem: "la partita IVA va scritta come testo" };
		if ("problem" in v) return v;
		out.vat = v.vat;
	}
	if (args.cf !== undefined) {
		const v = typeof args.cf === "string" ? buyerCf(args.cf) : { problem: "il codice fiscale va scritto come testo" };
		if ("problem" in v) return v;
		out.cf = v.cf;
	}
	const address = cleanText(args.address, 200, "l'indirizzo");
	if (isProblem(address)) return address;
	if (address !== undefined) out.address = address;
	if (args.recipient_code !== undefined) {
		const c = typeof args.recipient_code === "string" ? args.recipient_code.trim().toUpperCase() : "";
		if (!PRIVATE_CODE.test(c) && !PA_CODE.test(c)) return { problem: "il codice destinatario ha 7 caratteri (6 per un ufficio della pubblica amministrazione)" };
		out.code = c;
	}
	if (args.pec !== undefined) {
		const p = typeof args.pec === "string" ? args.pec.trim().toLowerCase() : "";
		if (p.length > FIELD_LIMITS.pec || !validAddress(p)) return { problem: "la PEC del cliente non sembra un indirizzo valido" };
		out.pec = p;
	}
	if (args.country !== undefined) {
		const c = typeof args.country === "string" ? args.country.trim().toUpperCase() : "";
		if (!/^[A-Z]{2}$/.test(c)) return { problem: "il paese è il codice di due lettere (DE, FR, CH…)" };
		out.country = c;
	}
	return out;
}

/** A public administration's order: its number, CIG and CUP as given. */
export function readOrder(value: unknown): Order | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "l'ordine ha un numero e, se ci sono, CIG e CUP" };
	const o = value as Record<string, unknown>;
	const code = (v: unknown, max: number, what: string): string | undefined | Problem => {
		if (v === undefined) return undefined;
		const t = typeof v === "string" ? v.trim() : "";
		return /^[A-Za-z0-9/._-]+$/.test(t) && t.length <= max ? t : { problem: `${what}: lettere e cifre, al massimo ${max}` };
	};
	const id = code(o.id, FIELD_LIMITS.idDocumento, "il numero dell'ordine");
	if (isProblem(id)) return id;
	if (id === undefined) return { problem: "manca il numero dell'ordine" };
	const cig = code(o.cig, FIELD_LIMITS.cig, "il CIG");
	if (isProblem(cig)) return cig;
	const cup = code(o.cup, FIELD_LIMITS.cup, "il CUP");
	if (isProblem(cup)) return cup;
	return { id, ...(cig === undefined ? {} : { cig: cig.toUpperCase() }), ...(cup === undefined ? {} : { cup: cup.toUpperCase() }) };
}
