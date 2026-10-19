/**
 * Il magazzino and the invoices received: an invoice's lines loaded as carichi, never by
 * themselves. First the proposal: for each line the article it would load (the article the person
 * named, the supplier's code or description learned for an article, the article's own code, its
 * name, or the one article whose every word is in the line, to be confirmed), with the quantity
 * and the cost per unit of the line (its total, the invoice's discounts spread in, divided by its
 * quantity, without VAT); the lines left out, and why; the invoice's spese accessorie apart; and a
 * check of all that. Then, with the person's own yes and that check, the lines confirmed (all, or
 * those said, each maybe with its article, a new article, or how many of its units one of the
 * line's is), each invoice line once whatever is asked again; what was learned kept for the
 * supplier; and the increases of this invoice's prices said once (purchase-store.ts). A proposal
 * that changed meanwhile loads nothing and is shown again. Descriptions, codes, units, numbers
 * and the supplier only inside the fences.
 */
import { createHash } from "node:crypto";
import { DateError, parseDate } from "../dates.ts";
import type { ToolContext } from "../engine.ts";
import { type FatturaLine, toUnits } from "../fattura-pa.ts";
import { n1 } from "../format-words.ts";
import { type Invoice, normalPath, partyKey, partyName, vatOf } from "../invoices.ts";
import { addDays } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import { sameStems, spelledOut, wordsWithin } from "../name-keys.ts";
import { goodDate, increasesIn, increaseWords, lineKey, PURCHASE_LIMITS, priceWords, purchaseUnit, spreadOf, spreadWords } from "../purchase-prices.ts";
import { claimIncreases, type PurchaseStore } from "../purchase-store.ts";
import { halfUp } from "../quote-sums.ts";
import { type CodeMap, codeMapKey, findStockItem, isCost, isQuantity, moveId, type Movement, type ReceivedKey, STOCK_LIMITS, type StockItem, stockItemId, stockUnit, type UnitMap } from "../stock.ts";
import type { InvoiceLoad, StockBook, StockStore } from "../stock-store.ts";
import { costText, packUnits, qtyOf, qtyText, stateOf } from "../stock-sums.ts";
import { findSupplier, meantSupplier, supplierNotFound } from "../supplier-find.ts";
import type { Supplier } from "../supplier-sums.ts";
import { cleanText, isProblem, readAmount } from "../text-input.ts";
import { fold } from "../text-match.ts";
import { requirePersonFor } from "../turn-origin.ts";
import { costWords, fencedStock, qtyWords, unitPlural } from "./stock-render.ts";

/** What receive_invoice needs from the stock tool: the store, the register and the suppliers as read, the increases said, who and when. */
export type StockInvoiceEnv = {
	readonly store: StockStore;
	readonly book: () => StockBook;
	/** The register read and the suppliers, the suppliers' way; a string when the register does not read. */
	readonly register: (ctx: ToolContext) => Promise<{ readonly invoices: readonly Invoice[]; readonly suppliers: readonly Supplier[] } | string>;
	readonly purchases?: PurchaseStore;
	readonly marker: (ctx: ToolContext) => { readonly by: string; readonly at: string };
	readonly audit: (ctx: ToolContext, count: number) => Promise<void>;
};

/** An invoice number as shown: at most this long, and only inside the fence. */
const NUMBER = PURCHASE_LIMITS.number;

/** Two invoices of one supplier with the same goods this many days apart or less may be one delivery invoiced twice. */
const SAME_GOODS_DAYS = 60;

/** A unit cost this many times the article's average, or its inverse, is asked about. */
const COST_FACTOR = 3n;

const SKIPPED: Readonly<Record<string, string>> = {
	done: "già caricata in magazzino",
	discount: "è uno sconto su tutta la fattura: l'ho diviso sulle altre righe",
	goods: "non è merce (sconto, premio, abbuono o importo a zero)",
	quantity: "la riga non dice la quantità",
	decimals: "la quantità ha più di 3 decimali",
	range: "la quantità è fuori da quello che tengo per un articolo",
	none: "nessun articolo del magazzino con questo nome o codice",
	pack: "le confezioni per quanto ne contiene ognuna non danno un numero preciso di unità",
	convert: "con le unità che mi hai detto non viene un numero preciso di unità dell'articolo",
	cost: "il costo per unità non si legge (troppo piccolo o troppo grande)",
	removed: "l'articolo scelto non c'è più",
	exists: "c'è già un articolo con questo nome: scegli quello invece di aggiungerne uno nuovo",
};

