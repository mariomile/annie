/**
 * The rules an outgoing invoice follows, in one place: FatturaPA's version, formats and codes as
 * the writer uses them, the field lengths of its schema, the VAT rates and nature, the regime
 * forfettario's dicitura, the imposta di bollo, the ritenuta d'acconto and the casse. Every value
 * says where it comes from; «da verificare» where the source is not certain or the practice varies.
 * The codes' meanings stay in fattura-pa-codes.ts, shared with the reader.
 */
import { NATURA, TIPO_CASSA } from "./fattura-pa-codes.ts";
import { BOLLO_CENTS, BOLLO_THRESHOLD_CENTS, RITENUTA_RATE } from "./quote-sums.ts";

/**
 * FatturaPA 1.2.2 (Agenzia delle Entrate, «Specifiche tecniche operative» v1.9, schema
 * Schema_VFPR12 / Schema_VFPA12): the namespace and the schema the root element names.
 */
export const FATTURA_NAMESPACE = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";
export const FATTURA_SCHEMA = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2 http://www.fatturapa.gov.it/export/fatturazione/sdi/fatturapa/v1.2/Schema_del_file_xml_FatturaPA_versione_1.2.xsd";

/** FormatoTrasmissione: FPR12 between private parties, FPA12 to a public administration (codice univoco ufficio of 6 characters). */
export const FORMAT_PRIVATE = "FPR12";
export const FORMAT_PA = "FPA12";

/**
 * TipoDocumento issued here (specifiche tecniche, tabella TipoDocumento): an invoice, a credit
 * note, and the fattura differita (TD24: goods delivered with a DDT, billed by the 15th of the
 * month after, DPR 633/1972 art. 21 c. 4 lett. a).
 */
export const INVOICE_TYPE = "TD01";
export const CREDIT_NOTE_TYPE = "TD04";
export const DEFERRED_TYPE = "TD24";
export type DocType = typeof INVOICE_TYPE | typeof CREDIT_NOTE_TYPE | typeof DEFERRED_TYPE;

/** An invoice (immediate or differita), not a credit note: it has a payment, a credit note may correct it. */
export const isInvoiceType = (t: string): boolean => t === INVOICE_TYPE || t === DEFERRED_TYPE;

/**
 * CodiceDestinatario without a channel of the customer's own: «0000000» for an Italian customer
 * with no codice nor PEC (the SdI puts the invoice in their cassetto fiscale; a private person
 * gets a copy from the seller, provv. AdE 89757/2018 punto 3.4), «XXXXXXX» for a foreign one
 * (specifiche tecniche, CodiceDestinatario).
 */
export const NO_CHANNEL_CODE = "0000000";
export const FOREIGN_CODE = "XXXXXXX";
/** A codice destinatario of an intermediary: 7 letters or digits; a public office's codice univoco: 6. */
export const PRIVATE_CODE = /^[A-Z0-9]{7}$/;
export const PA_CODE = /^[A-Z0-9]{6}$/;

/** CAP of a foreign address (the schema wants 5 digits: «00000» is the common practice; da verificare with the software in use). */
export const FOREIGN_CAP = "00000";
/** IdCodice of a foreign customer without a VAT number (common practice for non-EU private customers; da verificare). */
export const FOREIGN_NO_VAT_ID = "99999999999";

/** RegimeFiscale: ordinario and forfettario, the two Annie knows (tabella RegimeFiscale). */
export const REGIME_ORDINARIO = "RF01";
export const REGIME_FORFETTARIO = "RF19";
export type RegimeCode = typeof REGIME_ORDINARIO | typeof REGIME_FORFETTARIO;

/** The VAT rates a line may carry in Italy (DPR 633/1972, tabella A); 0 needs a nature. */
export const SALES_VAT_RATES = [22, 10, 5, 4, 0] as const;
export type SalesVatRate = (typeof SALES_VAT_RATES)[number];

/** The natures valid since 1 January 2021 (specifiche tecniche v1.6: N2, N3 and N6 only with their sub-codes). */
export const NATURE = ["N1", "N2.1", "N2.2", "N3.1", "N3.2", "N3.3", "N3.4", "N3.5", "N3.6", "N4", "N5", "N6.1", "N6.2", "N6.3", "N6.4", "N6.5", "N6.6", "N6.7", "N6.8", "N6.9", "N7"] as const;
export type Natura = (typeof NATURE)[number];

/** «non soggette, altri casi (N2.2)»: a nature in words, from the reader's table. */
export function naturaWords(n: Natura): string {
	return `${NATURA[n] ?? n} (${n})`;
}

/**
 * Regime forfettario: no VAT, nature N2.2 (non soggette, altri casi), no ritenuta d'acconto
 * (L. 190/2014, art. 1, commi 58 e 67) and this dicitura on the invoice (prassi: art. 1, commi
 * 54-89; risposta AdE). The XML takes Latin-1 only, so there the dash is a hyphen.
 */
export const FORFETTARIO_NATURA: Natura = "N2.2";
export const FORFETTARIO_DICITURA = "Operazione effettuata ai sensi dell'art. 1, commi 54-89, Legge n. 190/2014 – regime forfettario";

/**
 * Imposta di bollo on invoices without VAT over 77,47 € (DPR 642/1972, tariffa art. 13; art. 6
 * DM 17/06/2014 for the bollo virtuale of electronic invoices): 2,00 €, said in DatiBollo with
 * BolloVirtuale SI. Charged to the customer it is a line excluded from VAT (art. 15 DPR
 * 633/1972, nature N1). The same values as the quotes'.
 */
