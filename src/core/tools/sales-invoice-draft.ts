/**
 * The drafts of sales_invoices: from an accepted quote (its lines, customer, ritenuta, cassa,
 * bollo and terms, or the lines and customer the person gives in their place), from a customer's
 * hours not yet billed (one line per project, as to_quote makes them, each entry kept with its
 * minutes and terms to be checked again at issue), or from the lines the person dictates; and the
 * credit note of an invoice issued. A draft takes no number. What FatturaPA needs and nobody said
 * (the seller's data, the customer's tax id, address and channel, the VAT rate or nature, which
 * cassa, who pays the bollo, the IBAN, the last number before Annie) is asked in one go, never
 * invented.
 */
import type { ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { italianDate } from "../italian-format.ts";
import { inPeriod, type Period, PeriodError, readPeriod } from "../periods.ts";
import { QUOTES_BROKEN } from "../quote-store.ts";
import { FORM_NOTE } from "../client-find.ts";
import { listLines } from "../price-list-lines.ts";
import { findQuotes, type Quote, type QuoteCustomer, STATUS_WORDS } from "../quotes.ts";
import { CREDIT_NOTE_TYPE, DEFAULT_METHOD, FIELD_LIMITS, INPS_CASSA, INVOICE_TYPE, naturaWords, REGIME_FORFETTARIO, REGIME_ORDINARIO } from "../sales-invoice-rules.ts";
import { nextSeq, type SalesBook, type SalesSettings, type SalesState } from "../sales-invoice-store.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type Buyer, type Cassa, draftId, type HoursRef, type IssuedInvoice, invoiceNumber, isIssued, isPersonCf, regimeOf, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, type SalesLine, sellerOf, validInvoice } from "../sales-invoices.ts";
import { resolveClient } from "../timesheet-clients.ts";
import { activeReservation, oldestFirst, sameClient, type WorkEntry } from "../timesheet.ts";
import { TIMESHEET_BROKEN } from "../timesheet-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { hoursLines, lineWords, priced } from "../timesheet-sums.ts";
import { composeBuyer, findBuyer, type Known, quoteIds } from "./sales-invoice-buyer.ts";
import { anyMissing, askFor, askGroups, dueOf, type FilesSay, filesSay, findIssued, type Missing, noneMissing, type SalesEnv } from "./sales-invoice-env.ts";
import { type BuyerFields, fitsLatin, type GivenLine, paymentTermsOf, quoteLine, readBuyerFields, readCassa, readLines, readNatura, readOrder, readPayment, readRitenuta, readVatRate, withRates } from "./sales-invoice-input.ts";
import { draftAnswer, fenced } from "./sales-invoice-render.ts";

/** Where a draft's lines and customer come from, before the person's own fields. */
type Source = {
	readonly name: string;
	readonly known: Omit<Known, "name">;
	readonly quoteCustomer?: QuoteCustomer;
	readonly given: readonly GivenLine[];
	readonly ritenuta?: unknown;
	readonly cassa?: Cassa | { readonly missing: "type" };
	readonly bolloToClient?: boolean;
	readonly terms?: { readonly days: number; readonly endOfMonth: boolean };
	readonly quote?: string;
	readonly hours?: readonly HoursRef[];
	readonly notes: readonly string[];
};

const SELLER_TAIL = "I tuoi dati si salvano una volta con invoices op set_company (name, vat, cf, address, regime, iban), poi rifai questa fattura.";
const IBAN_TAIL = "L'IBAN si salva una volta con invoices op set_company iban, così non te lo richiedo.";
const RITENUTA_ASK = "la ritenuta d'acconto del 20% (prestazione professionale a un'azienda o a un ente): sì o no, lo ricordo per le prossime";
const BOLLO_ASK = "chi paga il bollo da 2,00 € (supera 77,47 € senza IVA): il cliente, con una riga in fattura, o tu; lo ricordo per le prossime";
const IBAN_ASK = "IBAN su cui ricevere il bonifico (oppure un altro modo di pagamento: contanti, assegno, carta, pagoPA)";
const VAT_ASK = "aliquota IVA delle voci (22, 10, 5 o 4%, oppure senza IVA con la natura, come N4 esente o N2.1 per un servizio a un cliente UE)";
const NATURA_ASK = "natura delle voci senza IVA (come N4 esente, N2.1 per un servizio a un cliente UE, N3.1 esportazione): la sa chi ti scrive o il suo commercialista";
const CASSA_ASK = "cassa professionale del contributo integrativo (codice da TC01 a TC21, come TC01 avvocati o TC04 Inarcassa) e percentuale, se non è il 4%";
const firstNumberAsk = (year: number) => `È la prima fattura che fai con me quest'anno: qual è il numero dell'ultima fattura che hai emesso nel ${year}? (se nessuna, parto da 1)`;
const proposeNumber = (year: number, h: number) => `Nei tuoi file l'ultima fattura del ${year} è la ${h}: questa sarà la ${h + 1}, va bene? (il file è nel riquadro sotto)`;
/** The file the proposed number comes from, said as it is named (a name in the person's folder: fenced). */
const proposedFrom = (file: string) => ["Il numero proposto viene da questo file:", fenced(file)].join("\n");
const NEW_CUSTOMER = "Se è un cliente diverso da questi, dimmelo e lo fatturo come cliente nuovo.";

/** The last number said before Annie, lower than the files' highest: said, never refused. */
export function lowNumberNote(last: number, files: FilesSay, year: number): string | undefined {
	const h = files.highest;
	if (h === undefined || last >= h.seq) return undefined;
	return [`Attenzione: tra i tuoi file del ${year} c'è già la fattura n. ${h.seq}, più alta dell'ultima che mi hai detto (${last}): partendo dalla ${last + 1} i numeri si ripeterebbero. Controlla con chi ti scrive; il file è questo:`, fenced(h.file)].join("\n");
}

/** The last number issued before Annie, as said: a whole number from 0; a string to answer when it does not read. */
export function readLastNumber(value: unknown): number | undefined | string {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= SALES_LIMITS.perYear) return "Errore: il numero dell'ultima fattura è un numero intero, 0 se non ce n'è nessuna.";
	return value;
}

