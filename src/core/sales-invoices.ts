/**
 * Le fatture emesse: the electronic invoices (and credit notes) the owner issues to a customer.
 * One starts as a draft, from an accepted quote, from the hours not yet billed or from lines the
 * person dictates; only when the person says yes it is issued: then it takes the next number of
 * the year (a draft removed takes none), the seller's data of that day and a file name, and its
 * FatturaPA XML is written in the workspace (fattura-pa-writer.ts), where the scadenzario finds it.
 * Nothing is sent to the SdI: the person uploads the file. Kept per instance in `sales-invoices.json`
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
	DEFERRED_TYPE,
	type DocType,
	FIELD_LIMITS,
	FOREIGN_CAP,
	FOREIGN_CODE,
	INPS_CASSA,
	INVOICE_TYPE,
	isInvoiceType,
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
	NOT_FEE_NATURA,
	SALES_VAT_RATES,
	type SalesVatRate,
	SELLER_PHONE,
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
	/** «IT» and the 11 digits, or a foreign VAT number with its prefix. */
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
	/** Not a fee: a spesa anticipata in nome e per conto del cliente (N1) or the bollo. Outside the ritenuta's and the cassa's base. */
	readonly notFee?: true;
	/** The voce of the listino it was filled from (LS-0001): issued, it moves the magazzino when the voce is an article there. */
	readonly item?: string;
	/** A fattura differita's line: the DDT (DT-0001) and its line it bills. The DDT moved the magazzino already: the invoice does not. */
	readonly ddt?: LineDdt;
};

/** The DDT line an invoice line bills. */
export type LineDdt = { readonly id: string; readonly line: number };

/** A DDT a fattura differita bills (DatiDDT): its id, its number and its date. */
export type DdtRef = { readonly id: string; readonly number: string; readonly date: string };

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
	/** A fattura differita (TD24): the DDTs it bills, marked billed when it is issued. */
	readonly ddt?: readonly DdtRef[];
	/** A credit note of a fattura differita sent to the wrong customer: issued, the DDTs that invoice billed are to bill again (a differita to the right one). */
	readonly release?: true;
	/** The call that made the draft: a call run again finds it. */
	readonly callId: string;
	/** A draft made in place of another (replace): the call that made the first of them, so who made that one still finds it. */
	readonly origin?: string;
	/** The number the draft said it would take, issued that day: at issue a different one is explained. */
	readonly expected?: string;
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
	/** Every needed step of the issue done (file, hours, quote): an issue or finish run on an invoice without it finishes them. */
	readonly finished?: true;
	/** The issue recorded in the audit, after it was finished: a finished invoice without it is audited on the next run. */
	readonly audited?: true;
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
	if (name === undefined) missing.push("nome o ragione sociale");
	else if (name.length > FIELD_LIMITS.denominazione) missing.push(`un nome più corto (al massimo ${FIELD_LIMITS.denominazione} caratteri)`);
	const vat = company?.vat;
	if (vat === undefined) missing.push("partita IVA");
	else if (!/^IT\d{11}$/.test(vat)) missing.push("partita IVA italiana");
	const cf = company?.cf;
	if (cf === undefined) missing.push("codice fiscale");
	const regime = regimeOf(company, profile);
	if (regime === undefined) missing.push("regime (ordinario o forfettario)");
	const address = company?.address === undefined ? undefined : italianAddress(company.address);
	if (address === undefined) missing.push(company?.address === undefined ? "indirizzo con CAP, comune e provincia" : "indirizzo scritto con CAP, comune e provincia, come «Via Roma 1, 20121 Milano MI»");
	if (missing.length > 0 || name === undefined || vat === undefined || cf === undefined || regime === undefined || address === undefined) return { missing };
	const rea = company?.rea === undefined ? null : REA.exec(company.rea);
	const phone = company?.phone?.replace(/[^\d+]/g, "");
	const email = company?.email;
	return {
		seller: {
			name,
			vat,
			cf,
			regime,
			address,
			...(rea === null || rea === undefined ? {} : { rea: { office: rea[1] as string, number: rea[2] as string } }),
			...(phone === undefined || !SELLER_PHONE.test(phone) ? {} : { phone }),
			...(email === undefined || email.length > FIELD_LIMITS.email || !validAddress(email) ? {} : { email }),
		},
	};
}

