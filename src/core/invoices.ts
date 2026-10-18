/**
 * The scadenzario: the electronic invoices found in an instance's workspace (invoice-scan.ts),
 * their instalments and which are paid. Whether an invoice is to pay or to collect depends on
 * which side the owner's company is: its partita IVA (or name), when set, says so; otherwise
 * neither is said. What is paid is not in the files: the owner says it, and it is kept in
 * `invoices.json` (invoice-store.ts), with who said it and when.
 */
import { type FatturaDocument, type FatturaInstalment, type FatturaParty, fromUnits, toUnits } from "./fattura-pa.ts";
import type { FoundFattura } from "./invoice-scan.ts";
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { bookKey, type ReminderEntry, type ReminderMark } from "./reminder-book.ts";
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

/** Whether a call only reads: a reading op, a reminder only drafted (not sent, no address to save), or set_company with nothing to set (it shows the company). */
export function invoiceCallReads(args: Record<string, unknown>): boolean {
	if (isInvoiceReadOp(args.op)) return true;
	if (args.op === "reminder") return args.send !== true && args.email === undefined;
	return args.op === "set_company" && ["vat", "name", "clear", "iban", "signature"].every((k) => args[k] === undefined);
}

export class InvoiceError extends Error {
	override readonly name = "InvoiceError";
}

export type { Marker } from "./marker.ts";

/** The owner's company, as the owner gave it: how the scadenzario tells what is to pay from what is to collect. */
export type Company = Marker & { readonly vat?: string; readonly name?: string; readonly ibans?: readonly string[]; readonly signature?: string };

/**
 * What is paid of one invoice: all of it (`all`) but the instalments in `except`, or the
 * instalments marked one by one. For a credit note, paid means used.
 */
export type PaidEntry = { readonly invoice: string; readonly all?: Marker; readonly except?: readonly number[]; readonly instalments?: readonly (Marker & { readonly n: number })[] };

/** The instalments of an invoice, from 1. */
export function instalmentRange(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i + 1);
}

/** Which instalments (from 1) an entry says paid. */
export function paidSet(entry: PaidEntry | undefined, count: number): Set<number> {
	if (entry === undefined) return new Set();
	if (entry.all !== undefined) {
		const except = new Set(entry.except ?? []);
		return new Set(instalmentRange(count).filter((n) => !except.has(n)));
	}
	return new Set((entry.instalments ?? []).map((m) => m.n).filter((n) => n >= 1 && n <= count));
}

/** Who marked instalment `n` paid, and when. */
function markerOf(entry: PaidEntry | undefined, n: number): Marker | undefined {
	if (entry?.all !== undefined) return entry.all;
	const one = entry?.instalments?.find((m) => m.n === n);
	return one === undefined ? undefined : { by: one.by, at: one.at };
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

/** A person's codice fiscale, omocodia letters included: a 16-letter name («Alfa Forniture Srl») is not one. */
const CODICE_FISCALE = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** What the person wrote about a party: a partita IVA or codice fiscale (its digits), or words that start words of the name. */
export function matchesParty(party: FatturaParty, query: string): boolean {
	const compact = query.replace(/[\s.-]+/g, "").toUpperCase();
	if (/^(?:[A-Z]{2})?\d{11}$/.test(compact) || CODICE_FISCALE.test(compact)) {
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
	/** The payment reminders recorded, oldest first. */
	readonly reminders?: readonly ReminderMark[];
	/** The PEC the invoice was delivered to (the customer's or an intermediary's), when written. */
	readonly pec?: string;
	/** To a public administration. */
	readonly publicAdmin?: true;
	/** Without instalments, under split payment: what is counted is the total less the VAT the administration pays to the State. */
	readonly splitNet?: true;
};

/** The register: every document of the files found, the same invoice once (the newest file), newest invoice first. */
export function register(found: readonly FoundFattura[], paid: readonly PaidEntry[], company: Company | undefined, reminders: readonly ReminderEntry[] = []): Invoice[] {
	const entries = new Map(paid.map((e) => [e.invoice, e]));
	const reminded = new Map(reminders.map((e) => [e.invoice, e.sent]));
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
				...(reminded.has(bookKey(key)) ? { reminders: reminded.get(bookKey(key)) } : {}),
				...(counted.splitNet ? { splitNet: true as const } : {}),
				...(fattura.pec === undefined ? {} : { pec: fattura.pec }),
				...(fattura.publicAdmin === true ? { publicAdmin: true as const } : {}),
			});
		}
	}
	return [...byKey.values()].sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? "") || b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Under split payment the supplier gets the total less the VAT, which the administration pays to
 * the State. Signs aside (a credit note may write a negative total, and its VAT either way), with
 * the total's sign; undefined when there is no split VAT or it is more than the total.
 */
function splitNet(doc: FatturaDocument): bigint | undefined {
	if (doc.splitVat === undefined || doc.total === undefined) return undefined;
	const total = toUnits(doc.total);
	const vat = toUnits(doc.splitVat);
	if (total === undefined || vat === undefined) return undefined;
	const abs = (n: bigint) => (n < 0n ? -n : n);
	const net = abs(total) - abs(vat);
	if (net < 0n || vat === 0n) return undefined;
	return total < 0n ? -net : net;
}

/**
 * The instalments that count. A credit note or a negative document counts what it is worth, the
 * sign aside. When the instalments add up to more than the total, the ones that repeat the same
 * date and amount are alternatives (two IBANs, two ways to pay): one each is kept. If they still
 * add up to more, they are counted in order up to the total, and the invoice is flagged.
 */
function countedInstalments(doc: FatturaDocument, total: bigint | undefined): { list: Instalment[]; mismatch: boolean; splitNet: boolean } {
	const split = doc.toPay === undefined && doc.instalments.length === 0 ? splitNet(doc) : undefined;
	const whole = doc.toPay ?? (split === undefined ? doc.total : fromUnits(split));
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
	return { list, mismatch, splitNet: split !== undefined };
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

/** What the invoice is worth as counted: its instalments up to the total (alternatives once); undefined when no amount reads. */
export function countedAmount(invoice: Invoice): bigint | undefined {
	const amounts = invoice.instalments.filter((i) => !i.extra && i.amount !== undefined).map((i) => i.amount as bigint);
	return amounts.length === 0 ? undefined : amounts.reduce((n, a) => n + a, 0n);
}

export function paidAmount(invoice: Invoice): bigint {
	return invoice.instalments.reduce((n, i) => (i.paid !== undefined && !i.extra && i.amount !== undefined ? n + i.amount : n), 0n);
}
