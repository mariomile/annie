/**
 * Italian electronic invoices (FatturaPA, the XML the Sistema di Interscambio delivers), plain or
 * signed (.xml.p7m): recognised by their content and read as a summary in Italian for the model:
 * the document, supplier and customer, lines, VAT, totals, payment, attachments by name. Only what
 * the file says; what is missing is left out. The XML is read with a small linear tokenizer: no
 * DTD (a DOCTYPE is refused, so no entity is ever expanded), only the five XML entities and
 * numeric references, any namespace prefix, CDATA. The document worker loads this file from
 * source: erasable TypeScript only.
 */
import { xmlUnescape } from "./html-text.ts";
import { formatResult, italianDate, italianMoney } from "./italian-format.ts";
import { isSignedEnvelope, MAX_P7M_BYTES, signedContent, signedContentStart } from "./p7m.ts";
import { checkCodiceFiscale, EU_VAT_COUNTRIES, parseTaxId } from "./tax-ids.ts";

export class FatturaError extends Error {
	override readonly name = "FatturaError";
}

/** The largest invoice read, in bytes: as a file inside an archive (ADR 0026); SdI's own limit is 5 MB. */
export const MAX_FATTURA_BYTES = MAX_P7M_BYTES;

/** Elements in one file, and their nesting: an invoice has a few thousand, about 7 deep. */
const MAX_ELEMENTS = 1_000_000;
const MAX_DEPTH = 64;

/** Lines shown per document, documents shown per file; the rest is counted. */
const MAX_LINES = 50;
const MAX_BODIES = 100;

/** The longest value shown: a line's description may be 1000 characters. */
const MAX_VALUE = 1000;

/** How much of the start is looked at to recognise an invoice: the root element comes first. */
const SNIFF_BYTES = 16 * 1024;

/** The namespace of FatturaPA 1.2 (FPA12, FPR12), and of the older versions under the same path. */
const NAMESPACE = "ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/";

const TIPO_DOCUMENTO: Record<string, string> = {
	TD01: "fattura",
	TD02: "acconto o anticipo su fattura",
	TD03: "acconto o anticipo su parcella",
	TD04: "nota di credito",
	TD05: "nota di debito",
	TD06: "parcella",
	TD07: "fattura semplificata",
	TD08: "nota di credito semplificata",
	TD09: "nota di debito semplificata",
	TD16: "integrazione fattura reverse charge interno",
	TD17: "integrazione o autofattura per acquisto di servizi dall'estero",
	TD18: "integrazione per acquisto di beni intracomunitari",
	TD19: "integrazione o autofattura per acquisto di beni ex art. 17 c. 2 DPR 633/72",
	TD20: "autofattura per regolarizzazione e integrazione delle fatture",
	TD21: "autofattura per splafonamento",
	TD22: "estrazione di beni da deposito IVA",
	TD23: "estrazione di beni da deposito IVA con versamento dell'IVA",
	TD24: "fattura differita (art. 21 c. 4 lett. a DPR 633/72)",
	TD25: "fattura differita (art. 21 c. 4 terzo periodo lett. b DPR 633/72)",
	TD26: "cessione di beni ammortizzabili e passaggi interni",
	TD27: "fattura per autoconsumo o cessioni gratuite senza rivalsa",
	TD28: "acquisti da San Marino con IVA (fattura cartacea)",
	TD29: "comunicazione per omessa o irregolare fatturazione",
};

const REGIME_FISCALE: Record<string, string> = {
	RF01: "ordinario",
	RF02: "contribuenti minimi",
	RF04: "agricoltura, attività connesse e pesca",
	RF05: "vendita sali e tabacchi",
	RF06: "commercio dei fiammiferi",
	RF07: "editoria",
	RF08: "gestione servizi di telefonia pubblica",
	RF09: "rivendita documenti di trasporto pubblico e di sosta",
	RF10: "intrattenimenti, giochi e altre attività (DPR 640/72)",
	RF11: "agenzie di viaggi e turismo",
	RF12: "agriturismo",
	RF13: "vendite a domicilio",
	RF14: "rivendita di beni usati, oggetti d'arte, d'antiquariato o da collezione",
	RF15: "agenzie di vendite all'asta di oggetti d'arte, antiquariato o da collezione",
	RF16: "IVA per cassa della pubblica amministrazione",
	RF17: "IVA per cassa",
	RF18: "altro",
	RF19: "forfettario",
	RF20: "franchigia IVA transfrontaliera",
};