/** The number the next invoice of `year` would take, as far as the store knows. */
function nextNumber(book: Pick<SalesBook, "next" | "settings">, day: string): string {
	const year = Number(day.slice(0, 4));
	return invoiceNumber(year, nextSeq(book, year), book.settings?.numbering ?? "plain");
}

/** The draft a call made already (a call run again): its answer again. */
function again(book: SalesBook, ctx: ToolContext, day: string): string | undefined {
	const made = book.invoices.find((i) => i.callId === ctx.callId);
	if (made === undefined) return undefined;
	return draftAnswer(made, salesTotals(made), isIssued(made) ? made.due : dueOf(made, day), nextNumber(book, day), day, []);
}

function cards(env: SalesEnv) {
	const book = env.clients?.read();
	return book === undefined || book.broken ? [] : book.cards;
}

/**
 * The customer a person names: a card, a customer invoiced here, or a new one with the name as
 * said (also when the person says it is new, or gives tax ids none of the close ones has).
 */
function customerOf(env: SalesEnv, said: unknown, book: SalesBook, notes: string[], given: BuyerFields, isNew: boolean): Known | string {
	const name = cleanText(said, 200, "il cliente");
	if (isProblem(name)) return `Errore: ${name.problem}.`;
	if (name === undefined) return "Errore: dimmi a quale cliente va la fattura.";
	if (isNew) return { name };
	const found = findBuyer(name, cards(env), book.invoices, given);
	if (found.kind === "close") return ["Intendi uno di questi? Non so dire quale:", fenced(found.candidates.map((c) => `• ${c}`).join("\n")), `Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui o con la sua partita IVA. ${NEW_CUSTOMER}`].join("\n");
	// The customer named, with another tax id than theirs: asked, never mixed.
	if (found.kind === "conflict") return [fenced(`${found.known.name} che conosco ha ${found.id}: è un cliente diverso? Se sì, lo fatturo come cliente nuovo.`), "Chiedi a chi ti scrive: se è un cliente diverso, rifai la bozza come cliente nuovo; se è lo stesso, rifalla senza quella partita IVA o codice fiscale, oppure correggi la sua scheda."].join("\n");
	if (found.kind === "exact") {
		if (found.form === true) notes.push(`${FORM_NOTE} ${NEW_CUSTOMER}`);
		return found.known;
	}
	// A tax id alone (not a 16-letter name): a partita IVA, or a codice fiscale's own shape.
	if (/^(?:[A-Z]{2})?\d{8,12}$|^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/i.test(name.replace(/[\s.\-/]/g, ""))) return askFor(["il nome o la ragione sociale del cliente: con questa partita IVA o codice fiscale non ho nessuno"]);
	return { name };
}

const sourceOf = (k: Known, extra: Omit<Source, "name" | "known">): Source => {
	const { name, ...known } = k;
	return { name, known, ...extra };
};

/** Whether a quote is for the customer `k`: the same name, or the same tax id. */
function quoteFor(q: Quote, k: Known): boolean {
	const ids = [k.card?.vat, k.previous?.vat].filter((v) => v !== undefined).map((v) => (v as string).replace(/^IT/, ""));
	return sameClient(q.customer.name, k.name) || (k.card !== undefined && sameClient(q.customer.name, k.card.name)) || (q.customer.vat !== undefined && ids.includes(q.customer.vat.replace(/^IT/, "")));
}

/** The customer's quotes accepted and not invoiced (nor in a draft): said, in case it is the same work. */
function openQuotesNote(env: SalesEnv, k: Known, book: SalesBook): string[] {
	if (env.quotes === undefined) return [];
	const quotes = env.quotes.read();
	if (quotes.broken) return [];
	const linked = new Set(book.invoices.map((i) => i.quote).filter((q) => q !== undefined));
	const open = quotes.quotes.filter((q) => q.status === "accepted" && q.invoice === undefined && !linked.has(q.number) && quoteFor(q, k));
	if (open.length === 0) return [];
	const numbers = open.map((q) => q.number);
	const which = numbers.length === 1 ? `il preventivo ${numbers[0]} accettato e non ancora fatturato` : `i preventivi ${numbers.join(", ")} accettati e non ancora fatturati`;
	return [fenced(`${k.name} ha anche ${which}: se è lo stesso lavoro, rifaccio la fattura dal preventivo.`)];
}