/** What the person chose for a line: its article, or a new one in a unit; and how many of the article's units one of the line's is. */
type Choice = { readonly item?: StockItem; readonly unit?: string; readonly each?: string };

/** A line's article as proposed: `created` a new one (its id the one it will get), `flags` what is to be confirmed, `learn` whether the description is kept for the supplier. */
type Load = { readonly item: StockItem; readonly created: boolean; readonly qty: bigint; readonly cost: bigint; readonly flags: readonly string[]; readonly notes: readonly string[]; readonly learn: boolean; readonly unit?: UnitMap };

/** One line as proposed: what it loads; or why it is left out (a reason of SKIPPED, or one said in full). */
type Proposal = { readonly line: number; readonly description: string; readonly code?: string } & (Load | { readonly skip: string; readonly why?: string });

const active = (items: readonly StockItem[]) => items.filter((i) => i.removed === undefined);
const loads = (p: Proposal): p is Proposal & Load => !("skip" in p);
const cut = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** A line's description as an article's name: one line, at most as long as a name. */
const nameOf = (l: FatturaLine) => cut(l.description, STOCK_LIMITS.name);

/** «a risme», «a pezzi»: the article's unit, said for a count. */
const inUnits = (unit: string) => `a ${unitPlural(unit)}`;

/** The articles a description may be, after the ones named or learned: the same name (spelled out, in either number), else every word of the article's name in it. */
function byName(items: readonly StockItem[], description: string): { item: StockItem; sure: boolean } | { close: readonly StockItem[] } | "none" {
	const spelled = spelledOut(description);
	const same = items.filter((i) => spelledOut(i.name) === spelled);
	if (same.length === 1) return { item: same[0] as StockItem, sure: true };
	const stems = same.length > 1 ? same : items.filter((i) => sameStems(spelledOut(i.name), spelled));
	if (stems.length === 1) return { item: stems[0] as StockItem, sure: true };
	if (stems.length > 1) return { close: stems };
	const within = items.filter((i) => wordsWithin(i.name, description));
	if (within.length === 1) return { item: within[0] as StockItem, sure: false };
	return within.length === 0 ? "none" : { close: within };
}

/** Whether an article's name and a line's description say the same thing, one within the other (abbreviations spelled out). */
const related = (name: string, description: string) => wordsWithin(name, description) || wordsWithin(description, name);

/**
 * Each line of `inv` against the magazzino as `book` has it: `choose` what the person said for
 * some lines (by line number). Its articles new are numbered from the book's next.
 */
