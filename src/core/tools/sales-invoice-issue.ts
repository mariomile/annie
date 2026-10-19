/**
 * sales_invoices op issue: a draft becomes an invoice only after the person's yes (confirm true).
 * Before a number is taken: the seller's data as saved today, the regime of the draft, the hours
 * and the quote it bills (unchanged since the draft), and a dry run of the XML with the longest
 * number, so an invoice never takes a number it cannot be written with. Then, each step safe to
 * run again:
 * 1. the number and the file progressive, under the store's lock (once per call id);
 * 2. the XML in `fatture/emesse/`, never over another file: a name taken by a different file
 *    gets a new progressive; the same content there already is this call's own write;
 * 3. the courtesy PDF beside it, same name (a failure is said, the invoice stands);
 * 4. the hours marked «fatturate» with the invoice's number, the quote marked invoiced, the
 *    magazzino moved (an invoice unloads the articles its lines sell, a credit note puts them
 *    back: once per invoice and line, stock-store.ts sale; a fattura differita's lines went out
 *    with their DDTs), the DDTs of a fattura differita marked billed (sales-ddt.ts);
 * 5. the invoice marked finished; then the audit (op and count), and the invoice marked audited,
 *    so an audit a crash left out is written on the next run, and never twice.
 * The number comes after the store's counter, the last number said before Annie and the highest
 * number of the year among the company's own invoices in the workspace. An invoice issued and not
 * finished (a crash, a PDF or a mark that failed) is completed by issuing it again.
 */
import type { ToolContext } from "../engine.ts";
import { FatturaWriteError, fatturaFileName, fatturaXml } from "../fattura-pa-writer.ts";
import { QUOTES_BROKEN } from "../quote-store.ts";
import { QuoteError, STATUS_WORDS } from "../quotes.ts";
import { ISSUED_FOLDER } from "../sales-invoice-rules.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { docWord, type IssuedInvoice, invoiceProblem, isIssued, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, type Seller, sellerOf } from "../sales-invoices.ts";
import type { Rounding } from "../timesheet.ts";
import { TIMESHEET_BROKEN } from "../timesheet-store.ts";
import { termsOf } from "../timesheet-sums.ts";
import { WorkspaceError } from "../workspace.ts";
import { askGroups, dueOf, filesSay, findIssued, namedDraft, noneMissing, type SalesEnv } from "./sales-invoice-env.ts";
import { courtesyMarkdown, fenced, invoiceLines, issuedAnswer } from "./sales-invoice-render.ts";
import { markStock, stockPreview } from "./sales-invoice-stock.ts";
import { ddtPreview, ddtProblem, markDdt } from "./sales-ddt.ts";
import { requirePersonFor } from "../turn-origin.ts";

/** Tries at a free file name before giving up. */
const NAME_TRIES = 5;

export async function issue(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
	const book = env.book();
	const mine = book.invoices.find((i): i is IssuedInvoice => isIssued(i) && i.issueCall === ctx.callId);
	if (mine !== undefined) return complete(env, mine, ctx, []);
	// Nothing named and an issue left halfway (or its audit): that one first, the drafts untouched.
	const unfinished = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && (i.finished !== true || i.audited !== true));
	if (args.draft === undefined && unfinished.length > 0) {
		if (unfinished.length > 1) return `Errore: ci sono più fatture con l'emissione da completare (n. ${unfinished.map((i) => i.number).join(", ")}): dimmi quale, e la completo prima di emettere altro.`;
		return complete(env, unfinished[0] as IssuedInvoice, ctx, []);
	}
	const named = namedDraft(book.invoices, args.draft, "emettere");
	if ("answer" in named) return named.answer;
	const target = named.found;
	if (isIssued(target)) {
		if (target.finished === true && target.audited === true) return `La ${docWord(target.type)} n. ${target.number} è già emessa: il file è ${target.file ?? "da scrivere"}.`;
		return complete(env, target, ctx, []);
	}
	if (args.confirm !== undefined && typeof args.confirm !== "boolean") return "Errore: la conferma è sì o no.";
	const checked = await ready(env, target, day);
	if (typeof checked === "string") return checked;
	if (args.confirm !== true) {
		return [
			`Emetterei questa ${docWord(target.type)} con la data di oggi: prende il prossimo numero e il file XML va in ${ISSUED_FOLDER}. Una volta emessa non si cancella più, si può solo stornare con una nota di credito.`,
			fenced(invoiceLines(target, salesTotals(target), dueOf(target, day), day).join("\n")),
			...stockPreview(env, target, day, env.marker(ctx)),
			...ddtPreview(target, day),
			"Ripeti a chi ti scrive i dati del riquadro e chiedi conferma: la emetto solo dopo il suo sì.",
		].join("\n");
	}
	// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
	const notPerson = requirePersonFor(ctx, `emetto la ${docWord(target.type)}`);
	if (notPerson !== undefined) return notPerson;
	const due = dueOf(target, day);
	const marker = env.marker(ctx);
	const year = Number(day.slice(0, 4));
	// The files only check the dates; the number is the store's alone.
	const latest = (await filesSay(env, ctx.signal, checked.vat, year, day)).latest;
	const inv = env.store.issue(target.id, ctx.callId, day, latest, (draft, number, seq, progressive) => ({
		...draft,
		number,
		year,
		seq,
		date: day,
		...(due === undefined ? {} : { due }),
		seller: checked,
		progressive,
		issued: marker,
		issueCall: ctx.callId,
	}));
	return complete(env, inv, ctx, []);
}

