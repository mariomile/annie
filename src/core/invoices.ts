/**
 * The scadenzario: the electronic invoices found in an instance's workspace (invoice-scan.ts),
 * their instalments and which are paid. Whether an invoice is to pay or to collect depends on
 * which side the owner's company is: its partita IVA (or name), when set, says so; otherwise
 * neither is said. What is paid is not in the files: the owner says it, and it is kept in
 * `invoices.json`, with who said it and when.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FatturaDocument, type FatturaInstalment, type FatturaParty, toUnits } from "./fattura-pa.ts";
import type { FoundFattura } from "./invoice-scan.ts";
import { realDate } from "./italian-calendar.ts";
import { updateJsonFile } from "./locked-json.ts";
import { checkVatNumber } from "./tax-ids.ts";
import { fold } from "./text-match.ts";

export const INVOICE_LIMITS = {
	/** Invoices with a paid mark: past it, no new one (the others' marks are never dropped). */
	marks: 5000,
	/** Instalments an invoice may have marked one by one. */
	instalments: 100,
	/** A company name as set by the owner. */
	name: 120,
} as const;

/** The scadenzario's ops that only read: they run in a brief's thread too (brief.ts); the others write. */
export const INVOICE_READ_OPS = ["due", "by_party", "list"] as const;
export type InvoiceReadOp = (typeof INVOICE_READ_OPS)[number];

export function isInvoiceReadOp(op: unknown): op is InvoiceReadOp {
	return INVOICE_READ_OPS.some((o) => o === op);
}

/** Whether a call only reads: a reading op, or set_company with nothing to set (it shows the company). */
export function invoiceCallReads(args: Record<string, unknown>): boolean {
	if (isInvoiceReadOp(args.op)) return true;
	return args.op === "set_company" && args.vat === undefined && args.name === undefined && args.clear === undefined;
}

export class InvoiceError extends Error {
	override readonly name = "InvoiceError";
}

/** Who did something, and when (ISO). */
export type Marker = { readonly by: string; readonly at: string };

/** The owner's company, as the owner gave it: how the scadenzario tells what is to pay from what is to collect. */
export type Company = Marker & { readonly vat?: string; readonly name?: string };

/**
 * What is paid of one invoice: all of it (`all`) but the instalments in `except`, or the
 * instalments marked one by one. For a credit note, paid means used.
 */
export type PaidEntry = { readonly invoice: string; readonly all?: Marker; readonly except?: readonly number[]; readonly instalments?: readonly (Marker & { readonly n: number })[] };

type Book = { readonly company?: Company; readonly paid: readonly PaidEntry[] };

/** What the store says; `broken` when invoices.json does not read: then nothing is paid, and nothing is written. */
export type BookState = { readonly company?: Company; readonly paid: readonly PaidEntry[]; readonly broken: boolean };

const BROKEN_WRITE = "lo stato delle fatture pagate (invoices.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