export { BOLLO_CENTS, BOLLO_THRESHOLD_CENTS };
export const BOLLO_NATURA: Natura = "N1";
export const BOLLO_DESCRIPTION = "Imposta di bollo assolta in modo virtuale";
export const BOLLO_REFERENCE = "Escluso art. 15 DPR 633/1972";
/**
 * Natures whose amounts do not count toward the bollo: exports and intra-EU supplies (art. 15
 * tariffa DPR 642/1972, allegato B, e risoluzioni AdE) and the reverse charge, where VAT is due
 * by the customer. Da verificare case by case with the commercialista.
 */
export const BOLLO_FREE_NATURE: readonly Natura[] = ["N3.1", "N3.2", "N3.3", "N3.4", "N6.1", "N6.2", "N6.3", "N6.4", "N6.5", "N6.6", "N6.7", "N6.8", "N6.9", "N7"];

/**
 * Ritenuta d'acconto on a professional's fees: 20% (art. 25 DPR 600/1973), RT01 for a person,
 * RT02 for a company (tabella TipoRitenuta), causale A, lavoro autonomo professionale (modello
 * CU) by default.
 */
export { RITENUTA_RATE };
export const RITENUTA_PERSON = "RT01";
export const RITENUTA_COMPANY = "RT02";
export const RITENUTA_CAUSALE = "A";
/** The causali the tool accepts (modello CU, istruzioni): the professional's and the occasional ones. */
export const RITENUTA_CAUSALI = ["A", "M", "M2", "O", "R", "Q", "W"] as const;

/**
 * Casse: the rivalsa INPS of the gestione separata, 4% of the fees (art. 1, comma 212, L.
 * 662/1996), TC22, part of the fee and so in the ritenuta's base; the contributo integrativo of
 * a cassa professionale (TC01 to TC21), usually 4% (2% for some casse, such as EPAP and ENPAP:
 * da verificare with the cassa), outside the ritenuta's base. Either takes the VAT of the lines
 * it is computed on.
 */
export const INPS_CASSA = "TC22";
export const INPS_RATE = "4";
export const INTEGRATIVO_RATE = "4";
export const CASSA_TYPES = Object.keys(TIPO_CASSA).filter((t) => t !== INPS_CASSA && t !== "TC07");
export const MAX_CASSA_RATE = 10;

/** ModalitaPagamento by the words a person uses; bonifico (MP05) by default (tabella ModalitaPagamento). */
export const PAYMENT_METHODS: Readonly<Record<string, string>> = { bonifico: "MP05", contanti: "MP01", assegno: "MP02", carta: "MP08", riba: "MP12", rid: "MP09", pagopa: "MP23" };
export const DEFAULT_METHOD = "MP05";
/** CondizioniPagamento: payment in full (TP02). */
export const PAYMENT_FULL = "TP02";
/** Payment terms in days, when the person says none: 30 days from the invoice date (art. 4 D.Lgs. 231/2002, the legal default). */
export const DEFAULT_PAYMENT_DAYS = 30;
export const MAX_PAYMENT_DAYS = 365;

/** Esigibilità: immediate, or split payment to a public administration (art. 17-ter DPR 633/1972). */
export const ESIGIBILITA_IMMEDIATE = "I";
export const ESIGIBILITA_SPLIT = "S";

/**
 * Lengths of the schema's fields (FatturaPA 1.2.2): what is longer is refused, never cut, so
 * nothing on the invoice says less than the person said.
 */
export const FIELD_LIMITS = {
	denominazione: 80,
	indirizzo: 60,
	comune: 60,
	numero: 20,
	descrizione: 1000,
	causale: 200,
	riferimentoNormativo: 100,
	unitaMisura: 10,
	idDocumento: 20,
	pec: 256,
	email: 256,
	cig: 15,
	cup: 15,
} as const;

/** The file's progressive (ProgressivoInvio, in the name too): 5 letters or digits, here base 36. */
export const PROGRESSIVE_LENGTH = 5;
/** The folder of the invoices issued, in the workspace: the scadenzario scans it with the others. */
export const ISSUED_FOLDER = "fatture/emesse";

/** A draft older than this many days is said in the list's compact line. */
export const STALE_DRAFT_DAYS = 7;

/**
 * A spesa anticipata in nome e per conto del cliente: outside the VAT base (art. 15 DPR 633/1972,
 * natura N1), not a fee, so outside the ritenuta's base (art. 25 DPR 600/1973) and the cassa's.
 * The bollo charged back is one too.
 */
export const NOT_FEE_NATURA: Natura = "N1";

/** The seller's phone as FatturaPA's Contatti/Telefono takes it: 5 to 12 characters, digits and a leading +. */
export const SELLER_PHONE = /^\+?\d{5,12}$/;

/**
 * Transmission to the SdI needs an accredited channel (an intermediary or the person's own
 * software): Annie only writes the file, the person uploads it.
 * The upload on the Agenzia's portal, as the person finds it (da verificare: the menu changes).
 */
export const UPLOAD_PATH = "portale Fatture e Corrispettivi → Fatturazione elettronica → Trasmissione → Carica il file";

/** Days from the invoice's date to transmit it to the SdI (art. 21 c. 4 DPR 633/1972, «fattura immediata»). */
export const TRANSMIT_DAYS = 12;
