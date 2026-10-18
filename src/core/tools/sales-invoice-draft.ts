/**
 * The drafts of sales_invoices: from an accepted quote (its lines, customer, ritenuta, cassa,
 * bollo and terms), from a customer's hours not yet billed (one line per project, as to_quote
 * makes them, each entry kept with its minutes and terms to be checked again at issue), or from
 * the lines the person dictates; and the credit note of an invoice issued. A draft takes no
 * number. What FatturaPA needs and nobody said (the seller's data, the customer's tax id, address
 * and channel, the VAT rate or nature, which cassa, who pays the bollo) is asked, never invented.
 */
import { hoursText } from "../durations.ts";
import type { ToolContext } from "../engine.ts";
import { italianDate } from "../italian-format.ts";
import { inPeriod, type Period, PeriodError, readPeriod } from "../periods.ts";
import { QUOTES_BROKEN } from "../quote-store.ts";
import { findQuotes, STATUS_WORDS } from "../quotes.ts";
import { CREDIT_NOTE_TYPE, FIELD_LIMITS, INPS_CASSA, INVOICE_TYPE, NO_CHANNEL_CODE, REGIME_FORFETTARIO, REGIME_ORDINARIO } from "../sales-invoice-rules.ts";
import type { SalesBook, SalesState } from "../sales-invoice-store.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type Cassa, draftId, type HoursRef, invoiceNumber, isIssued, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, sellerOf, validInvoice } from "../sales-invoices.ts";
import { resolveClient } from "../timesheet-clients.ts";
import { activeReservation, oldestFirst, sameClient } from "../timesheet.ts";
import { TIMESHEET_BROKEN } from "../timesheet-store.ts";
import { hoursLines, priced } from "../timesheet-sums.ts";
import { composeBuyer, findBuyer, type Known } from "./sales-invoice-buyer.ts";
import { fitsLatin, type GivenLine, isProblem, quoteLine, readBuyerFields, readCassa, readLines, readNatura, readOrder, readPayment, readRitenuta, readVatRate, termsOf, withRates } from "./sales-invoice-input.ts";
import { draftAnswer, fenced } from "./sales-invoice-render.ts";
import type { SalesEnv } from "./sales-invoice-tools.ts";
import { askFor, dueOf, findIssued } from "./sales-invoice-tools.ts";
import { cleanText } from "./quote-input.ts";
import { lineWords } from "./timesheet-quote.ts";

/** Where a draft's lines and customer come from, before the person's own fields. */
type Source = {
	readonly name: string;
	readonly known: Omit<Known, "name">;
	readonly quoteCustomer?: import("../quotes.ts").QuoteCustomer;
	readonly given: readonly GivenLine[];
	readonly ritenuta?: unknown;
	readonly cassa?: Cassa | { readonly missing: "type" };
	readonly bolloToClient?: boolean;
	readonly terms?: { readonly days: number; readonly endOfMonth: boolean };
	readonly quote?: string;
	readonly hours?: readonly HoursRef[];
	readonly notes: readonly string[];
};

/** The draft a call made already (a call run again): its answer again. */
function again(env: SalesEnv, book: SalesBook, ctx: ToolContext, day: string): string | undefined {
	const made = book.invoices.find((i) => i.callId === ctx.callId);
	if (made === undefined) return undefined;
	return draftAnswer(made, salesTotals(made), isIssued(made) ? made.due : dueOf(made, day), nextNumber(book, day), []);
}

function nextNumber(book: SalesBook, day: string): string {
	const year = Number(day.slice(0, 4));
	return invoiceNumber(year, book.next[String(year)] ?? 1, book.settings?.numbering ?? "plain");
}

function cards(env: SalesEnv) {
	const book = env.clients?.read();
	return book === undefined || book.broken ? [] : book.cards;
}

