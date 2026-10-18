/**
 * Italian electronic invoices (FatturaPA, the XML the Sistema di Interscambio delivers, ordinary
 * FPA12 and FPR12 or simplified FSM10), recognised by their content and read as a summary in
 * Italian for the owner: who invoices whom, how much and by when first, then the parties, lines,
 * VAT, totals, payment and attachments by name. Only what the file says (a sum is said to be
 * one); what is missing is left out. Amounts and quantities are written from their digits, never
 * through floating point. The XML goes through xml-tree.ts (no DTD, linear); signed files are
 * opened by documents.ts. Loaded by the document worker from source: erasable TypeScript only.
 */
import { endOfMonth } from "./dates.ts";
import { CAUSALE_PAGAMENTO, CONDIZIONI_PAGAMENTO, CREDIT_NOTES, coded, ESIGIBILITA, INTEGRATIONS, MODALITA_PAGAMENTO, NATURA, naturaNote, REGIME_FISCALE, TIPO_CASSA, TIPO_DOCUMENTO, TIPO_RITENUTA } from "./fattura-pa-codes.ts";
import { addDays, realDate } from "./italian-calendar.ts";
import { capitalized, italianDate, italianWeekday } from "./italian-format.ts";
import { withoutBidiControls } from "./html-text.ts";
import { checkCodiceFiscale, EU_VAT_COUNTRIES, euVatProblem, type EuVatCountry, partitaIvaProblem } from "./tax-ids.ts";
import { child, children, decodeXml, descendant, parseXml, type XmlElement, XmlError, xmlRoot } from "./xml-tree.ts";

export class FatturaError extends Error {
	override readonly name = "FatturaError";
}

/** The largest invoice summed up, in bytes: SdI's own limit is 5 MB, a lotto sent by other channels may be larger. */
export const MAX_FATTURA_BYTES = 20 * 1024 * 1024;

/** Elements in one file, and their nesting: an invoice of a thousand lines has about ten thousand, 7 deep. */
const MAX_ELEMENTS = 100_000;
const MAX_DEPTH = 64;

/** Lines shown per document, documents shown per file, references (DDT, orders) per kind; the rest is counted. */
const MAX_LINES = 50;
const MAX_BODIES = 100;
const MAX_REFERENCES = 10;

/** The longest value shown: a line's description may be 1000 characters. */
const MAX_VALUE = 1000;

/** How much of the start is looked at to recognise an invoice: the root element comes first. */
export const FATTURA_SNIFF_BYTES = 16 * 1024;

/** The namespace path of FatturaPA (ordinary v1.2, simplified v1.0). */
const NAMESPACE = "ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/";

const ROOTS = new Set(["FatturaElettronica", "FatturaElettronicaSemplificata"]);

const CREDIT_NOTE = "È una nota di credito: storna in tutto o in parte la fattura collegata; gli importi sono a favore del cliente, non da pagare al fornitore.";

const DOCTYPE = "la fattura contiene una dichiarazione DOCTYPE, che le fatture dello SdI non hanno: per sicurezza non la leggo. Chiedi il file originale al fornitore o scaricalo dal cassetto fiscale.";

/**
 * Whether these bytes start like a FatturaPA: the root element is FatturaElettronica (or
 * FatturaElettronicaSemplificata) in FatturaPA's namespace, or with FatturaPA's versione.
 */
export function isFatturaXml(data: Uint8Array): boolean {
	return fatturaRoot(decodeXml(data.subarray(0, FATTURA_SNIFF_BYTES))) !== undefined;
}