const NATURA: Record<string, string> = {
	N1: "escluse ex art. 15 DPR 633/72",
	N2: "non soggette",
	"N2.1": "non soggette ad IVA, artt. da 7 a 7-septies DPR 633/72",
	"N2.2": "non soggette, altri casi",
	N3: "non imponibili",
	"N3.1": "non imponibili, esportazioni",
	"N3.2": "non imponibili, cessioni intracomunitarie",
	"N3.3": "non imponibili, cessioni verso San Marino",
	"N3.4": "non imponibili, operazioni assimilate alle esportazioni",
	"N3.5": "non imponibili, a seguito di dichiarazioni d'intento",
	"N3.6": "non imponibili, altre operazioni che non concorrono al plafond",
	N4: "esenti",
	N5: "regime del margine, IVA non esposta in fattura",
	N6: "inversione contabile (reverse charge)",
	"N6.1": "inversione contabile, rottami e materiali di recupero",
	"N6.2": "inversione contabile, oro e argento",
	"N6.3": "inversione contabile, subappalto nel settore edile",
	"N6.4": "inversione contabile, cessione di fabbricati",
	"N6.5": "inversione contabile, telefoni cellulari",
	"N6.6": "inversione contabile, prodotti elettronici",
	"N6.7": "inversione contabile, comparto edile e settori connessi",
	"N6.8": "inversione contabile, settore energetico",
	"N6.9": "inversione contabile, altri casi",
	N7: "IVA assolta in altro Stato UE",
};

const ESIGIBILITA: Record<string, string> = { I: "immediata", D: "differita", S: "scissione dei pagamenti (split payment)" };

const TIPO_RITENUTA: Record<string, string> = {
	RT01: "persone fisiche",
	RT02: "persone giuridiche",
	RT03: "contributo INPS",
	RT04: "contributo ENASARCO",
	RT05: "contributo ENPAM",
	RT06: "altro contributo previdenziale",
};

const TIPO_CASSA: Record<string, string> = {
	TC01: "Cassa forense (avvocati)",
	TC02: "Cassa dottori commercialisti",
	TC03: "Cassa geometri",
	TC04: "Inarcassa (ingegneri e architetti)",
	TC05: "Cassa del notariato",
	TC06: "Cassa ragionieri e periti commerciali",
	TC07: "ENASARCO",
	TC08: "ENPACL (consulenti del lavoro)",
	TC09: "ENPAM (medici)",
	TC10: "ENPAF (farmacisti)",
	TC11: "ENPAV (veterinari)",
	TC12: "ENPAIA (impiegati dell'agricoltura)",
	TC13: "Fondo previdenza imprese di spedizione e agenzie marittime",
	TC14: "INPGI (giornalisti)",
	TC15: "ONAOSI",
	TC16: "CASAGIT",
	TC17: "EPPI (periti industriali)",
	TC18: "EPAP (pluricategoriale)",
	TC19: "ENPAB (biologi)",
	TC20: "ENPAPI (infermieri)",
	TC21: "ENPAP (psicologi)",
	TC22: "INPS",
};

const CONDIZIONI_PAGAMENTO: Record<string, string> = { TP01: "pagamento a rate", TP02: "pagamento completo", TP03: "anticipo" };

const MODALITA_PAGAMENTO: Record<string, string> = {
	MP01: "contanti",
	MP02: "assegno",
	MP03: "assegno circolare",
	MP04: "contanti presso la Tesoreria",
	MP05: "bonifico",
	MP06: "vaglia cambiario",
	MP07: "bollettino bancario",
	MP08: "carta di pagamento",
	MP09: "RID",
	MP10: "RID utenze",
	MP11: "RID veloce",
	MP12: "RIBA",
	MP13: "MAV",
	MP14: "quietanza erario",
	MP15: "giroconto su conti di contabilità speciale",
	MP16: "domiciliazione bancaria",
	MP17: "domiciliazione postale",
	MP18: "bollettino di c/c postale",
	MP19: "SEPA Direct Debit",
	MP20: "SEPA Direct Debit CORE",
	MP21: "SEPA Direct Debit B2B",
	MP22: "trattenuta su somme già riscosse",
	MP23: "pagoPA",
};

