/**
 * Who a supplier is, shared by the suppliers and the budgets: every supplier read from the cards
 * and the registers the suppliers' way (the invoices received with the payments the bank
 * statement confirmed, the expenses, the renewals) with their ledger, and a supplier found from
 * the words said (the clients' rule, client-find.ts, with the suppliers' ids), and what to ask
 * when the words fit none or more than one; and the line on payments that may be an expense too.
 */
import type { BankBook } from "./bank-store.ts";
import { findNamed } from "./client-find.ts";
import { n1 } from "./format-words.ts";
import type { Expense } from "./expenses.ts";
import type { Invoice } from "./invoices.ts";
import type { RenewalBook } from "./renewal-store.ts";
import { type Ledger, ledgerOf, type Supplier, suppliersOf, withBankPaid } from "./supplier-sums.ts";
import { SUPPLIER_ID_SAID, SUPPLIER_LIMITS, type SupplierCard } from "./suppliers.ts";

export type SupplierFound = { readonly kind: "exact"; readonly supplier: Supplier; readonly respelled: boolean; readonly form?: true } | { readonly kind: "close"; readonly candidates: readonly Supplier[] } | { readonly kind: "none" };

/** The clients' rule (client-find.ts) with the suppliers' ids: id, partita IVA or codice fiscale, then the name. */
export function findSupplier(suppliers: readonly Supplier[], said: string): SupplierFound {
	const r = findNamed(
		suppliers.map((s) => ({ item: s, names: [s.name, ...s.names], ...(s.vat === undefined ? {} : { vat: s.vat }), ...(s.cf === undefined ? {} : { cf: s.cf }), ids: s.card === undefined ? [] : [s.card.id] })),
		said,
		SUPPLIER_LIMITS.name,
		SUPPLIER_ID_SAID,
	);
	if (r.kind === "exact") return { kind: "exact", supplier: r.item, respelled: r.respelled, ...(r.form === true ? { form: true as const } : {}) };
	return r.kind === "close" ? { kind: "close", candidates: r.candidates } : r;
}

/** «Intendi …?»: the close ones in the fence (the caller's), to be asked. */
export function meantSupplier(candidates: readonly Supplier[], fence: (text: string) => string, more = ""): string {
	return [
		candidates.length === 1 ? "Intendi questo fornitore? Nessuno si chiama esattamente così, ma questo ha un nome simile:" : "Intendi uno di questi? Nessun fornitore si chiama esattamente così; quelli con un nome simile sono:",
		fence(candidates.map((c) => `• ${c.name}${c.vat === undefined ? "" : ` (partita IVA ${c.vat})`}`).join("\n")),
		`Chiedi a chi ti scrive ${candidates.length === 1 ? "se è lui" : "quale"}, e ripeti con il nome scritto come qui o con la partita IVA.${more}`,
	].join("\n");
}

/** A name that fits no supplier: the words said in the fence, and (`ask`) what to ask. */
export function supplierNotFound(said: string, fence: (text: string) => string, ask = true): string {
	return ["Non trovo questo fornitore tra schede, fatture ricevute, spese e rinnovi:", fence(said), ...(ask ? ["Chiedi a chi ti scrive come si chiama nelle fatture, o la partita IVA."] : [])].join("\n");
}

export type SupplierSources = {
	readonly cards: readonly SupplierCard[];
	/** The register (invoices.ts register) as read: the bank's confirmations are added here. */
	readonly invoices: readonly Invoice[];
	readonly expenses: readonly Expense[];
	readonly renewals?: RenewalBook;
	readonly bank?: BankBook;
	readonly dayOf: (at: string) => string;
};

/** Every supplier and its ledger, the suppliers' way; what does not read is said in `notes`, never guessed. */
export function loadSuppliers(r: SupplierSources): { suppliers: Supplier[]; ledger: Ledger; notes: string[] } {
	const notes: string[] = [];
	if (r.renewals?.broken === true) notes.push("L'elenco dei rinnovi non si legge: gli abbonamenti qui non ci sono.");
	if (r.bank?.broken === true) notes.push("I dati dell'estratto conto non si leggono: i pagamenti confermati dalla banca qui non ci sono.");
	const paid = withBankPaid(r.invoices, r.bank === undefined || r.bank.broken ? undefined : r.bank);
	const suppliers = suppliersOf({ cards: r.cards, invoices: paid, expenses: r.expenses, renewals: r.renewals === undefined || r.renewals.broken ? [] : r.renewals.renewals });
	return { suppliers, ledger: ledgerOf(paid, r.expenses, r.dayOf), notes };
}

/** Payments of supplier invoices that may be an expense too: both counted, said (the suppliers' and the budgets' words, these with the budgets they are in). */
export const twinsLine = (n: number, where: readonly string[] = []) =>
	`${n1(n, "Un pagamento di fattura potrebbe", "# pagamenti di fatture potrebbero")} essere anche una spesa registrata${where.length === 0 ? "" : ` (${where.join(", ")})`}: ${n === 1 ? "l'ho contato" : "li ho contati"} una volta come fattura e una come spesa. Controlla se sono gli stessi soldi.`;