function propose(inv: Invoice, book: Pick<StockBook, "items" | "moves" | "received" | "codes" | "units" | "nextItem">, choose: ReadonlyMap<number, Choice>): Proposal[] {
	const supplier = partyKey(inv.supplier);
	const done = new Set(book.received.map((r) => r.k));
	const items = active(book.items);
	const spread = spreadOf(inv.doc);
	const totals = new Map(spread.goods.map((g) => [g.line.n, g.total]));
	let created = 0;
	const out: Proposal[] = [];
	for (const l of inv.doc.lines ?? []) {
		if (l.kind === "AC") continue;
		const base = { line: l.n, description: l.description, ...(l.code === undefined ? {} : { code: l.code.value }) };
		if (done.has(lineKey(inv.key, l.n))) {
			out.push({ ...base, skip: "done" });
			continue;
		}
		if (spread.discounts.has(l.n)) {
			out.push({ ...base, skip: "discount" });
			continue;
		}
		const total = totals.get(l.n);
		if (total === undefined) {
			out.push({ ...base, skip: "goods" });
			continue;
		}
		if (l.quantity === undefined) {
			out.push({ ...base, skip: "quantity" });
			continue;
		}
		const picked = choose.get(l.n);
		let item: StockItem | undefined;
		let isNew = false;
		let learn = false;
		const flags: string[] = [];
		if (picked?.unit !== undefined) {
			const name = nameOf(l);
			if (name === "" || items.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
				out.push({ ...base, skip: "exists" });
				continue;
			}
			item = { id: stockItemId(book.nextItem + created), name, unit: picked.unit, by: "", at: "" };
			isNew = true;
			learn = true;
		} else if (picked?.item !== undefined) {
			// Chosen, then removed meanwhile: seen under the lock.
			const still = items.find((i) => i.id === picked.item?.id);
			if (still === undefined) {
				out.push({ ...base, skip: "removed" });
				continue;
			}
			item = still;
			learn = true;
		} else {
			const code = l.code?.value.toLowerCase();
			const learned = code === undefined ? undefined : book.codes.find((c) => c.s === supplier && c.c?.toLowerCase() === code);
			item = learned === undefined ? undefined : items.find((i) => i.id === learned.i);
			if (item === undefined && code !== undefined) item = items.find((i) => i.code?.toLowerCase() === code);
			// A code says the article whatever the description, unless the two say different things.
			if (item !== undefined && !related(item.name, l.description)) flags.push("da confermare: la descrizione non è quella dell'articolo");
			if (item === undefined) {
				const d = cut(spelledOut(l.description), STOCK_LIMITS.supplierText);
				const said = book.codes.find((c) => c.s === supplier && c.d === d);
				item = said === undefined ? undefined : items.find((i) => i.id === said.i);
			}
			if (item === undefined) {
				const f = byName(items, l.description);
				if (f === "none") {
					out.push({ ...base, skip: "none" });
					continue;
				}
				if ("close" in f) {
					out.push({ ...base, skip: "close", why: `più articoli vanno bene: ${f.close.slice(0, 5).map((i) => `${i.id} ${i.name}`).join(", ")}${f.close.length > 5 ? `, e altri ${f.close.length - 5}` : ""}` });
					continue;
				}
				item = f.item;
				if (!f.sure) {
					flags.push("da confermare: stesso nome");
					learn = true;
				}
			}
		}
		// The quantity in the article's units: as written, its packs times their size, or the line's unit as the person said it is, to the thousandth.
		const q = toUnits(l.quantity) as bigint;
		if (q % 100_000n !== 0n) {
			out.push({ ...base, skip: "decimals" });
			continue;
		}
		const written = q / 100_000n;
		const unit = purchaseUnit(l.unit);
		const notes: string[] = [];
		let thousandths: bigint | undefined;
		let teach: UnitMap | undefined;
		const known = unit === undefined ? undefined : (picked?.each ?? book.units.find((u) => u.s === supplier && u.u === unit && u.i === (item as StockItem).id)?.q);
		if (unit === undefined || unit === item.unit) {
			thousandths = written;
			if (unit === undefined) notes.push(`la riga non dice l'unità: contata ${inUnits(item.unit)}`);
		} else if (item.pack !== undefined && unit === item.pack.unit) {
			thousandths = packUnits(qtyText(written), item.pack.size);
			if (thousandths === undefined) {
				out.push({ ...base, skip: "pack" });
				continue;
			}
		} else if (known !== undefined) {
			const n = written * qtyOf(known);
			if (n % 1000n !== 0n) {
				out.push({ ...base, skip: "convert" });
				continue;
			}
			thousandths = n / 1000n;
			notes.push(`una «${cut(l.unit ?? unit, STOCK_LIMITS.unit)}» è ${qtyWords(qtyOf(known), item.unit)}`);
			if (picked?.each !== undefined) teach = { s: supplier.slice(0, STOCK_LIMITS.supplierKey), u: unit.slice(0, STOCK_LIMITS.unit), i: item.id, q: picked.each };
		} else {
			const said = cut(l.unit ?? unit, STOCK_LIMITS.unit);
			out.push({ ...base, skip: "unit", why: `la fattura conta in «${said}», l'articolo ${inUnits(item.unit)}: dimmi quante ${unitPlural(item.unit)} è una «${said}» e lo ricordo per questo fornitore` });
			continue;
		}
		if (thousandths <= 0n || !isQuantity(qtyText(thousandths))) {
			out.push({ ...base, skip: "range" });
			continue;
		}
		// The cost per unit to the ten-thousandth, half up: the line's total, discounts spread in, over its quantity.
		const cost = halfUp(total, 10n * thousandths);
		if (cost <= 0n || !isCost(costText(cost))) {
			out.push({ ...base, skip: "cost" });
			continue;
		}
		if (!isNew) {
			const average = stateOf(item, book.moves).average;
			if (average !== undefined && average > 0n && (cost >= COST_FACTOR * average || cost * COST_FACTOR <= average)) flags.push(`da confermare: il costo è molto diverso dal costo medio dell'articolo (${costWords(average)})`);
		}
		if (isNew) created++;
		out.push({ ...base, item, created: isNew, qty: thousandths, cost, flags, notes, learn, ...(teach === undefined ? {} : { unit: teach }) });
	}
	return out;
}