/** sales_invoices op finish: the invoice a number names, issued and not complete, completed with its own number. */
export async function finish(env: SalesEnv, args: Record<string, unknown>, ctx: ToolContext, _day: string): Promise<string> {
	if (typeof args.invoice !== "string" || args.invoice.trim() === "") return "Errore: dimmi il numero della fattura da completare.";
	const found = findIssued(env.book().invoices, args.invoice);
	if (found.length === 0) return "Errore: non trovo una fattura emessa con quel numero.";
	if (new Set(found.map((f) => f.year)).size > 1) return `Errore: c'è una fattura con quel numero in più anni (${found.map((f) => f.year).join(", ")}): dimmi l'anno.`;
	const inv = found[0] as IssuedInvoice;
	if (inv.finished === true && inv.audited === true && inv.issueCall !== ctx.callId) return `La ${docWord(inv.type)} n. ${inv.number} è già emessa e completa: il file è ${inv.file ?? "da scrivere"}.`;
	return complete(env, inv, ctx, []);
}

/** Why the number differs from the one the draft said: other invoices issued meanwhile, the last number before Annie said, the year, the way of writing it. */
function numberNote(env: SalesEnv, inv: IssuedInvoice): string | undefined {
	const expected = inv.expected;
	if (expected === undefined || expected === inv.number) return undefined;
	const others = env.book().invoices.filter((i) => isIssued(i) && i.id !== inv.id && i.year === inv.year && (i.issued as { at: string }).at > inv.at).length;
	const said = /(\d+)(?:\/\d{4})?$/.exec(expected);
	const saidYear = /^(\d{4})\//.exec(expected)?.[1];
	const why =
		inv.at.slice(0, 4) !== String(inv.year) || (saidYear !== undefined && saidYear !== String(inv.year))
			? "intanto è cambiato l'anno, e la numerazione riparte"
			: said !== null && Number(said[1]) === inv.seq
				? "intanto è cambiato il modo di scrivere il numero"
				: others > 0
					? `intanto ${others === 1 ? "è stata emessa un'altra fattura" : `sono state emesse altre ${others} fatture`}`
					: "intanto è stato detto o corretto il numero dell'ultima fattura prima di me";
	return `Nella bozza avevo detto la n. ${expected}: è la n. ${inv.number} perché ${why}.`;
}

/**
 * The steps after the number, each safe to run again: the XML, the PDF (not needed to finish), the
 * hours, the quote. Finished when the XML, the hours and the quote are done; the audit once, when
 * it becomes finished. `resumed`: issued before by another call.
 */
async function complete(env: SalesEnv, start: IssuedInvoice, ctx: ToolContext, notes: string[]): Promise<string> {
	const resumed = start.issueCall !== ctx.callId;
	const said = resumed ? undefined : numberNote(env, start);
	if (said !== undefined) notes.push(said);
	let inv = await writeXml(env, start);
	inv = await writePdf(env, inv, notes);
	const hours = await markHours(env, inv, ctx);
	const quote = await markQuote(env, inv, ctx);
	const stock = await markStock(env, inv, ctx);
	const ddt = await markDdt(env, inv, ctx);
	notes.push(...hours.notes, ...quote.notes, ...stock.notes, ...ddt.notes);
	if (inv.file !== undefined && hours.done && quote.done && stock.done && ddt.done) {
		env.store.setFinished(inv.id);
		// The audit once: on the run that finishes it, or the next one when a crash came in between.
		const now = env.book().invoices.find((i) => i.id === inv.id);
		if (now !== undefined && isIssued(now) && now.audited !== true) {
			await env.audit(ctx, "issue", 1);
			env.store.setAudited(inv.id);
		}
	} else notes.push(`L'emissione della fattura n. ${inv.number} non è completa: quando il problema è risolto, si completa con la fattura n. ${inv.number}, con lo stesso numero.`);
	return issuedAnswer(inv, salesTotals(inv), notes, resumed);
}

