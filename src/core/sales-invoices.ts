/**
 * Le fatture emesse: the electronic invoices (and credit notes) the owner issues to a customer.
 * One starts as a draft, from an accepted quote, from the hours not yet billed or from lines the
 * person dictates; only when the person says yes it is issued: then it takes the next number of
 * the year (a draft removed takes none), the seller's data of that day and a file name, and its
 * FatturaPA XML is written in the workspace (fattura-pa-writer.ts), where the scadenzario finds it.
 * Nothing is sent to the SdI: the file is uploaded by the person (InvoiceSender is the seam for an
 * intermediary, not implemented). Kept per instance in `sales-invoices.json`
 * (sales-invoice-store.ts); the arithmetic in sales-invoice-sums.ts, the rules in sales-invoice-rules.ts.
 */
import { validAddress } from "./email-address.ts";
import { validIban } from "./iban.ts";
import type { Company } from "./invoices.ts";
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { scaled } from "./quote-sums.ts";
import {
	CASSA_TYPES,
	CREDIT_NOTE_TYPE,
	type DocType,
	FIELD_LIMITS,
	FOREIGN_CAP,
	FOREIGN_CODE,
	INPS_CASSA,
	INVOICE_TYPE,
	MAX_CASSA_RATE,
	MAX_PAYMENT_DAYS,
	NATURE,
	type Natura,
	NO_CHANNEL_CODE,
	PA_CODE,
	PAYMENT_METHODS,
	PRIVATE_CODE,
	PROGRESSIVE_LENGTH,
	REGIME_FORFETTARIO,
	REGIME_ORDINARIO,
	type RegimeCode,
	RITENUTA_CAUSALI,
	RITENUTA_COMPANY,
	RITENUTA_PERSON,
	SALES_VAT_RATES,
	type SalesVatRate,
} from "./sales-invoice-rules.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";
import { checkCodiceFiscale, checkVatNumber } from "./tax-ids.ts";
import type { TaxProfile } from "./taxes.ts";

export class SalesInvoiceError extends Error {
	override readonly name = "SalesInvoiceError";
}

export const SALES_LIMITS = {
	/** Drafts and invoices kept: past it, no new draft. */
	invoices: 20_000,
	/** Invoices issued in one year: the number never goes past it. */
	perYear: 99_999,
	lines: 200,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 500,
	causale: 200,
	/** Entries of hours one invoice bills. */
	hours: 2_000,
	maxPrice: 1_000_000_000,
	maxQuantity: 1_000_000,
	fileBytes: 16 * 1024 * 1024,
} as const;

/** The ops that only read: they run in the brief's thread. */
const SALES_READ_OPS = ["list", "show"] as const;

export function salesCallReads(args: Record<string, unknown>): boolean {
	return SALES_READ_OPS.some((o) => o === args.op);
}

/** What another agente may ask: the list cut to counts and totals, never names, numbers or a draft. */
export function salesAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "list";
}

/**
 * The seam for an intermediary that would transmit the file to the SdI on the person's behalf.
 * Not implemented: today the person uploads the file to «Fatture e Corrispettivi» or to their software.
 */
export interface InvoiceSender {
	/** Hands the XML to the intermediary; the id it gives back, to follow the receipts. */
	send(file: { readonly name: string; readonly xml: string }, signal: AbortSignal): Promise<{ readonly id: string }>;
}

/** An address as FatturaPA writes it: street (number included), CAP, comune, provincia (Italy only), country. */
export type Address = { readonly street: string; readonly cap: string; readonly town: string; readonly province?: string; readonly country: string };

/** The owner as the invoice names them, taken from the company's data the day it is issued. */
export type Seller = {
	readonly name: string;
	/** «IT» and the 11 digits. */
	readonly vat: string;
	readonly cf: string;
	readonly regime: RegimeCode;
	readonly address: Address;
	readonly rea?: { readonly office: string; readonly number: string };
	readonly phone?: string;
	readonly email?: string;
};