/** The check of a proposal: the invoice, and each line it loads with its article, quantity and cost. Another check is another proposal. */
function checkOf(inv: Invoice, plan: readonly Proposal[]): string {
	const rows = plan.filter(loads).map((p) => [p.line, p.created ? `+${p.item.unit}|${p.item.name}` : p.item.id, p.qty.toString(), p.cost.toString(), p.unit?.q ?? ""]);
	return createHash("sha256").update(JSON.stringify([inv.key, rows])).digest("hex").slice(0, 8);
}

/** «ieri», «18/10», «la più recente»: the day said, or "latest", or why not. */
function dateSaid(raw: unknown, day: string): string | "latest" | { problem: string } | undefined {
	const said = cleanText(raw, 40, "la data della fattura");
	if (said === undefined || isProblem(said)) return said;
	const t = fold(said).replace(/[^a-z0-9/.\- ]/g, " ").replace(/\s+/g, " ").trim();
	if (/^(?:la )?(?:piu recente|ultima|l ultima)$|^(?:la )?ultima arrivata$/.test(t) || t === "l ultima") return "latest";
	try {
		return parseDate(t, day, { rule: "past" });
	} catch (error) {
		if (error instanceof DateError) return { problem: "la data della fattura: dimmela come 18/10, «ieri» o «la più recente»" };
		throw error;
	}
}

/** The invoice the person means, with the supplier taken from words close to only one (`took`), or the answer to give instead. */
function invoiceSaid(args: Record<string, unknown>, invoices: readonly Invoice[], suppliers: readonly Supplier[], day: string): { inv: Invoice; took?: string } | string {
	const received = invoices.filter((i) => i.side === "passive" && !i.credit && !i.doc.integration);
	const file = cleanText(args.file, 300, "il file");
	if (isProblem(file)) return `Errore: ${file.problem}.`;
	const number = cleanText(args.invoice, 40, "il numero della fattura");
	if (isProblem(number)) return `Errore: ${number.problem}.`;
	const supplierSaid = cleanText(args.supplier, STOCK_LIMITS.name, "il fornitore");
	if (isProblem(supplierSaid)) return `Errore: ${supplierSaid.problem}.`;
	const date = dateSaid(args.date, day);
	if (typeof date === "object") return `Errore: ${date.problem}.`;
	let pool = received;
	let took: string | undefined;
	if (file !== undefined) {
		const path = normalPath(file);
		pool = pool.filter((i) => i.paths.some((p) => normalPath(p) === path));
		if (pool.length === 0) return ["Questo file non è una fattura ricevuta che conosco:", fencedStock(file)].join("\n");
	}
	if (supplierSaid !== undefined) {
		const f = findSupplier(suppliers, supplierSaid);
		if (f.kind === "close" && f.candidates.length > 1) return meantSupplier(f.candidates, fencedStock);
		if (f.kind === "none") return supplierNotFound(supplierSaid, fencedStock);
		const supplier = f.kind === "exact" ? f.supplier : (f.candidates[0] as Supplier);
		if (f.kind === "close") took = `ho preso ${supplier.name}`;
		const keys = new Set(supplier.invoices.map((i) => i.key));
		pool = pool.filter((i) => keys.has(i.key));
	}
	if (number !== undefined) {
		const want = fold(number).replace(/\s+/g, "");
		pool = pool.filter((i) => fold(i.doc.number ?? "").replace(/\s+/g, "") === want);
	}
	if (date === "latest") {
		const last = pool.reduce((m, i) => ((i.doc.date ?? "") > m ? (i.doc.date ?? "") : m), "");
		pool = pool.filter((i) => (i.doc.date ?? "") === last);
	} else if (date !== undefined) pool = pool.filter((i) => i.doc.date === date);
	if (file === undefined && supplierSaid === undefined && number === undefined && date === undefined) return "Errore: dimmi quale fattura: il fornitore e il numero o il giorno, o il file.";
	const withTook = (text: string) => (took === undefined ? text : [text, fencedStock(took)].join("\n"));
	if (pool.length === 1) return { inv: pool[0] as Invoice, ...(took === undefined ? {} : { took }) };
	if (pool.length === 0) return withTook("Non trovo una fattura ricevuta così. Chiedi a chi ti scrive il fornitore e il numero della fattura (o il giorno), o il nome del file.");
	const latest = [...pool].sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? "")).slice(0, 5);
	return [`${pool.length} fatture ricevute vanno bene: le più recenti sono nel riquadro. Chiedi a chi ti scrive quale, e ripeti con il suo numero (e il fornitore).`, fencedStock([...(took === undefined ? [] : [took]), ...latest.map((i) => `• n. ${cut(i.doc.number ?? "?", NUMBER)} del ${i.doc.date === undefined ? "?" : italianDate(i.doc.date)} da ${partyName(i.supplier)}`)].join("\n"))].join("\n");
}