function fatturaRoot(text: string): ReturnType<typeof xmlRoot> {
	const root = xmlRoot(text);
	if (root === undefined || !ROOTS.has(root.name)) return undefined;
	return root.attrs.includes(NAMESPACE) || /\bversione\s*=\s*["'](FPA12|FPR12|FSM10)["']/.test(root.attrs) ? root : undefined;
}

/** A supplier or a customer as the invoice names them: what the scadenzario needs (invoices.ts); `email` from its Contatti, when written. */
export type FatturaParty = { readonly name?: string; readonly vat?: { readonly country?: string; readonly code: string }; readonly fiscal?: string; readonly email?: string };

/** One instalment (DettaglioPagamento): amount and due date as written (YYYY-MM-DD, maybe not a real day), the ModalitaPagamento code, the IBAN. */
export type FatturaInstalment = { readonly amount?: string; readonly due?: string; readonly method?: string; readonly iban?: string };

/**
 * One document of a file, as written: amounts are FatturaPA's decimal strings (1253.50), dates
 * YYYY-MM-DD. `toPay` is the sum of the instalments when each has an amount that reads; for a
 * simplified invoice `total` is the sum of its lines. `credit`: a nota di credito (TD04, TD08);
 * `integration`: a document for the reverse charge, nothing to pay.
 */
export type FatturaDocument = {
	readonly type?: string;
	readonly credit: boolean;
	readonly integration: boolean;
	readonly number?: string;
	readonly date?: string;
	readonly currency: string;
	readonly total?: string;
	readonly toPay?: string;
	readonly instalments: readonly FatturaInstalment[];
	/** Split payment (EsigibilitaIVA S): the VAT the public administration pays to the State, not to the supplier. */
	readonly splitVat?: string;
	/** The imponibile: the sum of the summary rows' ImponibileImporto, when there are any and each reads. */
	readonly taxable?: string;
};

/**
 * What a file says, structured: the summary is written from it; `count` is every document,
 * `documents` at most MAX_BODIES of them; `pec` the PEC the SdI delivered it to (PECDestinatario: the customer's, or an intermediary's); `publicAdmin` an invoice to a public
 * administration (format FPA12, or a six-character codice ufficio).
 */
export type Fattura = {
	readonly simplified: boolean;
	readonly signed: boolean;
	readonly supplier: FatturaParty;
	readonly customer: FatturaParty;
	readonly documents: readonly FatturaDocument[];
	readonly count: number;
	readonly pec?: string;
	readonly publicAdmin?: true;
};

/**
 * The invoice's structured content from its XML; `signed` when it came out of a .p7m. A
 * FatturaError in Italian when it cannot be read, or past MAX_FATTURA_BYTES.
 */
export function fatturaData(data: Uint8Array, signed: boolean): Fattura {
	if (data.length > MAX_FATTURA_BYTES) throw new FatturaError(`la fattura è troppo grande da leggere (oltre ${MAX_FATTURA_BYTES / 1024 / 1024} MB)`);
	return readInvoice(parsed(decodeXml(data)).invoice, signed).fattura;
}

/**
 * The invoice's summary from its XML; `signed` when it came out of a .p7m. A FatturaError in
 * Italian when it cannot be read. Past MAX_FATTURA_BYTES no summary: the XML as it is, to read in
 * pieces, with the attachments' contents left out and a note saying so.
 */
export function fatturaText(data: Uint8Array, signed: boolean): { text: string; parts?: number; note?: string } {
	if (data.length > MAX_FATTURA_BYTES) {
		let attachments = false;
		const text = withoutBidiControls(decodeXml(data)).replace(/<Attachment>[^<]*/g, () => {
			attachments = true;
			return "<Attachment>[allegato non mostrato]";
		});
		const note = `La fattura è troppo grande per il riepilogo (oltre ${MAX_FATTURA_BYTES / 1024 / 1024} MB): questo è il suo XML com'è${attachments ? ", senza il contenuto degli allegati" : ""}.`;
		return { text, note: signed ? `Firma digitale presente, non verificata. ${note}` : note };
	}
	const { invoice, attrs } = parsed(decodeXml(data));
	const { fattura, details, documents } = readInvoice(invoice, signed);
	const { supplier, customer } = fattura;
	const head = child(invoice, "FatturaElettronicaHeader");
	const out: string[] = [];
	const read = documents.map((d) => (fattura.simplified ? simplifiedBody(d) : ordinaryBody(d)));
	const first = read[0];
	if (fattura.count === 1 && first !== undefined) out.push(headline(first, supplier, customer));
	else out.push(`Lotto di ${fattura.count} documenti${supplier.name === undefined ? "" : ` da ${supplier.name}`}${customer.name === undefined ? "" : ` a ${customer.name}`}`);
	if (signed) out.push("Firma digitale presente, non verificata.");
	out.push("", ...partyLines("Fornitore (cedente/prestatore)", supplier, details.supplier, true));
	const representative = child(head, "RappresentanteFiscale");
	if (representative !== undefined) {
		const read = ordinaryParty(representative);
		out.push("", ...partyLines("Rappresentante fiscale del fornitore", read.party, read.details, false));
	}
	out.push("", ...partyLines("Cliente (cessionario/committente)", customer, details.customer, false));
	out.push(...issuer(head));
	read.forEach((body, i) => {
		out.push("");
		if (fattura.count > 1) out.push(`## Documento ${i + 1} di ${fattura.count}`, headline(body, supplier, customer));
		out.push(...body.lines);
	});
	if (fattura.count > MAX_BODIES) out.push("", `E altri ${fattura.count - MAX_BODIES} documenti non mostrati.`);
	out.push("", transmission(head, attrs, fattura.simplified));
	return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), ...(fattura.count > 1 ? { parts: fattura.count } : {}) };
}

/** The XML parsed, within the limits; a FatturaError when it is no invoice, has a DOCTYPE or does not parse. */
function parsed(xml: string): { invoice: XmlElement; attrs: string } {
	const root = fatturaRoot(xml);
	if (root === undefined) throw new FatturaError("non è una fattura elettronica che so leggere");
	if (root.doctype) throw new FatturaError(DOCTYPE);
	try {
		return { invoice: parseXml(xml, { maxElements: MAX_ELEMENTS, maxDepth: MAX_DEPTH }), attrs: root.attrs };
	} catch (error) {
		if (error instanceof XmlError) throw new FatturaError(error.message.replace("il file XML", "il file XML della fattura"));
		throw error;
	}
}

/**
 * A document as read: its data, its element, and which instalment each DettaglioPagamento
 * element became, so the summary writes each payment line from its own instalment.
 */
type ReadDocument = { readonly doc: FatturaDocument; readonly body: XmlElement; readonly instalmentOf: ReadonlyMap<XmlElement, FatturaInstalment> };

/** The parties and documents read once, for both the structured content and the summary; the parties' addresses and the like only for the summary. */
function readInvoice(invoice: XmlElement, signed: boolean): { fattura: Fattura; details: { supplier: PartyDetails; customer: PartyDetails }; documents: ReadDocument[] } {
	const simplified = invoice.name === "FatturaElettronicaSemplificata";
	const head = child(invoice, "FatturaElettronicaHeader");
	const supplier = simplified ? simplifiedSupplier(child(head, "CedentePrestatore")) : ordinaryParty(child(head, "CedentePrestatore"));
	const customer = simplified ? simplifiedCustomer(child(head, "CessionarioCommittente")) : ordinaryParty(child(head, "CessionarioCommittente"));
	const all = children(invoice, "FatturaElettronicaBody");
	const documents = all.slice(0, MAX_BODIES).map((body) => (simplified ? simplifiedDocument(body) : ordinaryDocument(body)));
	const transmission = child(head, "DatiTrasmissione");
	const pec = value(transmission, "PECDestinatario");
	const publicAdmin = value(transmission, "FormatoTrasmissione") === "FPA12" || value(transmission, "CodiceDestinatario")?.length === 6;
	return {
		fattura: { simplified, signed, supplier: supplier.party, customer: customer.party, documents: documents.map((d) => d.doc), count: all.length, ...(pec === undefined ? {} : { pec }), ...(publicAdmin ? { publicAdmin: true as const } : {}) },
		details: { supplier: supplier.details, customer: customer.details },
		documents,
	};
}