/** business: an Italian partita IVA; private: an Italian person with codice fiscale only; foreign; pa: a public office (codice univoco of 6). */
export type BuyerKind = "business" | "private" | "foreign" | "pa";

export type Buyer = {
	readonly name: string;
	readonly kind: BuyerKind;
	/** «IT01234567897», or a foreign VAT number with its prefix. */
	readonly vat?: string;
	readonly cf?: string;
	readonly address: Address;
	/** CodiceDestinatario: 7 characters, 6 for a public office, «0000000», «XXXXXXX». */
	readonly code: string;
	readonly pec?: string;
	/** The client's card it came from (clients.ts), when there is one. */
	readonly card?: string;
};

/** A line as stored: canonical decimal strings («1.5», «1250»); a 0% line has its nature. */
export type SalesLine = {
	readonly description: string;
	readonly quantity: string;
	readonly unit?: string;
	readonly price: string;
	readonly discount?: string;
	readonly vat: SalesVatRate;
	readonly natura?: Natura;
	/** The law a 0% line rests on, as the person says it (RiferimentoNormativo). */
	readonly reference?: string;
};

export type Ritenuta = { readonly type: typeof RITENUTA_PERSON | typeof RITENUTA_COMPANY; readonly causale: string };

/** A cassa on the fees: its code, rate, and whether it is in the ritenuta's base (the rivalsa INPS is). */
export type Cassa = { readonly type: string; readonly rate: string; readonly subject: boolean };

export type Payment = { readonly days: number; readonly endOfMonth: boolean; readonly method: string; readonly iban?: string };

/** The invoice a credit note corrects: its number, its date, its draft id. */
export type Related = { readonly number: string; readonly date: string; readonly id: string };

/** A public administration's order: its number and, when given, CIG and CUP. */
export type Order = { readonly id: string; readonly cig?: string; readonly cup?: string };

/** An entry of hours the invoice bills, with its minutes and terms when the draft was made: checked again at issue. */
export type HoursRef = { readonly id: string; readonly minutes: number; readonly rate: string; readonly rounding: number };

export type SalesInvoice = Marker & {
	/** «BZ-0001», never used again. */
	readonly id: string;
	readonly type: DocType;
	readonly regime: RegimeCode;
	readonly buyer: Buyer;
	readonly lines: readonly SalesLine[];
	readonly ritenuta?: Ritenuta;
	readonly cassa?: Cassa;
	/** The bollo, when due: charged to the customer (a line) or paid by the owner. */
	readonly bolloToClient?: boolean;
	readonly splitPayment?: true;
	readonly payment?: Payment;
	readonly order?: Order;
	readonly related?: Related;
	readonly causale?: string;
	/** The quote it bills, and the hours. */
	readonly quote?: string;
	readonly hours?: readonly HoursRef[];
	/** The call that made the draft: a call run again finds it. */
	readonly callId: string;
	// Set when issued.
	readonly number?: string;
	readonly year?: number;
	readonly seq?: number;
	readonly date?: string;
	readonly due?: string;
	readonly seller?: Seller;
	readonly progressive?: string;
	readonly file?: string;
	readonly pdf?: string;
	readonly issued?: Marker;
	readonly issueCall?: string;
};

export type IssuedInvoice = SalesInvoice & { readonly number: string; readonly year: number; readonly seq: number; readonly date: string; readonly seller: Seller; readonly progressive: string; readonly issued: Marker };

export function isIssued(i: SalesInvoice): i is IssuedInvoice {
	return i.number !== undefined;
}

/** «12» or «2026/12», as the person chose once. */
export type Numbering = "plain" | "year";

export function invoiceNumber(year: number, seq: number, numbering: Numbering): string {
	return numbering === "year" ? `${year}/${seq}` : String(seq);
}

export const draftId = (n: number) => `BZ-${String(n).padStart(4, "0")}`;
export const DRAFT_ID = /^BZ-(\d{4,6})$/;

/** The file's progressive: `n` in base 36, upper case, 5 characters. */
export function progressiveCode(n: number): string {
	return n.toString(36).toUpperCase().padStart(PROGRESSIVE_LENGTH, "0");
}

