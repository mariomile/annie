/**
 * The scadenzario read for a tool that only reads it: the paid marks and the company from its
 * store, the invoices from the shared scanner, and the two things a tool says when they are
 * missing (the state of the invoices does not read; the company is not known, so issued and
 * received cannot be told apart), each tool in its own words.
 */
import type { InvoiceScanner } from "./invoice-scan.ts";
import type { BookState, InvoiceStore } from "./invoice-store.ts";
import { type Invoice, register } from "./invoices.ts";

export type RegisterRead = {
	readonly book: BookState;
	/** The register; undefined when the state of the invoices does not read. */
	readonly invoices?: Invoice[];
	/** Files that may be invoices and do not read. */
	readonly unread: number;
	/** There are invoices but no company: issued and received are not told apart. */
	readonly noCompany: boolean;
	/** The tool's words for what is missing, when it gave them. */
	readonly notes: string[];
};

/** Reads the scadenzario once; never writes. */
export async function readRegister(
	store: Pick<InvoiceStore, "read">,
	scanner: InvoiceScanner,
	ctx: { readonly signal: AbortSignal; progress(text: string): void },
	words: { readonly broken?: string; readonly noCompany?: string } = {},
): Promise<RegisterRead> {
	const book = store.read();
	const notes: string[] = [];
	if (book.broken) {
		if (words.broken !== undefined) notes.push(words.broken);
		return { book, unread: 0, noCompany: false, notes };
	}
	const scan = await scanner.scan(ctx.signal, (t) => ctx.progress(t));
	const invoices = register(scan.invoices, book.paid, book.company, book.reminders);
	const noCompany = book.company === undefined && invoices.length > 0;
	if (noCompany && words.noCompany !== undefined) notes.push(words.noCompany);
	return { book, invoices, unread: scan.unread.length, noCompany, notes };
}