/** The customer a person names: a card, a customer invoiced here, or a new one with the name as said. */
function customerOf(env: SalesEnv, said: unknown, book: SalesBook): Known | string {
	const name = cleanText(said, 200, "il cliente");
	if (isProblem(name)) return `Errore: ${name.problem}.`;
	if (name === undefined) return "Errore: dimmi a quale cliente va la fattura.";
	const found = findBuyer(name, cards(env), book.invoices);
	if (found.kind === "close") return ["Intendi uno di questi? Nessun cliente si chiama esattamente così:", fenced(found.candidates.map((c) => `• ${c}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui."].join("\n");
	if (found.kind === "exact") return found.known;
	if (/^(?:[A-Z]{2})?\d{8,12}$|^[A-Z0-9]{16}$/i.test(name.replace(/[\s.\-/]/g, ""))) return askFor(["il nome o la ragione sociale del cliente: con questa partita IVA o codice fiscale non ho nessuno"]);
	return { name };
}

const sourceOf = (k: Known, extra: Omit<Source, "name" | "known">): Source => {
	const { name, ...known } = k;
	return { name, known, ...extra };
};

function fromLines(env: SalesEnv, args: Record<string, unknown>, book: SalesBook): Source | string {
	const given = readLines(args.lines);
	if (isProblem(given)) return `Errore: ${given.problem}.`;
	const known = customerOf(env, args.customer, book);
	return typeof known === "string" ? known : sourceOf(known, { given, notes: [] });
}

function fromQuote(env: SalesEnv, args: Record<string, unknown>, book: SalesBook): Source | string {
	if (env.quotes === undefined) return "Errore: qui non vedo i preventivi: detta le voci della fattura.";
	const quotes = env.quotes.read();
	if (quotes.broken) return `Errore: ${QUOTES_BROKEN}.`;
	const found = findQuotes(quotes.quotes, String(args.quote));
	if (found.length === 0) return ["Errore: non trovo questo preventivo:", fenced(String(args.quote))].join("\n");
	if (found.length > 1) return "Errore: c'è un preventivo con quel numero in più anni: dimmi l'anno, come «2026-004».";
	const q = found[0] as (typeof found)[number];
	if (q.status !== "accepted") return `Errore: il preventivo ${q.number} non risulta accettato (è ${STATUS_WORDS[q.status]}). Se il cliente l'ha accettato, va prima segnato come accettato, solo se chi ti scrive lo conferma.`;
	if (q.invoice !== undefined) return `Errore: il preventivo ${q.number} è già stato fatturato con la fattura n. ${q.invoice}.`;
	const other = book.invoices.find((i) => i.quote === q.number && i.type === INVOICE_TYPE && i.id !== args.replace);
	if (other !== undefined) return isIssued(other) ? `Errore: il preventivo ${q.number} è già fatturato con la fattura n. ${other.number}.` : `Errore: per il preventivo ${q.number} c'è già la bozza ${other.id}: emetti quella, oppure toglila prima.`;
	if (q.pricesIncludeVat === true) return "Errore: i prezzi del preventivo sono IVA compresa, e in fattura servono senza IVA: detta le voci con i prezzi senza IVA.";
	const cassa: Source["cassa"] = q.cassa === undefined ? undefined : q.cassa.kind === "rivalsa_inps" ? { type: INPS_CASSA, rate: q.cassa.rate, subject: true } : { missing: "type" };
	const found2 = findBuyer(q.customer.name, cards(env), book.invoices);
	const known: Known = found2.kind === "exact" ? { ...found2.known, name: q.customer.name } : { name: q.customer.name };
	const terms = termsOf(q.terms);
	return sourceOf(known, {
		quoteCustomer: q.customer,
		given: q.lines.map(quoteLine),
		...(q.ritenuta === true ? { ritenuta: true } : {}),
		...(cassa === undefined ? {} : { cassa }),
		...(q.bollo === true ? { bolloToClient: true } : {}),
		...(terms === undefined ? {} : { terms }),
		quote: q.number,
		notes: [],
	});
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
	const held = new Set(sheet.reservations.filter((x) => activeReservation(x, env.now())).flatMap((x) => x.entries.map((e) => e.id)));
	const inDrafts = new Set(book.invoices.filter((i) => !isIssued(i) && i.id !== args.replace).flatMap((i) => (i.hours ?? []).map((h) => h.id)));
	const open = sheet.entries.filter((e) => sameClient(e.client, r.name) && e.billable && e.billed === undefined && inPeriod(e.date, period) && !held.has(e.id));
	const picked = open.filter((e) => !inDrafts.has(e.id)).sort(oldestFirst);
	if (picked.length === 0) return open.length > 0 ? "Errore: le ore da fatturare di questo cliente sono già in un'altra bozza: emetti quella, oppure toglila prima." : `Nessuna ora da fatturare per questo cliente, ${period.label}: o sono già fatturate o in un preventivo, o non ce ne sono.`;
	if (picked.length > SALES_LIMITS.hours) return `Errore: sono più di ${SALES_LIMITS.hours} voci di ore: fattura un periodo più corto.`;
	const items = picked.map((e) => priced(e, sheet.rates));
	const unpriced = items.filter((p) => p.rate === undefined);
	if (unpriced.length > 0) return askFor([`la tariffa oraria con questo cliente: ${unpriced.length === 1 ? "una voce di ore non ha" : `${unpriced.length} voci di ore non hanno`} una tariffa. Va salvata nelle tariffe delle ore, poi rifai la fattura`]);
	// Room for latin1's longer forms of «…» and «–».
	const lines = hoursLines(items, "project", lineWords(period), FIELD_LIMITS.descrizione - 20);
	if (lines.length > SALES_LIMITS.lines) return `Errore: verrebbero più di ${SALES_LIMITS.lines} voci: fattura un periodo più corto.`;
	const found = findBuyer(r.name, cards(env), book.invoices);
	const known: Known = found.kind === "exact" ? { ...found.known, name: r.name } : { name: r.name };
	const minutes = items.reduce((s, p) => s + p.billed, 0);
	return sourceOf(known, {
		given: lines.map((l) => ({ description: l.description, quantity: String(l.quantity), price: String(l.price), ...(l.unit === undefined ? {} : { unit: l.unit }) })),
		hours: items.map((p) => ({ id: p.entry.id, minutes: p.entry.minutes, rate: p.rate as string, rounding: p.rounding })),
		notes: [`Ore in fattura: ${picked.length === 1 ? "una voce" : `${picked.length} voci`}, ${hoursText(minutes)} fatturabili. Le segno come fatturate quando la fattura è emessa.`],
	});
}

/** A draft of an invoice (TD01), from a quote, the hours or the lines. */
export async function draft(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
	const book = env.book();
	const done = again(env, book, ctx, day);
	if (done !== undefined) {
		await env.audit(ctx, "draft", 1);
		return done;
	}
	const company = env.company.read().company;
	const taxes = env.taxes.read();
	const seller = sellerOf(company, taxes.broken ? undefined : taxes.profile);
	if ("missing" in seller) return `${askFor(seller.missing, "emettere fatture")}\nSi salvano una volta nei dati dell'azienda, gli stessi della carta intestata.`;
	const sources = [args.quote, args.hours === true ? true : undefined, args.lines].filter((x) => x !== undefined).length;
	if (sources !== 1) return "Errore: la fattura parte da una cosa sola: un preventivo accettato, le ore da fatturare di un cliente, oppure le voci dettate.";
	const src = args.quote !== undefined ? fromQuote(env, args, book) : args.hours === true ? fromHours(env, args, book, day) : fromLines(env, args, book);
	if (typeof src === "string") return src;
	const regime = seller.seller.regime;
	const fields = readBuyerFields(args);
	if (isProblem(fields)) return `Errore: ${fields.problem}.`;
	const buyer = composeBuyer(src.name, { ...src.known, ...(src.quoteCustomer === undefined ? {} : { quote: src.quoteCustomer }) }, fields);
	if (isProblem(buyer)) return `Errore: ${buyer.problem}.`;
	if ("missing" in buyer) return askFor(buyer.missing);
	const vat = readVatRate(args.vat, "l'IVA");
	if (isProblem(vat)) return `Errore: ${vat.problem}.`;
	const natura = readNatura(args.natura, "le voci senza IVA");
	if (isProblem(natura)) return `Errore: ${natura.problem}.`;
	const reference = cleanText(args.reference, FIELD_LIMITS.riferimentoNormativo, "il riferimento normativo");
	if (isProblem(reference)) return `Errore: ${reference.problem}.`;
	const lines = withRates(src.given, { ...(vat === undefined ? {} : { vat }), ...(natura === undefined ? {} : { natura }), ...(reference === undefined ? {} : { reference }) }, regime);
	if (isProblem(lines)) return `Errore: ${lines.problem}.`;
	if ("missing" in lines) {
		return askFor([lines.missing === "vat" ? "l'aliquota IVA delle voci: 22, 10, 5 o 4%, oppure senza IVA con la sua natura (per esempio N4 esente, N2.1 per un servizio a un cliente UE)" : "la natura delle voci senza IVA (per esempio N4 esente, N2.1 per un servizio a un cliente UE, N3.1 esportazione): la sa chi ti scrive o il suo commercialista"]);
	}
	const long = lines.findIndex((l) => !fitsLatin(l.description, FIELD_LIMITS.descrizione) || (l.unit !== undefined && !fitsLatin(l.unit, FIELD_LIMITS.unitaMisura)) || (l.reference !== undefined && !fitsLatin(l.reference, FIELD_LIMITS.riferimentoNormativo)));
	if (long >= 0) return `Errore: la riga ${long + 1} è troppo lunga per la fattura (la descrizione al massimo ${FIELD_LIMITS.descrizione} caratteri).`;
	const ritenuta = readRitenuta(args.ritenuta ?? src.ritenuta, regime, seller.seller.cf);
	if (isProblem(ritenuta)) return `Errore: ${ritenuta.problem}.`;
	const cassa = args.cassa === undefined ? src.cassa : readCassa(args.cassa);
	if (isProblem(cassa)) return `Errore: ${cassa.problem}.`;
	if (cassa !== undefined && "missing" in cassa) return askFor(["di quale cassa professionale è il contributo integrativo (il codice da TC01 a TC21, per esempio TC01 avvocati, TC04 Inarcassa) e la percentuale, se non è il 4%"]);
	if (args.split_payment !== undefined && typeof args.split_payment !== "boolean") return "Errore: la scissione dei pagamenti è sì o no.";
	const split = args.split_payment === true;
	if (split && regime !== REGIME_ORDINARIO) return "Errore: in regime forfettario la fattura è senza IVA, quindi la scissione dei pagamenti non si applica.";
	const payment = readPayment(args, company?.ibans ?? [], src.terms);
	if (isProblem(payment)) return `Errore: ${payment.problem}.`;
	const order = readOrder(args.order);
	if (isProblem(order)) return `Errore: ${order.problem}.`;
	const causale = cleanText(args.notes, SALES_LIMITS.causale, "le note");
	if (isProblem(causale)) return `Errore: ${causale.problem}.`;
	if (causale !== undefined && !fitsLatin(causale, FIELD_LIMITS.causale)) return `Errore: le note sono troppo lunghe per la fattura (al massimo ${FIELD_LIMITS.causale} caratteri).`;
	if (args.bollo_to_client !== undefined && typeof args.bollo_to_client !== "boolean") return "Errore: il bollo è a carico del cliente o no.";
	const base = {
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
	} satisfies Omit<SalesInvoice, "id" | "callId" | "by" | "at">;
	let bolloToClient: boolean | undefined;
	let saveBollo = false;
	if (salesTotals(base).bollo.due) {
		bolloToClient = (args.bollo_to_client as boolean | undefined) ?? src.bolloToClient ?? book.settings?.bolloToClient;
		if (bolloToClient === undefined) {
			return "Questa fattura supera 77,47 € senza IVA, quindi ha il bollo virtuale da 2,00 €. Chiedi a chi ti scrive se il bollo è a carico del cliente (si aggiunge in fattura una riga da 2,00 €) o resta a carico suo: lo ricordo per le prossime fatture. Poi rifai la richiesta con la risposta.";
		}
		saveBollo = args.bollo_to_client !== undefined && book.settings?.bolloToClient === undefined;
	}
	const fields2 = { ...base, ...(bolloToClient === undefined ? {} : { bolloToClient }) };
	const notes = [...src.notes];
	if (buyer.kind === "private" && buyer.code === NO_CHANNEL_CODE && buyer.pec === undefined) notes.push(`Il cliente è un privato senza codice destinatario né PEC: in fattura va il codice ${NO_CHANNEL_CODE}, e una copia va data al cliente.`);
	return save(env, args, ctx, day, fields2, notes, "draft", saveBollo ? bolloToClient : undefined);
}

/** A credit note (TD04) for an invoice issued: all its lines, or the lines given; never more than what is left to credit. */
export async function creditNote(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
	const book = env.book();
	const done = again(env, book, ctx, day);
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
	const rates = new Set(original.lines.map((l) => `${l.vat}|${l.natura ?? ""}`));
	const only = rates.size === 1 ? original.lines[0] : undefined;
	const wide = { ...(vat ?? only?.vat) === undefined ? {} : { vat: (vat ?? only?.vat) as NonNullable<typeof vat> }, ...((natura ?? only?.natura) === undefined ? {} : { natura: (natura ?? only?.natura) as NonNullable<typeof natura> }) };
	const lines = withRates(given, wide, original.regime);
	if (isProblem(lines)) return `Errore: ${lines.problem}.`;
	if ("missing" in lines) return askFor([lines.missing === "vat" ? "l'aliquota IVA delle voci da stornare, come nella fattura" : "la natura delle voci senza IVA da stornare, come nella fattura"], "la nota di credito");
	const causale = cleanText(args.notes, SALES_LIMITS.causale, "le note");
	if (isProblem(causale)) return `Errore: ${causale.problem}.`;
	const fields = {
		type: CREDIT_NOTE_TYPE,
		regime: original.regime,
		buyer: original.buyer,
		lines,
		...(original.ritenuta === undefined ? {} : { ritenuta: original.ritenuta }),
		...(original.cassa === undefined ? {} : { cassa: original.cassa }),
		related: { number: original.number, date: original.date, id: original.id },
		causale: causale ?? `Storno della fattura n. ${original.number} del ${italianDate(original.date)}`,
	} satisfies Omit<SalesInvoice, "id" | "callId" | "by" | "at">;
	const total = (i: Parameters<typeof salesTotals>[0]) => salesTotals(i).total;
	const credited = book.invoices.filter((i) => i.type === CREDIT_NOTE_TYPE && i.related?.id === original.id && i.id !== args.replace).reduce((s, i) => s + total(i), 0n);
	if (credited + total(fields) > total(original)) return `Errore: la nota di credito supererebbe quello che resta da stornare della fattura n. ${original.number}: contando le altre note di credito e bozze, non si può stornare più del totale.`;
	return save(env, args, ctx, day, fields, [], "credit_note", undefined);
}

/** Save the draft (in place of `replace`, when given) under the store's lock, once per call. */
async function save(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, day: string, fields: Omit<SalesInvoice, "id" | "callId" | "by" | "at">, notes: string[], op: "draft" | "credit_note", bollo: boolean | undefined): Promise<string> {
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const marker = env.marker(ctx);
	if (!validInvoice({ ...marker, ...fields, id: "BZ-0000", callId: ctx.callId })) throw new SalesInvoiceError("i dati della fattura non sono validi: non ho salvato la bozza");
	env.store.update(ctx.callId, (state): SalesState => {
		const old = replace === undefined ? undefined : state.invoices.find((i) => i.id === replace);
		if (replace !== undefined && (old === undefined || isIssued(old))) throw new SalesInvoiceError(`la bozza ${replace} da sostituire non c'è, o è già emessa`);
		if (state.invoices.length >= SALES_LIMITS.invoices) throw new SalesInvoiceError("l'archivio delle fatture è pieno");
		const inv: SalesInvoice = { ...marker, ...fields, id: draftId(state.nextDraft), callId: ctx.callId };
		return {
			...state,
			...(bollo === undefined ? {} : { settings: { ...(state.settings ?? {}), ...marker, bolloToClient: bollo } }),
			nextDraft: state.nextDraft + 1,
			invoices: [...state.invoices.filter((i) => i !== old), inv],
		};
	});
	const book = env.book();
	const made = book.invoices.find((i) => i.callId === ctx.callId);
	if (made === undefined) throw new SalesInvoiceError("la bozza non risulta salvata");
	await env.audit(ctx, op, 1);
	if (replace !== undefined) notes.push(`Prende il posto della bozza ${replace}, che ho tolto.`);
	if (made.regime === REGIME_FORFETTARIO) notes.push("Regime forfettario: senza IVA, natura N2.2, con la dicitura di legge e senza ritenuta.");
	return draftAnswer(made, salesTotals(made), dueOf(made, day), nextNumber(book, day), notes);
}