/** The format of the transmission: FPA12 to a public office, FPR12 otherwise. */
export function formatOf(buyer: Pick<Buyer, "kind">): "FPA12" | "FPR12" {
	return buyer.kind === "pa" ? "FPA12" : "FPR12";
}

export const docWord = (type: DocType) => (type === CREDIT_NOTE_TYPE ? "nota di credito" : "fattura");

/** «Via Roma 1, 20121 Milano (MI)», «Via Roma 1 - 20121 Milano MI», with or without «Italia» at the end. */
const ITALIAN_ADDRESS = /^(.+?)[\s,;-]+(\d{5})\s+(.+?)[\s,]*\(?\b([A-Za-z]{2})\)?$/;

/** An Italian address in its parts, or undefined when CAP, comune or provincia cannot be told apart. */
export function italianAddress(text: string): Address | undefined {
	const flat = text.replace(/\s+/g, " ").replace(/[\s,]*\bitalia\s*$/i, "").trim();
	const m = ITALIAN_ADDRESS.exec(flat);
	if (m === null) return undefined;
	const street = (m[1] as string).replace(/[\s,;-]+$/, "").trim();
	const town = (m[3] as string).replace(/[\s,;-]+$/, "").trim();
	if (street === "" || town === "" || street.length > FIELD_LIMITS.indirizzo || town.length > FIELD_LIMITS.comune) return undefined;
	return { street, cap: m[2] as string, town, province: (m[4] as string).toUpperCase(), country: "IT" };
}

/** A foreign address: the street, then the town (its postal code inside) after the last comma. */
export function foreignAddress(text: string, country: string): Address | undefined {
	const flat = text.replace(/\s+/g, " ").trim();
	const at = flat.lastIndexOf(",");
	if (at < 0) return undefined;
	const street = flat.slice(0, at).trim();
	const town = flat.slice(at + 1).trim();
	if (street === "" || town === "" || street.length > FIELD_LIMITS.indirizzo || town.length > FIELD_LIMITS.comune) return undefined;
	return { street, cap: FOREIGN_CAP, town, country };
}

/** The address in one line, as a person writes it. */
export function addressText(a: Address): string {
	return a.country === "IT" ? `${a.street}, ${a.cap} ${a.town}${a.province === undefined ? "" : ` (${a.province})`}` : `${a.street}, ${a.town}, ${a.country}`;
}

/** The country of a VAT number's prefix, as FatturaPA writes it (Greece is EL in VIES, GR here). */
export function vatCountry(vat: string): string {
	const prefix = vat.slice(0, 2).toUpperCase();
	return prefix === "EL" ? "GR" : prefix;
}

/** The regime of the owner: as set with the company, else forfettario when the taxes' profile is there; undefined when not known. */
export function regimeOf(company: Pick<Company, "regime"> | undefined, profile: TaxProfile | undefined): RegimeCode | undefined {
	if (company?.regime === "forfettario") return REGIME_FORFETTARIO;
	if (company?.regime === "ordinario") return REGIME_ORDINARIO;
	return profile === undefined ? undefined : REGIME_FORFETTARIO;
}

const REA = /^([A-Z]{2})-(\d{1,7})$/;

/**
 * The seller from the company's data, or what FatturaPA needs that is missing (in words, to ask):
 * the name, the partita IVA, the codice fiscale, the regime, the address with CAP, comune and
 * provincia. Nothing is guessed.
 */