/** A person's codice fiscale (letters first), not a company's 11 digits. */
export const PERSON_CF = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}/;

/** Whether the seller is a person: a professional, whose fees to a company bear the ritenuta. */
export const isPersonCf = (cf: string | undefined): boolean => cf !== undefined && PERSON_CF.test(cf);

/** RT01 for a person (a personal codice fiscale), RT02 for a company. */
export function ritenutaType(cf: string | undefined): Ritenuta["type"] {
	return isPersonCf(cf) ? RITENUTA_PERSON : RITENUTA_COMPANY;
}

// Validation of what is stored: what does not have this shape makes the store unreadable. Each
// check names the field that fails, in words, so an issue refused says which one.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY = /^\d{1,12}(?:\.\d{1,3})?$/;
const PRICE = /^\d{1,12}(?:\.\d{1,8})?$/;
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);
/** Text on one line (no line break) of at most `max` characters. */
const isLine = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const percent = (v: unknown, max: number) => typeof v === "string" && PERCENT.test(v) && Number(v) > 0 && Number(v) <= max;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The first problem of a list of [failing, what], or undefined. */
const first = (checks: readonly (readonly [boolean, string])[]): string | undefined => checks.find(([bad]) => bad)?.[1];

function addressProblem(v: unknown, whose: string): string | undefined {
	if (!record(v)) return `l'indirizzo ${whose}`;
	const a = v as Address;
	return first([
		[!isLine(a.street, FIELD_LIMITS.indirizzo), `la via ${whose} (al massimo ${FIELD_LIMITS.indirizzo} caratteri)`],
		[!isLine(a.town, FIELD_LIMITS.comune), `il comune ${whose} (al massimo ${FIELD_LIMITS.comune} caratteri)`],
		[typeof a.cap !== "string" || !/^\d{5}$/.test(a.cap), `il CAP ${whose}`],
		[typeof a.country !== "string" || !/^[A-Z]{2}$/.test(a.country), `il paese ${whose}`],
		[a.province === undefined ? a.country === "IT" : typeof a.province !== "string" || !/^[A-Z]{2}$/.test(a.province) || a.country !== "IT", `la provincia ${whose}`],
	]);
}

function sellerProblem(v: unknown): string | undefined {
	if (!record(v)) return "i dati dell'azienda";
	const s = v as Seller;
	return (
		first([
			[!isLine(s.name, FIELD_LIMITS.denominazione), `il nome dell'azienda (al massimo ${FIELD_LIMITS.denominazione} caratteri)`],
			[typeof s.vat !== "string" || !/^IT\d{11}$/.test(s.vat), "la partita IVA dell'azienda"],
			[typeof s.cf !== "string" || !/^[A-Z0-9]{11,16}$/.test(s.cf), "il codice fiscale dell'azienda"],
			[s.regime !== REGIME_ORDINARIO && s.regime !== REGIME_FORFETTARIO, "il regime fiscale dell'azienda"],
			[s.rea !== undefined && (typeof s.rea.office !== "string" || !/^[A-Z]{2}$/.test(s.rea.office) || typeof s.rea.number !== "string" || !/^\d{1,7}$/.test(s.rea.number)), "il numero REA dell'azienda"],
			[s.phone !== undefined && (typeof s.phone !== "string" || !SELLER_PHONE.test(s.phone)), "il telefono dell'azienda (da 5 a 12 cifre, con il + davanti se serve)"],
			[s.email !== undefined && (typeof s.email !== "string" || s.email.length > FIELD_LIMITS.email || !validAddress(s.email)), "l'email dell'azienda"],
		]) ?? addressProblem(s.address, "dell'azienda")
	);
}