/** The seller, when the draft can be issued today; what to ask or why not otherwise. */
async function ready(env: SalesEnv, draft: SalesInvoice, day: string): Promise<Seller | string> {
	const company = env.company.read().company;
	const taxes = env.taxes.read();
	const seller = sellerOf(company, taxes.broken ? undefined : taxes.profile);
	if ("missing" in seller) return askGroups({ ...noneMissing(), me: [...seller.missing] }, ["I tuoi dati si salvano una volta con invoices op set_company (name, vat, cf, address, regime, iban), poi emetti di nuovo."]);
	if (seller.seller.regime !== draft.regime) return "Errore: il regime fiscale nei dati dell'azienda è cambiato da quando ho preparato la bozza: va rifatta.";
	const hours = hoursProblem(env, draft);
	if (hours !== undefined) return hours;
	const quote = quoteProblem(env, draft);
	if (quote !== undefined) return quote;
	const ddt = ddtProblem(env, draft);
	if (ddt !== undefined) return ddt;
	// A dry run with the longest number and progressive: a field that does not fit stops here, before a number is taken.
	const year = Number(day.slice(0, 4));
	const trial: IssuedInvoice = { ...draft, number: `${year}/99999`, year, seq: 99_999, date: day, seller: seller.seller, progressive: "ZZZZZ", issued: { by: draft.by, at: draft.at } };
	const problem = invoiceProblem(trial);
	if (problem !== undefined) return `Errore: la fattura non si può emettere così: va controllato ${problem}. Non ho usato nessun numero.`;
	try {
		fatturaXml(trial, salesTotals(trial));
	} catch (error) {
		if (error instanceof FatturaWriteError) return `Errore: la fattura non si può scrivere così (${error.message}): va corretta la bozza. Non ho usato nessun numero.`;
		throw error;
	}
	return seller.seller;
}

/** Why the hours of the draft cannot be billed now: changed, removed, billed meanwhile. */
function hoursProblem(env: SalesEnv, draft: SalesInvoice): string | undefined {
	if (draft.hours === undefined || draft.hours.length === 0) return undefined;
	if (env.timesheet === undefined) return "Errore: qui non vedo le ore di lavoro, quindi non posso segnarle come fatturate.";
	const sheet = env.timesheet.read();
	if (sheet.broken) return `Errore: ${TIMESHEET_BROKEN}.`;
	const byId = new Map(sheet.entries.map((e) => [e.id, e]));
	const changed = draft.hours.filter((h) => {
		const e = byId.get(h.id);
		if (e === undefined || e.billed !== undefined || !e.billable || e.minutes !== h.minutes) return true;
		const terms = termsOf(e, sheet.rates);
		return terms.rate !== h.rate || terms.rounding !== h.rounding;
	});
	if (changed.length === 0) return undefined;
	return `Errore: ${changed.length === 1 ? "una voce di ore è cambiata" : `${changed.length} voci di ore sono cambiate`} da quando ho preparato la bozza (modificate, tolte, o già fatturate): va rifatta la bozza, così la fattura corrisponde alle ore. Non ho usato nessun numero.`;
}

function quoteProblem(env: SalesEnv, draft: SalesInvoice): string | undefined {
	if (draft.quote === undefined || env.quotes === undefined) return undefined;
	const quotes = env.quotes.read();
	if (quotes.broken) return `Errore: ${QUOTES_BROKEN}.`;
	const q = quotes.quotes.find((x) => x.number === draft.quote);
	if (q === undefined) return `Errore: il preventivo ${draft.quote} non c'è più: va rifatta la bozza.`;
	if (q.invoice !== undefined) return `Errore: il preventivo ${q.number} è già fatturato con la fattura n. ${q.invoice}.`;
	if (q.status !== "accepted") return `Errore: il preventivo ${q.number} non risulta più accettato (è ${STATUS_WORDS[q.status]}).`;
	return undefined;
}

/** The XML in the workspace, under a name no other file has; the invoice as saved after. */
async function writeXml(env: SalesEnv, start: IssuedInvoice): Promise<IssuedInvoice> {
	let inv = start;
	for (let i = 0; i < NAME_TRIES; i++) {
		if (inv.file !== undefined) return inv;
		const xml = fatturaXml(inv, salesTotals(inv));
		const path = `${ISSUED_FOLDER}/${fatturaFileName(inv.seller.vat, inv.progressive)}`;
		if ((await env.workspace.stat(path)) !== undefined) {
			const there = await env.workspace.readExact(path).catch((error: unknown) => {
				if (error instanceof WorkspaceError) return undefined;
				throw error;
			});
			// The same content: this call's own write, before it was recorded.
			if (there?.data.toString("utf8") === xml) return saved(env, inv.id, { file: path });
			inv = env.store.newProgressive(inv.id);
			continue;
		}
		const written = await env.workspace.write(path, xml);
		return saved(env, inv.id, { file: written.path });
	}
	throw new SalesInvoiceError("non trovo un nome libero per il file della fattura nella cartella delle fatture emesse");
}

