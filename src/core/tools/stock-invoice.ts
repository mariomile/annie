/**
 * Il magazzino and the invoices received: an invoice's lines loaded as carichi, never by
 * themselves. First the proposal: for each line the article it would load (the supplier's code
 * learned for an article, the article's own code, or the article's name, the same in either
 * number), with the quantity and the cost per unit of the line (its total, discounts in, divided
 * by its quantity, without VAT); the lines left out, and why; and the increases of this invoice's
 * prices, said once (purchase-store.ts). Then, with the person's own yes, the lines confirmed
 * (all, or those said, each maybe with its article), each invoice line once whatever is asked
 * again, and the codes learned. Descriptions, codes and the supplier only inside the fences.
 */
import type { ToolContext } from "../engine.ts";
import { fromUnits, toUnits } from "../fattura-pa.ts";
import { n1 } from "../format-words.ts";
import { type Invoice, normalPath, partyKey, partyName, vatOf } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import { increasesOf, lineKey, priceWords, purchaseRows, purchaseUnit, tenthsWords } from "../purchase-prices.ts";
import type { PurchaseStore } from "../purchase-store.ts";
import { halfUp } from "../quote-sums.ts";
import { findStockItem, isCost, isQuantity, moveId, type Movement, type ReceivedKey, STOCK_LIMITS, type StockItem, type CodeMap } from "../stock.ts";
import type { InvoiceLoad, StockBook, StockStore } from "../stock-store.ts";
import { costText, packUnits, qtyText } from "../stock-sums.ts";
import { findSupplier, meantSupplier, supplierNotFound } from "../supplier-find.ts";
import type { Supplier } from "../supplier-sums.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { fold } from "../text-match.ts";
import { requirePersonFor } from "../turn-origin.ts";
import { costWords, fencedStock, qtyWords } from "./stock-render.ts";

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

/** Lines that are no goods: a discount, a premium, an allowance. */
const NOT_GOODS = new Set(["SC", "PR", "AB"]);

const SKIPPED: Readonly<Record<string, string>> = {
	done: "già caricata in magazzino",
	goods: "non è merce (sconto, premio, abbuono o importo a zero)",
	quantity: "la riga non dice la quantità",
	decimals: "la quantità ha più di 3 decimali",
	range: "la quantità è fuori da quello che tengo per un articolo",
	none: "nessun articolo del magazzino con questo nome o codice",
	close: "più articoli vanno bene con queste parole",
	unit: "l'unità della riga non è quella dell'articolo, né della sua confezione",
	pack: "le confezioni per quanto ne contiene ognuna non danno un numero preciso di unità",
	cost: "il costo per unità non si legge (troppo piccolo o troppo grande)",
	removed: "l'articolo scelto non c'è più",
};

/** One line as proposed: the article, quantity and cost, how it was found; or why it is left out. */
type Proposal = { readonly line: number; readonly description: string; readonly code?: string } & ({ readonly item: StockItem; readonly qty: bigint; readonly cost: bigint; readonly how: string; readonly unitNote?: string } | { readonly skip: string });

const active = (items: readonly StockItem[]) => items.filter((i) => i.removed === undefined);

/** «MG-0003» or the article's own name, exactly: what the person may say to choose a line's article. */
function chosen(items: readonly StockItem[], said: string): StockItem | undefined {
	const f = findStockItem(active(items), said, true);
	return typeof f === "object" && "item" in f && !f.respelled ? f.item : undefined;
}

/**
 * Each line of `inv` against the magazzino as `book` has it: `choose` the articles the person
 * named for some lines (by line number).
 */
