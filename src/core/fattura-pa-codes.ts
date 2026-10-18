/**
 * The codes of FatturaPA (the Agenzia delle Entrate's specifications, version 1.9) with what they
 * mean in plain Italian, for the summary in fattura-pa.ts. A code not listed is shown as written.
 * Loaded by the document worker from source: erasable TypeScript only.
 */

export const TIPO_DOCUMENTO: Readonly<Record<string, string>> = {
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
	TD24: "fattura differita (beni con DDT o servizi)",
	TD25: "fattura differita triangolare interna",
	TD26: "cessione di beni ammortizzabili e passaggi interni",
	TD27: "fattura per autoconsumo o cessioni gratuite senza rivalsa",
	TD28: "acquisti da San Marino con IVA (fattura cartacea)",
	TD29: "comunicazione per omessa o irregolare fatturazione",
};

/** Credit notes, ordinary and simplified: the amounts are in the customer's favour. */
export const CREDIT_NOTES: ReadonlySet<string> = new Set(["TD04", "TD08"]);

/** Integrations for the reverse charge: the customer's own document, nothing to pay to the supplier. */
export const INTEGRATIONS: ReadonlySet<string> = new Set(["TD16", "TD17", "TD18", "TD19"]);

export const REGIME_FISCALE: Readonly<Record<string, string>> = {
	RF01: "regime ordinario",
	RF02: "regime dei contribuenti minimi",
	RF04: "agricoltura, attività connesse e pesca",
	RF05: "vendita sali e tabacchi",
	RF06: "commercio dei fiammiferi",
	RF07: "editoria",
	RF08: "gestione servizi di telefonia pubblica",
	RF09: "rivendita documenti di trasporto pubblico e di sosta",
	RF10: "intrattenimenti, giochi e altre attività del DPR 640/72",
	RF11: "agenzie di viaggi e turismo",
	RF12: "agriturismo",
	RF13: "vendite a domicilio",
	RF14: "rivendita di beni usati, oggetti d'arte, d'antiquariato o da collezione",
	RF15: "agenzie di vendite all'asta di oggetti d'arte, antiquariato o da collezione",
	RF16: "IVA per cassa della pubblica amministrazione",
	RF17: "IVA per cassa",
	RF18: "altro regime",
	RF19: "regime forfettario",
	RF20: "franchigia IVA transfrontaliera",
};

export const NATURA: Readonly<Record<string, string>> = {
	N1: "escluse ex art. 15 DPR 633/72",
	N2: "non soggette",
	"N2.1": "non soggette (servizi a clienti esteri, artt. da 7 a 7-septies)",
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
	N6: "inversione contabile",
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

/** What a nature means for the money, said once in the VAT summary. */
export function naturaNote(code: string): string | undefined {
	if (code.startsWith("N6")) return "inversione contabile (reverse charge): il fornitore non addebita l'IVA; la integra e la versa il cliente";
	if (code.startsWith("N3") || code === "N4") return "nessuna IVA da pagare";
	return undefined;
}

/** Esigibilità: I (immediata) is the default and goes unsaid. */
export const ESIGIBILITA: Readonly<Record<string, string>> = {
	D: "esigibilità differita",
	S: "scissione dei pagamenti (split payment): l'IVA la versa la pubblica amministrazione cliente direttamente all'Erario; al fornitore si paga l'importo senza IVA",
};

/** RT01 and RT02 are withholding taxes; the others, social security contributions withheld. */
export const TIPO_RITENUTA: Readonly<Record<string, { readonly kind: "ritenuta" | "contributo"; readonly who: string }>> = {
	RT01: { kind: "ritenuta", who: "persone fisiche" },
	RT02: { kind: "ritenuta", who: "persone giuridiche" },
	RT03: { kind: "contributo", who: "INPS" },
	RT04: { kind: "contributo", who: "ENASARCO" },
	RT05: { kind: "contributo", who: "ENPAM" },
	RT06: { kind: "contributo", who: "altro" },
};

/** The commonest causali of the Certificazione Unica (CausalePagamento); the others are left out rather than shown as a bare letter. */
export const CAUSALE_PAGAMENTO: Readonly<Record<string, string>> = {
	A: "lavoro autonomo professionale",
	B: "diritti d'autore",
	C: "associazione in partecipazione con apporto di solo lavoro",
	D: "utili dei soci promotori e fondatori",
	H: "indennità per la cessazione di rapporti di agenzia",
	L: "diritti su opere dell'ingegno di altri",
	M: "lavoro autonomo occasionale",
	M1: "obblighi di fare, non fare o permettere",
	M2: "lavoro autonomo occasionale con iscrizione alla gestione separata",
	O: "lavoro autonomo occasionale senza iscrizione alla gestione separata",
	Q: "provvigioni ad agente monomandatario",
	R: "provvigioni ad agente plurimandatario",
	S: "provvigioni a commissionario",
	T: "provvigioni a mediatore",
	U: "provvigioni a procacciatore d'affari",
	V: "provvigioni per vendite a domicilio",
	W: "corrispettivi di contratti d'appalto",
};

export const TIPO_CASSA: Readonly<Record<string, string>> = {
	TC01: "Cassa forense degli avvocati",
	TC02: "Cassa dei dottori commercialisti",
	TC03: "Cassa dei geometri",
	TC04: "Inarcassa, ingegneri e architetti",
	TC05: "Cassa del notariato",
	TC06: "Cassa dei ragionieri e periti commerciali",
	TC07: "ENASARCO",
	TC08: "ENPACL, consulenti del lavoro",
	TC09: "ENPAM, medici",
	TC10: "ENPAF, farmacisti",
	TC11: "ENPAV, veterinari",
	TC12: "ENPAIA, impiegati dell'agricoltura",
	TC13: "Fondo delle imprese di spedizione e agenzie marittime",
	TC14: "INPGI, giornalisti",
	TC15: "ONAOSI",
	TC16: "CASAGIT",
	TC17: "EPPI, periti industriali",
	TC18: "EPAP, pluricategoriale",
	TC19: "ENPAB, biologi",
	TC20: "ENPAPI, infermieri",
	TC21: "ENPAP, psicologi",
	TC22: "INPS",
};

export const CONDIZIONI_PAGAMENTO: Readonly<Record<string, string>> = { TP01: "pagamento a rate", TP02: "pagamento completo", TP03: "anticipo" };

export const MODALITA_PAGAMENTO: Readonly<Record<string, string>> = {
	MP01: "contanti",
	MP02: "assegno",
	MP03: "assegno circolare",
	MP04: "contanti presso la Tesoreria",
	MP05: "bonifico",
	MP06: "vaglia cambiario",
	MP07: "bollettino bancario",
	MP08: "carta di pagamento",
	MP09: "RID (addebito diretto)",
	MP10: "RID utenze (addebito diretto)",
	MP11: "RID veloce (addebito diretto)",
	MP12: "Ri.Ba. (ricevuta bancaria)",
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

/** «bonifico (MP05)», «fattura differita (beni con DDT o servizi; TD24)»: the meaning first, then the code; the code alone when it is not known. */
export function coded(table: Readonly<Record<string, string>>, code: string | undefined): string | undefined {
	if (code === undefined) return undefined;
	const meaning = Object.hasOwn(table, code) ? table[code] : undefined;
	if (meaning === undefined) return code;
	return meaning.endsWith(")") ? `${meaning.slice(0, -1)}; ${code})` : `${meaning} (${code})`;
}
