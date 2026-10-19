/**
 * The prices paid, read once for a tool that only reads them (purchase_prices, margins): the
 * invoices received through the shared scanner, each supplier the suppliers' way (the cards, the
 * expenses), the rows (purchase-prices.ts purchaseRows) and what is missing, said once in words:
 * files that do not read, lines left out or past those kept, invoices in another currency, without
 * lines, or with a date that is no real day.
 */
import type { ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { MAX_DOC_LINES } from "../fattura-pa.ts";
import { n1 } from "../format-words.ts";
import type { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { dayOfIn } from "../italian-calendar.ts";
import { type ExpenseRow, type PurchaseRow, purchaseRows } from "../purchase-prices.ts";
import { readRegister } from "../register-read.ts";
import { loadSuppliers } from "../supplier-find.ts";
import type { Supplier } from "../supplier-sums.ts";
import type { SupplierStore } from "../supplier-store.ts";

export type PurchaseSources = {
	readonly invoices: Pick<InvoiceStore, "read">;
	readonly scanner: InvoiceScanner;
	readonly expenses?: Pick<ExpenseStore, "read">;
	readonly suppliers?: Pick<SupplierStore, "read">;
	readonly timeZone: string;
};

export type PurchaseData = { readonly rows: readonly PurchaseRow[]; readonly expenses: readonly ExpenseRow[]; readonly suppliers: readonly Supplier[]; readonly notes: readonly string[] };

/** The prices paid with the notes, or what to say instead when there are none to read (the state does not read, the company is not known, no invoice). */
export async function loadPurchases(sources: PurchaseSources, ctx: Pick<ToolContext, "signal" | "progress">): Promise<PurchaseData | string> {
	const read = await readRegister(sources.invoices, sources.scanner, ctx, {
		broken: "Lo stato delle fatture non si legge: senza, non so quali sono le fatture ricevute.",
		noCompany: "Non so ancora qual è la tua azienda (la sua partita IVA): senza, non distinguo le fatture ricevute da quelle emesse, e i prezzi d'acquisto non li ho.",
	});
	if (read.invoices === undefined || read.noCompany) return read.notes.join("\n") || "Non trovo fatture ricevute nel workspace.";
	const cards = sources.suppliers?.read();
	const expenses = sources.expenses?.read();
	const loaded = loadSuppliers({ cards: cards === undefined || cards.broken ? [] : cards.cards, invoices: read.invoices, expenses: expenses === undefined || expenses.broken ? [] : expenses.expenses, dayOf: dayOfIn(sources.timeZone) });
	const got = purchaseRows(read.invoices, loaded.suppliers);
	const notes: string[] = [];
	if (read.unread > 0) notes.push(`${n1(read.unread, "Un file di fattura non si legge", "# file di fatture non si leggono")} (per esempio uno oltre i 20 MB, di cui leggo solo il testo): le sue righe qui mancano.`);
	if (got.unread > 0) notes.push(got.unread === 1 ? "Una riga di fattura non si legge (manca la descrizione, o un prezzo o una quantità non è un numero): l'ho lasciata fuori, senza indovinare." : `${got.unread} righe di fatture non si leggono (manca la descrizione, o un prezzo o una quantità non è un numero): le ho lasciate fuori, senza indovinare.`);
	if (got.cut > 0) notes.push(`${n1(got.cut, "Una riga", "# righe")} di fatture molto lunghe ${got.cut === 1 ? "è" : "sono"} oltre le prime ${MAX_DOC_LINES} di una fattura: qui ${got.cut === 1 ? "manca" : "mancano"}.`);
	if (got.otherCurrency > 0) notes.push(`${n1(got.otherCurrency, "Una fattura è", "# fatture sono")} in un'altra valuta: non la confronto con quelle in euro.`);
	if (got.noLines > 0) notes.push(`${n1(got.noLines, "Una fattura ricevuta non ha", "# fatture ricevute non hanno")} righe con prezzo e quantità (per esempio le fatture semplificate): qui non ${got.noLines === 1 ? "c'è" : "ci sono"}.`);
	if (got.badDates > 0) notes.push(`${n1(got.badDates, "Una fattura ricevuta ha", "# fatture ricevute hanno")} una data che non esiste o prima del 2000: ${got.badDates === 1 ? "l'ho lasciata" : "le ho lasciate"} fuori.`);
	return { rows: got.rows, expenses: got.expenses, suppliers: loaded.suppliers, notes };
}
