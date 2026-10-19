/**
 * Il magazzino's own state, in `stock.json` of an instance (outside the workspace): the articles,
 * the movements (append-only: a change never edits or drops one, except a closed year, which
 * folds those up to a day into one apertura per article), the keys of the sales folded so, the
 * next numbers to give (never given twice), the ids of the calls that wrote (a call run again
 * writes nothing twice) and the brief's alerts already said. Changed under the shared file lock
 * through json-book.ts, with the copy `stock.json.bak`. Read never throws: a file that does not
 * read is `broken`, and nothing is written over it. What is on hand is never stored: it is worked
 * out from the movements every time (stock-sums.ts).
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import type { Marker } from "./marker.ts";
import { type CodeMap, codeMapKey, isCost, isQuantity, type LowClaim, MOVE_ID, moveId, type Movement, type ReceivedKey, type SaleKey, STOCK_ID, STOCK_LIMITS, StockError, type StockItem, stockItemId, type UnitMap, unitMapKey, validCodeMap, validItem, validLowClaim, validMove, validReceivedKey, validSaleKey, validStockCall, validUnitMap } from "./stock.ts";
import { costText, qtyOf, qtyText, saleQuantity, stateOf } from "./stock-sums.ts";

/** What a change works on: the articles, the movements and the next numbers. */
export type StockState = { readonly nextItem: number; readonly nextMove: number; readonly items: readonly StockItem[]; readonly moves: readonly Movement[] };

type Book = StockState & { readonly archived: readonly SaleKey[]; readonly received: readonly ReceivedKey[]; readonly codes: readonly CodeMap[]; readonly units: readonly UnitMap[]; readonly alerts: readonly LowClaim[]; readonly calls: readonly string[] };

export type StockBook = Book & { readonly broken: boolean };

export const STOCK_BROKEN = "il magazzino (stock.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

export const STOCK_FULL = "il magazzino è pieno: ci sono troppi movimenti per salvarne altri. Chi ti scrive può chiudere un anno passato: i movimenti fino alla fine di quell'anno diventano una riga di apertura per articolo, con la quantità e il costo medio di allora";

const EMPTY: Book = { nextItem: 1, nextMove: 1, items: [], moves: [], archived: [], received: [], codes: [], units: [], alerts: [], calls: [] };

/** What loading an invoice received writes: the articles it adds (numbered from the next), its carichi (numbered from the next), the keys of its lines, the supplier codes, descriptions and units learned. */
export type InvoiceLoad = { readonly items: readonly StockItem[]; readonly moves: readonly Movement[]; readonly keys: readonly ReceivedKey[]; readonly codes: readonly CodeMap[]; readonly units: readonly UnitMap[] };

/** One line of an invoice issued (or a credit note) that names a voce of the listino. */
export type SaleLine = { readonly line: number; readonly listino: string; readonly quantity: string; readonly unit?: string; readonly description: string };

/** An invoice issued, or a credit note (with `of`, the invoice it corrects), as the magazzino takes it. */
export type Sale = { readonly invoice: string; readonly number: string; readonly day: string; readonly of?: string; readonly lines: readonly SaleLine[] };

export type Skipped = { readonly description: string; readonly why: "unit" | "pack" | "quantity" | "nothing" };

/** What a sale would move now: the new movements (numbered from the next), the lines left out, and each article as it would be. */
export type SalePlan = { readonly added: readonly Movement[]; readonly skipped: readonly Skipped[] };

/** What a sale moved: every movement of it (this run's or an earlier one's), and the lines left out, with why. */
export type SaleOutcome =
	| { readonly broken: true }
	| { readonly full: true }
	| {
			readonly broken: false;
			readonly moved: readonly { readonly item: StockItem; readonly move: Movement; readonly negative: boolean }[];
			readonly skipped: readonly Skipped[];
	  };

/** The seam sales_invoices is given: the magazzino read (to show what an issue would move) and moved by an invoice issued, once per invoice and line. */
export type StockLink = Pick<StockStore, "read" | "sale">;

const saleKey = (invoice: string, line: number) => `${invoice}#${line}`;

/**
 * The movements a sale would add to `book`, without writing: each line naming a voce that is an
 * article here, not moved before (kept or folded by a closed year). A line in the article's unit,
 * or in its pack (a scatola of 12: twelve times); another unit, or a quantity that does not read,
 * is left out. A storno never puts back more than the invoice it corrects took out of that
 * article, less the storni before it.
 */