function buyerProblem(v: unknown): string | undefined {
	if (!record(v)) return "i dati del cliente";
	const b = v as Buyer;
	const fields = first([
		[!isLine(b.name, FIELD_LIMITS.denominazione), `il nome del cliente (al massimo ${FIELD_LIMITS.denominazione} caratteri)`],
		[typeof b.code !== "string", "il codice destinatario del cliente"],
		[b.vat !== undefined && (typeof b.vat !== "string" || !/^[A-Z]{2}[0-9A-Z+*.]{2,28}$/.test(b.vat)), "la partita IVA del cliente"],
		[b.cf !== undefined && (typeof b.cf !== "string" || !/^[A-Z0-9]{11,16}$/.test(b.cf)), "il codice fiscale del cliente"],
		[b.pec !== undefined && (typeof b.pec !== "string" || b.pec.length > FIELD_LIMITS.pec || !validAddress(b.pec)), "la PEC del cliente"],
		[b.card !== undefined && (typeof b.card !== "string" || !/^CL-\d{4,6}$/.test(b.card)), "la scheda del cliente"],
	]);
	if (fields !== undefined) return fields;
	const address = addressProblem(b.address, "del cliente");
	if (address !== undefined) return address;
	const channel = PRIVATE_CODE.test(b.code) || b.code === NO_CHANNEL_CODE;
	const fits =
		b.kind === "business"
			? b.vat?.startsWith("IT") === true && channel && b.address.country === "IT"
			: b.kind === "private"
				? b.vat === undefined && b.cf !== undefined && channel && b.address.country === "IT"
				: b.kind === "foreign"
					? b.code === FOREIGN_CODE && b.address.country !== "IT"
					: b.kind === "pa" && PA_CODE.test(b.code) && (b.vat !== undefined || b.cf !== undefined);
	return fits ? undefined : "il tipo di cliente, che non torna con la sua partita IVA, il codice fiscale, il codice destinatario o il paese";
}

/** A buyer as kept: its kind agrees with its tax ids and its code. */
export function validBuyer(v: unknown): v is Buyer {
	return buyerProblem(v) === undefined;
}

function lineProblem(v: unknown, n: number): string | undefined {
	const where = `la riga ${n}`;
	if (!record(v)) return where;
	const l = v as SalesLine;
	return first([
		[!isText(l.description, FIELD_LIMITS.descrizione), `la descrizione della riga ${n} (al massimo ${FIELD_LIMITS.descrizione} caratteri)`],
		[!optText(l.unit, FIELD_LIMITS.unitaMisura), `l'unità di misura della riga ${n}`],
		[!optText(l.reference, FIELD_LIMITS.riferimentoNormativo), `il riferimento normativo della riga ${n}`],
		[typeof l.quantity !== "string" || !QUANTITY.test(l.quantity) || Number(l.quantity) <= 0 || Number(l.quantity) > SALES_LIMITS.maxQuantity, `la quantità della riga ${n}`],
		[typeof l.price !== "string" || !PRICE.test(l.price) || scaled(l.price, 8) <= 0n || Number(l.price) > SALES_LIMITS.maxPrice, `il prezzo della riga ${n}`],
		[l.discount !== undefined && (!percent(l.discount, 100) || Number(l.discount) >= 100), `lo sconto della riga ${n}`],
		[!SALES_VAT_RATES.includes(l.vat), `l'IVA della riga ${n}`],
		[l.vat === 0 ? !NATURE.includes(l.natura as Natura) : l.natura !== undefined || l.reference !== undefined, `la natura della riga ${n}`],
		// A spesa anticipata (N1) is never a fee, and only it is not.
		[l.notFee !== undefined && l.notFee !== true, `la riga ${n}`],
		[l.item !== undefined && (typeof l.item !== "string" || !/^LS-\d{4,7}$/.test(l.item)), `la voce del listino della riga ${n}`],
		[l.ddt !== undefined && (!record(l.ddt) || Object.keys(l.ddt).some((k) => k !== "id" && k !== "line") || typeof l.ddt.id !== "string" || !DDT_REF.test(l.ddt.id) || !Number.isInteger(l.ddt.line) || l.ddt.line < 1 || l.ddt.line > 9999), `il DDT della riga ${n}`],
		[(l.notFee === true) !== (l.natura === NOT_FEE_NATURA), `la riga ${n}: le spese anticipate sono senza IVA (N1), e solo loro`],
	]);
}

