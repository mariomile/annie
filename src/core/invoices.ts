/**
 * The scadenzario: the electronic invoices (FatturaPA, fattura-pa.ts) found in an instance's
 * workspace, their instalments and which are paid. The files are found the way file_search finds
 * them (newest first, within its limits) and read in the document worker; what each says is kept
 * per file (path, size and time), so asking again reads nothing new. Whether an invoice is to pay
 * or to collect depends on which side the owner's company is: its partita IVA (or name), when
 * set, says so; otherwise neither is said. What is paid is not in the files: the owner says it,
 * and it is kept in `invoices.json`, with who said it and when.
 */
import { join } from "node:path";
import { DOCUMENT_READER_LIMITS, isTransient, readFattura } from "./document-reader.ts";
import type { ReadOptions } from "./document-texts.ts";
import { DocumentError, documentKind } from "./documents.ts";
import { type Fattura, type FatturaDocument, type FatturaInstalment, type FatturaParty, MAX_FATTURA_BYTES, toUnits } from "./fattura-pa.ts";
import { realDate } from "./italian-calendar.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { pool } from "./pool.ts";
import { partitaIvaProblem } from "./tax-ids.ts";
import { fold } from "./text-match.ts";
import { newestFirst, PARALLEL, SEARCH_LIMITS, type SearchLimits, WORKER_WAIT_MS } from "./workspace-search.ts";
import type { Workspace, WorkspaceFile } from "./workspace.ts";

export const INVOICE_LIMITS = {
	/** Files whose reading is remembered, the least recently used goes. */
	cache: 2000,
	/** Paid marks kept: the oldest go. */
	marks: 5000,
	/** A company name as set by the owner. */
	name: 120,
} as const;

/** The scadenzario's ops that only read: they run in a brief's thread too (brief.ts); the others write. */
export const INVOICE_READ_OPS: ReadonlySet<string> = new Set(["due", "by_party", "list"]);

export type ScanLimits = Pick<SearchLimits, "files" | "bytes" | "budgetMs">;

export class InvoiceError extends Error {
	override readonly name = "InvoiceError";
}

/** Names an invoice may have: .xml, signed .xml.p7m, or a bare .p7m that is not a signed PDF, Office file or text. */
const CANDIDATE = /\.(?:xml|p7m)$/i;
const OTHER_SIGNED = /\.(?:pdf|docx|xlsx|pptx|odt|ods|odp|txt|csv|jpe?g|png|tiff?)(?:\.p7m)+$/i;

function maybeInvoice(path: string): boolean {
	return CANDIDATE.test(path) && !OTHER_SIGNED.test(path);
}

export type FoundFattura = { readonly path: string; readonly modifiedAt: string; readonly fattura: Fattura };

export type ScanOutcome = {
	readonly invoices: readonly FoundFattura[];
	/** Files whose name may be an invoice's. */
	readonly candidates: number;
	/** Invoices that could not be read, with the reason. */
	readonly unread: readonly { readonly path: string; readonly why: string }[];
	/** Files left out by the limits: the oldest. */
	readonly leftOut: number;
};

type Entry = { readonly kind: "fattura"; readonly fattura: Fattura } | { readonly kind: "other" } | { readonly kind: "unread"; readonly why: string };

export type ReadFattura = (name: string, data: Uint8Array, options: ReadOptions) => Promise<Fattura>;

/**
 * The invoices of one workspace, each file read once while it stays the same (path, size and
 * modification time): in the document worker, one at a time, waiting a few seconds at most for a
 * worker, like file_search. A file that is not an invoice is remembered too; a failure that may
 * not happen again is not.
 */
export class InvoiceScanner {
	private readonly entries = new Map<string, Entry>();
	private readonly limits: ScanLimits;
	private readonly read: ReadFattura;
	private readonly maxEntries: number;

	constructor(
		private readonly workspace: Workspace,
		options: { readonly limits?: ScanLimits; readonly read?: ReadFattura; readonly maxEntries?: number } = {},
	) {
		this.limits = options.limits ?? SEARCH_LIMITS;
		this.read = options.read ?? readFattura;
		this.maxEntries = options.maxEntries ?? INVOICE_LIMITS.cache;
	}