/**
 * What the person said for some lines: `lines` as [{line, item?, new?, each?}] or line numbers.
 * `item` is the article's number, its name, or the one article whose name holds the words said;
 * `new` adds one named as the line, in its unit; `each` is how many of the article's units one of
 * the line's is.
 */
function choices(args: Record<string, unknown>, items: readonly StockItem[]): { only?: Set<number>; choose: Map<number, Choice> } | string {
	if (args.lines === undefined) return { choose: new Map() };
	if (!Array.isArray(args.lines) || args.lines.length === 0 || args.lines.length > 500) return "Errore: le righe sono un elenco, ognuna con il suo numero (e, se serve, l'articolo).";
	const only = new Set<number>();
	const choose = new Map<number, Choice>();
	for (const raw of args.lines) {
		const entry = typeof raw === "number" ? { line: raw } : raw;
		if (typeof entry !== "object" || entry === null) return "Errore: ogni riga ha il suo numero.";
		const { line, item, new: fresh, each } = entry as { line?: unknown; item?: unknown; new?: unknown; each?: unknown };
		if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || line > 9999) return "Errore: il numero di una riga va da 1 a 9999.";
		only.add(line);
		if (item !== undefined && fresh !== undefined) return `Errore: per la riga ${line} dimmi l'articolo che c'è già o di aggiungerne uno nuovo, non tutti e due.`;
		let choice: { item?: StockItem; unit?: string; each?: string } = {};
		if (item !== undefined) {
			if (typeof item !== "string" || item.trim() === "" || item.length > STOCK_LIMITS.name) return "Errore: l'articolo di una riga è il suo numero (MG-0001) o il suo nome.";
			const f = findStockItem(active(items), item);
			if (f === "none") return [`Per la riga ${line} non trovo questo articolo: dimmi il suo numero (MG-0001) o il nome come è in magazzino; se è nuovo, lo aggiungo con la sua unità.`, fencedStock(item)].join("\n");
			if ("close" in f) return [`Per la riga ${line} vanno bene più articoli: chiedi a chi ti scrive quale, e ripeti con il suo numero.`, fencedStock(f.close.slice(0, 10).map((i) => `• ${i.id} ${i.name}`).join("\n"))].join("\n");
			choice = { item: f.item };
		}
		if (fresh !== undefined) {
			const unit = typeof fresh === "object" && fresh !== null ? (fresh as { unit?: unknown }).unit : undefined;
			const said = cleanText(unit ?? "pezzi", STOCK_LIMITS.unit, "l'unità dell'articolo nuovo");
			if (said === undefined || isProblem(said)) return `Errore: ${said === undefined ? "dimmi l'unità dell'articolo nuovo" : said.problem}.`;
			choice = { unit: stockUnit(said) };
		}
		if (each !== undefined) {
			const read = readAmount(each, 3, `per la riga ${line}, quante unità dell'articolo è una della fattura`, fencedStock);
			if (read === undefined || isProblem(read)) return `Errore: ${read?.problem ?? "dimmi un numero"}.`;
			if (Number(read) <= 0 || !isQuantity(read)) return `Errore: per la riga ${line}, quante unità dell'articolo è una della fattura è un numero maggiore di zero, al più 3 decimali.`;
			choice = { ...choice, each: qtyText(qtyOf(read)) };
		}
		if (choice.item !== undefined || choice.unit !== undefined || choice.each !== undefined) choose.set(line, choice);
	}
	return { only, choose };
}

const lineHead = (p: Proposal) => `• riga ${p.line}, ${p.description}${p.code === undefined ? "" : ` [${p.code}]`}`;