export function planSale(book: Pick<Book, "items" | "moves" | "archived" | "nextMove">, sale: Sale, marker: Marker): SalePlan {
	const skipped: Skipped[] = [];
	const added: Movement[] = [];
	let next = book.nextMove;
	const done = new Set([...book.moves.flatMap((m) => (m.sale === undefined ? [] : [saleKey(m.sale.invoice, m.sale.line)])), ...book.archived.map((a) => a.k)]);
	for (const l of sale.lines) {
		const item = book.items.find((i) => i.removed === undefined && i.listino === l.listino);
		if (item === undefined || done.has(saleKey(sale.invoice, l.line))) continue;
		const read = saleQuantity(item, l.quantity, l.unit);
		if ("why" in read) {
			skipped.push({ description: l.description, why: read.why });
			continue;
		}
		let qty = read.qty;
		if (sale.of !== undefined) {
			const of = sale.of;
			const moves = [...book.moves, ...added];
			const out = moves.filter((m) => m.item === item.id && m.kind === "scarico" && m.sale?.invoice === of).reduce((n, m) => n + qtyOf(m.qty), 0n) + book.archived.filter((a) => a.i === item.id && a.of === undefined && a.k.startsWith(`${of}#`)).reduce((n, a) => n + qtyOf(a.q), 0n);
			const back = moves.filter((m) => m.item === item.id && m.kind === "storno" && m.sale?.of === of).reduce((n, m) => n + qtyOf(m.qty), 0n) + book.archived.filter((a) => a.i === item.id && a.of === of).reduce((n, a) => n + qtyOf(a.q), 0n);
			if (out - back < qty) qty = out - back;
			if (qty <= 0n) {
				skipped.push({ description: l.description, why: "nothing" });
				continue;
			}
		}
		const ref = { invoice: sale.invoice, line: l.line, number: sale.number, ...(sale.of === undefined ? {} : { of: sale.of }) };
		added.push(
			sale.of === undefined
				? { id: moveId(next), item: item.id, kind: "scarico", qty: qtyText(qty), day: sale.day, reason: "vendita", sale: ref, ...costAt(item, [...book.moves, ...added]), ...marker }
				: { id: moveId(next), item: item.id, kind: "storno", qty: qtyText(qty), day: sale.day, sale: ref, ...marker },
		);
		next += 1;
	}
	return { added, skipped };
}

/** The average cost an article goes out at now (the margin's cost of goods sold), when it has one that a movement holds. */
function costAt(item: StockItem, moves: readonly Movement[]): { cost?: string } {
	const average = stateOf(item, moves).average;
	return average === undefined || average <= 0n || !isCost(costText(average)) ? {} : { cost: costText(average) };
}

/** What a closed year folded: the movements and the articles. */
export type Closed = { readonly folded: number; readonly items: number };

