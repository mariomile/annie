/**
 * Which client the person means, by the one rule of timesheet-clients.ts, for each kind of op.
 * Recording (log, start, set_rate, edit): the same client already used takes its spelling, said
 * in a note; a close one is only suggested and the name is kept as said. Reading (list,
 * summary): the one close client with hours is used, and said; several are asked. Billing
 * (report, to_quote, mark_*): only the same client; a close one is refused with the candidates.
 * The names already used are the timesheet's, the rates' and the quotes'; the customers of the
 * invoices issued (scanned from files in the workspace) are suggestions only, never taken.
 */
import type { ToolContext } from "../engine.ts";
import type { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { register } from "../invoices.ts";
import type { QuoteStore } from "../quote-store.ts";
import { spellingKey } from "../name-keys.ts";
import { newestFirst, sameClient, TIMESHEET_LIMITS, type WorkEntry } from "../timesheet.ts";
import { closeClients, resolveClient } from "../timesheet-clients.ts";
import type { TimesheetBook } from "../timesheet-store.ts";
import { partyName } from "./invoice-words.ts";
import { fenced } from "./timesheet-render.ts";

export type ClientSources = {
	readonly quotes: Pick<QuoteStore, "read">;
	readonly company: Pick<InvoiceStore, "read">;
	readonly scanner?: InvoiceScanner;
};

/** A client to record: the name to store, and what to say about it. */
export type Named = { readonly name: string; readonly notes: readonly string[] };

const list = (names: readonly string[]) => fenced(names.map((n) => `• ${n}`).join("\n"));

/** Names in order, each once. */
function distinct(names: readonly string[]): string[] {
	return [...new Set(names)];
}

/** Names each once by spelling (case, accents and punctuation aside), the first kept. */
function bySpelling(names: readonly string[]): string[] {
	const out = new Map<string, string>();
	for (const n of names) if (!out.has(spellingKey(n))) out.set(spellingKey(n), n);
	return [...out.values()];
}

/** The clients of some entries, newest first, each spelling once. */
export function entryClients(entries: readonly WorkEntry[]): string[] {
	return distinct([...entries].sort(newestFirst).map((e) => e.client));
}

/** The note said when a name is written as already used. */
function respelled(name: string): string {
	return `Ho usato il nome del cliente già usato:\n${fenced(name)}`;
}

export function clientNames(sources: ClientSources) {
	/** The timesheet's names (newest first, then the rates'), then the quotes'. */
	function known(book: Pick<TimesheetBook, "entries" | "rates">): string[] {
		const names = [...entryClients(book.entries), ...book.rates.flatMap((r) => (r.client === undefined ? [] : [r.client]))];
		const quotes = sources.quotes.read();
		if (!quotes.broken) names.push(...[...quotes.quotes].reverse().map((q) => q.customer.name));
		return distinct(names);
	}

	/** The customers of the invoices issued, from the scan of the workspace: suggestions only. */
	async function invoiceNames(ctx: ToolContext): Promise<string[]> {
		if (sources.scanner === undefined) return [];
		const company = sources.company.read();
		if (company.broken || company.company === undefined) return [];
		const scan = await sources.scanner.scan(ctx.signal, (t) => ctx.progress(t));
		return distinct(register(scan.invoices, company.paid, company.company, company.reminders).flatMap((i) => (i.side === "active" && i.customer.name !== undefined ? [partyName(i.customer)] : [])));
	}

	return {
		known,

		/** The client to record from what the person said: the same one already used, else as said, with the close ones suggested. */
		async forRecord(said: string, book: Pick<TimesheetBook, "entries" | "rates">, ctx: ToolContext): Promise<Named> {
			const names = known(book);
			const found = resolveClient(said, names);
			if (found.kind === "exact") return { name: found.name, notes: found.respelled ? [respelled(found.name)] : [] };
			// The invoices are scanned only when no name already used is the same.
			const invoices = await invoiceNames(ctx);
			const fromInvoices = [...invoices.filter((n) => n !== said && spellingKey(n) === spellingKey(said)), ...closeClients(said, invoices)];
			const close = bySpelling([...(found.kind === "close" ? found.candidates : []), ...fromInvoices]).slice(0, 5);
			if (close.length === 0) return { name: said, notes: [] };
			return {
				name: said,
				notes: [`Ho scritto il cliente come detto. Ci sono nomi simili, già usati o nelle fatture:\n${list(close)}\nChiedi a chi ti scrive: «È lo stesso cliente di uno di questi?» Se sì, correggi il cliente della voce (op edit con client, il nome esatto).`],
			};
		},
	};
}

/** The client the person names, among those with entries: by name, or the answer saying why not. */
export type Chosen = { readonly client: string; readonly entries: WorkEntry[]; readonly notes: readonly string[] } | { readonly error: string };

function cut(said: string): string {
	return said.slice(0, TIMESHEET_LIMITS.client);
}

/**
 * For reading: the client with entries that `said` names; the one close client when there is
 * only one (said in a note); several close ones are asked. No client: no entries, no error.
 */
export function readClient(said: string, entries: readonly WorkEntry[]): Chosen {
	const found = resolveClient(cut(said), entryClients(entries));
	if (found.kind === "none") return { client: cut(said), entries: [], notes: [] };
	if (found.kind === "close" && found.candidates.length > 1) return { error: `Errore: più clienti hanno un nome simile:\n${list(found.candidates)}\nChiedi a chi ti scrive quale.` };
	const name = found.kind === "exact" ? found.name : (found.candidates[0] as string);
	const notes = found.kind === "close" ? [`Nessun cliente si chiama esattamente così: ho usato il solo nome simile con delle ore:\n${fenced(name)}\nSe non è lui, chiedi a chi ti scrive quale.`] : [];
	return { client: name, entries: entries.filter((e) => sameClient(e.client, name)), notes };
}

/** For billing: only the client with entries written as `said` (case, accents and punctuation aside); a close name is refused with the candidates. */
export function billClient(said: unknown, entries: readonly WorkEntry[]): Chosen {
	if (typeof said !== "string" || said.trim() === "") return { error: "Errore: indica il cliente con client." };
	const found = resolveClient(cut(said), entryClients(entries));
	if (found.kind === "close") {
		return { error: `Errore: nessun cliente con delle ore si chiama esattamente così; quelli con un nome simile sono:\n${list(found.candidates)}\nPer fatturare non scelgo io: chiedi a chi ti scrive quale, e rifai con client scritto come qui sopra.` };
	}
	if (found.kind === "none") return { error: `Errore: non trovo ore registrate per il cliente:\n${fenced(cut(said))}\nGuarda i clienti con op summary e period «anno».` };
	return { client: found.name, entries: entries.filter((e) => sameClient(e.client, found.name)), notes: found.respelled ? [respelled(found.name)] : [] };
}