function propose(inv: Invoice, book: Pick<StockBook, "items" | "received" | "codes">, choose: ReadonlyMap<number, StockItem>): Proposal[] {
	const supplier = partyKey(inv.supplier);
	const done = new Set(book.received.map((r) => r.k));
	const items = active(book.items);
	return (inv.doc.lines ?? []).map((l): Proposal => {
		const base = { line: l.n, description: l.description, ...(l.code === undefined ? {} : { code: l.code.value }) };
		if (done.has(lineKey(inv.key, l.n))) return { ...base, skip: "done" };
		const total = toUnits(l.total);
		if ((l.kind !== undefined && NOT_GOODS.has(l.kind)) || total === undefined || total <= 0n) return { ...base, skip: "goods" };
		if (l.quantity === undefined) return { ...base, skip: "quantity" };
		const picked = choose.get(l.n);
		// Chosen, then removed meanwhile: seen under the lock.
		if (picked !== undefined && !items.some((i) => i.id === picked.id)) return { ...base, skip: "removed" };
		let item = picked;
		let how = "scelto da chi ti scrive";
		if (item === undefined && l.code !== undefined) {
			const code = l.code.value.toLowerCase();
			const learned = book.codes.find((c) => c.s === supplier && c.c.toLowerCase() === code);
			item = learned === undefined ? undefined : items.find((i) => i.id === learned.i);
			how = "codice del fornitore già confermato";
			if (item === undefined) {
				item = items.find((i) => i.code?.toLowerCase() === code);
				how = "stesso codice";
			}
		}
		if (item === undefined) {
			const f = findStockItem(items, l.description, true);
			if (f === "none") return { ...base, skip: "none" };
			if ("close" in f) return { ...base, skip: "close" };
			item = f.item;
			how = f.respelled ? "stesso nome, al singolare o al plurale" : "stesso nome";
		}
		// The quantity in the article's units: as written, or its packs times their size, to the thousandth.
		const q = toUnits(l.quantity) as bigint;
		if (q % 100_000n !== 0n) return { ...base, skip: "decimals" };
		const said = fromUnits(q).replace(/\.?0+$/, "");
		const unit = purchaseUnit(l.unit);
		let thousandths: bigint | undefined;
		let unitNote: string | undefined;
		if (unit === undefined || unit === item.unit) {
			thousandths = q / 100_000n;
			if (unit === undefined) unitNote = `la riga non dice l'unità: contata a ${item.unit}`;
		} else if (item.pack !== undefined && unit === item.pack.unit) {
			thousandths = packUnits(said, item.pack.size);
			if (thousandths === undefined) return { ...base, skip: "pack" };
		} else return { ...base, skip: "unit" };
		if (thousandths <= 0n || !isQuantity(qtyText(thousandths))) return { ...base, skip: "range" };
		// The cost per unit to the ten-thousandth, half up: the line's total over its quantity.
		const cost = halfUp(total, 10n * thousandths);
		if (cost <= 0n || !isCost(costText(cost))) return { ...base, skip: "cost" };
		return { ...base, item, qty: thousandths, cost, how, ...(unitNote === undefined ? {} : { unitNote }) };
	});
}

/** The invoice the person means, or the answer to give instead. */
function invoiceSaid(args: Record<string, unknown>, invoices: readonly Invoice[], suppliers: readonly Supplier[]): Invoice | string {
	const received = invoices.filter((i) => i.side === "passive" && !i.credit && !i.doc.integration);
	const file = cleanText(args.file, 300, "il file");
	if (isProblem(file)) return `Errore: ${file.problem}.`;
	const number = cleanText(args.invoice, 40, "il numero della fattura");
	if (isProblem(number)) return `Errore: ${number.problem}.`;
	const supplierSaid = cleanText(args.supplier, STOCK_LIMITS.name, "il fornitore");
	if (isProblem(supplierSaid)) return `Errore: ${supplierSaid.problem}.`;
	let pool = received;
	if (file !== undefined) {
		const path = normalPath(file);
		pool = pool.filter((i) => i.paths.some((p) => normalPath(p) === path));
		if (pool.length === 0) return ["Questo file non è una fattura ricevuta che conosco:", fencedStock(file)].join("\n");
	}
	if (supplierSaid !== undefined) {
		const f = findSupplier(suppliers, supplierSaid);
		if (f.kind === "close") return meantSupplier(f.candidates, fencedStock);
		if (f.kind === "none") return supplierNotFound(supplierSaid, fencedStock);
		const keys = new Set(f.supplier.invoices.map((i) => i.key));
		pool = pool.filter((i) => keys.has(i.key));
	}
	if (number !== undefined) {
		const want = fold(number).replace(/\s+/g, "");
		pool = pool.filter((i) => fold(i.doc.number ?? "").replace(/\s+/g, "") === want);
	}
	if (file === undefined && supplierSaid === undefined && number === undefined) return "Errore: dimmi quale fattura: il fornitore e il numero, o il file.";
	if (pool.length === 1) return pool[0] as Invoice;
	if (pool.length === 0) return "Non trovo una fattura ricevuta così. Chiedi a chi ti scrive il fornitore e il numero della fattura, o il nome del file.";
	const latest = [...pool].sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? "")).slice(0, 5);
	return [`${pool.length} fatture ricevute vanno bene: le più recenti sono nel riquadro. Chiedi a chi ti scrive quale, e ripeti con il suo numero (e il fornitore).`, fencedStock(latest.map((i) => `• n. ${i.doc.number ?? "?"} del ${i.doc.date === undefined ? "?" : italianDate(i.doc.date)} da ${partyName(i.supplier)}`).join("\n"))].join("\n");
}