	async scan(signal: AbortSignal, progress?: (text: string) => void): Promise<ScanOutcome> {
		const files = newestFirst((await this.workspace.list()).filter((f) => maybeInvoice(f.path)));
		const considered = files.slice(0, this.limits.files);
		const fresh = considered.filter((f) => !this.entries.has(keyOf(f))).length;
		if (fresh >= 20) progress?.(`Leggo ${fresh} file di fatture…`);
		const started = performance.now();
		const left = () => this.limits.budgetMs - (performance.now() - started);
		let bytes = 0;
		let leftOut = files.length - considered.length;
		const unread: { path: string; why: string }[] = [];
		const read = await pool(considered, PARALLEL, async (file): Promise<FoundFattura | undefined> => {
			signal.throwIfAborted();
			const key = keyOf(file);
			let entry = this.entries.get(key);
			if (entry === undefined) {
				if (bytes + file.size > this.limits.bytes || left() <= 0) {
					leftOut++;
					return undefined;
				}
				bytes += file.size;
				entry = await this.readFile(file, left());
				if (entry === undefined) return undefined;
				this.keep(key, entry);
			} else {
				// Most recently used last.
				this.entries.delete(key);
				this.entries.set(key, entry);
			}
			if (entry.kind === "unread") unread.push({ path: file.path, why: entry.why });
			return entry.kind === "fattura" ? { path: file.path, modifiedAt: file.modifiedAt, fattura: entry.fattura } : undefined;
		});
		return { invoices: read.filter((f) => f !== undefined), candidates: files.length, unread, leftOut };
	}

	/** What the file is; undefined when it went away meanwhile or the worker could not read it now. */
	private async readFile(file: WorkspaceFile, left: number): Promise<Entry | undefined> {
		let data: Buffer;
		try {
			data = await this.workspace.read(file.path);
		} catch {
			return undefined;
		}
		// Telling an invoice costs a look at its start (16 KB, or 256 KB of a signed envelope), on this thread.
		if (documentKind(file.path, data) !== "fattura") return { kind: "other" };
		if (data.length > MAX_FATTURA_BYTES * 2) return { kind: "unread", why: "è troppo grande da leggere" };
		try {
			return { kind: "fattura", fattura: await this.read(file.path, data, { waitMs: WORKER_WAIT_MS, timeoutMs: Math.max(1000, Math.min(DOCUMENT_READER_LIMITS.timeoutMs, left)) }) };
		} catch (error) {
			if (!(error instanceof DocumentError)) throw error;
			if (isTransient(error)) return undefined;
			return { kind: "unread", why: error.message };
		}
	}

	private keep(key: string, entry: Entry): void {
		this.entries.set(key, entry);
		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= this.maxEntries) break;
			this.entries.delete(oldest);
		}
	}
}

function keyOf(file: WorkspaceFile): string {
	return `${file.path}\u0000${file.size}\u0000${file.modifiedAt}`;
}

/** The owner's company, as the owner gave it: how the scadenzario tells what is to pay from what is to collect. */
export type Company = { readonly vat?: string; readonly name?: string; readonly by: string; readonly at: string };

/** An invoice, or one instalment of it (from 1), said paid; for a credit note, used. */
export type PaidMark = { readonly invoice: string; readonly instalment?: number; readonly by: string; readonly at: string };

type Book = { readonly company?: Company; readonly paid: readonly PaidMark[] };

const EMPTY: Book = { paid: [] };

/** What is paid and the company of one instance, in `invoices.json`, changed under the shared file lock. */
export class InvoiceStore {
	private readonly file: string;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "invoices.json");
	}

	company(): Company | undefined {
		return readJsonFile<Book>(this.file, EMPTY).company;
	}

	paid(): readonly PaidMark[] {
		return readJsonFile<Book>(this.file, EMPTY).paid;
	}

	/** Set the company (undefined clears it). */
	setCompany(company: Company | undefined): void {
		updateJsonFile<Book>(this.file, EMPTY, (book) => {
			const { company: _old, ...rest } = book;
			return company === undefined ? rest : { ...rest, company };
		});
	}

	/**
	 * Mark `invoice`, which has `count` instalments (1 when it has none), paid or not: one
	 * instalment, or all of it. How many instalments changed, and the marks there were before.
	 */
	mark(input: { invoice: string; count: number; instalment?: number; paid: boolean; by: string; at: string }): { changed: number; before: readonly PaidMark[] } {
		const { invoice, count } = input;
		let result: { changed: number; before: readonly PaidMark[] } = { changed: 0, before: [] };
		updateJsonFile<Book>(this.file, EMPTY, (book) => {
			const mine = book.paid.filter((m) => m.invoice === invoice);
			const others = book.paid.filter((m) => m.invoice !== invoice);
			const was = paidInstalments(mine, count);
			const now = new Set(was);
			const targets = input.instalment === undefined ? Array.from({ length: count }, (_, i) => i + 1) : [input.instalment];
			for (const n of targets) {
				if (input.paid) now.add(n);
				else now.delete(n);
			}
			const changed = targets.filter((n) => was.has(n) !== now.has(n)).length;
			result = { changed, before: mine };
			if (changed === 0) return book;
			const whole = mine.find((m) => m.instalment === undefined);
			const made = { by: input.by, at: input.at };
			// The whole invoice is one mark; instalments one mark each, keeping who marked them and when.
			const marks: PaidMark[] =
				input.instalment === undefined
					? input.paid
						? [whole ?? { invoice, ...made }]
						: []
					: [...now].sort((a, b) => a - b).map((n) => mine.find((m) => m.instalment === n) ?? { invoice, instalment: n, ...(whole === undefined || !was.has(n) ? made : { by: whole.by, at: whole.at }) });
			return { ...book, paid: [...others, ...marks].slice(-INVOICE_LIMITS.marks) };
		});
		return result;
	}
}