export function sellerOf(company: Company | undefined, profile: TaxProfile | undefined): { readonly seller: Seller } | { readonly missing: readonly string[] } {
	const missing: string[] = [];
	const name = company?.name;
	if (name === undefined) missing.push("la ragione sociale (o nome e cognome)");
	else if (name.length > FIELD_LIMITS.denominazione) missing.push(`un nome dell'azienda più corto: in fattura al massimo ${FIELD_LIMITS.denominazione} caratteri`);
	const vat = company?.vat;
	if (vat === undefined) missing.push("la partita IVA");
	else if (!/^IT\d{11}$/.test(vat)) missing.push("una partita IVA italiana");
	const cf = company?.cf;
	if (cf === undefined) missing.push("il codice fiscale (per una società di solito è uguale alla partita IVA)");
	const regime = regimeOf(company, profile);
	if (regime === undefined) missing.push("il regime fiscale: ordinario o forfettario");
	const address = company?.address === undefined ? undefined : italianAddress(company.address);
	if (address === undefined) missing.push(company?.address === undefined ? "l'indirizzo della sede, con CAP, comune e provincia" : "l'indirizzo della sede scritto con CAP, comune e provincia, come «Via Roma 1, 20121 Milano MI»");
	if (missing.length > 0 || name === undefined || vat === undefined || cf === undefined || regime === undefined || address === undefined) return { missing };
	const rea = company?.rea === undefined ? null : REA.exec(company.rea);
	const phone = company?.phone?.replace(/[^\d+]/g, "");
	return {
		seller: {
			name,
			vat,
			cf,
			regime,
			address,
			...(rea === null || rea === undefined ? {} : { rea: { office: rea[1] as string, number: rea[2] as string } }),
			...(phone === undefined || phone.length < 5 || phone.length > 12 ? {} : { phone }),
			...(company?.email === undefined || company.email.length > FIELD_LIMITS.email ? {} : { email: company.email }),
		},
	};
}

/** RT01 for a person (a personal codice fiscale), RT02 for a company. */
export function ritenutaType(cf: string | undefined): Ritenuta["type"] {
	return cf !== undefined && /^[A-Z]{6}/.test(cf) ? RITENUTA_PERSON : RITENUTA_COMPANY;
}

// Validation of what is stored: what does not have this shape makes the store unreadable.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY = /^\d{1,12}(?:\.\d{1,3})?$/;
const PRICE = /^\d{1,12}(?:\.\d{1,8})?$/;
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);
const oneLine = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const percent = (v: unknown, max: number) => typeof v === "string" && PERCENT.test(v) && Number(v) > 0 && Number(v) <= max;

function validAddressParts(v: unknown): v is Address {
	if (typeof v !== "object" || v === null) return false;
	const a = v as Address;
	if (!oneLine(a.street, FIELD_LIMITS.indirizzo) || !oneLine(a.town, FIELD_LIMITS.comune) || typeof a.cap !== "string" || !/^\d{5}$/.test(a.cap)) return false;
	if (typeof a.country !== "string" || !/^[A-Z]{2}$/.test(a.country)) return false;
	return a.province === undefined ? a.country !== "IT" : typeof a.province === "string" && /^[A-Z]{2}$/.test(a.province) && a.country === "IT";
}

function validSeller(v: unknown): v is Seller {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Seller;
	if (!oneLine(s.name, FIELD_LIMITS.denominazione) || typeof s.vat !== "string" || !/^IT\d{11}$/.test(s.vat) || typeof s.cf !== "string" || !/^[A-Z0-9]{11,16}$/.test(s.cf)) return false;
	if (s.regime !== REGIME_ORDINARIO && s.regime !== REGIME_FORFETTARIO) return false;
	if (s.rea !== undefined && (typeof s.rea.office !== "string" || !/^[A-Z]{2}$/.test(s.rea.office) || typeof s.rea.number !== "string" || !/^\d{1,7}$/.test(s.rea.number))) return false;
	if (s.phone !== undefined && (typeof s.phone !== "string" || !/^\+?\d{4,11}$/.test(s.phone))) return false;
	return validAddressParts(s.address) && (s.email === undefined || (typeof s.email === "string" && validAddress(s.email)));
}