/** What is paid and the company of one instance, in `invoices.json`, changed under the shared file lock, with a .bak of the file before each change. */
export class InvoiceStore {
	private readonly file: string;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "invoices.json");
	}

	/** Never throws: a file that does not read is said `broken`. */
	read(): BookState {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paid: [], broken: false };
			return { paid: [], broken: true };
		}
		const book = bookOf(text);
		return book === undefined ? { paid: [], broken: true } : { ...book, broken: false };
	}

	/** Set the company (undefined clears it). */
	setCompany(company: Company | undefined): void {
		this.update((book) => {
			const { company: _old, ...rest } = book;
			return company === undefined ? rest : { ...rest, company };
		});
	}

	/**
	 * Mark `invoice`, which has `count` instalments (1 when it has none), paid or not: one
	 * instalment, or all of it. How many instalments changed, and the entry there was before.
	 * InvoiceError when the store is full or does not read.
	 */
	mark(input: { invoice: string; count: number; instalment?: number; paid: boolean } & Marker): { changed: number; before?: PaidEntry } {
		const { invoice, count, instalment } = input;
		let result: { changed: number; before?: PaidEntry } = { changed: 0 };
		this.update((book) => {
			const before = book.paid.find((e) => e.invoice === invoice);
			const was = paidSet(before, count);
			const targets = instalment === undefined ? range(count) : [instalment];
			const changed = targets.filter((n) => was.has(n) !== input.paid).length;
			result = { changed, ...(before === undefined ? {} : { before }) };
			if (changed === 0) return book;
			const made: Marker = { by: input.by, at: input.at };
			const next = nextEntry(before, { invoice, count, ...(instalment === undefined ? {} : { instalment }), paid: input.paid, made });
			if (before === undefined && book.paid.length >= INVOICE_LIMITS.marks) {
				throw new InvoiceError(`ci sono già ${INVOICE_LIMITS.marks} fatture segnate pagate, il massimo: non ne segno altre. Togli il segno a quelle vecchie con op mark_unpaid`);
			}
			const others = book.paid.filter((e) => e.invoice !== invoice);
			return { ...book, paid: next === undefined ? others : [...others, next] };
		});
		return result;
	}

	private update(change: (book: Book) => Book): void {
		if (this.read().broken) throw new InvoiceError(BROKEN_WRITE);
		try {
			updateJsonFile<unknown>(this.file, { paid: [] }, (raw) => {
				const book = validBook(raw);
				if (book === undefined) throw new InvoiceError(BROKEN_WRITE);
				const next = change(book);
				if (next !== book && existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
				return next === book ? raw : next;
			});
		} catch (error) {
			// Changed into something unreadable meanwhile.
			if (error instanceof SyntaxError) throw new InvoiceError(BROKEN_WRITE);
			throw error;
		}
	}
}

/** The entry after a change; undefined when nothing stays paid. */
function nextEntry(before: PaidEntry | undefined, change: { invoice: string; count: number; instalment?: number; paid: boolean; made: Marker }): PaidEntry | undefined {
	const { invoice, count, instalment, paid, made } = change;
	if (instalment === undefined) return paid ? { invoice, all: before?.all ?? made } : undefined;
	if (before?.all !== undefined) {
		const except = new Set(before.except ?? []);
		if (paid) except.delete(instalment);
		else except.add(instalment);
		if (except.size >= count) return undefined;
		return { invoice, all: before.all, ...(except.size === 0 ? {} : { except: [...except].sort((a, b) => a - b) }) };
	}
	const one = (before?.instalments ?? []).filter((m) => m.n !== instalment);
	const instalments = paid ? [...one, { n: instalment, ...made }].sort((a, b) => a.n - b.n) : one;
	if (instalments.length > INVOICE_LIMITS.instalments) throw new InvoiceError(`si possono segnare al più ${INVOICE_LIMITS.instalments} rate di una fattura`);
	return instalments.length === 0 ? undefined : { invoice, instalments };
}

function range(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i + 1);
}

/** Which instalments (from 1) an entry says paid. */
export function paidSet(entry: PaidEntry | undefined, count: number): Set<number> {
	if (entry === undefined) return new Set();
	if (entry.all !== undefined) {
		const except = new Set(entry.except ?? []);
		return new Set(range(count).filter((n) => !except.has(n)));
	}
	return new Set((entry.instalments ?? []).map((m) => m.n).filter((n) => n >= 1 && n <= count));
}

/** Who marked instalment `n` paid, and when. */
function markerOf(entry: PaidEntry | undefined, n: number): Marker | undefined {
	if (entry?.all !== undefined) return entry.all;
	const one = entry?.instalments?.find((m) => m.n === n);
	return one === undefined ? undefined : { by: one.by, at: one.at };
}

function bookOf(text: string): Book | undefined {
	try {
		return validBook(JSON.parse(text));
	} catch {
		return undefined;
	}
}

const isText = (v: unknown): v is string => typeof v === "string";
const isMarker = (v: unknown): v is Marker => typeof v === "object" && v !== null && isText((v as Marker).by) && isText((v as Marker).at);
const isN = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000;