/** Which instalments (from 1) the marks say paid. */
export function paidInstalments(marks: readonly PaidMark[], count: number): Set<number> {
	if (marks.some((m) => m.instalment === undefined)) return new Set(Array.from({ length: count }, (_, i) => i + 1));
	return new Set(marks.map((m) => m.instalment).filter((n): n is number => n !== undefined && n >= 1 && n <= count));
}

/**
 * A partita IVA as the owner may write it: spaces and dots out, capitals; an Italian one is 11
 * digits with or without IT and must pass the check digit; a foreign one keeps its country.
 * InvoiceError otherwise.
 */
export function companyVat(text: string): string {
	const clean = text.replace(/[\s.-]+/g, "").toUpperCase();
	const italian = /^(?:IT)?(\d{11})$/.exec(clean);
	if (italian !== null) {
		const problem = partitaIvaProblem(italian[1] as string);
		if (problem !== undefined) throw new InvoiceError(`la partita IVA ${italian[1]} non è valida: ${problem}`);
		return `IT${italian[1]}`;
	}
	if (/^[A-Z]{2}(?=[A-Z0-9]*\d)[A-Z0-9]{2,13}$/.test(clean)) return clean;
	throw new InvoiceError("scrivi la partita IVA come 11 cifre (o IT e 11 cifre), o con il prefisso del paese se è estera");
}

/** «IT02987650013», with Italy assumed when the country is missing. */
export function vatOf(party: FatturaParty): string | undefined {
	return party.vat === undefined ? undefined : `${(party.vat.country ?? "IT").toUpperCase()}${party.vat.code.toUpperCase()}`;
}