export class StockStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "stock.json"),
			empty: EMPTY,
			maxBytes: STOCK_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new StockError(STOCK_BROKEN),
			full: () => new StockError(STOCK_FULL),
		};
	}

	/** Never throws. */
	read(): StockBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write, "unchanged"). "rerun" when the call wrote already. The
	 * movements only grow: one changed or dropped is refused. StockError from `change` stops it with
	 * nothing written.
	 */
	update(callId: string, change: (state: StockState) => StockState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const state: StockState = { nextItem: book.nextItem, nextMove: book.nextMove, items: book.items, moves: book.moves };
			const next = change(state);
			if (next === state) return book;
			outcome = "written";
			return made(book, next, [...book.calls, callId].slice(-STOCK_LIMITS.calls));
		});
		return outcome;
	}

	/**
	 * An invoice received loaded, once per `callId`: `plan` gets the book as saved now and gives
	 * the articles added, the carichi, the keys of the lines they load and what was learned (a code,
	 * description or unit said again for the same supplier points to its new article). A line
	 * already loaded is refused, nothing written; so is a load that does not hold together, each
	 * with why.
	 */
	receiveInvoice(callId: string, plan: (book: Book) => InvoiceLoad): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const load = plan(book);
			if (load.moves.length === 0) return book;
			const why = loadProblem(book, load);
			if (why !== undefined) throw new StockError(why);
			const base = made(book, { nextItem: book.nextItem + load.items.length, nextMove: book.nextMove + load.moves.length, items: [...book.items, ...load.items], moves: [...book.moves, ...load.moves] }, [...book.calls, callId].slice(-STOCK_LIMITS.calls));
			const learned = new Set(load.codes.map(codeMapKey));
			const codes = [...book.codes.filter((c) => !learned.has(codeMapKey(c))), ...load.codes].slice(-STOCK_LIMITS.codes);
			const told = new Set(load.units.map(unitMapKey));
			const units = [...book.units.filter((u) => !told.has(unitMapKey(u))), ...load.units].slice(-STOCK_LIMITS.units);
			const out: Book = { ...base, received: [...book.received, ...load.keys], codes, units };
			if (validBook(out) === undefined) throw new StockError("quello che ho imparato da questa fattura (codici, descrizioni, unità) non si salva: non ho caricato niente");
			outcome = "written";
			return out;
		});
		return outcome;
	}

	/**
	 * The crossings of `wanted` not said yet, marked said by `callId`: each crossing once. A call
	 * run again gets back what it claimed.
	 */
	claim(callId: string, wanted: readonly Omit<LowClaim, "call">[]): LowClaim[] {
		let mine: LowClaim[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before;
				return book;
			}
			const said = (w: Omit<LowClaim, "call">) => book.alerts.some((a) => a.item === w.item && a.crossing === w.crossing);
			const fresh = wanted.filter((w) => !said(w) && book.items.some((i) => i.id === w.item)).map((w) => ({ ...w, call: callId }));
			mine = fresh;
			if (fresh.length === 0) return book;
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-STOCK_LIMITS.alerts) };
		});
		return mine;
	}

	/**
	 * An invoice issued unloads (vendita), a credit note reloads (storno): planSale under the lock,
	 * written once per invoice and line. A vendita past what there is is recorded all the same (the
	 * sale happened): the article is «in negativo» until a count. `{ broken: true }` when the file
	 * does not read, `{ full: true }` when it holds no more.
	 */
	sale(sale: Sale, marker: Marker): SaleOutcome {
		if (this.read().broken) return { broken: true };
		let skipped: readonly Skipped[] = [];
		try {
			updateBook(this.book, (book) => {
				const plan = planSale(book, sale, marker);
				skipped = plan.skipped;
				if (plan.added.length === 0) return book;
				return made(book, { nextItem: book.nextItem, nextMove: book.nextMove + plan.added.length, items: book.items, moves: [...book.moves, ...plan.added] }, book.calls);
			});
		} catch (error) {
			if (error instanceof StockError && error.message === STOCK_FULL) return { full: true };
			if (error instanceof StockError && error.message === STOCK_BROKEN) return { broken: true };
			throw error;
		}
		const now = this.read();
		const moved = now.moves
			.filter((m) => m.sale?.invoice === sale.invoice)
			.map((move) => {
				const item = now.items.find((i) => i.id === move.item) as StockItem;
				return { item, move, negative: stateOf(item, now.moves).negative };
			});
		return { broken: false, moved, skipped };
	}

	/**
	 * A year closed, once per `callId`: the movements up to `day` (the longest run from the first
	 * whose day is not after it, never splitting a carico from the correction of its cost) become
	 * one apertura per article, carrying what there was, the average cost exactly, and whether it
	 * was in negativo or under its minimum (with the movement it went so with, so the brief does not
	 * say it again). The sales' movements folded leave their keys, so an invoice line still moves
	 * once and a credit note's cap stays. Undefined when nothing is to fold; "rerun" when the call
	 * closed already.
	 */
	close(callId: string, day: string, marker: Marker, plan = false): Closed | "rerun" | undefined {
		let result: Closed | "rerun" | undefined;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				result = "rerun";
				return book;
			}
			let cut = 0;
			while (cut < book.moves.length && (book.moves[cut] as Movement).day <= day) cut++;
			// A correction after the cut of a carico before it: the cut goes back before that carico.
			for (let moved = true; moved; ) {
				moved = false;
				for (const m of book.moves.slice(cut)) {
					const at = m.kind === "costo" ? book.moves.findIndex((x) => x.id === m.fixes) : -1;
					if (at >= 0 && at < cut) {
						cut = at;
						moved = true;
					}
				}
			}
			const old = book.moves.slice(0, cut);
			const kept = book.moves.slice(cut);
			// Nothing to fold: none, or only the aperture of a year closed before.
			if (old.length === 0 || old.every((m) => m.kind === "apertura")) return book;
			const openings: Movement[] = [];
			for (const item of book.items) {
				const mine = old.filter((m) => m.item === item.id);
				if (mine.length === 0) continue;
				const s = stateOf(item, mine);
				const last = mine.reduce((a, b) => (a.id > b.id ? a : b));
				openings.push({
					id: last.id,
					item: item.id,
					kind: "apertura",
					qty: qtyText(s.onHand),
					day,
					...(s.average === undefined ? {} : { cost: costText(s.average) }),
					...(s.negativeSince === undefined ? {} : { negative: s.negativeSince }),
					...(s.lowBase === undefined ? {} : { low: s.lowBase }),
					...marker,
				});
			}
			openings.sort((a, b) => a.id.localeCompare(b.id));
			// An article in negativo past what a line holds: counted first, then the year closes.
			const under = openings.find((o) => !isQuantity(o.qty, true));
			if (under !== undefined) throw new StockError(`l'articolo ${under.item} a quella data risulta a ${qtyText(qtyOf(under.qty))}, troppo in negativo per una riga di apertura: prima chi ti scrive faccia un conteggio di quell'articolo, poi chiudi l'anno`);
			// The sale keys kept, with the invoice's year; those of invoices ten years or more before the year closed go (no credit note corrects them any more).
			const year = Number(day.slice(0, 4));
			const archived = [...book.archived, ...old.flatMap((m): SaleKey[] => (m.sale === undefined ? [] : [{ k: saleKey(m.sale.invoice, m.sale.line), i: m.item, q: m.qty, y: Number(m.day.slice(0, 4)), ...(m.sale.of === undefined ? {} : { of: m.sale.of }) }]))].filter((a) => a.y === undefined || a.y > year - 10);
			// The invoices received loaded go the same way, ten years on.
			const received = book.received.filter((r) => r.y > year - 10);
			result = { folded: old.length, items: openings.length };
			if (plan) return book;
			const out: Book = { ...book, moves: [...openings, ...kept], archived, received, calls: [...book.calls, callId].slice(-STOCK_LIMITS.calls) };
			if (validBook(out) === undefined) throw new StockError("la chiusura dell'anno non torna: non l'ho salvata");
			return out;
		});
		return result;
	}
}