/** «• riga 1, CARTA A4 [CA-80] → MG-0001 Carta A4: 10 risme a 4,86 €», with why only when it is to be confirmed. */
function proposalRow(p: Proposal): string {
	if (!loads(p)) return `${lineHead(p)}: ${p.why ?? SKIPPED[p.skip] ?? p.skip}`;
	const to = p.created ? `articolo nuovo, ${inUnits(p.item.unit)}` : `${p.item.id} ${p.item.name}`;
	const more = [...p.flags, ...p.notes];
	return `${lineHead(p)} → ${to}: ${qtyWords(p.qty, p.item.unit)} a ${costWords(p.cost)}${more.length === 0 ? "" : ` (${more.join("; ")})`}`;
}

/** The invoices of the same supplier, loaded already, within SAME_GOODS_DAYS, with the same lines and total: maybe one delivery invoiced twice. */
function sameGoods(inv: Invoice, invoices: readonly Invoice[], book: Pick<StockBook, "received">): Invoice | undefined {
	if (!goodDate(inv.doc.date)) return undefined;
	const done = new Set(book.received.map((r) => r.k));
	const goods = (i: Invoice) => JSON.stringify([i.doc.total ?? "", (i.doc.lines ?? []).map((l) => JSON.stringify([spelledOut(l.description), l.quantity ?? "", l.unit ?? "", l.total])).sort()]);
	const mine = goods(inv);
	const from = addDays(inv.doc.date, -SAME_GOODS_DAYS);
	const to = addDays(inv.doc.date, SAME_GOODS_DAYS);
	return invoices.find((o) => o.key !== inv.key && o.side === "passive" && !o.credit && partyKey(o.supplier) === partyKey(inv.supplier) && goodDate(o.doc.date) && o.doc.date >= from && o.doc.date <= to && (o.doc.lines ?? []).some((l) => done.has(lineKey(o.key, l.n))) && goods(o) === mine);
}

/** The fence of a proposal or of what was loaded: the supplier, the number, the lines, those left out, the spese, the discount spread. */
function fenceOf(inv: Invoice, plan: readonly Proposal[], took: string | undefined, also: readonly string[] = []): string {
	const spread = spreadOf(inv.doc);
	const skipped = plan.filter((p) => !loads(p));
	return fencedStock(
		[
			...(took === undefined ? [] : [took]),
			`Fornitore: ${partyName(inv.supplier)}`,
			`Fattura n. ${cut(inv.doc.number ?? "?", NUMBER)}`,
			...plan.filter(loads).map(proposalRow),
			...(skipped.length === 0 ? [] : ["Non le carico:", ...skipped.map(proposalRow)]),
			...(spread.expenses.length === 0 ? [] : ["Spese della fattura (non sono merce):", ...spread.expenses.map((l) => `• riga ${l.n}, ${l.description}: ${priceWords(toUnits(l.total) as bigint)}`)]),
			...(spread.spread === 0n ? [] : [spreadWords(inv.doc.number, inv.doc.date, spread.spread)]),
			...also,
		].join("\n"),
	);
}

/** What is said under the fence: lines that do not read, the spese, what is to be confirmed. */
function notesOf(inv: Invoice, plan: readonly Proposal[]): string[] {
	const out: string[] = [];
	const unread = inv.doc.linesSkipped ?? 0;
	const past = inv.doc.linesCut ?? 0;
	if (unread > 0) out.push(unread === 1 ? "Una riga della fattura non si legge (manca la descrizione, o un prezzo o una quantità non è un numero): non la propongo." : `${unread} righe della fattura non si leggono (manca la descrizione, o un prezzo o una quantità non è un numero): non le propongo.`);
	if (past > 0) out.push(`${n1(past, "Una riga è", "# righe sono")} oltre le prime 2000 della fattura: ${past === 1 ? "non la propongo, va caricata" : "non le propongo, vanno caricate"} a mano.`);
	if (spreadOf(inv.doc).expenses.length > 0) out.push("Le spese della fattura (trasporto e simili) non sono merce: le elenco a parte e non le aggiungo ai costi degli articoli.");
	return out;
}