/** A company's name without case, accents, punctuation and its legal form: «Alfa Forniture S.r.l.» is «alfa forniture». */
export function nameKey(name: string): string {
	return fold(name)
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\b(?:s ?r ?l ?s?|s ?p ?a|s ?n ?c|s ?a ?s|s ?a ?p ?a|soc(?:ieta)? coop(?:erativa)?|coop|unipersonale|in liquidazione)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Who a party is, to group and match invoices: the partita IVA, else the codice fiscale, else the name. */
export function partyKey(party: FatturaParty): string {
	return vatOf(party) ?? (party.fiscal === undefined ? `nome:${nameKey(party.name ?? "")}` : `cf:${party.fiscal.toUpperCase()}`);
}

/** Whether `party` is the company: by partita IVA (or codice fiscale with the same digits) when the company has one, else by name. */
function isCompany(party: FatturaParty, company: Company): boolean {
	if (company.vat !== undefined) {
		const vat = vatOf(party);
		if (vat !== undefined) return vat === company.vat;
		const digits = company.vat.slice(2);
		if (party.fiscal !== undefined && party.fiscal === digits) return true;
		if (company.name === undefined) return false;
	}
	return company.name !== undefined && party.name !== undefined && nameKey(party.name) !== "" && nameKey(party.name) === nameKey(company.name);
}

/** passive: the company is the customer, the invoice is to pay; active: it is the supplier, to collect; undefined: not known. */
export type Side = "passive" | "active";

export function sideOf(fattura: Fattura, company: Company | undefined): Side | undefined {
	if (company === undefined) return undefined;
	const supplier = isCompany(fattura.supplier, company);
	const customer = isCompany(fattura.customer, company);
	if (supplier === customer) return undefined; // neither, or an autofattura
	return supplier ? "active" : "passive";
}

/** One instalment of an invoice in the register: its amount in hundred-millionths when it reads, its due date when it is a real day. */
export type Instalment = {
	/** From 1. */
	readonly n: number;
	readonly amount?: bigint;
	/** As written, when it reads as no amount. */
	readonly amountText?: string;
	readonly due?: string;
	/** As written, when it is not a real day. */
	readonly dueText?: string;
	readonly method?: string;
	readonly iban?: string;
	readonly paid?: PaidMark;
};

/** One document of an invoice file, as the register sees it. */
export type Invoice = {
	/** The same invoice in two files (the XML and its .p7m) has the same key: the supplier, the number, the date. */
	readonly key: string;
	readonly path: string;
	readonly modifiedAt: string;
	readonly supplier: FatturaParty;
	readonly customer: FatturaParty;
	readonly doc: FatturaDocument;
	readonly side?: Side;
	/** The instalments; an invoice without any has one, its whole amount, without a due date. */
	readonly instalments: readonly Instalment[];
	/** Every instalment paid. */
	readonly paid: boolean;
};

/** The register: every document of the files found, the same invoice once (the newest file), newest invoice first. */
export function register(found: readonly FoundFattura[], paid: readonly PaidMark[], company: Company | undefined): Invoice[] {
	const marks = new Map<string, PaidMark[]>();
	for (const m of paid) marks.set(m.invoice, [...(marks.get(m.invoice) ?? []), m]);
	const seen = new Set<string>();
	const out: Invoice[] = [];
	const newest = [...found].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
	for (const { path, modifiedAt, fattura } of newest) {
		const side = sideOf(fattura, company);
		for (const doc of fattura.documents) {
			const key = invoiceKey(fattura.supplier, doc);
			if (seen.has(key)) continue;
			seen.add(key);
			const mine = marks.get(key) ?? [];
			const whole = owedText(doc);
			const raw: readonly FatturaInstalment[] = doc.instalments.length > 0 ? doc.instalments : [whole === undefined ? {} : { amount: whole }];
			const paidSet = paidInstalments(mine, raw.length);
			const wholeMark = mine.find((m) => m.instalment === undefined);
			const instalments = raw.map((r, i): Instalment => {
				const units = r.amount === undefined ? undefined : toUnits(r.amount);
				const mark = paidSet.has(i + 1) ? (mine.find((m) => m.instalment === i + 1) ?? wholeMark) : undefined;
				return {
					n: i + 1,
					// A credit note may write its amounts negative: what it is worth is the same.
					...(units === undefined ? (r.amount === undefined ? {} : { amountText: r.amount }) : { amount: units < 0n ? -units : units }),
					...(r.due === undefined ? {} : realDate(r.due) ? { due: r.due } : { dueText: r.due }),
					...(r.method === undefined ? {} : { method: r.method }),
					...(r.iban === undefined ? {} : { iban: r.iban }),
					...(mark === undefined ? {} : { paid: mark }),
				};
			});
			out.push({ key, path, modifiedAt, supplier: fattura.supplier, customer: fattura.customer, doc, ...(side === undefined ? {} : { side }), instalments, paid: paidSet.size === raw.length });
		}
	}
	return out.sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? "") || b.modifiedAt.localeCompare(a.modifiedAt));
}

/** What a document asks for as a whole: the instalments' sum, else its total. */
function owedText(doc: FatturaDocument): string | undefined {
	return doc.toPay ?? doc.total;
}

export function invoiceKey(supplier: FatturaParty, doc: FatturaDocument): string {
	return `${partyKey(supplier)}|${fold(doc.number ?? "").replace(/\s+/g, "")}|${doc.date ?? ""}|${doc.type ?? ""}`;
}

/** Sums by currency, exact. */
export type Sums = Map<string, bigint>;

export function addTo(sums: Sums, currency: string, units: bigint): void {
	sums.set(currency, (sums.get(currency) ?? 0n) + units);
}

/** The open (not paid) amount of an invoice, in its currency: what is still to pay or collect. */
export function openAmount(invoice: Invoice): bigint {
	return invoice.instalments.reduce((n, i) => (i.paid === undefined && i.amount !== undefined ? n + i.amount : n), 0n);
}

export function paidAmount(invoice: Invoice): bigint {
	return invoice.instalments.reduce((n, i) => (i.paid !== undefined && i.amount !== undefined ? n + i.amount : n), 0n);
}