/** Why a load of an invoice received does not hold together, said for the person; undefined when it does. */
function loadProblem(book: Book, load: InvoiceLoad): string | undefined {
	const keys = new Set(load.keys.map((k) => k.k));
	if (keys.size !== load.keys.length) return "due righe di questa fattura hanno lo stesso numero: non ho caricato niente";
	const done = new Set(book.received.map((r) => r.k));
	if (load.keys.some((k) => done.has(k.k))) return "una riga di questa fattura è già stata caricata nel frattempo: non ho caricato niente, ricontrolla";
	if (book.received.length + load.keys.length > STOCK_LIMITS.received) return STOCK_FULL;
	if (load.keys.some((k) => !validReceivedKey(k))) return "la data di questa fattura non è un giorno vero dal 2000 in poi: non ho caricato niente";
	const learned = new Map<string, string>();
	for (const c of load.codes) {
		if (!validCodeMap(c)) return "un codice o una descrizione del fornitore è troppo lungo per ricordarlo: non ho caricato niente";
		const was = learned.get(codeMapKey(c));
		if (was !== undefined && was !== c.i) return "lo stesso codice del fornitore è su due righe con articoli diversi: non ho caricato niente";
		learned.set(codeMapKey(c), c.i);
	}
	if (load.units.some((u) => !validUnitMap(u))) return "un'unità del fornitore non si ricorda così (troppo lunga, o non è una quantità): non ho caricato niente";
	const names = new Set(book.items.filter((i) => i.removed === undefined).map((i) => i.name.toLowerCase()));
	let next = book.nextItem;
	for (const i of load.items) {
		if (!validItem(i) || i.id !== stockItemId(next++)) return "un articolo nuovo di questa fattura non si aggiunge così (nome o unità non validi): non ho caricato niente";
		if (names.has(i.name.toLowerCase())) return "c'è già un articolo con il nome di una riga da aggiungere: scegli quello, non ho caricato niente";
		names.add(i.name.toLowerCase());
	}
	if (book.items.filter((i) => i.removed === undefined).length + load.items.length > STOCK_LIMITS.items) return `ci sono già troppi articoli (al massimo ${STOCK_LIMITS.items}): non ho caricato niente`;
	return undefined;
}