/** The proposal's answer: what can be loaded, how to confirm it, or the next step when nothing can. */
function proposalText(inv: Invoice, plan: readonly Proposal[], took: string | undefined, twin: Invoice | undefined, first: string): string {
	const ok = plan.filter(loads);
	const head = `Fattura del ${inv.doc.date === undefined ? "giorno non indicato" : italianDate(inv.doc.date)} (fornitore e numero nel riquadro)`;
	const out = [
		`${first}${ok.length === 0 ? `${head}: nessuna riga da caricare in magazzino.` : `${head}: ${n1(ok.length, "una riga si può caricare", "# righe si possono caricare")} in magazzino, come nel riquadro (costi per unità, senza IVA)${ok.length === plan.length ? "" : `; ${n1(plan.length - ok.length, "una no", "# no")}, con il motivo`}.`}`,
		fenceOf(inv, plan, took, twin === undefined ? [] : [`Sembra la stessa merce della fattura n. ${cut(twin.doc.number ?? "?", NUMBER)} del ${italianDate(twin.doc.date as string)}: è un'altra consegna?`]),
		...notesOf(inv, plan),
	];
	if (twin !== undefined) out.push("Attenzione: questa fattura ha le stesse righe di una già caricata in magazzino (nel riquadro): prima di caricarla chiedi a chi ti scrive se è davvero un'altra consegna.");
	const unsure = ok.filter((p) => p.flags.length > 0).length;
	if (unsure > 0) out.push(`${n1(unsure, "Una riga è", "# righe sono")} da confermare (nel riquadro il perché): chiedi a chi ti scrive di guardarle.`);
	if (ok.length > 0) {
		out.push(`Chiedi a chi ti scrive se va bene: con il suo sì ripeti con la conferma, le stesse righe e il controllo ${checkOf(inv, plan)}. Per una riga con l'articolo sbagliato, o senza articolo, dimmi il numero della riga e l'articolo giusto (MG-0001), o di aggiungerlo nuovo con la sua unità, e rifaccio la proposta. Niente si carica da solo.`);
	} else out.push("Per caricare una riga dimmi il suo numero e l'articolo del magazzino («la riga 1 è la carta A4»); se è un articolo nuovo, lo aggiungo.");
	return out.join("\n");
}

/**
 * receive_invoice: the proposal without confirm; with confirm, in the person's own turn and with
 * the proposal's check, the lines confirmed loaded (all those proposed, or those in `lines`),
 * each invoice line once.
 */