function fromLines(env: SalesEnv, args: Record<string, unknown>, book: SalesBook, notes: string[], fields: BuyerFields): Source | string {
	const given = readLines(args.lines);
	if (isProblem(given)) return `Errore: ${given.problem}.`;
	const known = customerOf(env, args.customer, book, notes, fields, args.new_customer === true);
	return typeof known === "string" ? known : sourceOf(known, { given, notes: openQuotesNote(env, known, book) });
}

function fromQuote(env: SalesEnv, args: Record<string, unknown>, book: SalesBook, notes: string[], fields: BuyerFields): Source | string {
	if (env.quotes === undefined) return "Errore: qui non vedo i preventivi: detta le voci della fattura.";
	const quotes = env.quotes.read();
	if (quotes.broken) return `Errore: ${QUOTES_BROKEN}.`;
	const found = findQuotes(quotes.quotes, String(args.quote));
	if (found.length === 0) return ["Errore: non trovo questo preventivo:", fenced(String(args.quote))].join("\n");
	if (found.length > 1) return "Errore: c'è un preventivo con quel numero in più anni: dimmi l'anno, come «2026-004».";
	const q = found[0] as Quote;
	if (q.status !== "accepted") return `Errore: il preventivo ${q.number} non risulta accettato (è ${STATUS_WORDS[q.status]}). Se il cliente l'ha accettato, lo segnalo accettato con quotes (op set_status accepted) solo se chi ti scrive lo conferma.`;
	if (q.invoice !== undefined) return `Errore: il preventivo ${q.number} è già stato fatturato con la fattura n. ${q.invoice}.`;
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const other = book.invoices.find((i) => i.quote === q.number && i.type === INVOICE_TYPE && i.id !== replace);
	if (other !== undefined) return isIssued(other) ? `Errore: il preventivo ${q.number} è già fatturato con la fattura n. ${other.number}.` : `Errore: per il preventivo ${q.number} c'è già la bozza ${other.id}: emetti quella, oppure la rifaccio prendendo il suo posto.`;
	// The person's own lines take the place of the quote's: then their prices are theirs.
	let given: readonly GivenLine[];
	if (args.lines !== undefined) {
		const read = readLines(args.lines);
		if (isProblem(read)) return `Errore: ${read.problem}.`;
		given = read;
	} else {
		if (q.pricesIncludeVat === true) return "Errore: i prezzi del preventivo sono IVA compresa, e in fattura servono senza IVA: detta le voci con i prezzi senza IVA.";
		given = q.lines.map(quoteLine);
	}
	const cassa: Source["cassa"] = q.cassa === undefined ? undefined : q.cassa.kind === "rivalsa_inps" ? { type: INPS_CASSA, rate: q.cassa.rate, subject: true } : { missing: "type" };
	const terms = paymentTermsOf(q.terms);
	const extra = {
		given,
		...(q.ritenuta === true ? { ritenuta: true } : {}),
		...(cassa === undefined ? {} : { cassa }),
		...(q.bollo === true ? { bolloToClient: true } : {}),
		...(terms === undefined ? {} : { terms }),
		quote: q.number,
		notes: [],
	};
	// Another customer named: the quote stays linked, its customer is not taken.
	if (args.customer !== undefined) {
		const known = customerOf(env, args.customer, book, notes, fields, args.new_customer === true);
		return typeof known === "string" ? known : sourceOf(known, extra);
	}
	// The quote's own tax ids tell its customer: one of the same name with others is not taken.
	const byName = findBuyer(q.customer.name, cards(env), book.invoices, quoteIds(q.customer));
	const known: Known = byName.kind === "exact" ? { ...byName.known, name: q.customer.name } : { name: q.customer.name };
	return sourceOf(known, { ...extra, quoteCustomer: q.customer });
}

/** The hours of the customer in the period already in a quote or an invoice, said by where they are. */
function alreadyBilled(entries: readonly WorkEntry[]): string | undefined {
	const where = new Map<string, number>();
	for (const e of entries) {
		if (e.billed === undefined) continue;
		const ref = e.billed.ref;
		const key = ref !== undefined ? (/^fattura\s/i.test(ref) ? `nella ${ref}` : `in «${ref}»`) : e.billed.quote !== undefined ? `nel preventivo ${e.billed.quote}` : "già fatturate";
		where.set(key, (where.get(key) ?? 0) + 1);
	}
	if (where.size === 0) return undefined;
	return [...where.entries()].map(([w, n]) => `${n1(n, "una voce è", "# voci sono")} ${w}`).join("; ");
}