/** A buyer as kept: its kind agrees with its tax ids and its code. */
export function validBuyer(v: unknown): v is Buyer {
	if (typeof v !== "object" || v === null) return false;
	const b = v as Buyer;
	if (!oneLine(b.name, FIELD_LIMITS.denominazione) || !validAddressParts(b.address) || typeof b.code !== "string") return false;
	if (b.vat !== undefined && (typeof b.vat !== "string" || !/^[A-Z]{2}[0-9A-Z+*.]{2,28}$/.test(b.vat))) return false;
	if (b.cf !== undefined && (typeof b.cf !== "string" || !/^[A-Z0-9]{11,16}$/.test(b.cf))) return false;
	if (b.pec !== undefined && (typeof b.pec !== "string" || b.pec.length > FIELD_LIMITS.pec || !validAddress(b.pec))) return false;
	if (b.card !== undefined && (typeof b.card !== "string" || !/^CL-\d{4,6}$/.test(b.card))) return false;
	switch (b.kind) {
		case "business":
			return b.vat?.startsWith("IT") === true && (PRIVATE_CODE.test(b.code) || b.code === NO_CHANNEL_CODE) && b.address.country === "IT";
		case "private":
			return b.vat === undefined && b.cf !== undefined && (PRIVATE_CODE.test(b.code) || b.code === NO_CHANNEL_CODE) && b.address.country === "IT";
		case "foreign":
			return b.code === FOREIGN_CODE && b.address.country !== "IT";
		case "pa":
			return PA_CODE.test(b.code) && (b.vat !== undefined || b.cf !== undefined);
		default:
			return false;
	}
}

function validLine(v: unknown): v is SalesLine {
	if (typeof v !== "object" || v === null) return false;
	const l = v as SalesLine;
	if (!isText(l.description, FIELD_LIMITS.descrizione) || !optText(l.unit, FIELD_LIMITS.unitaMisura) || !optText(l.reference, FIELD_LIMITS.riferimentoNormativo)) return false;
	if (typeof l.quantity !== "string" || !QUANTITY.test(l.quantity) || Number(l.quantity) <= 0 || Number(l.quantity) > SALES_LIMITS.maxQuantity) return false;
	if (typeof l.price !== "string" || !PRICE.test(l.price) || scaled(l.price, 8) <= 0n || Number(l.price) > SALES_LIMITS.maxPrice) return false;
	if (l.discount !== undefined && (!percent(l.discount, 100) || Number(l.discount) >= 100)) return false;
	if (!SALES_VAT_RATES.includes(l.vat)) return false;
	return l.vat === 0 ? NATURE.includes(l.natura as Natura) : l.natura === undefined && l.reference === undefined;
}

function validPayment(v: unknown): v is Payment {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Payment;
	if (!Number.isInteger(p.days) || p.days < 0 || p.days > MAX_PAYMENT_DAYS || typeof p.endOfMonth !== "boolean") return false;
	if (!Object.values(PAYMENT_METHODS).includes(p.method)) return false;
	return p.iban === undefined || (typeof p.iban === "string" && validIban(p.iban) === p.iban);
}

function validCassa(v: unknown): v is Cassa {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Cassa;
	return (c.type === INPS_CASSA || CASSA_TYPES.includes(c.type)) && percent(c.rate, MAX_CASSA_RATE) && typeof c.subject === "boolean";
}

function validRitenuta(v: unknown): v is Ritenuta {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Ritenuta;
	return (r.type === RITENUTA_PERSON || r.type === RITENUTA_COMPANY) && RITENUTA_CAUSALI.some((c) => c === r.causale);
}

const code = (v: unknown, max: number) => typeof v === "string" && /^[A-Za-z0-9/._-]+$/.test(v) && v.length <= max;

