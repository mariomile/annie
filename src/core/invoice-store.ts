/**
 * The scadenzario's own state, in `invoices.json` of an instance (outside the workspace): the
 * owner's company, what is paid, the payment reminders sent and the customers' addresses
 * (reminder-book.ts). Changed under the shared file lock; `invoices.json.bak` keeps the last state
 * written. Read never throws: a file that does not read is `broken` (everything open, nothing
 * written); reminders or addresses that do not read are left out and not written over, while the
 * paid marks still count.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validAddress } from "./google-actions.ts";
import { type Company, INVOICE_LIMITS, InvoiceError, instalmentRange, type Marker, type PaidEntry, paidSet } from "./invoices.ts";
import { updateJsonFile } from "./locked-json.ts";
import { type Contact, type ReminderEntry, type ReminderItem, ReminderLimit, type ReminderMade, validContacts, validReminders, withContact, withReminders } from "./reminder-book.ts";

/** As on disk: reminders and contacts are checked on their own, so a bad one never hides the paid marks. */
type Book = { readonly company?: Company; readonly paid: readonly PaidEntry[]; readonly reminders?: unknown; readonly contacts?: unknown };

/** What the store says. `broken`: invoices.json does not read, nothing is paid and nothing is written; `remindersBroken`, `contactsBroken`: that part does not read. */
export type BookState = {
	readonly company?: Company;
	readonly paid: readonly PaidEntry[];
	readonly reminders?: readonly ReminderEntry[];
	readonly contacts?: readonly Contact[];
	readonly broken: boolean;
	readonly remindersBroken?: true;
	readonly contactsBroken?: true;
};

export const BROKEN_WRITE = "lo stato delle fatture pagate (invoices.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";
export const REMINDERS_BROKEN = "i solleciti annotati in invoices.json non si leggono: non li cambio, perché andrebbero persi. Va sistemato il file nella cartella dell'agente";
const CONTACTS_BROKEN = "gli indirizzi dei clienti salvati in invoices.json non si leggono: non li cambio, perché andrebbero persi";

/** The company: a partita IVA or a name, its IBANs (at most 5) and a signature for the letters. */
export const COMPANY_LIMITS = { ibans: 5, signature: 300 } as const;

