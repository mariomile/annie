import { AGENT_CHANNEL } from "../agent-messages.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { euros, n1 } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { dayOfIn, todayIn } from "../italian-calendar.ts";
import type { Marker } from "../marker.ts";
import { keyWithin, nearKey, spellingKey } from "../name-keys.ts";
import { inPeriod, PeriodError, readPeriod } from "../periods.ts";
import { findItems, parseItemId, type PriceItem } from "../price-list.ts";
import { PRICE_LIST_BROKEN, type PriceListStore } from "../price-list-store.ts";
import { readRegister } from "../register-read.ts";
import { type Movement, type Reason, REASON_WORDS, REASONS, STOCK_LIMITS, STOCK_OPS, stockAgentReads, StockError, type StockItem, stockItemId, type StockOp, stockUnit, moveId } from "../stock.ts";
import { STOCK_BROKEN, type StockState, type StockStore } from "../stock-store.ts";
import { costOf, type ItemState, isLow, qtyOf, qtyText, stateOf } from "../stock-sums.ts";
import { findSupplier, loadSuppliers, meantSupplier } from "../supplier-find.ts";
import type { SupplierStore } from "../supplier-store.ts";
import { cleanText, isProblem, readAmount } from "../text-input.ts";
import { requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { BRIEF_NOTHING, briefAnswer, costWords, fencedStock, listAnswer, lowAnswer, movesAnswer, NO_ITEMS, qtyWords, statusAnswer, stockCsv, valueAnswer } from "./stock-render.ts";

/** What changed, for the audit: the op and how many, never names, quantities, costs or suppliers. */
export type StockEvent = { readonly type: "stock.changed"; readonly op: "add_item" | "receive" | "unload" | "count" | "remove_item" | "export"; readonly count: number };

export type StockToolsOptions = {
	readonly workspace: Workspace;
	readonly store: StockStore;
	/** The listino, read only: an article may be one of its voci (then an invoice issued with it unloads it). */
	readonly priceList?: Pick<PriceListStore, "read">;
	/** Where a carico's supplier is found, the suppliers' way (supplier-find.ts), read only: the scadenzario through its scanner, the expenses, the supplier cards. Without them the supplier is kept as said. */
	readonly invoices?: Pick<InvoiceStore, "read">;
	readonly scanner?: InvoiceScanner;
	readonly expenses?: Pick<ExpenseStore, "read">;
	readonly suppliers?: Pick<SupplierStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: StockEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Il magazzino: the stock of the person's shop or workshop, article by article (MG-0001), from its movements: carichi, scarichi, inventory counts and the credit notes' returns. Quantities may have 3 decimals (kg, m, l). The value is at the weighted average cost, which only a carico changes.",
	"What the person says → op: «aggiungi le cartucce XL al magazzino, a pezzi, avvisami sotto le 10» → add_item (item, unit, min); «avvisami sotto le 10 cartucce» on an article there already → add_item with min (it changes the article); «ho ricevuto 50 cartucce XL dal fornitore Beta a 12 € l'una» → receive (item, quantity 50, cost 12, supplier); «ne ho usate 2 in negozio» → unload (reason uso_interno); «ho buttato 3 rotoli rovinati» → unload (reason scarto); «quante cartucce mi restano?» → status; «cosa ho in magazzino?» → list; «cosa sta finendo?» → low; «quanto vale il magazzino?» → value; «movimenti delle cartucce di ottobre» → movements (item, period); «ho contato 37 cartucce, sistema» → count (item, quantity 37); «togli le cartucce dal magazzino» → remove_item; «fammi il file del magazzino» → export, then file_send.",
	"An article that is a voce of the listino (item LS-0001 on add_item) is unloaded by the sales invoices issued with that voce, and put back by their credit notes: never unload a sale invoiced so. price_list is the prices, stock the quantities. A scarico past what there is asks first: repeat with confirm true only after the person's yes. summary of the brief: low with compact true. Repeat quantities and amounts as given, never compute them yourself.",
].join(" ");

/**
 * Il magazzino (stock.ts): the articles and their movements kept here, the listino and the
 * suppliers read only. add_item, receive, unload, count, remove_item and the export change
 * something (and the brief's low, which marks its alerts as said); the rest only reads. Today is
 * read once per call.
 */
export function createStockTools(options: StockToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: StockEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "stock.changed", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const amount = (description: string) => ({ type: ["number", "string"], description });
	return [
		{
			name: "stock",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...STOCK_OPS] },
					item: text(STOCK_LIMITS.name, "the article: its name as said, its id MG-0001, its code, or (add_item) a voce of the listino LS-0001"),
					unit: text(STOCK_LIMITS.unit, "add_item: pezzi, kg, m, litri… (default: the listino's unit, else pezzi)"),
					min: amount("add_item: the minimum level, under it the article is sottoscorta («avvisami sotto le 10»); 0 removes it"),
					code: text(STOCK_LIMITS.code, "add_item: the person's own code or SKU"),
					place: text(STOCK_LIMITS.place, "add_item: where it is kept («scaffale B»)"),
					category: text(STOCK_LIMITS.category, "add_item: a category, for the value by category"),
					quantity: amount("receive, unload: how many; count: how many were counted"),
					cost: amount("receive: the unit cost in euros, VAT excluded («12», «0,85»)"),
					supplier: text(STOCK_LIMITS.name, "receive: the supplier, as said or partita IVA"),
					doc: text(STOCK_LIMITS.doc, "receive: the document's reference (DDT, invoice number)"),
					reason: { type: "string", enum: [...REASONS], description: "unload: why: vendita, uso_interno, reso (to the supplier), scarto" },
					note: text(STOCK_LIMITS.note, "receive, unload, count: a short note"),
					period: text(40, "movements: «ottobre», «questo mese», «2026»"),
					confirm: { type: "boolean", description: "unload: the person said yes to going under zero" },
					compact: { type: "boolean", description: "low: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!STOCK_OPS.includes(args.op as StockOp)) return "Errore: non conosco questa operazione sul magazzino.";
				const op = args.op as StockOp;
				for (const key of ["compact", "confirm"]) if (args[key] !== undefined && typeof args[key] !== "boolean") return `Errore: ${key === "compact" ? "compact" : "la conferma"} è sì o no.`;
				// Another agente's request is not the person's word: names and quantities, nothing else.
				const agent = ctx.thread?.channel === AGENT_CHANNEL;
				if (agent && !stockAgentReads(args)) return "Errore: a un altro agente do solo l'elenco degli articoli e cosa sta finendo, con nomi e quantità. Non do costi, valori, fornitori o movimenti e non cambio niente; il resto lo chiede chi ti scrive, nella sua conversazione.";
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "add_item":
							return await addItem(args, ctx);
						case "receive":
							return await receive(args, ctx, day);
						case "unload":
							return await unload(args, ctx, day);
						case "count":
							return await count(args, ctx, day);
						case "status":
							return status(args);
						case "list":
							return listAnswer(states(), agent);
						case "low":
							return args.compact === true ? await brief(ctx) : lowAnswer(states(), agent);
						case "value":
							return valueAnswer(states());
						case "movements":
							return movements(args, day);
						case "remove_item":
							return await removeItem(args, ctx);
						case "export":
							return await exportCsv(ctx, day);
					}
				} catch (error) {
					if (error instanceof StockError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function book() {
		const b = store.read();
		if (b.broken) throw new StockError(STOCK_BROKEN);
		return b;
	}

	function active(items: readonly StockItem[]): StockItem[] {
		return items.filter((i) => i.removed === undefined);
	}

	function states(): ItemState[] {
		const b = book();
		return active(b.items).map((i) => stateOf(i, b.moves));
	}

	/** The article said: by id, voce of the listino, code or name; one a slip away is taken only when it is the only one. */
	function found(items: readonly StockItem[], said: string, strict = false): { item: StockItem } | { close: StockItem[] } | "none" {
		const t = said.trim();
		const mg = /^\s*mg\s*-?\s*0*(\d{1,6})\s*$/i.exec(t);
		if (mg !== null) {
			const i = items.find((x) => x.id === stockItemId(Number(mg[1])));
			return i === undefined ? "none" : { item: i };
		}
		const ls = parseItemId(t);
		if (ls !== undefined) {
			const i = items.find((x) => x.listino === ls);
			return i === undefined ? "none" : { item: i };
		}
		const byCode = items.find((x) => x.code !== undefined && x.code.toLowerCase() === t.toLowerCase());
		if (byCode !== undefined) return { item: byCode };
		const key = spellingKey(t);
		if (key === "") return "none";
		const same = items.filter((x) => spellingKey(x.name) === key);
		if (same.length === 1) return { item: same[0] as StockItem };
		if (strict) return "none";
		const near = items.filter((x) => nearKey(spellingKey(x.name), key));
		const within = items.filter((x) => !near.includes(x) && keyWithin(spellingKey(x.name), key));
		if (near.length === 1 && within.length === 0) return { item: near[0] as StockItem };
		const close = [...near, ...within];
		return close.length === 0 ? "none" : { close };
	}

	/** The article an op names, or the answer to give instead. */
	function named(args: Record<string, unknown>, items: readonly StockItem[]): StockItem | string {
		const said = cleanText(args.item, STOCK_LIMITS.name, "il nome dell'articolo");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi quale articolo: il nome, o il suo numero (MG-0001).";
		const f = found(active(items), said);
		if (f === "none") return ["Non trovo questo articolo in magazzino:", fencedStock(said), "Chiedi a chi ti scrive se va aggiunto, con la sua unità (pezzi, kg, metri, litri)."].join("\n");
		if ("close" in f) return [f.close.length === 1 ? "Intendi questo articolo? Nessuno si chiama esattamente così:" : "Intendi uno di questi? Nessun articolo si chiama esattamente così:", fencedStock(f.close.slice(0, 8).map((i) => `• ${i.name} (${i.id})`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il suo numero."].join("\n");
		return f.item;
	}

	function readQuantity(value: unknown, what: string, zero: boolean): string | { problem: string } {
		const read = readAmount(value, 3, what, fencedStock);
		if (read === undefined) return { problem: `dimmi ${what}` };
		if (isProblem(read)) return read;
		if ((!zero && Number(read) <= 0) || Number(read) > STOCK_LIMITS.maxQuantity) return { problem: `${what}: un numero maggiore di zero, al più 3 decimali` };
		return read;
	}

	/** The voce of the listino `said` is: by its id, or by its exact name; undefined when none. */
	function listinoOf(said: string): PriceItem | string | undefined {
		if (options.priceList === undefined) return parseItemId(said) === undefined ? undefined : "Errore: qui non vedo il listino.";
		const list = options.priceList.read();
		if (list.broken) return parseItemId(said) === undefined ? undefined : `Errore: ${PRICE_LIST_BROKEN}.`;
		const f = findItems(list.items, said);
		if (parseItemId(said) !== undefined) return f.kind === "exact" ? f.item : "Errore: nel listino non c'è una voce con questo numero.";
		return f.kind === "exact" && f.slip !== true ? f.item : undefined;
	}

	async function addItem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const said = cleanText(args.item, STOCK_LIMITS.name, "il nome dell'articolo");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi il nome dell'articolo, o la voce del listino (LS-0001).";
		const code = cleanText(args.code, STOCK_LIMITS.code, "il codice");
		if (isProblem(code)) return `Errore: ${code.problem}.`;
		const place = cleanText(args.place, STOCK_LIMITS.place, "il posto");
		if (isProblem(place)) return `Errore: ${place.problem}.`;
		const category = cleanText(args.category, STOCK_LIMITS.category, "la categoria");
		if (isProblem(category)) return `Errore: ${category.problem}.`;
		const unitSaid = cleanText(args.unit, STOCK_LIMITS.unit, "l'unità");
		if (isProblem(unitSaid)) return `Errore: ${unitSaid.problem}.`;
		const min = args.min === undefined ? undefined : readQuantity(args.min, "il minimo", true);
		if (isProblem(min)) return `Errore: ${min.problem}.`;
		const voce = listinoOf(said);
		if (typeof voce === "string") return voce;
		const b = book();
		const by = marker(ctx);
		// The same article said again (by name, code, id or voce): its minimum, place, category, code change.
		const there = found(active(b.items), said, true);
		const old = typeof there === "object" && "item" in there ? there.item : voce === undefined ? undefined : active(b.items).find((i) => i.listino === voce.id);
		const unit = unitSaid === undefined ? undefined : stockUnit(unitSaid);
		const notes: string[] = [];
		const applied = await ctx.step("apply", async () => {
			let id = "";
			let changed = false;
			const outcome = store.update(ctx.callId, (state): StockState => {
				const now = old === undefined ? undefined : state.items.find((i) => i.id === old.id && i.removed === undefined);
				if (old !== undefined && now === undefined) throw new StockError("l'articolo è stato tolto nel frattempo");
				if (now !== undefined) {
					id = now.id;
					if (unit !== undefined && unit !== now.unit && state.moves.some((m) => m.item === now.id)) throw new StockError(`l'articolo ${now.id} ha già movimenti in ${now.unit}: l'unità non si cambia più`);
					const next: StockItem = {
						...now,
						...(unit === undefined ? {} : { unit }),
						...(code === undefined ? {} : { code }),
						...(place === undefined ? {} : { place }),
						...(category === undefined ? {} : { category }),
						...(min === undefined || Number(min) === 0 ? {} : { min }),
					};
					if (min !== undefined && Number(min) === 0) delete (next as { min?: string }).min;
					if (JSON.stringify(next) === JSON.stringify(now)) return state;
					changed = true;
					clash(state.items, next);
					return { ...state, items: state.items.map((i) => (i.id === now.id ? { ...next, edited: by } : i)) };
				}
				if (active(state.items).length >= STOCK_LIMITS.items) throw new StockError(`ci sono già ${STOCK_LIMITS.items} articoli, il massimo: togline qualcuno prima`);
				id = stockItemId(state.nextItem);
				const voceUnit = voce?.unit === undefined || voce.unit === "forfait" ? undefined : stockUnit(voce.unit);
				const made: StockItem = {
					id,
					name: (voce?.name ?? said).slice(0, STOCK_LIMITS.name),
					unit: unit ?? voceUnit ?? "pezzo",
					...(min === undefined || Number(min) === 0 ? {} : { min }),
					...(code === undefined ? {} : { code }),
					...(place === undefined ? {} : { place }),
					...(category === undefined ? {} : { category }),
					...(voce === undefined ? {} : { listino: voce.id }),
					callId: ctx.callId,
					...by,
				};
				clash(state.items, made);
				changed = true;
				return { ...state, nextItem: state.nextItem + 1, items: [...state.items, made] };
			});
			if (outcome === "rerun") return { id: book().items.find((i) => i.callId === ctx.callId)?.id ?? old?.id ?? "", changed: true, created: old === undefined };
			return { id, changed, created: old === undefined };
		});
		if (applied.changed) await audit(ctx, "add_item", 1);
		const item = book().items.find((i) => i.id === applied.id);
		if (item === undefined) return "Fatto.";
		const s = stateOf(item, book().moves);
		const what = `${item.id}, in ${item.unit === "pezzo" ? "pezzi" : item.unit}${item.min === undefined ? ", senza minimo" : `, avviso sotto ${qtyWords(qtyOf(item.min), item.unit)}`}${old === undefined ? "" : `, ora ${qtyWords(s.onHand, item.unit)}`}`;
		const head = !applied.changed ? `Era già così, non ho cambiato niente: ${what}.` : applied.created ? `Fatto, nuovo articolo ${what}.` : `Fatto, ho aggiornato l'articolo ${what}.`;
		if (applied.created && unit === undefined && item.listino === undefined) notes.push("L'ho messo a pezzi: se si conta in altro modo (kg, metri, litri), dimmelo.");
		if (item.listino !== undefined && applied.created) notes.push(`È la voce ${item.listino} del listino: le fatture emesse con quella voce lo scaricano da sole, e le note di credito lo rimettono.`);
		if (applied.created) notes.push("Per caricare la merce dimmi quanta e a che costo per unità.");
		return [head, ...notes, fencedStock(`Articolo: ${item.name}${item.code === undefined ? "" : `, codice ${item.code}`}${item.place === undefined ? "" : `, posto: ${item.place}`}${item.category === undefined ? "" : `, categoria: ${item.category}`}`)].join("\n");
	}

	/** Name, code and voce are one article's on the list. */
	function clash(items: readonly StockItem[], next: StockItem): void {
		const others = active(items).filter((i) => i.id !== next.id);
		if (others.some((i) => spellingKey(i.name) === spellingKey(next.name))) throw new StockError("c'è già un articolo con questo nome");
		if (next.code !== undefined && others.some((i) => i.code?.toLowerCase() === next.code?.toLowerCase())) throw new StockError("questo codice è già di un altro articolo");
		if (next.listino !== undefined && others.some((i) => i.listino === next.listino)) throw new StockError(`la voce ${next.listino} del listino è già un altro articolo`);
	}

	/** The supplier said for a carico: the one found the suppliers' way, as said when none is, or what to ask when it may be more than one. */
	async function supplierOf(said: string, ctx: ToolContext): Promise<{ name: string; vat?: string; note?: string } | string> {
		if (options.invoices === undefined && options.suppliers === undefined) return { name: said };
		const read = options.invoices === undefined ? undefined : await readRegister(options.invoices, options.scanner ?? new InvoiceScanner(workspace), ctx);
		const cards = options.suppliers?.read();
		const expenses = options.expenses?.read();
		const loaded = loadSuppliers({ cards: cards === undefined || cards.broken ? [] : cards.cards, invoices: read?.invoices ?? [], expenses: expenses === undefined || expenses.broken ? [] : expenses.expenses, dayOf: dayOfIn(timeZone) });
		const f = findSupplier(loaded.suppliers, said);
		if (f.kind === "close") return meantSupplier(f.candidates, fencedStock);
		if (f.kind === "none") return { name: said, note: "Il fornitore non è tra quelli che conosco: l'ho segnato come detto." };
		return { name: f.supplier.name.slice(0, STOCK_LIMITS.name), ...(f.supplier.vat === undefined ? {} : { vat: f.supplier.vat }) };
	}

	async function receive(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const item = named(args, b.items);
		if (typeof item === "string") return item;
		const quantity = readQuantity(args.quantity, "quanti ne sono arrivati", false);
		if (isProblem(quantity)) return `Errore: ${quantity.problem}.`;
		if (args.cost === undefined) return "Errore: dimmi il costo per unità, senza IVA: serve per il costo medio e il valore del magazzino.";
		const cost = readAmount(args.cost, 4, "il costo per unità", fencedStock);
		if (cost === undefined || isProblem(cost)) return `Errore: ${cost?.problem ?? "dimmi il costo per unità"}.`;
		if (Number(cost) <= 0 || Number(cost) > STOCK_LIMITS.maxCost) return `Errore: il costo per unità va da più di zero a ${STOCK_LIMITS.maxCost.toLocaleString("it-IT")} €.`;
		const doc = cleanText(args.doc, STOCK_LIMITS.doc, "il documento");
		if (isProblem(doc)) return `Errore: ${doc.problem}.`;
		const note = cleanText(args.note, STOCK_LIMITS.note, "la nota");
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const supplierSaid = cleanText(args.supplier, STOCK_LIMITS.name, "il fornitore");
		if (isProblem(supplierSaid)) return `Errore: ${supplierSaid.problem}.`;
		const supplier = supplierSaid === undefined ? undefined : await supplierOf(supplierSaid, ctx);
		if (typeof supplier === "string") return supplier;
		const before = stateOf(item, b.moves);
		const move = await write(ctx, item, (id) => ({
			id,
			item: item.id,
			kind: "carico",
			qty: quantity,
			day,
			cost,
			...(supplier === undefined ? {} : { supplier: { name: supplier.name, ...(supplier.vat === undefined ? {} : { vat: supplier.vat }) } }),
			...(doc === undefined ? {} : { doc }),
			...(note === undefined ? {} : { note }),
		}));
		await audit(ctx, "receive", 1);
		const after = stateOf(item, book().moves);
		const lines = [`Fatto, carico ${move.id} su ${item.id}: +${qtyWords(qtyOf(quantity), item.unit)} a ${costWords(costOf(cost))} l'uno. Ora ${qtyWords(after.onHand, item.unit)}, costo medio ${after.average === undefined ? "da sapere" : costWords(after.average)}${before.average !== undefined && after.average !== before.average ? ` (era ${costWords(before.average)})` : ""}, valore ${euros(after.value ?? 0n)}.`];
		if (supplier?.note !== undefined) lines.push(supplier.note);
		const inside = [`Articolo: ${item.name}`, ...(supplier === undefined ? [] : [`Fornitore: ${supplier.name}`]), ...(doc === undefined ? [] : [`Documento: ${doc}`]), ...(note === undefined ? [] : [`Nota: ${note}`])];
		lines.push(fencedStock(inside.join("\n")));
		return lines.join("\n");
	}

	/** A movement written once per call (the step keeps its id): the one this call wrote, run again. */
	async function write(ctx: ToolContext, item: StockItem, make: (id: string, state: StockState) => Omit<Movement, "by" | "at">, check?: (state: StockState) => void): Promise<Movement> {
		const by = marker(ctx);
		const id = await ctx.step("apply", async () => {
			let made = "";
			const outcome = store.update(ctx.callId, (state) => {
				if (!state.items.some((i) => i.id === item.id && i.removed === undefined)) throw new StockError("l'articolo è stato tolto nel frattempo");
				check?.(state);
				const m = { ...make(moveId(state.nextMove), state), callId: ctx.callId, ...by } as Movement;
				made = m.id;
				return { ...state, nextMove: state.nextMove + 1, moves: [...state.moves, m] };
			});
			if (outcome === "rerun") return book().moves.find((m) => m.callId === ctx.callId)?.id ?? "";
			return made;
		});
		const move = book().moves.find((m) => m.id === id);
		if (move === undefined) throw new StockError("il movimento non risulta salvato");
		return move;
	}

	async function unload(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const item = named(args, b.items);
		if (typeof item === "string") return item;
		const quantity = readQuantity(args.quantity, "quanti ne sono usciti", false);
		if (isProblem(quantity)) return `Errore: ${quantity.problem}.`;
		if (!REASONS.includes(args.reason as Reason)) return "Errore: dimmi perché escono: vendita, uso interno, reso al fornitore o scarto.";
		const reason = args.reason as Reason;
		const note = cleanText(args.note, STOCK_LIMITS.note, "la nota");
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const q = qtyOf(quantity);
		const mine = b.moves.find((m) => m.callId === ctx.callId);
		const before = stateOf(item, b.moves);
		// Past what there is: asked once, recorded only with the person's yes, in a turn of theirs.
		if (mine === undefined && before.onHand - q < 0n) {
			if (args.confirm !== true)
				return `In magazzino risultano ${qtyWords(before.onHand, item.unit)} di ${item.id}: scaricandone ${qtyWords(q, item.unit)} andrebbe in negativo di ${qtyWords(q - before.onHand, item.unit)}. Chiedi a chi ti scrive se va bene lo stesso (di solito vuol dire che manca un carico); con il suo sì ripeti con la conferma, e l'articolo resta segnato in negativo fino al prossimo conteggio.`;
			const refused = requirePersonFor(ctx, "registro uno scarico che manda il magazzino in negativo");
			if (refused !== undefined) return refused;
		}
		const move = await write(
			ctx,
			item,
			(id) => ({ id, item: item.id, kind: "scarico", qty: quantity, day, reason, ...(note === undefined ? {} : { note }) }),
			(state) => {
				// Changed meanwhile: past zero now, without the yes.
				if (args.confirm !== true && stateOf(item, state.moves).onHand - q < 0n) throw new StockError("nel frattempo la quantità è cambiata e questo scarico manderebbe l'articolo in negativo: ricontrolla con chi ti scrive");
			},
		);
		await audit(ctx, "unload", 1);
		const after = stateOf(item, book().moves);
		const lines = [`Fatto, scarico ${move.id} su ${item.id}: −${qtyWords(q, item.unit)}, ${REASON_WORDS[reason]}. Ora ${qtyWords(after.onHand, item.unit)}.`];
		if (after.negative) lines.push("L'articolo è in negativo: resta segnato così fino al prossimo conteggio.");
		else if (after.lowSince !== undefined) lines.push("Ora è sottoscorta.");
		if (reason === "vendita" && item.listino !== undefined) lines.push(`Attenzione: questo articolo è la voce ${item.listino} del listino, e le fatture emesse con quella voce lo scaricano da sole. Se questa vendita ha una fattura così, è contata due volte: dillo a chi ti scrive.`);
		lines.push(fencedStock(`Articolo: ${item.name}${note === undefined ? "" : `\nNota: ${note}`}`));
		return lines.join("\n");
	}

	async function count(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const item = named(args, b.items);
		if (typeof item === "string") return item;
		const counted = readQuantity(args.quantity, "quanti ne hai contati", true);
		if (isProblem(counted)) return `Errore: ${counted.problem}.`;
		const refused = requirePersonFor(ctx, "correggo il magazzino con un conteggio");
		if (refused !== undefined) return refused;
		const note = cleanText(args.note, STOCK_LIMITS.note, "la nota");
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const before = stateOf(item, b.moves);
		// The difference from what there is as saved when it is written: a movement meanwhile counts.
		const move = await write(ctx, item, (id, state) => {
			const there = stateOf(item, state.moves).onHand;
			return { id, item: item.id, kind: "rettifica", qty: qtyText(qtyOf(counted) - there), day, counted, ...(note === undefined ? {} : { note }) };
		});
		await audit(ctx, "count", 1);
		const d = qtyOf(move.qty);
		const head =
			d === 0n
				? `Fatto, conteggio ${move.id} su ${item.id}: ${qtyWords(qtyOf(counted), item.unit)}, torna con quello che risultava.`
				: `Fatto, rettifica ${move.id} su ${item.id}: contati ${qtyWords(qtyOf(counted), item.unit)}, ne risultavano ${qtyWords(qtyOf(counted) - d, item.unit)}, quindi ${d > 0n ? `+${qtyWords(d, item.unit)}` : `−${qtyWords(-d, item.unit)}`}. I movimenti di prima restano come sono.`;
		const lines = [head];
		if (before.negative) lines.push("Non è più in negativo.");
		const after = stateOf(item, book().moves);
		if (after.lowSince !== undefined) lines.push("È sottoscorta.");
		lines.push(fencedStock(`Articolo: ${item.name}${note === undefined ? "" : `\nNota: ${note}`}`));
		return lines.join("\n");
	}

	function status(args: Record<string, unknown>): string {
		const b = book();
		if (active(b.items).length === 0) return NO_ITEMS;
		if (args.item === undefined) return listAnswer(states(), false);
		const item = named(args, b.items);
		if (typeof item === "string") return item;
		return statusAnswer(stateOf(item, b.moves));
	}

	function movements(args: Record<string, unknown>, day: string): string {
		const b = book();
		let moves = b.moves;
		const parts: string[] = [];
		if (args.item !== undefined) {
			const item = named(args, b.items);
			if (typeof item === "string") return item;
			moves = moves.filter((m) => m.item === item.id);
			parts.push(`di ${item.id}`);
		}
		if (args.period !== undefined) {
			if (typeof args.period !== "string") return "Errore: il periodo è un testo, come «ottobre».";
			try {
				const p = readPeriod(args.period.slice(0, 40), day);
				moves = moves.filter((m) => inPeriod(m.day, p));
				parts.push(p.of);
			} catch (error) {
				if (error instanceof PeriodError) return `Errore: non capisco il periodo: ${fencedStock(args.period.slice(0, 40))}. Dimmi un mese, come «ottobre», o «questo mese».`;
				throw error;
			}
		}
		return movesAnswer(moves, b.items, parts.length === 0 ? "in tutto" : parts.join(" "));
	}

	async function removeItem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const b = book();
		const done = b.calls.includes(ctx.callId);
		let item: StockItem | undefined;
		if (!done) {
			const n = named(args, b.items);
			if (typeof n === "string") return n;
			const s = stateOf(n, b.moves);
			if (s.onHand !== 0n) return `Non lo tolgo: di ${n.id} risultano ancora ${qtyWords(s.onHand, n.unit)}. Se in realtà non ce ne sono, prima un conteggio a zero, poi lo tolgo; i suoi movimenti restano comunque nello storico.`;
			item = n;
		}
		const refused = requirePersonFor(ctx, "tolgo un articolo dal magazzino");
		if (refused !== undefined) return refused;
		const by = marker(ctx);
		// A call run again after it removed: the same answer, from the step.
		const gone = await ctx.step("apply", async () => {
			if (item === undefined) return "";
			const id = item.id;
			const outcome = store.update(ctx.callId, (state) => {
				const now = state.items.find((i) => i.id === id);
				if (now === undefined || now.removed !== undefined) return state;
				if (stateOf(now, state.moves).onHand !== 0n) throw new StockError("nel frattempo la quantità è cambiata: non lo tolgo");
				return { ...state, items: state.items.map((i) => (i.id === id ? { ...i, removed: by } : i)) };
			});
			return outcome === "written" ? id : "";
		});
		// Nothing removed (a call run again with its steps lost): nothing to audit.
		if (gone === "") return done ? "Fatto, l'articolo è tolto." : "L'articolo non c'è già più nell'elenco.";
		await audit(ctx, "remove_item", 1);
		return [`Fatto, ho tolto ${gone} dall'elenco del magazzino. I suoi movimenti restano nello storico.`, ...(item === undefined ? [] : [fencedStock(`Articolo: ${item.name}`)])].join("\n");
	}

	/** The brief's line: the articles that went under their minimum, each crossing said once. */
	async function brief(ctx: ToolContext): Promise<string> {
		const low = states().filter((s) => s.lowSince !== undefined);
		if (low.length === 0) return BRIEF_NOTHING;
		const claims = await ctx.step("claim", async () => store.claim(ctx.callId, low.map((s) => ({ item: s.item.id, crossing: s.lowSince as string }))));
		const said = new Set(claims.map((c) => c.item));
		return briefAnswer(low.filter((s) => said.has(s.item.id)));
	}

	async function exportCsv(ctx: ToolContext, day: string): Promise<string> {
		const all = states();
		if (all.length === 0) return NO_ITEMS;
		const csv = stockCsv(all);
		// The name only from today's date, under magazzino/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `magazzino/magazzino-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		await audit(ctx, "export", all.length);
		const low = all.filter(isLow).length;
		return [`Salvato ${written}: ${n1(all.length, "un articolo", "# articoli")}${low === 0 ? "" : `, ${low} sottoscorta o in negativo in cima`}, con quantità, minimo, costo medio e valore (separatore «;», si apre con Excel).`, "Mandalo con file_send se chi ti scrive lo vuole."].join("\n");
	}
}