/** A draft or an invoice as stored, checked field by field. */
export function validInvoice(v: unknown): v is SalesInvoice {
	if (!isMarker(v)) return false;
	const i = v as SalesInvoice;
	if (typeof i.id !== "string" || !DRAFT_ID.test(i.id) || (i.type !== INVOICE_TYPE && i.type !== CREDIT_NOTE_TYPE)) return false;
	if ((i.regime !== REGIME_ORDINARIO && i.regime !== REGIME_FORFETTARIO) || !validBuyer(i.buyer) || !isText(i.callId, 200)) return false;
	if (!Array.isArray(i.lines) || i.lines.length === 0 || i.lines.length > SALES_LIMITS.lines || !i.lines.every(validLine)) return false;
	if (i.ritenuta !== undefined && !validRitenuta(i.ritenuta)) return false;
	if (i.cassa !== undefined && !validCassa(i.cassa)) return false;
	if (i.bolloToClient !== undefined && typeof i.bolloToClient !== "boolean") return false;
	if (i.splitPayment !== undefined && i.splitPayment !== true) return false;
	if (i.payment !== undefined && (!validPayment(i.payment) || i.type !== INVOICE_TYPE)) return false;
	if (i.order !== undefined && (!code(i.order.id, FIELD_LIMITS.idDocumento) || (i.order.cig !== undefined && !code(i.order.cig, FIELD_LIMITS.cig)) || (i.order.cup !== undefined && !code(i.order.cup, FIELD_LIMITS.cup)))) return false;
	if ((i.related === undefined) !== (i.type === INVOICE_TYPE)) return false;
	if (i.related !== undefined && (!isText(i.related.number, FIELD_LIMITS.numero) || !isDay(i.related.date) || typeof i.related.id !== "string" || !DRAFT_ID.test(i.related.id))) return false;
	if (!optText(i.causale, SALES_LIMITS.causale) || !optText(i.quote, 30)) return false;
	if (i.hours !== undefined && (!Array.isArray(i.hours) || i.hours.length > SALES_LIMITS.hours || !i.hours.every((h) => typeof h === "object" && h !== null && typeof h.id === "string" && /^O-\d{4}-\d{4,6}$/.test(h.id) && Number.isInteger(h.minutes) && h.minutes > 0 && typeof h.rate === "string" && PRICE.test(h.rate) && Number.isInteger(h.rounding)))) return false;
	if (i.number === undefined) return [i.year, i.seq, i.date, i.due, i.seller, i.progressive, i.file, i.pdf, i.issued, i.issueCall].every((x) => x === undefined);
	if (!isText(i.number, FIELD_LIMITS.numero) || !Number.isInteger(i.year) || !Number.isInteger(i.seq) || (i.seq as number) < 1 || !isDay(i.date) || Number(i.date?.slice(0, 4)) !== i.year) return false;
	if (i.due !== undefined && !isDay(i.due)) return false;
	if (!validSeller(i.seller) || typeof i.progressive !== "string" || !/^[0-9A-Z]{5}$/.test(i.progressive) || !isMarker(i.issued) || !optText(i.issueCall, 200)) return false;
	for (const path of [i.file, i.pdf]) if (path !== undefined && (typeof path !== "string" || !/^fatture\/emesse\/IT\d{11}_[0-9A-Z]{5}\.(?:xml|pdf)$/.test(path))) return false;
	return true;
}

export const validCall = (v: unknown): boolean => isText(v, 200);

/** A buyer's partita IVA as kept: «IT» and 11 digits for an Italian one, the prefix and the number for a foreign one; a problem otherwise. */
export function buyerVat(text: string): { readonly vat: string } | { readonly problem: string } {
	const checked = checkVatNumber(text);
	if (checked === undefined) return { problem: "questo sembra un codice fiscale di una persona, non una partita IVA" };
	if ("problem" in checked) return { problem: `la partita IVA del cliente non va: ${checked.problem}` };
	return { vat: /^\d{11}$/.test(checked.number) ? `IT${checked.number}` : checked.number };
}

/** A buyer's codice fiscale: a person's 16 characters (checked) or a body's 11 digits. */
export function buyerCf(text: string): { readonly cf: string } | { readonly problem: string } {
	const compact = text.replace(/[\s.\-/]/g, "").toUpperCase();
	if (/^\d{11}$/.test(compact)) return { cf: compact };
	const checked = checkCodiceFiscale(compact);
	return "problem" in checked ? { problem: `il codice fiscale del cliente non va: ${checked.problem}` } : { cf: checked.code };
}