/** The lines the person chose, with the article named for some: `lines` as [{line, item?}] or line numbers. */
function choices(args: Record<string, unknown>, items: readonly StockItem[]): { only?: Set<number>; choose: Map<number, StockItem> } | string {
	if (args.lines === undefined) return { choose: new Map() };
	if (!Array.isArray(args.lines) || args.lines.length === 0 || args.lines.length > 500) return "Errore: le righe sono un elenco, ognuna con il suo numero (e, se serve, l'articolo).";
	const only = new Set<number>();
	const choose = new Map<number, StockItem>();
	for (const raw of args.lines) {
		const entry = typeof raw === "number" ? { line: raw } : raw;
		if (typeof entry !== "object" || entry === null) return "Errore: ogni riga ha il suo numero.";
		const { line, item } = entry as { line?: unknown; item?: unknown };
		if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || line > 9999) return "Errore: il numero di una riga va da 1 a 9999.";
		only.add(line);
		if (item === undefined) continue;
		if (typeof item !== "string" || item.length > STOCK_LIMITS.name) return "Errore: l'articolo di una riga è il suo numero (MG-0001) o il suo nome.";
		const found = chosen(items, item);
		if (found === undefined) return [`Per la riga ${line} non trovo esattamente questo articolo: dimmi il suo numero (MG-0001) o il nome come è in magazzino.`, fencedStock(item)].join("\n");
		choose.set(line, found);
	}
	return { only, choose };
}

function proposalRow(p: Proposal): string {
	if ("skip" in p) return `• riga ${p.line}, ${p.description}${p.code === undefined ? "" : ` [${p.code}]`}: ${SKIPPED[p.skip] ?? p.skip}`;
	return `• riga ${p.line}, ${p.description}${p.code === undefined ? "" : ` [${p.code}]`} → ${p.item.id} ${p.item.name}: ${qtyWords(p.qty, p.item.unit)} a ${costWords(p.cost)} per unità, senza IVA (${p.how}${p.unitNote === undefined ? "" : `; ${p.unitNote}`})`;
}

/**
 * The increases of this invoice's prices (5% or more on the supplier's previous purchase), each
 * invoice line said once: here, or in the brief, whichever comes first.
 */
async function increasesHere(env: StockInvoiceEnv, ctx: ToolContext, inv: Invoice, invoices: readonly Invoice[], suppliers: readonly Supplier[], day: string): Promise<string[]> {
	if (env.purchases === undefined || env.purchases.read().broken || inv.doc.date === undefined) return [];
	const rows = purchaseRows(invoices, suppliers).rows;
	const mine = increasesOf(rows, 500n, inv.doc.date, inv.doc.date).filter((i) => i.latest.invoice === inv.key);
	if (mine.length === 0) return [];
	const purchases = env.purchases;
	const claimed = new Set(await ctx.step("increases", async () => purchases.claim(ctx.callId, day, "invoice", mine.map((i) => lineKey(i.latest.invoice, i.latest.line)))));
	const said = mine.filter((i) => claimed.has(lineKey(i.latest.invoice, i.latest.line)));
	if (said.length === 0) return [];
	return [
		[`${n1(said.length, "Un prezzo di questa fattura è aumentato", "# prezzi di questa fattura sono aumentati")} rispetto all'acquisto precedente dallo stesso fornitore: dillo a chi ti scrive.`, fencedStock(said.map((i) => `• ${i.supplier} ti ha fatto pagare ${i.product.name} ${tenthsWords(i.tenths)} in più dell'ultima volta (${priceWords(i.latest.price)} invece di ${priceWords(i.previous.price)} per ${i.product.unit ?? "unità"})`).join("\n"))].join("\n"),
	];
}

/**
 * receive_invoice: the proposal without confirm; with confirm, in the person's own turn, the
 * lines confirmed loaded (all those proposed, or those in `lines`), each invoice line once.
 */