/** An ordinary document's data: type, number, date, totals and the instalments of every DatiPagamento in order. */
function ordinaryDocument(body: XmlElement): ReadDocument {
	const general = descendant(body, "DatiGenerali/DatiGeneraliDocumento");
	const type = value(general, "TipoDocumento");
	const instalmentOf = new Map<XmlElement, FatturaInstalment>();
	for (const detail of children(body, "DatiPagamento").flatMap((p) => children(p, "DettaglioPagamento"))) {
		instalmentOf.set(detail, optional({ amount: value(detail, "ImportoPagamento"), due: value(detail, "DataScadenzaPagamento"), method: value(detail, "ModalitaPagamento"), iban: value(detail, "IBAN") }));
	}
	const instalments = [...instalmentOf.values()];
	const toPay = paidSum(instalments);
	const splitVat = splitPaymentVat(body);
	const taxable = summaryTaxable(body);
	const doc: FatturaDocument = {
		...optional({ type, number: value(general, "Numero"), date: value(general, "Data"), total: value(general, "ImportoTotaleDocumento"), toPay: toPay === undefined ? undefined : fromUnits(toPay), splitVat: splitVat === undefined ? undefined : fromUnits(splitVat), taxable: taxable === undefined ? undefined : fromUnits(taxable) }),
		credit: type !== undefined && CREDIT_NOTES.has(type),
		integration: type !== undefined && INTEGRATIONS.has(type),
		currency: value(general, "Divisa") ?? "EUR",
		instalments,
	};
	return { doc, body, instalmentOf };
}

/** The imponibile of the summary rows (DatiRiepilogo/ImponibileImporto), when there are any and each reads. */
function summaryTaxable(body: XmlElement): bigint | undefined {
	const rows = children(child(body, "DatiBeniServizi"), "DatiRiepilogo");
	if (rows.length === 0) return undefined;
	let sum = 0n;
	for (const row of rows) {
		const units = toUnits(value(row, "ImponibileImporto") ?? "");
		if (units === undefined) return undefined;
		sum += units;
	}
	return sum;
}

/** The VAT of the summary rows under split payment (EsigibilitaIVA S), when there are any and each reads. */
function splitPaymentVat(body: XmlElement): bigint | undefined {
	const rows = children(child(body, "DatiBeniServizi"), "DatiRiepilogo").filter((r) => value(r, "EsigibilitaIVA") === "S");
	if (rows.length === 0) return undefined;
	let sum = 0n;
	for (const row of rows) {
		const units = toUnits(value(row, "Imposta") ?? "");
		if (units === undefined) return undefined;
		sum += units;
	}
	return sum;
}

/** A simplified document's data: its total is the sum of its lines, VAT included, when each reads; no instalments. */
function simplifiedDocument(body: XmlElement): ReadDocument {
	const general = descendant(body, "DatiGenerali/DatiGeneraliDocumento");
	const type = value(general, "TipoDocumento");
	const rows = children(body, "DatiBeniServizi");
	let sum: bigint | undefined = 0n;
	for (const row of rows) {
		const amount = value(row, "Importo");
		const units = amount === undefined ? undefined : toUnits(amount);
		sum = sum === undefined || units === undefined ? undefined : sum + units;
	}
	const doc: FatturaDocument = {
		...optional({ type, number: value(general, "Numero"), date: value(general, "Data"), total: sum === undefined || rows.length === 0 ? undefined : fromUnits(sum) }),
		credit: type !== undefined && CREDIT_NOTES.has(type),
		integration: type !== undefined && INTEGRATIONS.has(type),
		currency: value(general, "Divisa") ?? "EUR",
		instalments: [],
	};
	return { doc, body, instalmentOf: new Map() };
}

/** What a document of the file says, read: its data, the due date for the headline and its lines. */
type Body = { readonly doc: FatturaDocument; readonly due?: string; readonly lines: string[] };

/** «Fattura n. 2026/0153 del 15/10/2026 da Alfa S.r.l. a Beta Srl, totale 1.342,00 €, scadenza 30/11/2026». */
function headline(body: Body, supplier: FatturaParty, customer: FatturaParty): string {
	const { type, number, currency } = body.doc;
	const kind = type === undefined ? "Documento" : capitalized(Object.hasOwn(TIPO_DOCUMENTO, type) ? (TIPO_DOCUMENTO[type] as string) : `documento ${type}`);
	const what = joined([kind, labelled("n.", number), labelled("del", date(body.doc.date)), labelled("da", supplier.name), labelled("a", customer.name)], " ");
	return joined([what, labelled("totale", money(body.doc.total, currency)), body.due]) ?? kind;
}

/** What the summary says of a party beyond who it is: address, regime, REA, contacts. */
type PartyDetails = { readonly sede?: XmlElement; readonly regime?: string; readonly rea?: XmlElement; readonly contacts?: XmlElement };

/** A supplier or a customer, as either kind of invoice gives it. */
type ReadParty = { readonly party: FatturaParty; readonly details: PartyDetails };

function ordinaryParty(el: XmlElement | undefined): ReadParty {
	const data = child(el, "DatiAnagrafici");
	const registry = child(data, "Anagrafica");
	return party({
		name: value(registry, "Denominazione") ?? joined([value(registry, "Titolo"), value(registry, "Nome"), value(registry, "Cognome")], " "),
		vatOf: child(data, "IdFiscaleIVA"),
		fiscal: value(data, "CodiceFiscale"),
		sede: child(el, "Sede"),
		regime: value(data, "RegimeFiscale"),
		rea: child(el, "IscrizioneREA"),
		contacts: child(el, "Contatti"),
	});
}