/** An element of the invoice: its local name (no prefix), its children, its own text. */
type Element = { readonly name: string; readonly children: Element[]; text: string };

/**
 * Whether these bytes are a FatturaPA, plain or signed, from their start only: the root element
 * is FatturaElettronica in FatturaPA's namespace (or with a versione FPA12 or FPR12 attribute).
 */
export function isFatturaPA(data: Uint8Array): boolean {
	if (isSignedEnvelope(data)) {
		const start = signedContentStart(data, SNIFF_BYTES);
		return start !== undefined && rootOf(decode(start.subarray(0, SNIFF_BYTES))) !== undefined;
	}
	return rootOf(decode(data.subarray(0, SNIFF_BYTES))) !== undefined;
}

/**
 * The root element's attributes when the text starts like a FatturaPA: past the XML declaration,
 * processing instructions, comments and a DOCTYPE (refused later, when the file is read).
 */
function rootOf(text: string): { readonly doctype: boolean; readonly attrs: string } | undefined {
	let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	let doctype = false;
	for (;;) {
		while (at < text.length && /\s/.test(text.charAt(at))) at++;
		if (text.startsWith("<?", at)) at = after(text, "?>", at);
		else if (text.startsWith("<!--", at)) at = after(text, "-->", at);
		else if (text.startsWith("<!DOCTYPE", at)) {
			doctype = true;
			at = doctypeEnd(text, at);
		} else break;
		if (at < 0) return undefined;
	}
	if (text.charAt(at) !== "<") return undefined;
	const end = tagEnd(text, at);
	if (end < 0) return undefined;
	const tag = text.slice(at + 1, end);
	const name = /^[^\s/>]+/.exec(tag)?.[0] ?? "";
	if (localName(name) !== "FatturaElettronica") return undefined;
	const attrs = tag.slice(name.length);
	return attrs.includes(NAMESPACE) || /\bversione\s*=\s*["'](FPA12|FPR12)["']/.test(attrs) ? { doctype, attrs } : undefined;
}

/** The index after `close`, searched from `at`; -1 when it is not there. */
function after(text: string, close: string, at: number): number {
	const end = text.indexOf(close, at);
	return end < 0 ? -1 : end + close.length;
}

/** The end of a DOCTYPE, past an internal subset in brackets and quoted strings; -1 when it does not end. */
function doctypeEnd(text: string, at: number): number {
	let brackets = 0;
	let quote = "";
	for (let i = at; i < text.length; i++) {
		const c = text.charAt(i);
		if (quote !== "") {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "[") brackets++;
		else if (c === "]") brackets--;
		else if (c === ">" && brackets <= 0) return i + 1;
	}
	return -1;
}

/** The index of the `>` that closes the tag opening at `at`, past `>` inside quoted attribute values; -1 if none. */
function tagEnd(text: string, at: number): number {
	let quote = "";
	for (let i = at + 1; i < text.length; i++) {
		const c = text.charAt(i);
		if (quote !== "") {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === ">") return i;
	}
	return -1;
}

function localName(name: string): string {
	return name.slice(name.lastIndexOf(":") + 1);
}

/**
 * Bytes as text in the encoding they declare: UTF-8 unless a byte order mark says UTF-16 or the
 * XML declaration names another (ISO-8859-1 and Windows-1252 turn up in invoices from old programs).
 */
function decode(data: Uint8Array): string {
	if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
	if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
	const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 200)).toString("latin1");
	const declared = /^(?:﻿|\xEF\xBB\xBF)?\s*<\?xml[^>]{0,150}?encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head)?.[1];
	let label = "utf-8";
	if (declared !== undefined) {
		try {
			label = new TextDecoder(declared).encoding;
		} catch {
			// An encoding nobody knows: UTF-8, as XML says when nothing else is known.
		}
	}
	return new TextDecoder(label).decode(data);
}

/**
 * The invoice's summary, from the XML or from the signed file around it; a FatturaError (or a
 * P7mError for the envelope) in Italian when it cannot be read.
 */