function paymentProblem(v: unknown): string | undefined {
	if (!record(v)) return "il pagamento";
	const p = v as Payment;
	return first([
		[!Number.isInteger(p.days) || p.days < 0 || p.days > MAX_PAYMENT_DAYS || typeof p.endOfMonth !== "boolean", "i giorni di pagamento"],
		[!Object.values(PAYMENT_METHODS).includes(p.method), "il modo di pagamento"],
		[p.iban !== undefined && (typeof p.iban !== "string" || validIban(p.iban) !== p.iban), "l'IBAN"],
	]);
}

const validCassa = (c: Cassa) => record(c) && (c.type === INPS_CASSA || CASSA_TYPES.includes(c.type)) && percent(c.rate, MAX_CASSA_RATE) && typeof c.subject === "boolean";
const validRitenuta = (r: Ritenuta) => record(r) && (r.type === RITENUTA_PERSON || r.type === RITENUTA_COMPANY) && RITENUTA_CAUSALI.some((c) => c === r.causale);
const code = (v: unknown, max: number) => typeof v === "string" && /^[A-Za-z0-9/._-]+$/.test(v) && v.length <= max;
const DDT_REF = /^DT-\d{4,6}$/;
const validDdtRef = (d: DdtRef) => record(d) && Object.keys(d).every((k) => ["id", "number", "date"].includes(k)) && typeof d.id === "string" && DDT_REF.test(d.id) && isText(d.number, 20) && isDay(d.date);
const validHours = (h: HoursRef) => record(h) && typeof h.id === "string" && /^O-\d{4}-\d{4,6}$/.test(h.id) && Number.isInteger(h.minutes) && h.minutes > 0 && typeof h.rate === "string" && PRICE.test(h.rate) && Number.isInteger(h.rounding);