/** The book after a change, checked: the movements before it all there, unchanged, in their place. */
function made(book: Book, next: StockState, calls: readonly string[]): Book {
	if (next.moves.length < book.moves.length || book.moves.some((m, n) => next.moves[n] !== m)) throw new StockError("i movimenti del magazzino non si cambiano: non ho salvato");
	if (next.moves.length > STOCK_LIMITS.moves) throw new StockError(STOCK_FULL);
	const out: Book = { ...book, nextItem: next.nextItem, nextMove: next.nextMove, items: next.items, moves: next.moves, alerts: book.alerts.filter((a) => next.items.some((i) => i.id === a.item)), calls };
	if (validBook(out) === undefined) throw new StockError("il magazzino non è valido: non l'ho salvato");
	return out;
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9_999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextItem) || !counter(b.nextMove)) return undefined;
	if (!Array.isArray(b.items) || b.items.length > STOCK_LIMITS.items || !b.items.every(validItem)) return undefined;
	if (!Array.isArray(b.moves) || b.moves.length > STOCK_LIMITS.moves || !b.moves.every(validMove)) return undefined;
	if (!Array.isArray(b.archived) || b.archived.length > STOCK_LIMITS.archived || !b.archived.every(validSaleKey)) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > STOCK_LIMITS.alerts || !b.alerts.every(validLowClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > STOCK_LIMITS.calls || !b.calls.every(validStockCall)) return undefined;
	// A file from before the invoices received were loaded has neither list.
	const received = b.received ?? [];
	const codes = b.codes ?? [];
	if (!Array.isArray(received) || received.length > STOCK_LIMITS.received || !received.every(validReceivedKey) || new Set(received.map((r) => r.k)).size !== received.length) return undefined;
	if (!Array.isArray(codes) || codes.length > STOCK_LIMITS.codes || !codes.every(validCodeMap) || new Set(codes.map(codeMapKey)).size !== codes.length) return undefined;
	const units = b.units ?? [];
	if (!Array.isArray(units) || units.length > STOCK_LIMITS.units || !units.every(validUnitMap) || new Set(units.map(unitMapKey)).size !== units.length) return undefined;
	// Numbers never given again: every id below its counter, each once; one article on the list per name, code and voce.
	const ids = new Set<string>();
	const taken = new Set<string>();
	for (const x of b.items) {
		if (Number(STOCK_ID.exec(x.id)?.[1]) >= b.nextItem || ids.has(x.id)) return undefined;
		ids.add(x.id);
		if (x.removed !== undefined) continue;
		for (const key of [`n:${x.name.toLowerCase()}`, ...(x.code === undefined ? [] : [`c:${x.code.toLowerCase()}`]), ...(x.listino === undefined ? [] : [`l:${x.listino}`])]) {
			if (taken.has(key)) return undefined;
			taken.add(key);
		}
	}
	// Movements in their order, each of an article here; a sale's line moved once; a correction of an earlier carico of its article; aperture first, one per article.
	let last = 0;
	const sales = new Set(b.archived.map((a) => a.k));
	if (sales.size !== b.archived.length) return undefined;
	const seen = new Map<string, Movement>();
	const opened = new Set<string>();
	let pastOpenings = false;
	for (const m of b.moves) {
		const n = Number(MOVE_ID.exec(m.id)?.[1]);
		if (n <= last || n >= b.nextMove || !ids.has(m.item)) return undefined;
		last = n;
		if (m.kind === "apertura") {
			if (pastOpenings || opened.has(m.item)) return undefined;
			opened.add(m.item);
		} else pastOpenings = true;
		if (m.kind === "costo") {
			const fixed = seen.get(m.fixes as string);
			if (fixed === undefined || fixed.kind !== "carico" || fixed.item !== m.item) return undefined;
		}
		if (m.sale !== undefined) {
			const key = saleKey(m.sale.invoice, m.sale.line);
			if (sales.has(key)) return undefined;
			sales.add(key);
		}
		seen.set(m.id, m);
	}
	if (codes.some((c) => !ids.has(c.i)) || units.some((u) => !ids.has(u.i))) return undefined;
	return { ...b, received, codes, units };
}