export function fatturaText(data: Uint8Array): { text: string; parts?: number } {
	if (data.length > MAX_FATTURA_BYTES) throw new FatturaError("la fattura è troppo grande da leggere");
	const signed = isSignedEnvelope(data);
	const xml = decode(signed ? signedContent(data) : data);
	const root = rootOf(xml);
	if (root === undefined) throw new FatturaError(signed ? "il file firmato non contiene una fattura elettronica che so leggere" : "non è una fattura elettronica che so leggere");
	if (root.doctype) throw new FatturaError("la fattura contiene una dichiarazione DOCTYPE: per sicurezza non la leggo (le fatture elettroniche vere non ne hanno)");
	const invoice = parse(xml);
	const bodies = all(invoice, "FatturaElettronicaBody");
	const out: string[] = [];
	const format = value(invoice, "FatturaElettronicaHeader/DatiTrasmissione/FormatoTrasmissione") ?? /\bversione\s*=\s*["']([^"']{1,10})["']/.exec(root.attrs)?.[1];
	const audience = format === "FPA12" ? ", verso la pubblica amministrazione" : format === "FPR12" ? ", tra privati" : "";
	out.push(`Fattura elettronica (FatturaPA${format === undefined ? "" : ` ${format}${audience}`})`);
	if (signed) out.push("Firma digitale presente, non verificata.");
	if (bodies.length > 1) out.push(`Lotto di ${bodies.length} documenti.`);
	out.push(...header(invoice));
	bodies.slice(0, MAX_BODIES).forEach((body, i) => {
		out.push("");
		if (bodies.length > 1) out.push(`## Documento ${i + 1} di ${bodies.length}`);
		out.push(...bodyLines(body));
	});
	if (bodies.length > MAX_BODIES) out.push("", `E altri ${bodies.length - MAX_BODIES} documenti non mostrati.`);
	return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), ...(bodies.length > 1 ? { parts: bodies.length } : {}) };
}

/**
 * The XML as a tree of elements, by local names. One forward pass with indexOf: comments,
 * processing instructions and CDATA are found by their ends, a tag's end past quoted values.
 * Any declaration (<!DOCTYPE, <!ENTITY) is refused; unknown entities stay as written.
 */
function parse(xml: string): Element {
	const stack: Element[] = [];
	let root: Element | undefined;
	let count = 0;
	let at = 0;
	const broken = () => new FatturaError("il file XML della fattura è rovinato o incompleto");
	while (at < xml.length) {
		const lt = xml.indexOf("<", at);
		const textEnd = lt < 0 ? xml.length : lt;
		const top = stack.at(-1);
		if (textEnd > at && top !== undefined) top.text += xmlUnescape(xml.slice(at, textEnd));
		if (lt < 0) break;
		if (xml.startsWith("<!--", lt)) at = after(xml, "-->", lt + 4);
		else if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt + 9);
			if (end < 0) throw broken();
			if (top !== undefined) top.text += xml.slice(lt + 9, end);
			at = end + 3;
		} else if (xml.startsWith("<?", lt)) at = after(xml, "?>", lt + 2);
		else if (xml.startsWith("<!", lt)) throw new FatturaError("la fattura contiene dichiarazioni (DOCTYPE o ENTITY): per sicurezza non la leggo");
		else if (xml.charAt(lt + 1) === "/") {
			const end = xml.indexOf(">", lt);
			if (end < 0) throw broken();
			const open = stack.pop();
			if (open === undefined || open.name !== localName(xml.slice(lt + 2, end).trim())) throw broken();
			at = end + 1;
		} else {
			const end = tagEnd(xml, lt);
			if (end < 0) throw broken();
			const tag = xml.slice(lt + 1, end);
			const name = /^[^\s/>]+/.exec(tag)?.[0];
			if (name === undefined) throw broken();
			if (++count > MAX_ELEMENTS) throw new FatturaError("la fattura ha troppi elementi da leggere");
			const element: Element = { name: localName(name), children: [], text: "" };
			if (top !== undefined) top.children.push(element);
			else if (root === undefined) root = element;
			else throw broken();
			if (!tag.endsWith("/")) {
				if (stack.length >= MAX_DEPTH) throw new FatturaError("la fattura è annidata troppo in profondità");
				stack.push(element);
			}
			at = end + 1;
		}
		if (at < 0) throw broken();
	}
	if (root === undefined || stack.length > 0) throw broken();
	if (root.name !== "FatturaElettronica") throw new FatturaError("non è una fattura elettronica che so leggere");
	return root;
}