/** The field of a draft or an invoice that does not have its shape, in words; undefined when it all does. */
export function invoiceProblem(v: unknown): string | undefined {
	if (!isMarker(v)) return "chi l'ha fatta e quando";
	const i = v as SalesInvoice;
	const head = first([
		[typeof i.id !== "string" || !DRAFT_ID.test(i.id), "il numero della bozza"],
		[i.type !== INVOICE_TYPE && i.type !== CREDIT_NOTE_TYPE && i.type !== DEFERRED_TYPE, "il tipo di documento"],
		[i.regime !== REGIME_ORDINARIO && i.regime !== REGIME_FORFETTARIO, "il regime fiscale"],
		[!isText(i.callId, 200), "la richiesta che l'ha fatta"],
		[i.origin !== undefined && !isText(i.origin, 200), "la richiesta della prima bozza"],
		[!Array.isArray(i.lines) || i.lines.length === 0 || i.lines.length > SALES_LIMITS.lines, `le righe (da 1 a ${SALES_LIMITS.lines})`],
	]);
	if (head !== undefined) return head;
	const buyer = buyerProblem(i.buyer);
	if (buyer !== undefined) return buyer;
	for (const [n, l] of i.lines.entries()) {
		const problem = lineProblem(l, n + 1);
		if (problem !== undefined) return problem;
	}
	const body = first([
		[i.ritenuta !== undefined && !validRitenuta(i.ritenuta), "la ritenuta d'acconto"],
		[i.cassa !== undefined && !validCassa(i.cassa), "la cassa previdenziale"],
		[i.bolloToClient !== undefined && typeof i.bolloToClient !== "boolean", "chi paga il bollo"],
		[i.splitPayment !== undefined && i.splitPayment !== true, "la scissione dei pagamenti"],
		[i.payment !== undefined && !isInvoiceType(i.type), "il pagamento, che una nota di credito non ha"],
		[i.order !== undefined && (!record(i.order) || !code(i.order.id, FIELD_LIMITS.idDocumento) || (i.order.cig !== undefined && !code(i.order.cig, FIELD_LIMITS.cig)) || (i.order.cup !== undefined && !code(i.order.cup, FIELD_LIMITS.cup))), "l'ordine (numero, CIG, CUP)"],
		[(i.related === undefined) !== isInvoiceType(i.type), "la fattura che la nota di credito storna"],
		[i.related !== undefined && (!record(i.related) || !isText(i.related.number, FIELD_LIMITS.numero) || !isDay(i.related.date) || typeof i.related.id !== "string" || !DRAFT_ID.test(i.related.id)), "la fattura che la nota di credito storna"],
		[!optText(i.causale, SALES_LIMITS.causale), `le note (al massimo ${SALES_LIMITS.causale} caratteri)`],
		[!optText(i.quote, 30), "il preventivo"],
		[!optText(i.expected, FIELD_LIMITS.numero), "il numero che la bozza diceva"],
		[i.hours !== undefined && (!Array.isArray(i.hours) || i.hours.length > SALES_LIMITS.hours || !i.hours.every(validHours)), "le ore fatturate"],
		// A fattura differita (TD24) and only it bills DDTs (DatiDDT); a credit note's lines may point at the DDT the goods went or came back with.
		[(i.ddt !== undefined) !== (i.type === DEFERRED_TYPE), "il tipo di documento della fattura differita (TD24, con i suoi DDT)"],
		[i.ddt !== undefined && (!Array.isArray(i.ddt) || i.ddt.length === 0 || i.ddt.length > SALES_LIMITS.lines || !i.ddt.every(validDdtRef) || new Set(i.ddt.map((d) => d.id)).size !== i.ddt.length), "i DDT della fattura differita"],
		[i.type !== CREDIT_NOTE_TYPE && (i.lines.some((l) => l.ddt !== undefined && !(i.ddt ?? []).some((d) => d.id === l.ddt?.id)) || (i.ddt ?? []).some((d) => !i.lines.some((l) => l.ddt?.id === d.id))), "i DDT della fattura differita"],
		[i.release !== undefined && (i.release !== true || i.type !== CREDIT_NOTE_TYPE), "i DDT che la nota di credito rimette da fatturare"],
	]);
	if (body !== undefined) return body;
	if (i.payment !== undefined) {
		const payment = paymentProblem(i.payment);
		if (payment !== undefined) return payment;
	}
	if (i.number === undefined) return [i.year, i.seq, i.date, i.due, i.seller, i.progressive, i.file, i.pdf, i.issued, i.issueCall, i.finished, i.audited].every((x) => x === undefined) ? undefined : "il numero della fattura";
	const issued = first([
		[!isText(i.number, FIELD_LIMITS.numero) || !Number.isInteger(i.year) || !Number.isInteger(i.seq) || (i.seq as number) < 1, "il numero della fattura"],
		[!isDay(i.date) || Number(i.date?.slice(0, 4)) !== i.year, "la data della fattura"],
		[i.due !== undefined && !isDay(i.due), "la scadenza"],
		[typeof i.progressive !== "string" || !/^[0-9A-Z]{5}$/.test(i.progressive), "il progressivo del file"],
		[!isMarker(i.issued) || !optText(i.issueCall, 200), "chi l'ha emessa e quando"],
		[i.finished !== undefined && i.finished !== true, "la fine dell'emissione"],
		[i.audited !== undefined && (i.audited !== true || i.finished !== true), "la registrazione dell'emissione"],
		[[i.file, i.pdf].some((path) => path !== undefined && (typeof path !== "string" || !/^fatture\/emesse\/IT\d{11}_[0-9A-Z]{5}\.(?:xml|pdf)$/.test(path))), "il nome del file"],
	]);
	return issued ?? sellerProblem(i.seller);
}

/** A draft or an invoice as stored, checked field by field. */
export function validInvoice(v: unknown): v is SalesInvoice {
	return invoiceProblem(v) === undefined;
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