/** The simplified invoice keeps the supplier's data directly under CedentePrestatore. */
function simplifiedSupplier(el: XmlElement | undefined): ReadParty {
	return party({
		name: value(el, "Denominazione") ?? joined([value(el, "Nome"), value(el, "Cognome")], " "),
		vatOf: child(el, "IdFiscaleIVA"),
		fiscal: value(el, "CodiceFiscale"),
		sede: child(el, "Sede"),
		regime: value(el, "RegimeFiscale"),
		rea: child(el, "IscrizioneREA"),
	});
}

/** And the customer's under IdentificativiFiscali and AltriDatiIdentificativi. */
function simplifiedCustomer(el: XmlElement | undefined): ReadParty {
	const ids = child(el, "IdentificativiFiscali");
	const other = child(el, "AltriDatiIdentificativi");
	return party({ name: value(other, "Denominazione") ?? joined([value(other, "Nome"), value(other, "Cognome")], " "), vatOf: child(ids, "IdFiscaleIVA"), fiscal: value(ids, "CodiceFiscale"), sede: child(other, "Sede") });
}

function party(found: { name?: string; vatOf?: XmlElement; fiscal?: string; sede?: XmlElement; regime?: string; rea?: XmlElement; contacts?: XmlElement }): ReadParty {
	const code = value(found.vatOf, "IdCodice");
	const country = value(found.vatOf, "IdPaese");
	const vat = code === undefined ? undefined : country === undefined ? { code } : { country, code };
	const email = value(found.contacts, "Email");
	return {
		party: { ...(found.name === undefined ? {} : { name: found.name }), ...(vat === undefined ? {} : { vat }), ...(found.fiscal === undefined ? {} : { fiscal: found.fiscal }), ...(email === undefined ? {} : { email }) },
		details: {
			...(found.sede === undefined ? {} : { sede: found.sede }),
			...(found.regime === undefined ? {} : { regime: found.regime }),
			...(found.rea === undefined ? {} : { rea: found.rea }),
			...(found.contacts === undefined ? {} : { contacts: found.contacts }),
		},
	};
}

/** A party's lines: name, tax ids checked on paper, address, regime, REA, contacts. */
function partyLines(title: string, p: FatturaParty, d: PartyDetails, supplier: boolean): string[] {
	const out = [`${title}: ${p.name ?? "nome non indicato"}`];
	if (p.vat !== undefined) out.push(`- Partita IVA: ${p.vat.country ?? ""}${p.vat.code}${vatProblem(p.vat.country, p.vat.code)}`);
	if (p.fiscal !== undefined) out.push(`- Codice fiscale: ${p.fiscal}${fiscalProblem(p.fiscal)}`);
	const { sede } = d;
	if (sede !== undefined) {
		const street = joined([value(sede, "Indirizzo"), value(sede, "NumeroCivico")], " ");
		const province = value(sede, "Provincia");
		const town = joined([value(sede, "CAP"), value(sede, "Comune"), province === undefined ? undefined : `(${province})`], " ");
		const address = joined([street, town, value(sede, "Nazione")]);
		if (address !== undefined) out.push(`- Sede: ${address}`);
	}
	if (supplier) {
		const regime = coded(REGIME_FISCALE, d.regime);
		if (regime !== undefined) out.push(regime.startsWith("regime ") ? `- ${capitalized(regime)}` : `- Regime fiscale: ${regime}`);
		const rea = joined([value(d.rea, "Ufficio"), value(d.rea, "NumeroREA")], " ");
		if (rea !== undefined) out.push(`- REA: ${rea}${value(d.rea, "StatoLiquidazione") === "LS" ? " (in liquidazione)" : ""}`);
	}
	const contacts = joined([labelled("tel.", value(d.contacts, "Telefono")), labelled("email", value(d.contacts, "Email"))]);
	if (contacts !== undefined) out.push(`- Contatti: ${contacts}`);
	return out;
}

/** «(attenzione: …; controllo senza rete)» when the offline check finds the VAT number wrong; nothing for countries it does not know. */
function vatProblem(country: string | undefined, code: string): string {
	const prefix = country === "GR" ? "EL" : country;
	if (prefix === undefined || !Object.hasOwn(EU_VAT_COUNTRIES, prefix)) return "";
	return warning(euVatProblem(prefix as EuVatCountry, code));
}

/** A codice fiscale checked on paper: a company's 11 digits as a partita IVA, a person's 16 characters; others (foreign) not. */
function fiscalProblem(code: string): string {
	if (/^\d{11}$/.test(code)) return warning(partitaIvaProblem(code));
	if (code.length !== 16) return "";
	const checked = checkCodiceFiscale(code);
	return warning("problem" in checked ? checked.problem : undefined);
}

function warning(problem: string | undefined): string {
	if (problem === undefined) return "";
	const said = problem.includes("cifra di controllo") || problem.includes("carattere di controllo") ? "la cifra di controllo non torna, forse un errore di battitura" : problem.replace(/\s*\([^)]*\)/g, "");
	return ` (attenzione: ${said}; controllo senza rete)`;
}

/** Who issued the invoice when not the supplier: a third party, or the customer on the supplier's behalf. */
function issuer(head: XmlElement | undefined): string[] {
	const third = ordinaryParty(child(head, "TerzoIntermediarioOSoggettoEmittente")).party;
	const who = value(head, "SoggettoEmittente");
	const name = joined([third.name, third.vat === undefined ? undefined : `P.IVA ${third.vat.country ?? ""}${third.vat.code}`]);
	if (who === "CC") return ["", "Emessa dal cliente per conto del fornitore."];
	if (who === "TZ" || name !== undefined) return ["", `Emessa da un terzo per conto del fornitore${name === undefined ? "" : `: ${name}`}.`];
	return [];
}

