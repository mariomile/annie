/**
 * The FatturaPA 1.2.2 XML of an invoice issued here (sales-invoices.ts), the reader's counterpart
 * (fattura-pa.ts). Built as a small tree in the schema's order and serialised in one place: every
 * value is escaped, flattened to one line, stripped of control and format characters and brought
 * to Latin-1 (the schema's String…LatinType), so a name or a description can never add an element,
 * close one or break the file. A value longer than its field is an error, never cut: the input
 * layer refuses it first. Amounts come from sales-invoice-sums.ts, as FatturaPA writes them.
 */
import { latin1 } from "./plain-text.ts";
import {
	BOLLO_CENTS,
	CREDIT_NOTE_TYPE,
	ESIGIBILITA_IMMEDIATE,
	ESIGIBILITA_SPLIT,
	FATTURA_NAMESPACE,
	FATTURA_SCHEMA,
	FIELD_LIMITS,
	FORFETTARIO_DICITURA,
	FOREIGN_NO_VAT_ID,
	NO_CHANNEL_CODE,
	PAYMENT_FULL,
	REGIME_FORFETTARIO,
	RITENUTA_RATE,
} from "./sales-invoice-rules.ts";
import { amount2, decimalAtLeast, isFee, type SalesTotals } from "./sales-invoice-sums.ts";
import { type Address, type Buyer, formatOf, type IssuedInvoice } from "./sales-invoices.ts";

export class FatturaWriteError extends Error {
	override readonly name = "FatturaWriteError";
}

type Node = { readonly name: string; readonly text?: string; readonly kids?: readonly Node[] };
type Maybe = Node | undefined | false;

/** An element with children; those undefined or false are left out. */
function el(name: string, ...kids: readonly Maybe[]): Node {
	return { name, kids: kids.filter((k): k is Node => k !== undefined && k !== false) };
}

/** An element with a value, at most `max` characters once cleaned; none when the value is missing. */
function leaf(name: string, value: string | undefined, max = 1000): Node | undefined {
	if (value === undefined) return undefined;
	const text = latin1(value);
	if (text === "") throw new FatturaWriteError(`${name} è vuoto`);
	if (text.length > max) throw new FatturaWriteError(`${name} supera ${max} caratteri`);
	return { name, text };
}

const ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escaped(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

function serialise(node: Node, depth: number, out: string[]): void {
	const pad = "\t".repeat(depth);
	if (node.text !== undefined) {
		out.push(`${pad}<${node.name}>${escaped(node.text)}</${node.name}>`);
		return;
	}
	out.push(`${pad}<${node.name}>`);
	for (const kid of node.kids ?? []) serialise(kid, depth + 1, out);
	out.push(`${pad}</${node.name}>`);
}

const rate = (vat: number) => `${vat}.00`;

function sede(a: Address): Node {
	return el("Sede", leaf("Indirizzo", a.street, FIELD_LIMITS.indirizzo), leaf("CAP", a.cap, 5), leaf("Comune", a.town, FIELD_LIMITS.comune), leaf("Provincia", a.province, 2), leaf("Nazione", a.country, 2));
}

/** The customer's tax ids: the VAT number for a business, a foreign customer and an office that has one; the codice fiscale beside or alone. */
function buyerIds(b: Buyer): Maybe[] {
	const vat = b.vat === undefined ? (b.kind === "foreign" ? { country: b.address.country, code: FOREIGN_NO_VAT_ID } : undefined) : { country: b.vat.slice(0, 2), code: b.vat.slice(2) };
	return [vat !== undefined && el("IdFiscaleIVA", leaf("IdPaese", vat.country, 2), leaf("IdCodice", vat.code, 28)), b.kind !== "foreign" && leaf("CodiceFiscale", b.cf, 16)];
}

function header(inv: IssuedInvoice): Node {
	const { seller, buyer } = inv;
	// PECDestinatario only beside the code of no channel (specifiche tecniche).
	const pec = buyer.code === NO_CHANNEL_CODE ? buyer.pec : undefined;
	return el(
		"FatturaElettronicaHeader",
		el(
			"DatiTrasmissione",
			el("IdTrasmittente", leaf("IdPaese", "IT", 2), leaf("IdCodice", seller.cf, 28)),
			leaf("ProgressivoInvio", inv.progressive, 10),
			leaf("FormatoTrasmissione", formatOf(buyer), 5),
			leaf("CodiceDestinatario", buyer.code, 7),
			leaf("PECDestinatario", pec, FIELD_LIMITS.pec),
		),
		el(
			"CedentePrestatore",
			el("DatiAnagrafici", el("IdFiscaleIVA", leaf("IdPaese", "IT", 2), leaf("IdCodice", seller.vat.slice(2), 28)), leaf("CodiceFiscale", seller.cf, 16), el("Anagrafica", leaf("Denominazione", seller.name, FIELD_LIMITS.denominazione)), leaf("RegimeFiscale", seller.regime, 4)),
			sede(seller.address),
			seller.rea !== undefined && el("IscrizioneREA", leaf("Ufficio", seller.rea.office, 2), leaf("NumeroREA", seller.rea.number, 20), leaf("StatoLiquidazione", "LN", 2)),
			(seller.phone !== undefined || seller.email !== undefined) && el("Contatti", leaf("Telefono", seller.phone, 12), leaf("Email", seller.email, FIELD_LIMITS.email)),
		),
		el("CessionarioCommittente", el("DatiAnagrafici", ...buyerIds(buyer), el("Anagrafica", leaf("Denominazione", buyer.name, FIELD_LIMITS.denominazione))), sede(buyer.address)),
	);
}

function general(inv: IssuedInvoice, t: SalesTotals): Node {
	const causali = [inv.regime === REGIME_FORFETTARIO ? FORFETTARIO_DICITURA : undefined, inv.causale].filter((c): c is string => c !== undefined);
	return el(
		"DatiGenerali",
		el(
			"DatiGeneraliDocumento",
			leaf("TipoDocumento", inv.type, 4),
			leaf("Divisa", "EUR", 3),
			leaf("Data", inv.date, 10),
			leaf("Numero", inv.number, FIELD_LIMITS.numero),
			inv.ritenuta !== undefined && el("DatiRitenuta", leaf("TipoRitenuta", inv.ritenuta.type, 4), leaf("ImportoRitenuta", amount2(t.ritenuta), 15), leaf("AliquotaRitenuta", rate(RITENUTA_RATE), 6), leaf("CausalePagamento", inv.ritenuta.causale, 2)),
			t.bollo.due && el("DatiBollo", leaf("BolloVirtuale", "SI", 2), leaf("ImportoBollo", amount2(BOLLO_CENTS), 15)),
			...t.cassa.map((c) =>
				el(
					"DatiCassaPrevidenziale",
					leaf("TipoCassa", inv.cassa?.type, 4),
					leaf("AlCassa", decimalAtLeast(inv.cassa?.rate ?? "0", 2), 6),
					leaf("ImportoContributoCassa", amount2(c.amount), 15),
					leaf("ImponibileCassa", amount2(c.base), 15),
					leaf("AliquotaIVA", rate(c.vat), 6),
					inv.ritenuta !== undefined && inv.cassa?.subject === true && leaf("Ritenuta", "SI", 2),
					leaf("Natura", c.natura, 4),
				),
			),
			leaf("ImportoTotaleDocumento", amount2(t.total), 15),
			...causali.map((c) => leaf("Causale", c, FIELD_LIMITS.causale)),
		),
		inv.order !== undefined && el("DatiOrdineAcquisto", leaf("IdDocumento", inv.order.id, FIELD_LIMITS.idDocumento), leaf("CodiceCUP", inv.order.cup, FIELD_LIMITS.cup), leaf("CodiceCIG", inv.order.cig, FIELD_LIMITS.cig)),
		inv.related !== undefined && el("DatiFattureCollegate", leaf("IdDocumento", inv.related.number, FIELD_LIMITS.idDocumento), leaf("Data", inv.related.date, 10)),
	);
}

function goods(inv: IssuedInvoice, t: SalesTotals): Node {
	const lines = t.lines.map((l, i) =>
		el(
			"DettaglioLinee",
			leaf("NumeroLinea", String(i + 1), 4),
			leaf("Descrizione", l.description, FIELD_LIMITS.descrizione),
			leaf("Quantita", decimalAtLeast(l.quantity, 2), 21),
			leaf("UnitaMisura", l.unit, FIELD_LIMITS.unitaMisura),
			leaf("PrezzoUnitario", decimalAtLeast(l.price, 2), 21),
			l.discount !== undefined && el("ScontoMaggiorazione", leaf("Tipo", "SC", 2), leaf("Percentuale", decimalAtLeast(l.discount, 2), 6)),
			leaf("PrezzoTotale", amount2(t.amounts[i] as bigint), 21),
			leaf("AliquotaIVA", rate(l.vat), 6),
			// The ritenuta is on the fees only: never a spesa anticipata (N1) or the bollo charged back.
			inv.ritenuta !== undefined && isFee(l) && leaf("Ritenuta", "SI", 2),
			leaf("Natura", l.natura, 4),
		),
	);
	const rows = t.rows.map((r) =>
		el(
			"DatiRiepilogo",
			leaf("AliquotaIVA", rate(r.vat), 6),
			leaf("Natura", r.natura, 4),
			leaf("ImponibileImporto", amount2(r.taxable), 15),
			leaf("Imposta", amount2(r.tax), 15),
			r.vat > 0 && leaf("EsigibilitaIVA", inv.splitPayment === true ? ESIGIBILITA_SPLIT : ESIGIBILITA_IMMEDIATE, 1),
			leaf("RiferimentoNormativo", r.reference, FIELD_LIMITS.riferimentoNormativo),
		),
	);
	return el("DatiBeniServizi", ...lines, ...rows);
}

function payment(inv: IssuedInvoice, t: SalesTotals): Node | undefined {
	const p = inv.payment;
	if (p === undefined || inv.type === CREDIT_NOTE_TYPE) return undefined;
	const terms = p.days > 0;
	return el(
		"DatiPagamento",
		leaf("CondizioniPagamento", PAYMENT_FULL, 4),
		el(
			"DettaglioPagamento",
			leaf("ModalitaPagamento", p.method, 4),
			terms && leaf("DataRiferimentoTerminiPagamento", inv.date, 10),
			terms && leaf("GiorniTerminiPagamento", String(p.days), 3),
			leaf("DataScadenzaPagamento", inv.due, 10),
			leaf("ImportoPagamento", amount2(t.toPay), 15),
			leaf("IBAN", p.iban, 34),
		),
	);
}

/** The XML of an issued invoice with its totals. */
export function fatturaXml(inv: IssuedInvoice, totals: SalesTotals): string {
	const body = el("FatturaElettronicaBody", general(inv, totals), goods(inv, totals), payment(inv, totals));
	const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<p:FatturaElettronica versione="${formatOf(inv.buyer)}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="${FATTURA_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${FATTURA_SCHEMA}">`];
	serialise(header(inv), 1, out);
	serialise(body, 1, out);
	out.push("</p:FatturaElettronica>");
	return `${out.join("\n")}\n`;
}

/** «IT01234567897_0000C.xml»: the seller's partita IVA and the file's progressive (the SdI's naming). */
export function fatturaFileName(sellerVat: string, progressive: string, ext: "xml" | "pdf" = "xml"): string {
	return `${sellerVat}_${progressive}.${ext}`;
}