function child(el: Element | undefined, name: string): Element | undefined {
	return el?.children.find((c) => c.name === name);
}

function all(el: Element | undefined, name: string): Element[] {
	return el === undefined ? [] : el.children.filter((c) => c.name === name);
}

/** The element at a path of local names, «A/B/C», taking the first of each. */
function at(el: Element | undefined, path: string): Element | undefined {
	let current = el;
	for (const name of path.split("/")) current = child(current, name);
	return current;
}

/** The text of the element at `path` on one line, at most MAX_VALUE characters; undefined when empty or missing. */
function value(el: Element | undefined, path: string): string | undefined {
	return ownText(at(el, path));
}

/** An element's own text on one line (a value never makes a line of its own), at most MAX_VALUE characters. */
function ownText(el: Element | undefined): string | undefined {
	if (el === undefined) return undefined;
	const text = el.text.replace(/\s+/g, " ").trim();
	if (text === "") return undefined;
	return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** «TD01 fattura»: a code with its meaning, or the code alone when it is not one of the known ones. */
function coded(table: Record<string, string>, code: string | undefined): string | undefined {
	if (code === undefined) return undefined;
	const meaning = Object.hasOwn(table, code) ? table[code] : undefined;
	return meaning === undefined ? code : `${code} ${meaning}`;
}

/** 1.234,56 €; another currency by its code; as written when it is no amount. */
function money(raw: string | undefined, currency: string): string | undefined {
	if (raw === undefined) return undefined;
	if (!/^-?\d{1,15}(?:\.\d{1,8})?$/.test(raw)) return raw;
	const decimals = Math.max(2, (raw.split(".")[1] ?? "").replace(/0+$/, "").length);
	try {
		const shown = italianMoney(Number(raw), decimals);
		return currency === "EUR" ? `${shown} €` : `${shown} ${currency}`;
	} catch {
		return raw;
	}
}

/** 22% or 10,5%; as written when it is no number. */
function percent(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	return /^\d{1,3}(?:\.\d{1,8})?$/.test(raw) ? `${formatResult(Number(raw))}%` : raw;
}

/** 17/10/2026; as written when it is no date. */
function date(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? italianDate(raw) : raw;
}

function quantity(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	return /^\d{1,12}(?:\.\d{1,8})?$/.test(raw) ? formatResult(Number(raw)) : raw;
}

/** The parts that are there, joined; undefined when none is. */
function joined(parts: readonly (string | undefined)[], separator = ", "): string | undefined {
	const there = parts.filter((p): p is string => p !== undefined && p !== "");
	return there.length === 0 ? undefined : there.join(separator);
}

/** The transmission, the supplier and the customer: once per file, also for a lotto. */
function header(invoice: Element): string[] {
	const head = child(invoice, "FatturaElettronicaHeader");
	const out: string[] = [];
	const transmission = child(head, "DatiTrasmissione");
	const recipient = joined([value(transmission, "CodiceDestinatario") === undefined ? undefined : `codice destinatario ${value(transmission, "CodiceDestinatario")}`, value(transmission, "PECDestinatario") === undefined ? undefined : `PEC ${value(transmission, "PECDestinatario")}`]);
	if (recipient !== undefined) out.push(`Recapito: ${recipient}`);
	out.push("", ...party("Fornitore (cedente/prestatore)", child(head, "CedentePrestatore"), true));
	const representative = child(head, "RappresentanteFiscale");
	if (representative !== undefined) out.push("", ...party("Rappresentante fiscale del fornitore", representative, false));
	out.push("", ...party("Cliente (cessionario/committente)", child(head, "CessionarioCommittente"), false));
	return out;
}

/** A supplier or a customer: name, tax ids checked on paper, address, regime, contacts. */
function party(title: string, el: Element | undefined, supplier: boolean): string[] {
	if (el === undefined) return [`${title}: non indicato`];
	const data = child(el, "DatiAnagrafici");
	const registry = child(data, "Anagrafica");
	const name = value(registry, "Denominazione") ?? joined([value(registry, "Titolo"), value(registry, "Nome"), value(registry, "Cognome")], " ");
	const out = [`${title}: ${name ?? "nome non indicato"}`];
	const country = value(data, "IdFiscaleIVA/IdPaese");
	const code = value(data, "IdFiscaleIVA/IdCodice");
	if (code !== undefined) out.push(`- Partita IVA: ${country ?? ""}${code}${vatProblem(country, code)}`);
	const fiscal = value(data, "CodiceFiscale");
	if (fiscal !== undefined) out.push(`- Codice fiscale: ${fiscal}${fiscalProblem(fiscal)}`);
	const sede = child(el, "Sede");
	if (sede !== undefined) {
		const street = joined([value(sede, "Indirizzo"), value(sede, "NumeroCivico")], " ");
		const province = value(sede, "Provincia");
		const town = joined([value(sede, "CAP"), value(sede, "Comune"), province === undefined ? undefined : `(${province})`], " ");
		const address = joined([street, town, value(sede, "Nazione")]);
		if (address !== undefined) out.push(`- Sede: ${address}`);
	}
	if (supplier) {
		const regime = coded(REGIME_FISCALE, value(data, "RegimeFiscale"));
		if (regime !== undefined) out.push(`- Regime fiscale: ${regime}`);
		const rea = child(el, "IscrizioneREA");
		const reaNumber = joined([value(rea, "Ufficio"), value(rea, "NumeroREA")], " ");
		if (reaNumber !== undefined) out.push(`- REA: ${reaNumber}${value(rea, "StatoLiquidazione") === "LS" ? " (in liquidazione)" : ""}`);
	}
	const contacts = joined([value(el, "Contatti/Telefono") === undefined ? undefined : `tel. ${value(el, "Contatti/Telefono")}`, value(el, "Contatti/Email") === undefined ? undefined : `email ${value(el, "Contatti/Email")}`]);
	if (contacts !== undefined) out.push(`- Contatti: ${contacts}`);
	return out;
}

/** What the offline check finds wrong with a VAT number, in parentheses; nothing for countries it does not know. */
function vatProblem(country: string | undefined, code: string): string {
	const prefix = country === "GR" ? "EL" : country;
	if (prefix === undefined || !Object.hasOwn(EU_VAT_COUNTRIES, prefix)) return "";
	const id = parseTaxId(code, prefix);
	const problem = "problem" in id ? id.problem : undefined;
	return problem === undefined ? "" : ` (il controllo formale non torna: ${problem})`;
}

/** A codice fiscale checked on paper: a person's 16 characters, or a company's 11 digits. */
function fiscalProblem(code: string): string {
	let problem: string | undefined;
	if (/^\d{11}$/.test(code)) {
		const id = parseTaxId(code, "IT");
		problem = id.kind === "vat" ? id.problem : undefined;
	} else {
		const checked = checkCodiceFiscale(code);
		problem = "problem" in checked ? checked.problem : undefined;
	}
	return problem === undefined ? "" : ` (il controllo formale non torna: ${problem})`;
}

/** One document of the file: data, lines, VAT, totals, payment, attachments. */
function bodyLines(body: Element): string[] {
	const general = at(body, "DatiGenerali/DatiGeneraliDocumento");
	const currency = value(general, "Divisa") ?? "EUR";
	const out: string[] = [];
	const type = value(general, "TipoDocumento");
	if (type !== undefined) out.push(`Tipo documento: ${coded(TIPO_DOCUMENTO, type)}`);
	const number = value(general, "Numero");
	if (number !== undefined) out.push(`Numero: ${number}`);
	const issued = date(value(general, "Data"));
	if (issued !== undefined) out.push(`Data: ${issued}`);
	if (value(general, "Divisa") !== undefined) out.push(`Divisa: ${currency}`);
	const reasons = all(general, "Causale")
		.map(ownText)
		.filter((c) => c !== undefined);
	if (reasons.length > 0) out.push(`Causale: ${reasons.join(" ").slice(0, 2 * MAX_VALUE)}`);
	for (const linked of all(child(body, "DatiGenerali"), "DatiFattureCollegate")) {
		const what = joined([value(linked, "IdDocumento") === undefined ? undefined : `n. ${value(linked, "IdDocumento")}`, date(value(linked, "Data")) === undefined ? undefined : `del ${date(value(linked, "Data"))}`], " ");
		if (what !== undefined) out.push(`Fattura collegata: ${what}`);
	}
	out.push(...lines(child(body, "DatiBeniServizi"), currency));
	out.push(...summaries(child(body, "DatiBeniServizi"), currency));
	out.push(...totals(general, currency));
	out.push(...payments(body, currency));
	out.push(...attachments(body));
	return out;
}

function lines(goods: Element | undefined, currency: string): string[] {
	const rows = all(goods, "DettaglioLinee");
	if (rows.length === 0) return [];
	const out = ["", `Righe (${rows.length}):`];
	rows.slice(0, MAX_LINES).forEach((row, i) => {
		const unit = value(row, "UnitaMisura");
		const amount = quantity(value(row, "Quantita"));
		const discounts = all(row, "ScontoMaggiorazione")
			.map((s) => discount(s, currency))
			.filter((s) => s !== undefined);
		const details = joined(
			[
				amount === undefined ? undefined : `quantità ${amount}${unit === undefined ? "" : ` ${unit}`}`,
				money(value(row, "PrezzoUnitario"), currency) === undefined ? undefined : `prezzo unitario ${money(value(row, "PrezzoUnitario"), currency)}`,
				...discounts,
				rate(row),
				value(row, "Ritenuta") === "SI" ? "soggetta a ritenuta" : undefined,
				money(value(row, "PrezzoTotale"), currency) === undefined ? undefined : `totale ${money(value(row, "PrezzoTotale"), currency)}`,
			],
			"; ",
		);
		out.push(`${value(row, "NumeroLinea") ?? i + 1}. ${value(row, "Descrizione") ?? "(senza descrizione)"}${details === undefined ? "" : `; ${details}`}`);
	});
	if (rows.length > MAX_LINES) out.push(`e altre ${rows.length - MAX_LINES} righe`);
	return out;
}

/** «sconto 10%», «maggiorazione 5,00 €». */
function discount(el: Element, currency: string): string | undefined {
	const kind = value(el, "Tipo") === "MG" ? "maggiorazione" : "sconto";
	const how = percent(value(el, "Percentuale")) ?? money(value(el, "Importo"), currency);
	return how === undefined ? undefined : `${kind} ${how}`;
}

/** «IVA 22%», or the nature of a line without VAT: «N2.2 non soggette, altri casi». */
function rate(el: Element): string | undefined {
	const nature = coded(NATURA, value(el, "Natura"));
	const vat = value(el, "AliquotaIVA");
	if (nature !== undefined && (vat === undefined || Number(vat) === 0)) return `IVA ${nature}`;
	return vat === undefined ? undefined : `IVA ${percent(vat)}`;
}

function summaries(goods: Element | undefined, currency: string): string[] {
	const rows = all(goods, "DatiRiepilogo");
	if (rows.length === 0) return [];
	const out = ["", "Riepilogo IVA:"];
	for (const row of rows) {
		const esigibilita = value(row, "EsigibilitaIVA");
		const parts = joined(
			[
				money(value(row, "ImponibileImporto"), currency) === undefined ? undefined : `imponibile ${money(value(row, "ImponibileImporto"), currency)}`,
				money(value(row, "Imposta"), currency) === undefined ? undefined : `imposta ${money(value(row, "Imposta"), currency)}`,
				money(value(row, "SpeseAccessorie"), currency) === undefined ? undefined : `spese accessorie ${money(value(row, "SpeseAccessorie"), currency)}`,
				esigibilita === undefined ? undefined : `esigibilità ${coded(ESIGIBILITA, esigibilita)}`,
				value(row, "RiferimentoNormativo") === undefined ? undefined : `riferimento normativo: ${value(row, "RiferimentoNormativo")}`,
			],
			"; ",
		);
		out.push(`- ${rate(row) ?? "IVA"}${parts === undefined ? "" : `: ${parts}`}`);
	}
	return out;
}

/** Fund contributions, withholdings, stamp duty, the total. */
function totals(general: Element | undefined, currency: string): string[] {
	const out = [""];
	for (const fund of all(general, "DatiCassaPrevidenziale")) {
		const parts = joined([
			percent(value(fund, "AlCassa")) === undefined ? undefined : `aliquota ${percent(value(fund, "AlCassa"))}`,
			money(value(fund, "ImportoContributoCassa"), currency) === undefined ? undefined : `contributo ${money(value(fund, "ImportoContributoCassa"), currency)}`,
			money(value(fund, "ImponibileCassa"), currency) === undefined ? undefined : `su imponibile ${money(value(fund, "ImponibileCassa"), currency)}`,
			rate(fund),
			value(fund, "Ritenuta") === "SI" ? "soggetto a ritenuta" : undefined,
		]);
		out.push(`Cassa previdenziale: ${coded(TIPO_CASSA, value(fund, "TipoCassa")) ?? "non indicata"}${parts === undefined ? "" : `, ${parts}`}`);
	}
	for (const withholding of all(general, "DatiRitenuta")) {
		const parts = joined([
			money(value(withholding, "ImportoRitenuta"), currency),
			percent(value(withholding, "AliquotaRitenuta")) === undefined ? undefined : `aliquota ${percent(value(withholding, "AliquotaRitenuta"))}`,
			value(withholding, "CausalePagamento") === undefined ? undefined : `causale ${value(withholding, "CausalePagamento")}`,
		]);
		out.push(`Ritenuta d'acconto: ${coded(TIPO_RITENUTA, value(withholding, "TipoRitenuta")) ?? "tipo non indicato"}${parts === undefined ? "" : `, ${parts}`}`);
	}
	const stamp = child(general, "DatiBollo");
	if (stamp !== undefined) out.push(`Bollo virtuale: ${money(value(stamp, "ImportoBollo"), currency) ?? (value(stamp, "BolloVirtuale") === "SI" ? "sì" : "indicato")}`);
	const adjustments = all(general, "ScontoMaggiorazione")
		.map((s) => discount(s, currency))
		.filter((s) => s !== undefined);
	if (adjustments.length > 0) out.push(`Sul documento: ${adjustments.join(", ")}`);
	const total = money(value(general, "ImportoTotaleDocumento"), currency);
	if (total !== undefined) out.push(`Totale documento: ${total}`);
	const rounding = money(value(general, "Arrotondamento"), currency);
	if (rounding !== undefined) out.push(`Arrotondamento: ${rounding}`);
	return out.length === 1 ? [] : out;
}

function payments(body: Element, currency: string): string[] {
	const out: string[] = [];
	for (const payment of all(body, "DatiPagamento")) {
		out.push("", `Pagamento: ${coded(CONDIZIONI_PAGAMENTO, value(payment, "CondizioniPagamento")) ?? "condizioni non indicate"}`);
		for (const detail of all(payment, "DettaglioPagamento")) {
			const days = value(detail, "GiorniTerminiPagamento");
			const parts = joined([
				money(value(detail, "ImportoPagamento"), currency),
				date(value(detail, "DataScadenzaPagamento")) === undefined ? undefined : `scadenza ${date(value(detail, "DataScadenzaPagamento"))}`,
				days === undefined || days === "0" ? undefined : `a ${days} giorni${date(value(detail, "DataRiferimentoTerminiPagamento")) === undefined ? "" : ` dal ${date(value(detail, "DataRiferimentoTerminiPagamento"))}`}`,
				value(detail, "IBAN") === undefined ? undefined : `IBAN ${value(detail, "IBAN")}`,
				value(detail, "IstitutoFinanziario") === undefined ? undefined : `istituto ${value(detail, "IstitutoFinanziario")}`,
				value(detail, "BIC") === undefined ? undefined : `BIC ${value(detail, "BIC")}`,
				value(detail, "Beneficiario") === undefined ? undefined : `beneficiario ${value(detail, "Beneficiario")}`,
			]);
			out.push(`- ${coded(MODALITA_PAGAMENTO, value(detail, "ModalitaPagamento")) ?? "modalità non indicata"}${parts === undefined ? "" : `: ${parts}`}`);
		}
	}
	return out;
}

/** Attachments by name, format and size: never decoded. */
function attachments(body: Element): string[] {
	const list = all(body, "Allegati");
	if (list.length === 0) return [];
	const out = ["", `Allegati (${list.length}, non aperti):`];
	for (const attachment of list) {
		const format = value(attachment, "FormatoAttachment");
		const compression = value(attachment, "AlgoritmoCompressione");
		const size = base64Size(child(attachment, "Attachment")?.text ?? "");
		const about = joined([format, compression === undefined ? undefined : `compresso ${compression}`, size === 0 ? undefined : bytesLabel(size)]);
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
	return `${formatResult(Math.round((size / 1024 / 1024) * 10) / 10)} MB`;
}