/** The technical line, last: format, recipient code or PEC. */
function transmission(head: XmlElement | undefined, attrs: string, simplified: boolean): string {
	const data = child(head, "DatiTrasmissione");
	const format = value(data, "FormatoTrasmissione") ?? /\bversione\s*=\s*["']([A-Z0-9]{1,10})["']/.exec(attrs)?.[1];
	const audience = format === "FPA12" ? " (verso la pubblica amministrazione)" : format === "FPR12" ? " (tra privati)" : "";
	const name = simplified ? "FatturaPA semplificata" : "FatturaPA";
	return `Trasmissione: ${joined([`${name}${format === undefined ? "" : ` ${format}${audience}`}`, labelled("codice destinatario", value(data, "CodiceDestinatario")), labelled("PEC", value(data, "PECDestinatario"))])}`;
}

/** One document of an ordinary invoice, from its data and its element: references, lines, VAT, totals, payment, attachments. */
function ordinaryBody({ doc, body, instalmentOf }: ReadDocument): Body {
	const generalData = child(body, "DatiGenerali");
	const general = child(generalData, "DatiGeneraliDocumento");
	const { type, credit, integration, currency } = doc;
	const out: string[] = [];
	if (type !== undefined) out.push(`Tipo documento: ${coded(TIPO_DOCUMENTO, type)}`);
	if (credit) out.push(CREDIT_NOTE);
	if (integration) out.push("È un documento di integrazione per il reverse charge, non è una fattura da pagare.");
	out.push(...defined([labelled("Numero:", doc.number), labelled("Data:", date(doc.date)), currency === "EUR" ? undefined : `Divisa: ${currency}`]));
	const reasons = children(general, "Causale")
		.map(ownText)
		.filter((c) => c !== undefined);
	if (reasons.length > 0) out.push(`Causale: ${reasons.join(" ").slice(0, 2 * MAX_VALUE)}`);
	out.push(...references(generalData, "DatiFattureCollegate", "Fattura collegata"));
	out.push(...references(generalData, "DatiOrdineAcquisto", "Ordine d'acquisto"));
	out.push(...references(generalData, "DatiContratto", "Contratto"));
	out.push(...references(generalData, "DatiConvenzione", "Convenzione"));
	out.push(...references(generalData, "DatiRicezione", "Ricezione"));
	out.push(...transportDocuments(generalData));
	const goods = child(body, "DatiBeniServizi");
	out.push(...lineLines(goods, currency));
	out.push(...summaryLines(goods, currency));
	out.push(...totalLines(general, doc, !(credit || integration)));
	const payment = paymentLines(children(body, "DatiPagamento"), doc, instalmentOf);
	out.push(...payment.lines, ...attachmentLines(body));
	const due = credit || integration ? undefined : payment.due;
	return { doc, ...(due === undefined ? {} : { due }), lines: out };
}

/** One document of a simplified invoice: lines with the VAT inside the amount, the invoice it corrects. */
function simplifiedBody({ doc, body }: ReadDocument): Body {
	const generalData = child(body, "DatiGenerali");
	const general = child(generalData, "DatiGeneraliDocumento");
	const { type, currency } = doc;
	const out: string[] = [];
	if (type !== undefined) out.push(`Tipo documento: ${coded(TIPO_DOCUMENTO, type)}`);
	if (doc.credit) out.push(CREDIT_NOTE);
	out.push(...defined([labelled("Numero:", doc.number), labelled("Data:", date(doc.date)), currency === "EUR" ? undefined : `Divisa: ${currency}`]));
	const corrected = child(generalData, "DatiFatturaRettificata");
	const which = joined([labelled("n.", value(corrected, "NumeroFR")), labelled("del", date(value(corrected, "DataFR")))], " ");
	if (which !== undefined) out.push(`Fattura rettificata: ${joined([which, labelled("elementi rettificati:", value(corrected, "ElementiRettificati"))])}`);
	const rows = children(body, "DatiBeniServizi");
	if (rows.length > 0) out.push("", `Righe (${rows.length}):`);
	rows.slice(0, MAX_LINES).forEach((row, i) => {
		const amount = value(row, "Importo");
		const vat = rate(row, "DatiIVA/Aliquota");
		const parts = joined([labelled("importo", money(amount, currency)), vat === undefined ? undefined : `${vat}${labelled(", imposta", money(value(row, "DatiIVA/Imposta"), currency)) ?? ""}`, labelled("riferimento normativo:", value(row, "RiferimentoNormativo"))], "; ");
		out.push(`${i + 1}. ${value(row, "Descrizione") ?? "(senza descrizione)"}${parts === undefined ? "" : `; ${parts}`}`);
	});
	if (rows.length > MAX_LINES) out.push(`e altre ${rows.length - MAX_LINES} righe`);
	out.push("");
	if (value(general, "BolloVirtuale") === "SI") out.push("Bollo virtuale: sì");
	const total = money(doc.total, currency);
	if (total !== undefined) out.push(`Totale (somma delle righe, IVA inclusa): ${total}`);
	out.push(...attachmentLines(body));
	return { doc, lines: out };
}

/** Orders, contracts, linked invoices…: «Ordine d'acquisto: n. 45 del 01/10/2026, CIG …, CUP …». */
function references(generalData: XmlElement | undefined, name: string, label: string): string[] {
	const list = children(generalData, name);
	const out = list.slice(0, MAX_REFERENCES).flatMap((el) => {
		const what = joined([joined([labelled("n.", value(el, "IdDocumento")), labelled("del", date(value(el, "Data")))], " "), labelled("CIG", value(el, "CodiceCIG")), labelled("CUP", value(el, "CodiceCUP")), labelled("commessa", value(el, "CodiceCommessaConvenzione"))]);
		return what === undefined ? [] : [`${label}: ${what}`];
	});
	if (list.length > MAX_REFERENCES) out.push(`e altri ${list.length - MAX_REFERENCES} riferimenti (${label.toLowerCase()})`);
	return out;
}

function transportDocuments(generalData: XmlElement | undefined): string[] {
	const list = children(generalData, "DatiDDT");
	const out = list.slice(0, MAX_REFERENCES).flatMap((el) => {
		const what = joined([labelled("n.", value(el, "NumeroDDT")), labelled("del", date(value(el, "DataDDT")))], " ");
		return what === undefined ? [] : [`DDT: ${what}`];
	});
	if (list.length > MAX_REFERENCES) out.push(`e altri ${list.length - MAX_REFERENCES} DDT`);
	return out;
}

function lineLines(goods: XmlElement | undefined, currency: string): string[] {
	const rows = children(goods, "DettaglioLinee");
	if (rows.length === 0) return [];
	const out = ["", `Righe (${rows.length}):`];
	rows.slice(0, MAX_LINES).forEach((row, i) => {
		const unit = value(row, "UnitaMisura");
		const amount = quantity(value(row, "Quantita"));
		const from = date(value(row, "DataInizioPeriodo"));
		const to = date(value(row, "DataFinePeriodo"));
		const details = joined(
			[
				amount === undefined ? undefined : `quantità ${amount}${unit === undefined ? "" : ` ${unit}`}`,
				labelled("prezzo unitario", money(value(row, "PrezzoUnitario"), currency)),
				...children(row, "ScontoMaggiorazione").map((s) => adjustment(s, currency)),
				rate(row, "AliquotaIVA"),
				value(row, "Ritenuta") === "SI" ? "soggetta a ritenuta" : undefined,
				from === undefined && to === undefined ? undefined : joined(["periodo", labelled("dal", from), labelled("al", to)], " "),
				labelled("totale", money(value(row, "PrezzoTotale"), currency)),
			],
			"; ",
		);
		out.push(`${value(row, "NumeroLinea") ?? i + 1}. ${value(row, "Descrizione") ?? "(senza descrizione)"}${details === undefined ? "" : `; ${details}`}`);
	});
	if (rows.length > MAX_LINES) out.push(`e altre ${rows.length - MAX_LINES} righe`);
	return out;
}

/** «sconto 10%», «maggiorazione 5,00 €». */
function adjustment(el: XmlElement, currency: string): string | undefined {
	return labelled(value(el, "Tipo") === "MG" ? "maggiorazione" : "sconto", percent(value(el, "Percentuale")) ?? money(value(el, "Importo"), currency));
}

/** «IVA 22%», or the nature of an amount without VAT: «non soggette, altri casi (N2.2)». */
function rate(el: XmlElement, path: string): string | undefined {
	const nature = coded(NATURA, value(el, "Natura"));
	const vat = value(el, path);
	if (nature !== undefined && (vat === undefined || toUnits(vat) === 0n)) return nature;
	return labelled("IVA", percent(vat));
}

function summaryLines(goods: XmlElement | undefined, currency: string): string[] {
	const rows = children(goods, "DatiRiepilogo");
	if (rows.length === 0) return [];
	const out = ["", "Riepilogo IVA:"];
	for (const row of rows) {
		const nature = value(row, "Natura");
		const esigibilita = value(row, "EsigibilitaIVA");
		const parts = joined(
			[
				labelled("imponibile", money(value(row, "ImponibileImporto"), currency)),
				labelled("imposta", money(value(row, "Imposta"), currency)),
				labelled("spese accessorie", money(value(row, "SpeseAccessorie"), currency)),
				labelled("arrotondamento", money(value(row, "Arrotondamento"), currency)),
				esigibilita === undefined ? undefined : ESIGIBILITA[esigibilita],
				nature === undefined ? undefined : naturaNote(nature),
				labelled("riferimento normativo:", value(row, "RiferimentoNormativo")),
			],
			"; ",
		);
		out.push(`- ${rate(row, "AliquotaIVA") ?? "IVA"}${parts === undefined ? "" : `: ${parts}`}`);
	}
	return out;
}

/**
 * Fund contributions, withholdings, stamp duty, discounts, the total and, with `toPay` when the
 * instalments add up to something else, what is to be paid.
 */
function totalLines(general: XmlElement | undefined, doc: FatturaDocument, toPay: boolean): string[] {
	const { currency } = doc;
	const out = [""];
	for (const fund of children(general, "DatiCassaPrevidenziale")) {
		const parts = joined([labelled("aliquota", percent(value(fund, "AlCassa"))), labelled("contributo", money(value(fund, "ImportoContributoCassa"), currency)), labelled("su imponibile", money(value(fund, "ImponibileCassa"), currency)), rate(fund, "AliquotaIVA"), value(fund, "Ritenuta") === "SI" ? "soggetto a ritenuta" : undefined]);
		out.push(`Cassa previdenziale: ${joined([coded(TIPO_CASSA, value(fund, "TipoCassa")) ?? "non indicata", parts])}`);
	}
	for (const withholding of children(general, "DatiRitenuta")) out.push(withholdingLine(withholding, currency));
	const stamp = child(general, "DatiBollo");
	if (stamp !== undefined) out.push(`Bollo virtuale: ${money(value(stamp, "ImportoBollo"), currency) ?? (value(stamp, "BolloVirtuale") === "SI" ? "sì" : "indicato")}`);
	const adjustments = defined(children(general, "ScontoMaggiorazione").map((s) => adjustment(s, currency)));
	if (adjustments.length > 0) out.push(`Sconto sul totale: ${adjustments.join(", ")}`);
	const { total } = doc;
	if (total !== undefined) out.push(`Totale documento: ${money(total, currency)}`);
	const due = !toPay || doc.toPay === undefined ? undefined : toUnits(doc.toPay);
	const totalUnits = total === undefined ? undefined : toUnits(total);
	if (due !== undefined && totalUnits !== undefined && due !== totalUnits) out.push(`Da pagare: ${money(doc.toPay, currency)} (diverso dal totale documento: di solito per ritenuta d'acconto, split payment o rate)`);
	const rounding = money(value(general, "Arrotondamento"), currency);
	if (rounding !== undefined) out.push(`Arrotondamento: ${rounding}`);
	return out.length === 1 ? [] : out;
}

/** The sum of every instalment, when each has an amount that reads; undefined otherwise. */
function paidSum(instalments: readonly FatturaInstalment[]): bigint | undefined {
	let sum = 0n;
	let any = false;
	for (const { amount } of instalments) {
		const units = amount === undefined ? undefined : toUnits(amount);
		if (units === undefined) return undefined;
		sum += units;
		any = true;
	}
	return any ? sum : undefined;
}

/**
 * «Ritenuta d'acconto (persone fisiche): 208,00 €, 20%, per lavoro autonomo professionale
 * (causale A): la trattiene il cliente e la versa all'Erario»; for RT03 to RT06 a social security
 * contribution withheld.
 */
function withholdingLine(el: XmlElement, currency: string): string {
	const type = value(el, "TipoRitenuta");
	const known = type !== undefined && Object.hasOwn(TIPO_RITENUTA, type) ? TIPO_RITENUTA[type] : undefined;
	const causale = value(el, "CausalePagamento");
	const meaning = causale !== undefined && Object.hasOwn(CAUSALE_PAGAMENTO, causale) ? CAUSALE_PAGAMENTO[causale] : undefined;
	const parts = joined([money(value(el, "ImportoRitenuta"), currency), percent(value(el, "AliquotaRitenuta")), meaning === undefined ? undefined : `per ${meaning} (causale ${causale})`]);
	if (known?.kind === "contributo") return `Contributo previdenziale trattenuto (${known.who})${parts === undefined ? "" : `: ${parts}`}`;
	const title = known === undefined ? `Ritenuta${type === undefined ? "" : ` (${type})`}` : `Ritenuta d'acconto (${known.who})`;
	return `${title}${parts === undefined ? "" : `: ${parts}`}: la trattiene il cliente e la versa all'Erario`;
}

/** The payment terms and instalments; `due` is the first due date, for the headline («prima scadenza» when there are instalments). */
function paymentLines(payments: XmlElement[], doc: FatturaDocument, instalmentOf: ReadonlyMap<XmlElement, FatturaInstalment>): { lines: string[]; due?: string } {
	const { currency, credit } = doc;
	const out: string[] = [];
	const dues: string[] = [];
	let instalments = 0;
	for (const payment of payments) {
		const terms = coded(CONDIZIONI_PAGAMENTO, value(payment, "CondizioniPagamento")) ?? "condizioni non indicate";
		out.push("", credit ? `Pagamento indicato (rimborso o storno a favore del cliente): ${terms}` : `Pagamento: ${terms}`);
		const details = children(payment, "DettaglioPagamento");
		instalments += details.length;
		details.forEach((detail, i) => {
			const instalment = instalmentOf.get(detail) ?? {};
			const raw = instalment.due;
			if (raw !== undefined && realDate(raw)) dues.push(raw);
			const parts = joined([
				money(instalment.amount, currency),
				dueText(detail, raw),
				labelled("codice pagamento/avviso", value(detail, "CodicePagamento")),
				labelled("IBAN", instalment.iban),
				labelled("istituto", value(detail, "IstitutoFinanziario")),
				labelled("BIC", value(detail, "BIC")),
				labelled("beneficiario", value(detail, "Beneficiario")),
				joined([labelled("sconto per pagamento anticipato", money(value(detail, "ScontoPagamentoAnticipato"), currency)), labelled("entro il", date(value(detail, "DataLimitePagamentoAnticipato")))], " "),
				joined([labelled("penale per ritardo", money(value(detail, "PenalitaPagamentiRitardati"), currency)), labelled("dal", date(value(detail, "DataDecorrenzaPenale")))], " "),
			]);
			const mode = coded(MODALITA_PAGAMENTO, instalment.method) ?? "modalità non indicata";
			out.push(`- ${details.length > 1 ? `rata ${i + 1} di ${details.length}, ` : ""}${mode}${parts === undefined ? "" : `: ${parts}`}`);
		});
	}
	const first = dues.sort()[0];
	const due = first === undefined ? undefined : `${instalments > 1 ? "prima scadenza" : "scadenza"} ${italianDate(first)}`;
	return { lines: out, ...(due === undefined ? {} : { due }) };
}

/**
 * The due date as the invoice writes it, which is the one that counts, checked against the terms
 * beside it: «scadenza lunedì 30/11/2026 (30 giorni fine mese dal 15/10/2026)», or what the terms
 * would give when they disagree. Days with no due date are said as they are, never worked out.
 */
function dueText(detail: XmlElement, raw: string | undefined): string | undefined {
	const fromRaw = value(detail, "DataRiferimentoTerminiPagamento");
	const from = fromRaw !== undefined && realDate(fromRaw) ? fromRaw : undefined;
	const daysRaw = value(detail, "GiorniTerminiPagamento");
	const days = daysRaw !== undefined && /^\d{1,3}$/.test(daysRaw) && Number(daysRaw) > 0 ? Number(daysRaw) : undefined;
	// A date of reference that does not exist (2026-02-30) is said as written, and said not valid.
	const start = fromRaw === undefined ? undefined : `dal ${date(fromRaw)}`;
	const invalid = fromRaw !== undefined && from === undefined;
	if (raw === undefined) {
		const said = start === undefined ? undefined : `${start}${invalid ? " (data non valida)" : ""}`;
		if (days !== undefined) return `a ${days} giorni ${said ?? "(data di partenza non indicata)"}`;
		return labelled("termini", said);
	}
	if (!realDate(raw)) return `scadenza ${raw} (data non valida)`;
	const due = `scadenza ${italianWeekday(raw)} ${italianDate(raw)}`;
	const inside = start === undefined ? undefined : `${start}${invalid ? ", data non valida" : ""}`;
	if (days === undefined) return inside === undefined ? due : `${due} (termini ${inside})`;
	if (from === undefined) return `${due} (a ${days} giorni${inside === undefined ? ", data di partenza non indicata" : ` ${inside}`})`;
	const plain = addDays(from, days);
	if (plain === raw) return `${due} (${days} giorni ${start})`;
	if (endOfMonth(plain) === raw) return `${due} (${days} giorni fine mese ${start})`;
	if (addDays(endOfMonth(from), days) === raw) return `${due} (fine mese più ${days} giorni ${start})`;
	return `${due}, come scritta in fattura (${days} giorni ${start} sarebbero ${italianWeekday(plain)} ${italianDate(plain)})`;
}

/** Attachments by name, format and size: never decoded. */
function attachmentLines(body: XmlElement): string[] {
	const list = children(body, "Allegati");
	if (list.length === 0) return [];
	const out = ["", `Allegati (${list.length}, non aperti):`];
	for (const attachment of list) {
		const size = base64Size(child(attachment, "Attachment")?.text ?? "");
		const about = joined([value(attachment, "FormatoAttachment"), labelled("compresso", value(attachment, "AlgoritmoCompressione")), size === 0 ? undefined : bytesLabel(size)]);
		const description = value(attachment, "DescrizioneAttachment");
		out.push(`- ${value(attachment, "NomeAttachment") ?? "senza nome"}${about === undefined ? "" : ` (${about})`}${description === undefined ? "" : `: ${description}`}`);
	}
	return out;
}

/** The size of what a base64 text decodes to, counted without decoding it. */
function base64Size(text: string): number {
	let chars = 0;
	let padding = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 61) padding++;
		else if (c > 32) chars++;
	}
	return Math.max(0, Math.floor(((chars + padding) * 3) / 4) - padding);
}