export async function receiveInvoice(env: StockInvoiceEnv, args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
	const reg = await env.register(ctx);
	if (typeof reg === "string") return reg;
	const found = invoiceSaid(args, reg.invoices, reg.suppliers, day);
	if (typeof found === "string") return found;
	const { inv, took } = found;
	if (inv.doc.lines === undefined || inv.doc.lines.length === 0) return "Questa fattura non ha righe con prezzo e quantità che so leggere (per esempio una fattura semplificata): la merce va caricata a mano, riga per riga.";
	if (inv.doc.date !== undefined && !goodDate(inv.doc.date)) return "Questa fattura ha una data che non esiste, o di prima del 2000: non la carico in magazzino. Chiedi a chi ti scrive di controllarla; la merce si può caricare a mano.";
	if (inv.doc.currency !== "EUR") return "Questa fattura non è in euro: i costi del magazzino sono in euro, e non la converto. La merce va caricata a mano, con il costo in euro.";
	const b = env.book();
	const picked = choices(args, b.items);
	if (typeof picked === "string") return picked;
	const chosen = (plan: Proposal[]) => plan.filter((p) => picked.only === undefined || picked.only.has(p.line));
	if (args.confirm !== true) return proposalText(inv, chosen(propose(inv, b, picked.choose)), took, sameGoods(inv, reg.invoices, b), "");
	const refused = requirePersonFor(ctx, "carico in magazzino la merce di una fattura");
	if (refused !== undefined) return refused;
	const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
	if (check === undefined || !/^[0-9a-f]{8}$/.test(check)) return "Errore: per caricare serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.";
	const by = env.marker(ctx);
	const supplier = { name: partyName(inv.supplier).slice(0, STOCK_LIMITS.name), ...(vatOf(inv.supplier) === undefined ? {} : { vat: vatOf(inv.supplier) as string }) };
	const s = partyKey(inv.supplier).slice(0, STOCK_LIMITS.supplierKey);
	const year = Number((inv.doc.date ?? day).slice(0, 4));
	const doc = `fattura n. ${cut(inv.doc.number ?? "?", NUMBER)}`.slice(0, STOCK_LIMITS.doc);
	const loaded = await ctx.step("apply", async () => {
		let plan: Proposal[] = [];
		let changed = false;
		const kept: string[] = [];
		const outcome = env.store.receiveInvoice(ctx.callId, (book): InvoiceLoad => {
			// Again under the lock: a line loaded meanwhile, an article removed or a cost changed are seen here.
			plan = chosen(propose(inv, book, picked.choose));
			if (checkOf(inv, plan) !== check) {
				changed = true;
				return { items: [], moves: [], keys: [], codes: [], units: [] };
			}
			const items: StockItem[] = [];
			const moves: Movement[] = [];
			const keys: ReceivedKey[] = [];
			const units: UnitMap[] = [];
			const codes = new Map<string, CodeMap>();
			const clashing = new Set<string>();
			const learn = (c: CodeMap, said: string) => {
				const key = codeMapKey(c);
				const was = codes.get(key);
				if (was !== undefined && was.i !== c.i) {
					clashing.add(key);
					kept.push(said);
				}
				codes.set(key, c);
			};
			for (const p of plan.filter(loads)) {
				const item = p.created ? { ...p.item, callId: ctx.callId, ...by } : p.item;
				if (p.created) items.push(item);
				moves.push({ id: moveId(book.nextMove + moves.length), item: item.id, kind: "carico", qty: qtyText(p.qty), day: inv.doc.date ?? day, cost: costText(p.cost), supplier, doc, callId: ctx.callId, ...by });
				keys.push({ k: lineKey(inv.key, p.line), y: year });
				if (p.code !== undefined) learn({ s, c: p.code.slice(0, STOCK_LIMITS.supplierCode), i: item.id }, `il codice ${p.code} è su più righe con articoli diversi: non lo ricordo`);
				if (p.learn) learn({ s, d: cut(spelledOut(p.description), STOCK_LIMITS.supplierText), i: item.id }, `la descrizione della riga ${p.line} è su più righe con articoli diversi: non la ricordo`);
				if (p.unit !== undefined) units.push(p.unit);
			}
			return { items, moves, keys, codes: [...codes.entries()].filter(([k]) => !clashing.has(k)).map(([, c]) => c), units };
		});
		const rows = plan.filter(loads);
		if (outcome === "rerun") return { rerun: true, changed: false, text: "", count: env.book().moves.filter((m) => m.callId === ctx.callId).length };
		if (changed) return { rerun: false, changed: true, text: proposalText(inv, plan, took, sameGoods(inv, reg.invoices, env.book()), "La proposta è cambiata da quando l'hai mostrata (una riga caricata nel frattempo, un articolo o un costo diverso): non ho caricato niente. Ecco quella nuova.\n"), count: 0 };
		if (rows.length === 0) return { rerun: false, changed: false, text: [`Non ho caricato niente: nessuna riga di questa fattura si può caricare ora.`, fenceOf(inv, plan, took), ...notesOf(inv, plan), "Per caricare una riga dimmi il suo numero e l'articolo del magazzino («la riga 1 è la carta A4»); se è un articolo nuovo, lo aggiungo."].join("\n"), count: 0 };
		const head = `Fatto, ho caricato in magazzino ${n1(rows.length, "una riga", "# righe")} della fattura del ${inv.doc.date === undefined ? "giorno non indicato" : italianDate(inv.doc.date)} (fornitore e numero nel riquadro)${rows.length === plan.length ? "" : `; ${n1(plan.length - rows.length, "una no", "# no")}, con il motivo`}. Ogni riga resta caricata una volta sola, anche se me lo chiedi di nuovo.`;
		const added = rows.filter((p) => p.created).length;
		return { rerun: false, changed: false, text: [head, fenceOf(inv, plan, took, kept), ...notesOf(inv, plan), ...(added === 0 ? [] : [`${n1(added, "Ho aggiunto un articolo nuovo", "Ho aggiunto # articoli nuovi")} al magazzino, con il nome della riga: se vuoi, dimmi sotto quanto avvisarti.`])].join("\n"), count: rows.length };
	});
	if (loaded.rerun) return `Fatto: ${n1(loaded.count, "una riga di questa fattura è caricata", "# righe di questa fattura sono caricate")} in magazzino.`;
	if (loaded.changed || loaded.count === 0) return loaded.text;
	await env.audit(ctx, loaded.count);
	// The increases of this invoice's prices, said here once (the brief does not say them again).
	const said = await claimIncreases(env.purchases, ctx, day, increasesIn(reg.invoices, reg.suppliers, inv));
	const rises = said.length === 0 ? [] : [`${n1(said.length, "Un prezzo di questa fattura è aumentato", "# prezzi di questa fattura sono aumentati")} rispetto all'acquisto precedente dallo stesso fornitore: dillo a chi ti scrive.`, fencedStock(said.map(increaseWords).join("\n"))];
	return [loaded.text, ...rises].join("\n");
}