function fromHours(env: SalesEnv, args: Record<string, unknown>, book: SalesBook, day: string): Source | string {
	if (env.timesheet === undefined) return "Errore: qui non vedo le ore di lavoro: detta le voci della fattura.";
	const sheet = env.timesheet.read();
	if (sheet.broken) return `Errore: ${TIMESHEET_BROKEN}.`;
	const said = cleanText(args.customer, 200, "il cliente");
	if (isProblem(said)) return `Errore: ${said.problem}.`;
	if (said === undefined) return "Errore: dimmi di quale cliente fatturare le ore.";
	const names = [...new Set(sheet.entries.map((e) => e.client))];
	const r = resolveClient(said, names);
	if (r.kind === "close") return ["Intendi uno di questi? Nessun cliente con delle ore si chiama esattamente così:", fenced(r.candidates.map((c) => `• ${c}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui."].join("\n");
	if (r.kind === "none") return ["Errore: non trovo ore registrate per questo cliente:", fenced(said)].join("\n");
	let period: Period;
	try {
		period = args.period === undefined ? { ...readPeriod("anno", day), from: "0000-01-01", label: `fino al ${italianDate(day)}` } : readPeriod(String(args.period), day);
	} catch (error) {
		if (error instanceof PeriodError) return `Errore: ${error.message}.`;
		throw error;
	}
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const held = new Set(sheet.reservations.filter((x) => activeReservation(x, env.now())).flatMap((x) => x.entries.map((e) => e.id)));
	const inDrafts = new Set(book.invoices.filter((i) => !isIssued(i) && i.id !== replace).flatMap((i) => (i.hours ?? []).map((h) => h.id)));
	const mine = sheet.entries.filter((e) => sameClient(e.client, r.name) && e.billable && inPeriod(e.date, period));
	const open = mine.filter((e) => e.billed === undefined && !held.has(e.id));
	const picked = open.filter((e) => !inDrafts.has(e.id)).sort(oldestFirst);
	const billed = alreadyBilled(mine);
	if (picked.length === 0) {
		if (open.length > 0) {
			const other = book.invoices.find((i) => !isIssued(i) && i.id !== replace && (i.hours ?? []).some((h) => open.some((e) => e.id === h.id)));
			return `Errore: le ore da fatturare di questo cliente sono già nella bozza ${other?.id ?? ""}: emetti quella, oppure la rifaccio prendendo il suo posto.`;
		}
		return billed === undefined ? `Nessuna ora da fatturare per questo cliente, ${period.label}: non ce ne sono.` : [`Nessuna ora da fatturare per questo cliente, ${period.label}: sono già in un preventivo o in una fattura.`, fenced(billed)].join("\n");
	}
	if (picked.length > SALES_LIMITS.hours) return `Errore: sono più di ${SALES_LIMITS.hours} voci di ore: fattura un periodo più corto.`;
	const items = picked.map((e) => priced(e, sheet.rates));
	const unpriced = items.filter((p) => p.rate === undefined);
	if (unpriced.length > 0) return askFor([`la tariffa oraria con questo cliente: ${unpriced.length === 1 ? "una voce di ore non ha" : `${unpriced.length} voci di ore non hanno`} una tariffa. Va salvata nelle tariffe delle ore, poi rifai la fattura`]);
	// Room for latin1's longer forms of «…» and «–».
	const lines = hoursLines(items, "project", lineWords(period), FIELD_LIMITS.descrizione - 20);
	if (lines.length > SALES_LIMITS.lines) return `Errore: verrebbero più di ${SALES_LIMITS.lines} voci: fattura un periodo più corto.`;
	const found = findBuyer(r.name, cards(env), book.invoices);
	const known: Known = found.kind === "exact" ? { ...found.known, name: r.name } : { name: r.name };
	return sourceOf(known, {
		given: lines.map((l) => ({ description: l.description, quantity: String(l.quantity), price: String(l.price), ...(l.unit === undefined ? {} : { unit: l.unit }) })),
		hours: items.map((p) => ({ id: p.entry.id, minutes: p.entry.minutes, rate: p.rate as string, rounding: p.rounding })),
		notes: [
			"Le ore le segno come fatturate quando la fattura è emessa.",
			...(billed === undefined ? [] : ["Altre ore dello stesso periodo non le rimetto, perché sono già fatturate o in un preventivo:", fenced(billed)]),
			...openQuotesNote(env, known, book),
		],
	});
}

/** The lines that name a voce of the listino filled from it (price-list-lines.ts), in the regime known; the arguments as they are when none does. */
function fromList(env: SalesEnv, args: Record<string, unknown>): { args: Record<string, unknown>; notes: readonly string[] } | string {
	const filled = listLines({ ...(env.priceList === undefined ? {} : { priceList: env.priceList }), company: env.company, taxes: env.taxes }, args.lines, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: args.vat, natura: args.natura } });
	if (filled === undefined) return { args, notes: [] };
	if ("ask" in filled) return filled.ask;
	return { args: { ...args, lines: filled.lines }, notes: filled.notes };
}

/** What a draft checked with `check` answers when it could be made: every datum is there. */
export const DRAFT_CHECKED = "[la bozza si può fare]";

/**
 * A draft of an invoice (TD01), from a quote, the hours or the lines. `check`: everything is
 * read and asked as for a draft, and nothing is saved: DRAFT_CHECKED when it could be made (the
 * recurring invoices ask what is missing once, when they are set).
 */
export async function draft(env: SalesEnv, given: Record<string, unknown>, ctx: ToolContext, day: string, o: { readonly check?: boolean } = {}): Promise<string> {
	const book = env.book();
	const done = o.check === true ? undefined : again(book, ctx, day);
	if (done !== undefined) {
		await env.audit(ctx, "draft", 1);
		return done;
	}
	const listed = fromList(env, given);
	if (typeof listed === "string") return listed;
	const args = listed.args;
	if (args.hours === true && (args.quote !== undefined || args.lines !== undefined)) return "Errore: la fattura delle ore parte solo dalle ore del cliente: per aggiungere altre voci, detta tutte le voci.";
	if (args.quote === undefined && args.hours !== true && args.lines === undefined) return "Errore: la fattura parte da un preventivo accettato, dalle ore da fatturare di un cliente, oppure dalle voci dettate.";
	if (args.new_customer !== undefined && typeof args.new_customer !== "boolean") return "Errore: il cliente nuovo è sì o no.";
	const fields = readBuyerFields(args);
	if (isProblem(fields)) return `Errore: ${fields.problem}.`;
	const notes: string[] = [...listed.notes];
	const src = args.quote !== undefined ? fromQuote(env, args, book, notes, fields) : args.hours === true ? fromHours(env, args, book, day) : fromLines(env, args, book, notes, fields);
	if (typeof src === "string") return src;
	notes.push(...src.notes);
	// Everything missing is gathered and asked once, by whom it is about; what is wrong is said at once.
	const missing: Missing = noneMissing();
	const tails: string[] = [];
	const company = env.company.read().company;
	const taxes = env.taxes.read();
	const profile = taxes.broken ? undefined : taxes.profile;
	const seller = sellerOf(company, profile);
	if ("missing" in seller) missing.me.push(...seller.missing);
	const regime = "seller" in seller ? seller.seller.regime : regimeOf(company, profile);
	const sellerCf = "seller" in seller ? seller.seller.cf : company?.cf;
	const composed = composeBuyer(src.name, { ...src.known, ...(src.quoteCustomer === undefined ? {} : { quote: src.quoteCustomer }) }, fields);
	if (isProblem(composed)) return `Errore: ${composed.problem}.`;
	const buyer: Buyer | undefined = "missing" in composed ? undefined : composed;
	if ("missing" in composed) missing.customer.push(...composed.missing);
	const vat = readVatRate(args.vat, "l'IVA");
	if (isProblem(vat)) return `Errore: ${vat.problem}.`;
	const natura = readNatura(args.natura, "le voci senza IVA");
	if (isProblem(natura)) return `Errore: ${natura.problem}.`;
	const reference = cleanText(args.reference, FIELD_LIMITS.riferimentoNormativo, "il riferimento normativo");
	if (isProblem(reference)) return `Errore: ${reference.problem}.`;
	// Without the regime (asked with the person's data) the rates wait for it.
	const rated = regime === undefined ? undefined : withRates(src.given, { ...(vat === undefined ? {} : { vat }), ...(natura === undefined ? {} : { natura }), ...(reference === undefined ? {} : { reference }) }, regime);
	if (rated !== undefined && isProblem(rated)) return `Errore: ${rated.problem}.`;
	if (rated !== undefined && "missing" in rated) missing.invoice.push(rated.missing === "vat" ? VAT_ASK : NATURA_ASK);
	const lines: SalesLine[] | undefined = rated === undefined || "missing" in rated ? undefined : rated;
	const long = (lines ?? []).findIndex((l) => !fitsLatin(l.description, FIELD_LIMITS.descrizione) || (l.unit !== undefined && !fitsLatin(l.unit, FIELD_LIMITS.unitaMisura)) || (l.reference !== undefined && !fitsLatin(l.reference, FIELD_LIMITS.riferimentoNormativo)));
	if (long >= 0) return `Errore: la riga ${long + 1} è troppo lunga per la fattura (la descrizione al massimo ${FIELD_LIMITS.descrizione} caratteri).`;
	// The ritenuta: as said, or the quote's; to a company or a public office in the ordinario, asked once when the seller is a professional person.
	const settings: SalesSettings | undefined = book.settings;
	if (args.ritenuta !== undefined && typeof args.ritenuta !== "boolean" && typeof args.ritenuta !== "string") return "Errore: la ritenuta è sì, no, o la sua causale.";
	let ritenutaSaid: unknown = args.ritenuta ?? src.ritenuta;
	let saveRitenuta: boolean | undefined;
	const asksRitenuta = regime === REGIME_ORDINARIO && isPersonCf(sellerCf) && (buyer?.kind === "business" || buyer?.kind === "pa");
	if (asksRitenuta && ritenutaSaid === undefined) {
		if (settings?.ritenutaToBusiness === undefined) missing.invoice.push(RITENUTA_ASK);
		else ritenutaSaid = settings.ritenutaToBusiness;
	} else if (asksRitenuta && args.ritenuta !== undefined && settings?.ritenutaToBusiness === undefined) saveRitenuta = args.ritenuta !== false;
	let ritenuta = regime === undefined || buyer === undefined ? undefined : readRitenuta(ritenutaSaid, regime, sellerCf, buyer.kind);
	if (isProblem(ritenuta)) return `Errore: ${ritenuta.problem}.`;
	const cassa = args.cassa === undefined ? src.cassa : readCassa(args.cassa);
	if (isProblem(cassa)) return `Errore: ${cassa.problem}.`;
	if (cassa !== undefined && "missing" in cassa) missing.invoice.push(CASSA_ASK);
	if (args.split_payment !== undefined && typeof args.split_payment !== "boolean") return "Errore: la scissione dei pagamenti è sì o no.";
	const split = args.split_payment === true;
	if (split && regime === REGIME_FORFETTARIO) return "Errore: in regime forfettario la fattura è senza IVA, quindi la scissione dei pagamenti non si applica.";
	// The IBAN saved with the company, or the one of the last invoice issued.
	const lastIban = [...book.invoices].reverse().find((i) => isIssued(i) && i.payment?.iban !== undefined)?.payment?.iban;
	const ibans = company?.ibans !== undefined && company.ibans.length > 0 ? company.ibans : lastIban === undefined ? [] : [lastIban];
	const payment = readPayment(args, ibans, src.terms);
	if (isProblem(payment)) return `Errore: ${payment.problem}.`;
	if (payment.method === DEFAULT_METHOD && payment.iban === undefined) {
		// With the person's data to save anyway, the IBAN goes with them.
		if (missing.me.length > 0) missing.me.push("IBAN");
		else {
			missing.invoice.push(IBAN_ASK);
			tails.push(IBAN_TAIL);
		}
	}
	if (missing.me.length > 0) tails.unshift(SELLER_TAIL);
	const order = readOrder(args.order);
	if (isProblem(order)) return `Errore: ${order.problem}.`;
	const causale = cleanText(args.notes, SALES_LIMITS.causale, "il testo delle note");
	if (isProblem(causale)) return `Errore: ${causale.problem}.`;
	if (causale !== undefined && !fitsLatin(causale, FIELD_LIMITS.causale)) return `Errore: le note sono troppo lunghe per la fattura (al massimo ${FIELD_LIMITS.causale} caratteri).`;
	if (args.bollo_to_client !== undefined && typeof args.bollo_to_client !== "boolean") return "Errore: il bollo è a carico del cliente o no.";
	let bolloToClient: boolean | undefined;
	let saveBollo: boolean | undefined;
	if (lines !== undefined && regime !== undefined && salesTotals({ type: INVOICE_TYPE, regime, lines, ...(cassa === undefined || "missing" in cassa ? {} : { cassa }) }).bollo.due) {
		bolloToClient = (args.bollo_to_client as boolean | undefined) ?? src.bolloToClient ?? settings?.bolloToClient;
		if (bolloToClient === undefined) missing.invoice.push(BOLLO_ASK);
		else if (args.bollo_to_client !== undefined && settings?.bolloToClient === undefined) saveBollo = bolloToClient;
	}
	// The first invoice of the year with Annie: the number reached before, from the files or asked.
	const year = Number(day.slice(0, 4));
	const last = readLastNumber(args.last_number);
	if (typeof last === "string") return last;
	const first = await firstOfYear(env, book, ctx, day, company?.vat, last);
	if (first.ask !== undefined) missing.invoice.push(first.ask);
	// With a question the notes are not said: the file a proposed number comes from goes with it.
	if (first.note !== undefined) (first.ask === undefined ? notes : tails).push(first.note);
	if (anyMissing(missing) || "missing" in seller || buyer === undefined || lines === undefined || regime === undefined || (cassa !== undefined && "missing" in cassa)) return askGroups(missing, tails);
	// A ritenuta with nothing to bear it (only spese anticipate) is dropped.
	if (ritenuta !== undefined && salesTotals({ type: INVOICE_TYPE, regime, lines, ...(cassa === undefined ? {} : { cassa }), ritenuta }).ritenutaBase === 0n) {
		ritenuta = undefined;
		notes.push("Ho tolto la ritenuta d'acconto: nessun compenso soggetto a ritenuta.");
	}
	const fieldsOut = {
		type: INVOICE_TYPE,
		regime,
		buyer,
		lines,
		...(ritenuta === undefined ? {} : { ritenuta }),
		...(cassa === undefined ? {} : { cassa }),
		...(split ? { splitPayment: true as const } : {}),
		payment,
		...(order === undefined ? {} : { order }),
		...(causale === undefined ? {} : { causale }),
		...(src.quote === undefined ? {} : { quote: src.quote }),
		...(src.hours === undefined ? {} : { hours: src.hours }),
		...(bolloToClient === undefined ? {} : { bolloToClient }),
	} satisfies Omit<SalesInvoice, "id" | "callId" | "by" | "at">;
	const patch: Partial<Pick<SalesSettings, "bolloToClient" | "ritenutaToBusiness">> & { lastBefore?: number } = {
		...(saveBollo === undefined ? {} : { bolloToClient: saveBollo }),
		...(saveRitenuta === undefined ? {} : { ritenutaToBusiness: saveRitenuta }),
		...(first.save === undefined ? {} : { lastBefore: first.save }),
	};
	if (o.check === true) return DRAFT_CHECKED;
	return save(env, args, ctx, day, fieldsOut, notes, "draft", (state) => settingsAfter(state, patch, year, env.marker(ctx)));
}

/**
 * The last number before Annie, while she has issued nothing this year: as said (corrected, and
 * warned when lower than the files' highest); proposed from the files in `fatture/emesse/`; not
 * asked in January when she issued every invoice of last year and the files have none of this
 * year; asked otherwise. The files never move the number by themselves.
 */
async function firstOfYear(env: SalesEnv, book: SalesBook, ctx: ToolContext, day: string, vat: string | undefined, last: number | undefined): Promise<{ ask?: string; note?: string; save?: number }> {
	const year = Number(day.slice(0, 4));
	const issued = (y: number) => book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.year === y);
	if (issued(year).length > 0) return {};
	const said = book.settings?.lastBefore?.[String(year)];
	if (said !== undefined && last === undefined) return {};
	const files: FilesSay = vat === undefined ? {} : await filesSay(env, ctx.signal, vat, year, day);
	if (last !== undefined) {
		const low = lowNumberNote(last, files, year);
		return { save: last, ...(low === undefined ? {} : { note: low }) };
	}
	if (files.highest !== undefined) return { ask: proposeNumber(year, files.highest.seq), note: proposedFrom(files.highest.file) };
	const before = issued(year - 1);
	const allLastYear = day.slice(5, 7) === "01" && before.length > 0 && (book.settings?.lastBefore?.[String(year - 1)] ?? 0) === 0 && Math.min(...before.map((i) => i.seq)) === 1;
	if (allLastYear) return { save: 0 };
	return { ask: firstNumberAsk(year) };
}

/** The settings with what this draft's answers say: a choice made stays; the last number before Annie is corrected while she has issued nothing that year. */
function settingsAfter(state: SalesState, patch: { bolloToClient?: boolean; ritenutaToBusiness?: boolean; lastBefore?: number }, year: number, marker: { by: string; at: string }): SalesState {
	const s = state.settings;
	const bollo = patch.bolloToClient !== undefined && s?.bolloToClient === undefined;
	const ritenuta = patch.ritenutaToBusiness !== undefined && s?.ritenutaToBusiness === undefined;
	const last = patch.lastBefore !== undefined && !state.invoices.some((i) => isIssued(i) && i.year === year);
	if (!bollo && !ritenuta && !last) return state;
	return {
		...state,
		settings: {
			...(s ?? {}),
			...marker,
			...(bollo ? { bolloToClient: patch.bolloToClient as boolean } : {}),
			...(ritenuta ? { ritenutaToBusiness: patch.ritenutaToBusiness as boolean } : {}),
			...(last ? { lastBefore: { ...(s?.lastBefore ?? {}), [String(year)]: patch.lastBefore as number } } : {}),
		},
	};
}

const rowKey = (r: { vat: number; natura?: string }) => `${r.vat}|${r.natura ?? ""}`;
const rowName = (r: { vat: number; natura?: string }) => (r.vat === 0 ? `senza IVA, ${naturaWords((r.natura ?? "N2.2") as Parameters<typeof naturaWords>[0])}` : `IVA ${r.vat}%`);

/** A credit note (TD04) for an invoice issued: all its lines, or the lines given at its own rates; never more than what is left to credit, rate by rate. */
export async function creditNote(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
	const book = env.book();
	const done = again(book, ctx, day);
	if (done !== undefined) {
		await env.audit(ctx, "credit_note", 1);
		return done;
	}
	if (typeof args.invoice !== "string" || args.invoice.trim() === "") return "Errore: dimmi il numero della fattura da stornare.";
	const found = findIssued(book.invoices, args.invoice, INVOICE_TYPE);
	if (found.length === 0) return "Errore: non trovo una fattura emessa con quel numero.";
	if (new Set(found.map((f) => f.year)).size > 1) return `Errore: c'è una fattura con quel numero in più anni (${found.map((f) => f.year).join(", ")}): dimmi l'anno.`;
	const original = found[0] as (typeof found)[number];
	let given: readonly GivenLine[] = original.lines;
	if (args.lines !== undefined) {
		const read = readLines(args.lines);
		if (isProblem(read)) return `Errore: ${read.problem}.`;
		given = read;
	}
	const vat = readVatRate(args.vat, "l'IVA");
	if (isProblem(vat)) return `Errore: ${vat.problem}.`;
	const natura = readNatura(args.natura, "le voci senza IVA");
	if (isProblem(natura)) return `Errore: ${natura.problem}.`;
	const originalRows = salesTotals(original).rows;
	const only = originalRows.length === 1 ? originalRows[0] : undefined;
	const wideVat = vat ?? only?.vat;
	const wideNatura = natura ?? only?.natura;
	const lines = withRates(given, { ...(wideVat === undefined ? {} : { vat: wideVat }), ...(wideNatura === undefined ? {} : { natura: wideNatura }) }, original.regime);
	if (isProblem(lines)) return `Errore: ${lines.problem}.`;
	if ("missing" in lines) return askFor([`l'aliquota IVA di ogni voce da stornare, una di quelle della fattura: ${originalRows.map(rowName).join(", ")}`], "la nota di credito");
	// Each line at a rate (and nature) of the invoice it corrects.
	const pairs = new Set(originalRows.map(rowKey));
	const stranger = lines.findIndex((l) => !pairs.has(rowKey(l)));
	if (stranger >= 0) return `Errore: la riga ${stranger + 1} della nota di credito è ${rowName(lines[stranger] as SalesLine)}, che la fattura n. ${original.number} non ha: ogni riga va con un'aliquota della fattura (${originalRows.map(rowName).join(", ")}).`;
	const causale = cleanText(args.notes, SALES_LIMITS.causale, "il testo delle note");
	if (isProblem(causale)) return `Errore: ${causale.problem}.`;
	if (args.wrong_customer !== undefined && typeof args.wrong_customer !== "boolean") return "Errore: il cliente sbagliato è sì o no.";
	const fields = {
		type: CREDIT_NOTE_TYPE,
		regime: original.regime,
		buyer: original.buyer,
		lines,
		...(original.ritenuta === undefined || lines.every((l) => l.notFee === true) ? {} : { ritenuta: original.ritenuta }),
		...(original.cassa === undefined ? {} : { cassa: original.cassa }),
		related: { number: original.number, date: original.date, id: original.id },
		...(causale === undefined ? {} : { causale }),
	} satisfies Omit<SalesInvoice, "id" | "callId" | "by" | "at">;
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const notes = args.wrong_customer === true ? ["Dopo averla emessa, rifaccio la fattura al cliente giusto."] : [];
	// Under the lock: the other credit notes and drafts of this invoice as saved now, rate by rate.
	const limit = (state: SalesState): SalesState => {
		const credited = new Map<string, bigint>();
		const others = state.invoices.filter((i) => i.type === CREDIT_NOTE_TYPE && i.related?.id === original.id && i.id !== replace);
		for (const inv of [...others, fields]) for (const r of salesTotals(inv).rows) credited.set(rowKey(r), (credited.get(rowKey(r)) ?? 0n) + r.taxable);
		for (const r of originalRows) {
			if ((credited.get(rowKey(r)) ?? 0n) > r.taxable) throw new SalesInvoiceError(`la nota di credito supererebbe quello che resta da stornare della fattura n. ${original.number} per le voci ${rowName(r)}: contando le altre note di credito e bozze, non si storna più di quanto fatturato`);
		}
		return state;
	};
	return save(env, args, ctx, day, fields, notes, "credit_note", limit);
}

/**
 * Save the draft (in place of `replace`, when given) under the store's lock, once per call.
 * `within`: what is checked and changed besides, on the state as saved now (a limit, the settings).
 */
async function save(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, day: string, fields: Omit<SalesInvoice, "id" | "callId" | "by" | "at">, notes: string[], op: "draft" | "credit_note", within: (state: SalesState) => SalesState): Promise<string> {
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const marker = env.marker(ctx);
	if (!validInvoice({ ...marker, ...fields, id: "BZ-0000", callId: ctx.callId })) throw new SalesInvoiceError("i dati della fattura non sono validi: non ho salvato la bozza");
	env.store.update(ctx.callId, (saved): SalesState => {
		const state = within(saved);
		const old = replace === undefined ? undefined : state.invoices.find((i) => i.id === replace);
		if (replace !== undefined && (old === undefined || isIssued(old))) throw new SalesInvoiceError(`la bozza ${replace} da sostituire non c'è, o è già emessa`);
		if (state.invoices.length >= SALES_LIMITS.invoices) throw new SalesInvoiceError("l'archivio delle fatture è pieno");
		// In place of another: the lineage stays, so whoever made the first one (a recurring invoice) still finds it.
		const inv: SalesInvoice = { ...marker, ...fields, id: draftId(state.nextDraft), callId: ctx.callId, ...(old === undefined ? {} : { origin: old.origin ?? old.callId }), expected: nextNumber(state, day) };
		return { ...state, nextDraft: state.nextDraft + 1, invoices: [...state.invoices.filter((i) => i !== old), inv] };
	});
	const book = env.book();
	const made = book.invoices.find((i) => i.callId === ctx.callId);
	if (made === undefined) throw new SalesInvoiceError("la bozza non risulta salvata");
	await env.audit(ctx, op, 1);
	if (replace !== undefined) notes.push(`Prende il posto della bozza ${replace}, che ho tolto.`);
	return draftAnswer(made, salesTotals(made), dueOf(made, day), nextNumber(book, day), day, notes);
}