export class InvoiceStore {
	private readonly file: string;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "invoices.json");
	}

	/** Never throws. */
	read(): BookState {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paid: [], broken: false };
			return { paid: [], broken: true };
		}
		const book = bookOf(text);
		if (book === undefined) return { paid: [], broken: true };
		const { reminders, contacts, ...rest } = book;
		const remindersOk = validReminders(reminders);
		const contactsOk = validContacts(contacts, validAddress);
		return {
			...rest,
			...(remindersOk ? (reminders === undefined ? {} : { reminders: reminders as readonly ReminderEntry[] }) : { remindersBroken: true as const }),
			...(contactsOk ? (contacts === undefined ? {} : { contacts: contacts as readonly Contact[] }) : { contactsBroken: true as const }),
			broken: false,
		};
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
	 * instalment, or all of it. How many instalments changed, and the entry there was before. An
	 * invoice now paid in full has nothing left to remind: its reminders go. InvoiceError when the
	 * store is full or does not read.
	 */
	mark(input: { invoice: string; count: number; instalment?: number; paid: boolean } & Marker): { changed: number; before?: PaidEntry } {
		const { invoice, count, instalment } = input;
		let result: { changed: number; before?: PaidEntry } = { changed: 0 };
		this.update((book) => {
			const before = book.paid.find((e) => e.invoice === invoice);
			const was = paidSet(before, count);
			const targets = instalment === undefined ? instalmentRange(count) : [instalment];
			const changed = targets.filter((n) => was.has(n) !== input.paid).length;
			result = { changed, ...(before === undefined ? {} : { before }) };
			if (changed === 0) return book;
			const made: Marker = { by: input.by, at: input.at };
			const next = nextEntry(before, { invoice, count, ...(instalment === undefined ? {} : { instalment }), paid: input.paid, made });
			if (before === undefined && book.paid.length >= INVOICE_LIMITS.marks) {
				throw new InvoiceError(`ci sono già ${INVOICE_LIMITS.marks} fatture segnate pagate, il massimo: non ne segno altre. Togli il segno a quelle vecchie con op mark_unpaid`);
			}
			const others = book.paid.filter((e) => e.invoice !== invoice);
			const paidNow = next !== undefined && paidSet(next, count).size === count;
			const sent = validReminders(book.reminders) ? ((book.reminders as readonly ReminderEntry[] | undefined) ?? []) : [];
			const reminders = paidNow && sent.some((e) => e.invoice === invoice) ? { reminders: sent.filter((e) => e.invoice !== invoice) } : {};
			return { ...book, paid: next === undefined ? others : [...others, next], ...reminders };
		});
		return result;
	}

	/**
	 * Record payment reminders: how many were recorded (reminder-book.ts says which are not
	 * recorded twice). InvoiceError when the store is full or does not read.
	 */
	remind(items: readonly ReminderItem[], made: ReminderMade): number {
		let recorded = 0;
		this.update((book) => {
			if (!validReminders(book.reminders)) throw new InvoiceError(REMINDERS_BROKEN);
			const next = limited(() => withReminders((book.reminders as readonly ReminderEntry[] | undefined) ?? [], items, made));
			recorded = next.recorded;
			return recorded === 0 ? book : { ...book, reminders: next.entries };
		});
		return recorded;
	}

	/** Save a customer's address the person gave, over the old one. InvoiceError when the book is full or does not read. */
	saveContact(contact: Contact): void {
		if (!validAddress(contact.email)) throw new InvoiceError("indirizzo non valido");
		this.update((book) => {
			if (!validContacts(book.contacts, validAddress)) throw new InvoiceError(CONTACTS_BROKEN);
			const contacts = (book.contacts as readonly Contact[] | undefined) ?? [];
			if (contacts.find((c) => c.key === contact.key)?.email === contact.email) return book;
			return { ...book, contacts: limited(() => withContact(contacts, contact)) };
		});
	}

	/** The change under the lock; then a copy of what was written, the last good state, in invoices.json.bak. */
	private update(change: (book: Book) => Book): void {
		if (this.read().broken) throw new InvoiceError(BROKEN_WRITE);
		let changed = false;
		try {
			updateJsonFile<unknown>(this.file, { paid: [] }, (raw) => {
				const book = validBook(raw);
				if (book === undefined) throw new InvoiceError(BROKEN_WRITE);
				const next = change(book);
				changed = next !== book;
				return changed ? next : raw;
			});
		} catch (error) {
			// Changed into something unreadable meanwhile.
			if (error instanceof SyntaxError) throw new InvoiceError(BROKEN_WRITE);
			throw error;
		}
		if (changed && existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
	}
}

function limited<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof ReminderLimit) throw new InvoiceError(error.message);
		throw error;
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

function validCompany(company: unknown): boolean {
	if (company === undefined) return true;
	if (!isMarker(company)) return false;
	const c = company as Company;
	if ((c.vat !== undefined && !isText(c.vat)) || (c.name !== undefined && !isText(c.name))) return false;
	if (c.ibans !== undefined && !(Array.isArray(c.ibans) && c.ibans.length <= COMPANY_LIMITS.ibans && c.ibans.every((i) => isText(i) && i.length <= 34))) return false;
	return c.signature === undefined || (isText(c.signature) && c.signature.length <= COMPANY_LIMITS.signature);
}

/** The book when the JSON has its shape; undefined otherwise. Reminders and contacts are checked when used. */
function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Book).paid)) return undefined;
	const { company, paid } = raw as Book;
	if (!validCompany(company)) return undefined;
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