export async function receiveInvoice(env: StockInvoiceEnv, args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
	const reg = await env.register(ctx);
	if (typeof reg === "string") return reg;
	const inv = invoiceSaid(args, reg.invoices, reg.suppliers);
	if (typeof inv === "string") return inv;
	if (inv.doc.lines === undefined || inv.doc.lines.length === 0) return "Questa fattura non ha righe con prezzo e quantità che so leggere (per esempio una fattura semplificata): la merce va caricata a mano, riga per riga.";
	const b = env.book();
	const picked = choices(args, b.items);
	if (typeof picked === "string") return picked;
	const head = `Fattura n. ${inv.doc.number ?? "?"}${inv.doc.date === undefined ? "" : ` del ${italianDate(inv.doc.date)}`} (fornitore nel riquadro)`;
	const skippedRead = (inv.doc.linesSkipped ?? 0) + (inv.doc.linesCut ?? 0);
	const unread = skippedRead === 0 ? [] : [`${n1(skippedRead, "Una riga della fattura non si legge", "# righe della fattura non si leggono")}: ${skippedRead === 1 ? "non la propongo" : "non le propongo"}.`];
	if (args.confirm !== true) {
		const all = propose(inv, b, picked.choose).filter((p) => picked.only === undefined || picked.only.has(p.line));
		const ok = all.filter((p) => !("skip" in p));
		const out = [
			ok.length === 0 ? `${head}: nessuna riga da caricare in magazzino.` : `${head}: ${n1(ok.length, "una riga si può caricare", "# righe si possono caricare")} in magazzino, come nel riquadro${ok.length === all.length ? "" : `; ${n1(all.length - ok.length, "una no", "# no")}, con il motivo`}.`,
			fencedStock([`Fornitore: ${partyName(inv.supplier)}`, ...all.map(proposalRow)].join("\n")),
			...unread,
			...(await increasesHere(env, ctx, inv, reg.invoices, reg.suppliers, day)),
		];
		if (ok.length > 0) out.push("Chiedi a chi ti scrive se va bene: con il suo sì ripeti con la conferma, per tutte le righe o solo per quelle che vuole; per una riga con l'articolo sbagliato, o senza articolo, dimmi il numero della riga e l'articolo giusto (MG-0001). Niente si carica da solo.");
		return out.join("\n");
	}
	const refused = requirePersonFor(ctx, "carico in magazzino la merce di una fattura");
	if (refused !== undefined) return refused;
	const by = env.marker(ctx);
	const supplier = { name: partyName(inv.supplier).slice(0, STOCK_LIMITS.name), ...(vatOf(inv.supplier) === undefined ? {} : { vat: vatOf(inv.supplier) as string }) };
	const year = Number((inv.doc.date ?? day).slice(0, 4));
	const doc = `fattura n. ${inv.doc.number ?? "?"}`.slice(0, STOCK_LIMITS.doc);
	const loaded = await ctx.step("apply", async () => {
		let plan: Proposal[] = [];
		const outcome = env.store.receiveInvoice(ctx.callId, (book): InvoiceLoad => {
			// Again under the lock: a line loaded meanwhile, an article removed, are seen here.
			plan = propose(inv, book, picked.choose).filter((p) => picked.only === undefined || picked.only.has(p.line));
			const moves: Movement[] = [];
			const keys: ReceivedKey[] = [];
			const codes: CodeMap[] = [];
			for (const p of plan) {
				if ("skip" in p) continue;
				moves.push({ id: moveId(book.nextMove + moves.length), item: p.item.id, kind: "carico", qty: qtyText(p.qty), day: inv.doc.date ?? day, cost: costText(p.cost), supplier, doc, callId: ctx.callId, ...by });
				keys.push({ k: lineKey(inv.key, p.line), y: year });
				if (p.code !== undefined) codes.push({ s: partyKey(inv.supplier).slice(0, STOCK_LIMITS.supplierKey), c: p.code.slice(0, STOCK_LIMITS.supplierCode), i: p.item.id });
			}
			return { moves, keys, codes };
		});
		if (outcome === "rerun") return { rerun: true, rows: [] as string[], skipped: [] as string[], count: env.book().moves.filter((m) => m.callId === ctx.callId).length };
		return { rerun: false, rows: plan.filter((p) => !("skip" in p)).map(proposalRow), skipped: plan.filter((p) => "skip" in p).map(proposalRow), count: plan.filter((p) => !("skip" in p)).length };
	});
	if (loaded.rerun) return `Fatto: ${n1(loaded.count, "una riga di questa fattura è caricata", "# righe di questa fattura sono caricate")} in magazzino.`;
	if (loaded.count === 0) return [`${head}: non ho caricato niente.`, fencedStock([`Fornitore: ${partyName(inv.supplier)}`, ...loaded.skipped].join("\n"))].join("\n");
	await env.audit(ctx, loaded.count);
	return [
		`Fatto, ho caricato in magazzino ${n1(loaded.count, "una riga", "# righe")} della ${head.charAt(0).toLowerCase()}${head.slice(1)}${loaded.skipped.length === 0 ? "" : `; ${n1(loaded.skipped.length, "una no", "# no")}, con il motivo`}. Ogni riga resta caricata una volta sola, anche se me lo chiedi di nuovo.`,
		fencedStock([`Fornitore: ${partyName(inv.supplier)}`, ...loaded.rows, ...loaded.skipped].join("\n")),
		...unread,
	].join("\n");
}