function bytesLabel(size: number): string {
	if (size < 1024) return `${size} byte`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(Math.round((size / 1024 / 1024) * 10) / 10).toString().replace(".", ",")} MB`;
}

/** The text of the element at `path` on one line (a value never makes a line of its own), at most MAX_VALUE characters. */
function value(el: XmlElement | undefined, path: string): string | undefined {
	return ownText(descendant(el, path));
}

function ownText(el: XmlElement | undefined): string | undefined {
	if (el === undefined) return undefined;
	const text = withoutBidiControls(el.text).replace(/\s+/g, " ").trim();
	if (text === "") return undefined;
	return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** «totale 12,00 €» when there is a value, nothing otherwise. */
function labelled(label: string, v: string | undefined): string | undefined {
	return v === undefined ? undefined : `${label} ${v}`;
}

/** The parts that are there, joined; undefined when none is. */
function joined(parts: readonly (string | undefined)[], separator = ", "): string | undefined {
	const there = defined(parts).filter((p) => p !== "");
	return there.length === 0 ? undefined : there.join(separator);
}

function defined(parts: readonly (string | undefined)[]): string[] {
	return parts.filter((p): p is string => p !== undefined);
}

/** The fields that have a value: optional properties stay absent rather than undefined. */
function optional<T extends Record<string, string | undefined>>(fields: T): { [K in keyof T]?: string } {
	return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: string };
}

/** FatturaPA's numbers: a dot for decimals, at most 8 of them, an optional minus. */
const DECIMAL = /^(-?)(\d{1,18})(?:\.(\d{1,8}))?$/;

/** A number written the Italian way from its digits: 1.234,5 with at least `minDecimals`; undefined when it is no number. */
function decimal(raw: string, minDecimals: number): string | undefined {
	const m = DECIMAL.exec(raw);
	if (m === null) return undefined;
	const integer = (m[2] as string).replace(/^0+(?=\d)/, "");
	const decimals = (m[3] ?? "").replace(/0+$/, "").padEnd(minDecimals, "0");
	const zero = /^0+$/.test(integer) && /^0*$/.test(decimals);
	const grouped = integer.replace(/\B(?=(\d{3})+$)/g, ".");
	return `${m[1] === "-" && !zero ? "-" : ""}${grouped}${decimals === "" ? "" : `,${decimals}`}`;
}

/** An amount in hundred-millionths, for exact sums; undefined when it is no number. */
export function toUnits(raw: string): bigint | undefined {
	const m = DECIMAL.exec(raw);
	if (m === null) return undefined;
	const units = BigInt(`${m[2]}${(m[3] ?? "").padEnd(8, "0")}`);
	return m[1] === "-" ? -units : units;
}

/** Hundred-millionths back to FatturaPA's decimal form: 125350000000n → 1253.50000000. */
export function fromUnits(units: bigint): string {
	const digits = (units < 0n ? -units : units).toString().padStart(9, "0");
	return `${units < 0n ? "-" : ""}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

/** 1.234,56 €, another currency by its code; as written when it is no amount. */
export function money(raw: string | undefined, currency: string): string | undefined {
	if (raw === undefined) return undefined;
	const shown = decimal(raw, 2);
	if (shown === undefined) return raw;
	return currency === "EUR" ? `${shown} €` : `${shown} ${currency}`;
}

/** 22% or 10,5%; as written when it is no number. */
function percent(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const shown = decimal(raw, 0);
	return shown === undefined ? raw : `${shown}%`;
}

function quantity(raw: string | undefined): string | undefined {
	return raw === undefined ? undefined : (decimal(raw, 0) ?? raw);
}

/** 17/10/2026 for a date that exists; anything else as written. */
function date(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	return realDate(raw) ? italianDate(raw) : raw;
}