function saved(env: SalesEnv, id: string, files: { file?: string; pdf?: string }): IssuedInvoice {
	env.store.setFiles(id, files);
	const inv = env.book().invoices.find((i) => i.id === id);
	if (inv === undefined || !isIssued(inv)) throw new SalesInvoiceError("la fattura non c'è più");
	return inv;
}

/** The courtesy PDF beside the XML: a file already there with its name is this invoice's own (the name is its progressive). */
async function writePdf(env: SalesEnv, inv: IssuedInvoice, notes: string[]): Promise<IssuedInvoice> {
	if (inv.pdf !== undefined || inv.file === undefined) return inv;
	const xmlName = fatturaFileName(inv.seller.vat, inv.progressive);
	const path = `${ISSUED_FOLDER}/${fatturaFileName(inv.seller.vat, inv.progressive, "pdf")}`;
	try {
		if ((await env.workspace.stat(path)) !== undefined) return saved(env, inv.id, { pdf: path });
		const doc = await env.make({ format: "pdf", text: courtesyMarkdown(inv, salesTotals(inv), xmlName), name: `${inv.type === "TD04" ? "Nota di credito" : "Fattura"} ${inv.number}`, pictures: [], now: env.now().getTime() });
		const written = await env.workspace.write(path, doc.data);
		return saved(env, inv.id, { pdf: written.path });
	} catch (error) {
		if (error instanceof SalesInvoiceError) throw error;
		notes.push("La copia di cortesia in PDF non sono riuscita a farla: la fattura è emessa lo stesso, il file valido è l'XML.");
		return inv;
	}
}

/** The hours billed: «fatturate» with the invoice's number, at the terms of the draft; the quote's hours get the number too. */
async function markHours(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const timesheet = env.timesheet;
	if (timesheet === undefined || (inv.hours === undefined && inv.quote === undefined)) return { notes: [], done: true };
	const ref = `fattura ${inv.number}`;
	const own = new Map((inv.hours ?? []).map((h) => [h.id, h]));
	const result = await ctx.step("hours", async () => {
		const sheet = timesheet.read();
		if (sheet.broken) return { changed: 0, reserved: 0, broken: true };
		const quoted = inv.quote === undefined ? [] : sheet.entries.filter((e) => e.billed !== undefined && e.billed.quote === inv.quote && e.billed.ref === undefined).map((e) => e.id);
		const ids = [...own.keys(), ...quoted];
		if (ids.length === 0) return { changed: 0, reserved: 0, broken: false };
		const marker = env.marker(ctx);
		const r = timesheet.setBilled(ids, (e) => {
			if (e.billed?.ref === ref) return undefined;
			const h = own.get(e.id);
			if (h !== undefined) return e.billed === undefined ? { ...marker, ref, rate: h.rate, rounding: h.rounding as Rounding } : undefined;
			return e.billed !== undefined && e.billed.quote === inv.quote ? { ...e.billed, ref } : undefined;
		});
		return { changed: r.changed.length, reserved: r.reserved.length, broken: false };
	});
	if (result.broken) return { notes: ["Attenzione: il registro delle ore non si legge, quindi le ore non sono segnate come fatturate."], done: false };
	const out: string[] = [];
	if (result.changed > 0) out.push(`Ho segnato come fatturate ${result.changed === 1 ? "una voce di ore" : `${result.changed} voci di ore`}, con il numero della fattura.`);
	if (result.reserved > 0) out.push(`Attenzione: ${result.reserved === 1 ? "una voce di ore era" : `${result.reserved} voci di ore erano`} in un preventivo in preparazione e non ${result.reserved === 1 ? "è segnata" : "sono segnate"}: ricontrollale con chi ti scrive.`);
	return { notes: out, done: true };
}

async function markQuote(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const quotes = env.quotes;
	const quote = inv.quote;
	if (quote === undefined || quotes === undefined) return { notes: [], done: true };
	const done = await ctx.step("quote", async () => {
		try {
			quotes.markInvoiced(quote, inv.number);
			return true;
		} catch (error) {
			if (error instanceof QuoteError) return false;
			throw error;
		}
	});
	return done ? { notes: [`Il preventivo ${quote} ora risulta fatturato.`], done } : { notes: [`Attenzione: non sono riuscita a segnare il preventivo ${quote} come fatturato.`], done };
}