/** The book when the JSON has its shape; undefined otherwise. */
function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Book).paid)) return undefined;
	const { company, paid } = raw as Book;
	if (company !== undefined && !(isMarker(company) && (company.vat === undefined || isText(company.vat)) && (company.name === undefined || isText(company.name)))) return undefined;
	const entries = paid.every(
		(e) =>
			typeof e === "object" &&
			e !== null &&
			isText(e.invoice) &&
			(e.all === undefined || isMarker(e.all)) &&
			(e.except === undefined || (Array.isArray(e.except) && e.except.every(isN))) &&
			(e.instalments === undefined || (Array.isArray(e.instalments) && e.instalments.every((m: unknown) => isMarker(m) && isN((m as { n?: unknown }).n)))),
	);
	return entries ? (raw as Book) : undefined;
}

/**
 * A partita IVA as the owner may write it, with or without a label («P.IVA 03311220036»), checked
 * on paper (tax-ids.ts): «IT» and the 11 digits for an Italian one (a body's numeric codice
 * fiscale too), the prefix and the number for a foreign one. InvoiceError otherwise.
 */
export function companyVat(text: string): string {
	const checked = checkVatNumber(text);
	if (checked === undefined) throw new InvoiceError("questo sembra un codice fiscale di una persona, non una partita IVA: dammi la partita IVA dell'azienda, o il suo nome");
	if ("problem" in checked) throw new InvoiceError(`la partita IVA non va: ${checked.problem}`);
	return /^\d{11}$/.test(checked.number) ? `IT${checked.number}` : checked.number;
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

/** Who a party is, to group invoices by party: the partita IVA, else the codice fiscale, else the name without its legal form. */
export function partyKey(party: FatturaParty): string {
	return vatOf(party) ?? (party.fiscal === undefined ? `nome:${nameKey(party.name ?? "")}` : `cf:${party.fiscal.toUpperCase()}`);
}

/** Who a party is to tell two invoices apart: the tax ids, else the full name, legal form included; undefined without any. */
function partyIdentity(party: FatturaParty): string | undefined {
	const tax = vatOf(party) ?? (party.fiscal === undefined ? undefined : `cf:${party.fiscal.toUpperCase()}`);
	if (tax !== undefined) return tax;
	const name = fold(party.name ?? "").replace(/\s+/g, " ").trim();
	return name === "" ? undefined : `nome:${name}`;
}

/** What the person wrote about a party: a partita IVA or codice fiscale (its digits), or words that start words of the name. */
export function matchesParty(party: FatturaParty, query: string): boolean {
	const compact = query.replace(/[\s.-]+/g, "").toUpperCase();
	if (/^(?:[A-Z]{2})?\d{11}$/.test(compact) || /^[A-Z0-9]{16}$/.test(compact)) {
		const digits = compact.replace(/^[A-Z]{2}(?=\d{11}$)/, "");
		return party.vat?.code.toUpperCase() === digits || party.fiscal?.toUpperCase() === digits || vatOf(party) === compact;
	}
	const words = nameKey(query).split(" ").filter((w) => w !== "");
	if (words.length === 0 || party.name === undefined) return false;
	const name = nameKey(party.name).split(" ");
	return words.every((w) => name.some((n) => n.startsWith(w)));
}

/** Whether `party` is the company: by partita IVA (or a codice fiscale with its digits) when both have one, else by the words of the name. */
function isCompany(party: FatturaParty, company: Company): boolean {
	if (company.vat !== undefined) {
		const vat = vatOf(party);
		if (vat !== undefined) return vat === company.vat;
		if (party.fiscal !== undefined && party.fiscal === company.vat.slice(2)) return true;
		if (company.name === undefined) return false;
	}
	return company.name !== undefined && matchesParty(party, company.name);
}

/** passive: the company is the customer, the invoice is to pay; active: it is the supplier, to collect. */
export type Side = "passive" | "active";

function sideOf(supplier: FatturaParty, customer: FatturaParty, company: Company | undefined): Side | undefined {
	if (company === undefined) return undefined;
	const isSupplier = isCompany(supplier, company);
	const isCustomer = isCompany(customer, company);
	if (isSupplier === isCustomer) return undefined; // neither, or an autofattura
	return isSupplier ? "active" : "passive";
}

/** One instalment of an invoice in the register. */
export type Instalment = {
	/** From 1, among the instalments kept (alternatives written twice count once). */
	readonly n: number;
	/** What counts toward the invoice, in hundred-millionths, when the amount reads. */
	readonly amount?: bigint;
	/** As written, when it reads as no amount. */
	readonly amountText?: string;
	/** A real day; `dueText` when the invoice writes one that is not. */
	readonly due?: string;
	readonly dueText?: string;
	readonly method?: string;
	readonly iban?: string;
	readonly paid?: Marker;
	/** Past the document's total: not counted (see `mismatch`). */
	readonly extra?: boolean;
};

/** One document of an invoice file, as the register sees it. */
export type Invoice = {
	/** The same invoice in two files (the XML and its .p7m) has the same key. */
	readonly key: string;
	/** The newest file holding it, and every file that does. */
	readonly path: string;
	readonly paths: readonly string[];
	readonly modifiedAt: string;
	readonly supplier: FatturaParty;
	readonly customer: FatturaParty;
	readonly doc: FatturaDocument;
	readonly side?: Side;
	/** A credit note, or a document with a negative total, which works as one. */
	readonly credit: boolean;
	/** Negative total on a document that is not a credit note: counted as a credit, and said. */
	readonly negative: boolean;
	/** The instalments add up to more than the total even without repeated alternatives: counted up to the total. */
	readonly mismatch: boolean;
	/** The instalments; an invoice without any has one, its whole amount, without a due date. */
	readonly instalments: readonly Instalment[];
	/** Every instalment paid (or the credit note used). */
	readonly paid: boolean;
};

/** The register: every document of the files found, the same invoice once (the newest file), newest invoice first. */
export function register(found: readonly FoundFattura[], paid: readonly PaidEntry[], company: Company | undefined): Invoice[] {
	const entries = new Map(paid.map((e) => [e.invoice, e]));
	const byKey = new Map<string, Invoice>();
	const newest = [...found].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
	for (const { path, modifiedAt, fattura } of newest) {
		const side = sideOf(fattura.supplier, fattura.customer, company);
		for (const doc of fattura.documents) {
			const key = invoiceKey(fattura.supplier, fattura.customer, doc, path);
			const seen = byKey.get(key);
			if (seen !== undefined) {
				byKey.set(key, { ...seen, paths: [...seen.paths, path] });
				continue;
			}
			const total = doc.total === undefined ? undefined : toUnits(doc.total);
			const negative = !doc.credit && total !== undefined && total < 0n;
			const counted = countedInstalments(doc, total);
			const entry = entries.get(key);
			const done = paidSet(entry, counted.list.length);
			const instalments = counted.list.map((i): Instalment => {
				const marker = done.has(i.n) ? markerOf(entry, i.n) : undefined;
				return marker === undefined ? i : { ...i, paid: marker };
			});
			byKey.set(key, {
				key,
				path,
				paths: [path],
				modifiedAt,
				supplier: fattura.supplier,
				customer: fattura.customer,
				doc,
				...(side === undefined ? {} : { side }),
				credit: doc.credit || negative,
				negative,
				mismatch: counted.mismatch,
				instalments,
				paid: done.size === counted.list.length,
			});
		}
	}
	return [...byKey.values()].sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? "") || b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * The instalments that count. A credit note or a negative document counts what it is worth, the
 * sign aside. When the instalments add up to more than the total, the ones that repeat the same
 * date and amount are alternatives (two IBANs, two ways to pay): one each is kept. If they still
 * add up to more, they are counted in order up to the total, and the invoice is flagged.
 */
function countedInstalments(doc: FatturaDocument, total: bigint | undefined): { list: Instalment[]; mismatch: boolean } {
	const whole = doc.toPay ?? doc.total;
	const raw: readonly FatturaInstalment[] = doc.instalments.length > 0 ? doc.instalments : [whole === undefined ? {} : { amount: whole }];
	const flip = doc.credit || (total !== undefined && total < 0n);
	const units = (r: FatturaInstalment) => {
		const u = r.amount === undefined ? undefined : toUnits(r.amount);
		return u !== undefined && flip && u < 0n ? -u : u;
	};
	let kept = [...raw];
	const cap = total === undefined ? undefined : total < 0n ? -total : total;
	const sum = (list: readonly FatturaInstalment[]) => list.reduce<bigint | undefined>((n, r) => (n === undefined || units(r) === undefined ? undefined : n + (units(r) as bigint)), 0n);
	let mismatch = false;
	if (cap !== undefined && kept.length > 1 && (sum(kept) ?? 0n) > cap) {
		const seen = new Set<string>();
		kept = kept.filter((r) => {
			const key = `${r.due ?? ""}|${units(r) ?? r.amount ?? ""}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		mismatch = (sum(kept) ?? 0n) > cap;
	}
	let left = cap;
	const list = kept.map((r, i): Instalment => {
		let amount = units(r);
		let extra = false;
		if (mismatch && amount !== undefined && left !== undefined) {
			if (amount > left) amount = left;
			left -= amount;
			extra = amount === 0n;
		}
		return {
			n: i + 1,
			...(amount === undefined ? (r.amount === undefined ? {} : { amountText: r.amount }) : { amount }),
			...(r.due === undefined ? {} : realDate(r.due) ? { due: r.due } : { dueText: r.due }),
			...(r.method === undefined ? {} : { method: r.method }),
			...(r.iban === undefined ? {} : { iban: r.iban }),
			...(extra ? { extra } : {}),
		};
	});
	return { list, mismatch };
}

/**
 * The same invoice in any file: the supplier's tax id, the number, the date, the type. Without a
 * tax id the supplier's full name and the customer too; without any name, the file as well.
 */
export function invoiceKey(supplier: FatturaParty, customer: FatturaParty, doc: FatturaDocument, path: string): string {
	const what = `${fold(doc.number ?? "").replace(/\s+/g, "")}|${doc.date ?? ""}|${doc.type ?? ""}`;
	const tax = vatOf(supplier) ?? (supplier.fiscal === undefined ? undefined : `cf:${supplier.fiscal.toUpperCase()}`);
	if (tax !== undefined) return `${tax}|${what}`;
	const name = partyIdentity(supplier);
	const buyer = partyIdentity(customer) ?? "";
	return name === undefined ? `file:${path}|${buyer}|${what}` : `${name}|${buyer}|${what}`;
}

/** A workspace path however the person writes it: «./fatture\\a.xml» is «fatture/a.xml». */
export function normalPath(path: string): string {
	return path
		.trim()
		.replace(/\\/g, "/")
		.split("/")
		.filter((p) => p !== "" && p !== ".")
		.join("/");
}

/** The invoices `query` means: by file (any copy), number and party. A number matches as written, else by its last digits when only one does. */
export function findInvoices(invoices: readonly Invoice[], query: { readonly number?: string; readonly party?: string; readonly path?: string }): Invoice[] {
	const { number, party } = query;
	const path = query.path === undefined ? undefined : normalPath(query.path);
	const candidates = invoices.filter((i) => (path === undefined || i.paths.includes(path)) && (party === undefined || matchesParty(i.supplier, party) || matchesParty(i.customer, party)));
	if (number === undefined) return candidates;
	const same = candidates.filter((i) => sameNumber(i.doc.number, number));
	if (same.length > 0) return same;
	const digits = /^\D*?0*(\d+)$/.exec(number.trim())?.[1];
	if (digits === undefined) return [];
	const ending = candidates.filter((i) => /0*(\d+)\D*$/.exec(i.doc.number ?? "")?.[1] === digits);
	return ending.length === 1 ? ending : [];
}

/** The same invoice number however it is written: case, spaces. */
function sameNumber(number: string | undefined, asked: string): boolean {
	if (number === undefined) return false;
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
	return norm(number) === norm(asked);
}

/** Sums by currency, exact. */
export type Sums = Map<string, bigint>;

export function addTo(sums: Sums, currency: string, units: bigint): void {
	sums.set(currency, (sums.get(currency) ?? 0n) + units);
}

/** What is still open of an invoice (not paid, not past the total), in its currency. */
export function openAmount(invoice: Invoice): bigint {
	return invoice.instalments.reduce((n, i) => (i.paid === undefined && !i.extra && i.amount !== undefined ? n + i.amount : n), 0n);
}

export function paidAmount(invoice: Invoice): bigint {
	return invoice.instalments.reduce((n, i) => (i.paid !== undefined && !i.extra && i.amount !== undefined ? n + i.amount : n), 0n);
}
