import { createHash } from "node:crypto";
import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { euros, n1 } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { Company } from "../invoices.ts";
import { daysBetween, todayIn } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import { type LeadTime, type Order, type OrderLine, isAwaited, isOpen, ORDER_LIMITS, ORDER_OPS, OrderError, orderId, type OrderOp, orderState } from "../orders.ts";
import { ORDERS_BROKEN, type OrderStore } from "../order-store.ts";
import { latestBySupplier, offersFor, sellersOf, type SuggestData, suggestions } from "../order-suggest.ts";
import { costText, qtyText } from "../stock-sums.ts";
import type { StockItem } from "../stock.ts";
import { STOCK_BROKEN, type StockStore } from "../stock-store.ts";
import type { Supplier } from "../supplier-sums.ts";
import type { SupplierStore } from "../supplier-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { daysSaid, latestOf, linesSaid, orderSaid, type SupplierSaid, supplierSaid } from "./order-input.ts";
import { briefAnswer, expectedTotal, fencedOrders, lineWords, orderBlock, orderMarkdown, orderRow, ordersCsv, suggestAnswer } from "./order-render.ts";
import { loadPurchases } from "./purchase-data.ts";
import { fileSlug } from "./quote-input.ts";

/** What was done, for the audit: the op and how many, never suppliers, articles, quantities or prices. */
export type OrderEvent = { readonly type: "orders.used"; readonly op: OrderOp | "brief"; readonly count: number };

export type OrderToolsOptions = {
	readonly workspace: Workspace;
	readonly store: OrderStore;
	/** The magazzino, read only: the articles, their movements (the pace), the codes and units learned. */
	readonly stock: Pick<StockStore, "read">;
	/** The scadenzario: the invoices received (the prices paid, through the shared scanner) and the company for the document's letterhead. */
	readonly invoices?: Pick<InvoiceStore, "read">;
	readonly scanner?: InvoiceScanner;
	readonly expenses?: Pick<ExpenseStore, "read">;
	readonly suppliers?: Pick<SupplierStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: OrderEvent) => Promise<void>;
	/** Tests: the clock and the document maker (default: the document worker). */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

const DESCRIPTION = [
	"Gli ordini ai fornitori (OR-0001): what to reorder for the magazzino, the orders' drafts per supplier, their document, and whether the goods arrived. Annie never sends an order: the person does, and says so.",
	"What the person says → op: «cosa devo riordinare?», «cosa sta per finire?» → suggest (cover_days: the days of sales past the minimum, default 30); «fammi l'ordine per Beta» → create with supplier (the articles to reorder that Beta sells); «prepara gli ordini» → create (one draft per supplier: the usual one, or prefer cheapest); «ordina 50 cartucce XL dal fornitore che le fa pagare meno» → create with lines [{item, quantity 50}] and prefer cheapest; create first shows the drafts with a check: show them, and only after the person's yes repeat with confirm true and that check. «aggiungi 10 risme all'ordine di Beta», «togli il toner», «senza prezzi» → change (order or supplier; lines [{item, quantity}], quantity 0 takes it off; notes; no_prices) while it is a draft; «fammi il PDF dell'ordine per Beta» → document (format pdf or docx), then offer file_send, or google_mail_send to the supplier with the file attached (it leaves only after the person approves the card); «l'ho mandato» → mark_sent (only when the person says it went out); «annulla l'ordine OR-0002» → cancel; «è arrivato l'ordine di Beta?» → status (supplier or order); «quali ordini ho aperti?» → list (all true for every one); «Beta consegna in 10 giorni» → lead_time (supplier, days); «fammi il file degli ordini» → export, then file_send.",
	"The goods of an order arrive with the supplier's invoice: stock receive_invoice loads it and marks the order; never mark it by hand. Quantities are in the article's unit (or its pack, with unit); prices per unit without IVA. summary of the brief: list with compact true. Repeat quantities and amounts as given, never compute them yourself.",
].join(" ");

const AGENT_REFUSAL = "Errore: gli ordini dicono fornitori, articoli e prezzi, quindi a un altro agente do solo quanti sono: li prepara e li cambia chi ti scrive, nella sua conversazione.";

/** One line of a draft as proposed: the article, how many, the price expected and where it comes from. */
type DraftLine = { readonly item: StockItem; readonly qty: bigint; readonly price?: bigint; readonly priceFrom?: "purchase" | "said"; readonly priceDay?: string };
type Draft = { readonly supplier: SupplierSaid; readonly lines: readonly DraftLine[] };

/**
 * Gli ordini (orders.ts): the orders kept here, the magazzino and the invoices received read
 * only. create, change, mark_sent, cancel, document, export and lead_time write (and the brief's
 * list, which marks what it said); suggest, list and status only read. Today is read once per call.
 */
export function createOrderTools(options: OrderToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const make = options.make ?? ((input: MakeInput) => makeDocumentFile(input));
	const scanner = options.invoices === undefined ? undefined : (options.scanner ?? new InvoiceScanner(workspace));
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: OrderEvent["op"], count: number) => {
		await ctx.step("audit", async () => {
			await options.record?.({ type: "orders.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const amount = (description: string) => ({ type: ["number", "string"], description });

	type Loaded = { readonly data: SuggestData; readonly orders: readonly Order[]; readonly leads: readonly LeadTime[]; readonly suppliers: readonly Supplier[]; readonly notes: readonly string[] };

	/** The orders and the magazzino must read; the prices paid are said when they do not. */
	async function load(ctx: ToolContext): Promise<Loaded | string> {
		const book = store.read();
		if (book.broken) return `Errore: ${ORDERS_BROKEN}.`;
		const stock = options.stock.read();
		if (stock.broken) return `Errore: ${STOCK_BROKEN}.`;
		const notes: string[] = [];
		let rows: SuggestData["purchases"] = [];
		let suppliers: readonly Supplier[] = [];
		if (options.invoices !== undefined && scanner !== undefined) {
			const got = await loadPurchases({ invoices: options.invoices, scanner, ...(options.expenses === undefined ? {} : { expenses: options.expenses }), ...(options.suppliers === undefined ? {} : { suppliers: options.suppliers }), timeZone }, ctx);
			if (typeof got === "string") notes.push(`I prezzi delle fatture ricevute qui mancano: ${got.charAt(0).toLowerCase()}${got.slice(1)}`);
			else {
				rows = got.rows;
				suppliers = got.suppliers;
			}
		}
		return { data: { items: stock.items, moves: stock.moves, purchases: rows, codes: stock.codes, units: stock.units }, orders: book.orders, leads: book.leads, suppliers, notes };
	}

	const leadOf = (leads: readonly LeadTime[]) => (key: string | undefined) => leads.find((l) => l.s === key)?.days ?? ORDER_LIMITS.lead;

	function coverOf(args: Record<string, unknown>): number | string {
		return daysSaid(args.cover_days, "i giorni di uscite da coprire", ORDER_LIMITS.maxCover) ?? ORDER_LIMITS.cover;
	}

	/** Late: sent more than the supplier's lead time ago, not all arrived. */
	function lateOf(loaded: Loaded, day: string): { order: Order; days: number }[] {
		const lead = leadOf(loaded.leads);
		return loaded.orders
			.filter((o) => isAwaited(o) && o.sentDay !== undefined && daysBetween(o.sentDay, day) > lead(o.supplier.key))
			.map((order) => ({ order, days: daysBetween(order.sentDay as string, day) }))
			.sort((a, b) => b.days - a.days || a.order.id.localeCompare(b.order.id));
	}

	/** The drafts the person's words make: their lines, or what to reorder; each article to the supplier said, else the usual one (or the cheapest). What is left out, with why. */
	function drafts(args: Record<string, unknown>, loaded: Loaded, day: string): { drafts: Draft[]; left: string[] } | string {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return supplier;
		if (args.prefer !== undefined && args.prefer !== "usual" && args.prefer !== "cheapest") return "Errore: il fornitore da preferire è quello solito o il più conveniente.";
		const cheapest = args.prefer === "cheapest";
		let wanted: { item: StockItem; qty: bigint; price?: bigint }[];
		const fromSuggest = args.lines === undefined;
		if (!fromSuggest) {
			const said = linesSaid(args.lines, loaded.data.items);
			if (typeof said === "string") return said;
			wanted = said;
		} else {
			const cover = coverOf(args);
			if (typeof cover === "string") return cover;
			wanted = suggestions(loaded.data, day, { cover, lead: leadOf(loaded.leads) }).map((s) => ({ item: s.item, qty: s.qty }));
			if (wanted.length === 0) return ["Niente da riordinare: nessun articolo è sotto il minimo o ci arriva prima che un ordine possa arrivare. Se chi ti scrive vuole ordinare qualcosa lo stesso, dimmi l'articolo e quanti.", ...loaded.notes].join("\n");
		}
		const groups = new Map<string, { supplier: SupplierSaid; lines: DraftLine[] }>();
		const left: string[] = [];
		for (const w of wanted) {
			const offers = offersFor(w.item, loaded.data);
			const sellers = sellersOf(offers, day);
			let to: SupplierSaid | undefined = supplier;
			if (supplier !== undefined && fromSuggest && !offers.some((o) => o.key === supplier.key)) {
				left.push(`• ${w.item.name}: non l'hai mai comprato da questo fornitore`);
				continue;
			}
			if (to === undefined) {
				const pick = cheapest ? (sellers.cheapest ?? sellers.usual) : (sellers.usual ?? sellers.cheapest);
				if (pick === undefined) {
					left.push(`• ${w.item.name}: non so da chi lo compri (nessuna fattura o carico con il fornitore): dimmi il fornitore`);
					continue;
				}
				to = { key: pick.key, name: pick.supplier.slice(0, ORDER_LIMITS.name), ...(pick.vat === undefined ? {} : { vat: pick.vat }) };
			}
			const last = latestBySupplier(offers).find((o) => o.key === to.key);
			const line: DraftLine = w.price !== undefined ? { item: w.item, qty: w.qty, price: w.price, priceFrom: "said" } : last !== undefined ? { item: w.item, qty: w.qty, price: last.cost, priceFrom: "purchase", priceDay: last.day } : { item: w.item, qty: w.qty };
			const g = groups.get(to.key) ?? { supplier: to, lines: [] };
			g.lines.push(line);
			groups.set(to.key, g);
		}
		return { drafts: [...groups.values()], left };
	}

	const checkOf = (ds: readonly Draft[]) => createHash("sha256").update(JSON.stringify(ds.map((d) => [d.supplier.key, d.lines.map((l) => [l.item.id, l.qty.toString(), l.price?.toString() ?? ""])]))).digest("hex").slice(0, 16);

	const draftLineRow = (l: DraftLine, n: number) => `  ${n}. ${l.item.name}: ${lineWords({ qty: qtyText(l.qty), unit: l.item.unit, ...(l.price === undefined ? {} : { price: costText(l.price) }) })}${l.price === undefined ? " (prezzo non noto: chiedilo al fornitore)" : l.priceFrom === "said" ? " (prezzo detto da te)" : ` (l'ultimo pagato, ${italianDate(l.priceDay as string)})`}`;

	function proposalText(ds: readonly Draft[], left: readonly string[], loaded: Loaded, first = ""): string {
		const rows: string[] = [];
		for (const d of ds) {
			rows.push(`Fornitore: ${d.supplier.name}`, ...d.lines.map((l, i) => draftLineRow(l, i + 1)));
			const total = expectedTotal(d.lines.map((l) => ({ qty: qtyText(l.qty), ...(l.price === undefined ? {} : { price: costText(l.price) }) })));
			if (total !== undefined) rows.push(`  Totale previsto: ${euros(total)} senza IVA`);
		}
		if (left.length > 0) rows.push("Non li metto in un ordine:", ...left);
		const already = ds.flatMap((d) => loaded.orders.filter((o) => o.supplier.key === d.supplier.key && o.status === "draft").map((o) => o.id));
		const out = [`${first}${ds.length === 0 ? "Nessuna bozza d'ordine da preparare" : `Preparerei ${n1(ds.length, "una bozza d'ordine", "# bozze d'ordine, una per fornitore")}`}, come nel riquadro (prezzi per unità, senza IVA).`, fencedOrders(rows.join("\n"))];
		if (already.length > 0) out.push(`Per ${already.length === 1 ? "questo fornitore c'è già una bozza" : "questi fornitori ci sono già delle bozze"} (${already.join(", ")}): se chi ti scrive preferisce, cambio quella invece di farne un'altra.`);
		if (ds.length > 0) out.push(`Chiedi a chi ti scrive se va bene: con il suo sì ripeti con la conferma e il controllo ${checkOf(ds)}. Non mando niente a nessuno: l'ordine al fornitore lo manda chi ti scrive, e poi me lo dice.`);
		return [...out, ...loaded.notes].join("\n");
	}

	async function create(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const built = drafts(args, loaded, day);
		if (typeof built === "string") return { text: built, count: 0 };
		if (args.confirm !== true) return { text: proposalText(built.drafts, built.left, loaded), count: 0 };
		const refused = requirePersonFor(ctx, "preparo le bozze d'ordine");
		if (refused !== undefined) return { text: refused, count: 0 };
		const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
		if (check === undefined || !/^[0-9a-f]{16}$/.test(check)) return { text: "Errore: per preparare le bozze serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
		if (built.drafts.length === 0) return { text: proposalText(built.drafts, built.left, loaded), count: 0 };
		if (checkOf(built.drafts) !== check) return { text: proposalText(built.drafts, built.left, loaded, "La proposta è cambiata da quando l'hai mostrata (il magazzino, i prezzi o le righe): non ho preparato niente. Ecco quella nuova.\n"), count: 0 };
		const by = marker(ctx);
		const ids = await ctx.step("create", async () => {
			store.update(ctx.callId, (state) => {
				const made: Order[] = built.drafts.map((d, i) => ({
					id: orderId(state.nextOrder + i),
					supplier: d.supplier,
					status: "draft",
					day,
					lines: d.lines.map((l, n): OrderLine => ({ n: n + 1, item: l.item.id, name: l.item.name, qty: qtyText(l.qty), unit: l.item.unit, ...(l.price === undefined ? {} : { price: costText(l.price), priceFrom: l.priceFrom as "purchase" | "said", ...(l.priceDay === undefined ? {} : { priceDay: l.priceDay }) }) })),
					receipts: [],
					callId: ctx.callId,
					...by,
				}));
				if (state.orders.length + made.length > ORDER_LIMITS.orders) throw new OrderError(`ci sono già troppi ordini (al massimo ${ORDER_LIMITS.orders}): esporta e annulla quelli vecchi`);
				return { ...state, nextOrder: state.nextOrder + made.length, orders: [...state.orders, ...made] };
			});
			return store.read().orders.filter((o) => o.callId === ctx.callId).map((o) => o.id);
		});
		const made = store.read().orders.filter((o) => ids.includes(o.id));
		return {
			text: [
				`Fatto: ${n1(made.length, `ho preparato la bozza d'ordine ${ids[0]}`, `ho preparato # bozze d'ordine (${ids.join(", ")})`)}, come nel riquadro. Non l'ho mandata a nessuno.`,
				fencedOrders(made.map((o) => orderBlock(o, day)).join("\n")),
				"Se chi ti scrive vuole, faccio il documento da mandare al fornitore (PDF o Word). Quando l'ha mandato, me lo dice e lo segno come inviato.",
			].join("\n"),
			count: made.length,
		};
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, (x) => x.status === "draft", "in bozza");
		if (typeof o === "string") return { text: o, count: 0 };
		if (o.status !== "draft") return { text: `L'ordine ${o.id} è ${o.status === "cancelled" ? "annullato" : "già inviato"}: si cambia solo una bozza. Per ordinare altro, ne preparo uno nuovo.`, count: 0 };
		const said = args.lines === undefined ? [] : linesSaid(args.lines, loaded.data.items, true);
		if (typeof said === "string") return { text: said, count: 0 };
		const notes = cleanText(args.notes, ORDER_LIMITS.notes, "le note", true);
		if (isProblem(notes)) return { text: `Errore: ${notes.problem}.`, count: 0 };
		if (args.no_prices !== undefined && typeof args.no_prices !== "boolean") return { text: "Errore: senza prezzi è sì o no.", count: 0 };
		if (said.length === 0 && notes === undefined && args.no_prices === undefined) return { text: "Errore: dimmi cosa cambiare: le righe (articolo e quanti, 0 per toglierlo), le note o se il documento va senza prezzi.", count: 0 };
		const offersOf = (item: StockItem) => latestBySupplier(offersFor(item, loaded.data)).find((x) => x.key === o.supplier.key);
		let lines = [...o.lines];
		for (const l of said) {
			const at = lines.findIndex((x) => x.item === l.item.id);
			if (l.qty === 0n) {
				if (at >= 0) lines.splice(at, 1);
				continue;
			}
			const last = offersOf(l.item);
			const price = l.price !== undefined ? { price: costText(l.price), priceFrom: "said" as const } : at >= 0 ? (lines[at]?.price === undefined ? {} : { price: lines[at]?.price as string, priceFrom: lines[at]?.priceFrom as "purchase" | "said", ...(lines[at]?.priceDay === undefined ? {} : { priceDay: lines[at]?.priceDay as string }) }) : last === undefined ? {} : { price: costText(last.cost), priceFrom: "purchase" as const, priceDay: last.day };
			const next: OrderLine = { n: at >= 0 ? (lines[at] as OrderLine).n : Math.max(0, ...lines.map((x) => x.n)) + 1, item: l.item.id, name: l.item.name, qty: qtyText(l.qty), unit: l.item.unit, ...price };
			if (at >= 0) lines[at] = next;
			else lines.push(next);
		}
		if (lines.length === 0) return { text: `Così l'ordine ${o.id} resterebbe senza righe: se non serve più, chi ti scrive può dirmi di annullarlo.`, count: 0 };
		lines = lines.map((l, i) => ({ ...l, n: i + 1 }));
		const by = marker(ctx);
		await ctx.step("change", async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.orders.find((x) => x.id === o.id);
				if (cur === undefined || cur.status !== "draft") throw new OrderError(`l'ordine ${o.id} non è più una bozza: non l'ho cambiato`);
				const changed: Order = { ...cur, lines, ...(notes === undefined ? {} : { notes }), ...(args.no_prices === true ? { noPrices: true as const } : {}), edited: by };
				const out = args.no_prices === false ? (({ noPrices: _, ...rest }) => rest)(changed) : changed;
				return { ...state, orders: state.orders.map((x) => (x.id === o.id ? (out as Order) : x)) };
			});
			return true;
		});
		const after = store.read().orders.find((x) => x.id === o.id) as Order;
		return { text: [`Fatto: ho cambiato la bozza ${o.id}, ora è così.`, fencedOrders(orderBlock(after, day)), ...(after.file === undefined ? [] : ["Il documento fatto prima non è più aggiornato: se serve, lo rifaccio."])].join("\n"), count: lines.length };
	}

	async function status(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string, op: "mark_sent" | "cancel"): Promise<{ text: string; count: number }> {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, op === "mark_sent" ? (x) => x.status === "draft" : isOpen, op === "mark_sent" ? "in bozza" : "aperto");
		if (typeof o === "string") return { text: o, count: 0 };
		if (op === "mark_sent" && o.status !== "draft") return { text: `L'ordine ${o.id} è ${o.status === "sent" ? "già segnato come inviato" : "annullato"}.`, count: 0 };
		if (op === "cancel" && (o.status === "cancelled" || orderState(o) === "received")) return { text: `L'ordine ${o.id} è ${o.status === "cancelled" ? "già annullato" : "già arrivato tutto"}: non c'è niente da annullare.`, count: 0 };
		const refused = requirePersonFor(ctx, op === "mark_sent" ? `segno come inviato l'ordine ${o.id}` : `annullo l'ordine ${o.id}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const by = marker(ctx);
		await ctx.step(op, async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.orders.find((x) => x.id === o.id);
				if (cur === undefined || (op === "mark_sent" ? cur.status !== "draft" : cur.status === "cancelled")) return state;
				const next: Order = op === "mark_sent" ? { ...cur, status: "sent", sentDay: day, sent: by } : { ...cur, status: "cancelled", cancelled: by };
				return { ...state, orders: state.orders.map((x) => (x.id === o.id ? next : x)) };
			});
			return true;
		});
		const lead = leadOf(loaded.leads)(o.supplier.key);
		if (op === "mark_sent") return { text: `Segnato: l'ordine ${o.id} è inviato da oggi. Quando arriva la fattura del fornitore e la carichi in magazzino, segno lì la merce arrivata. Se dopo ${n1(lead, "un giorno", "# giorni")} (il tempo di consegna di questo fornitore) non è arrivato tutto, te lo ricordo nel brief.`, count: 1 };
		return { text: `Annullato l'ordine ${o.id}.${o.status === "sent" ? " L'avevi già mandato al fornitore: diglielo tu, io non gli scrivo." : ""}`, count: 1 };
	}

	async function document(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, isOpen, "aperto");
		if (typeof o === "string") return { text: o, count: 0 };
		if (o.status === "cancelled") return { text: `L'ordine ${o.id} è annullato: non ne faccio il documento.`, count: 0 };
		const format = args.format === undefined ? "pdf" : args.format;
		if (format !== "pdf" && format !== "docx") return { text: "Errore: il documento è PDF o Word.", count: 0 };
		if (args.no_prices !== undefined && typeof args.no_prices !== "boolean") return { text: "Errore: senza prezzi è sì o no.", count: 0 };
		const order: Order = args.no_prices === true ? { ...o, noPrices: true } : args.no_prices === false ? (({ noPrices: _, ...rest }) => rest as Order)(o) : o;
		const book = options.invoices?.read();
		const company: Partial<Company> = book === undefined || book.broken ? {} : (book.company ?? {});
		const card = loaded.suppliers.find((s) => s.vat !== undefined && s.vat === o.supplier.vat)?.card ?? loaded.suppliers.find((s) => s.name === o.supplier.name)?.card;
		const contact = card?.contacts.find((c) => c.email !== undefined) ?? card?.contacts[0];
		const ext = `.${format}`;
		try {
			const path = await ctx.step("path", async () => (o.file?.endsWith(ext) ? o.file : await freePath(workspace, `ordini/Ordine-${o.id}${fileSlug(o.supplier.name) === "" ? "" : `-${fileSlug(o.supplier.name)}`}`, ext)));
			const made = await ctx.step("file", async () => {
				const doc = await make({ format, text: orderMarkdown(order, company, contact === undefined ? undefined : { ...(contact.name === undefined ? {} : { name: contact.name }), ...(contact.email === undefined ? {} : { email: contact.email }), ...(contact.phone === undefined ? {} : { phone: contact.phone }) }), name: `Ordine ${o.id}`, pictures: [], now: now().getTime() });
				const written = (await workspace.write(path, doc.data)).path;
				return { path: written, notes: [...doc.notes] };
			});
			await ctx.step("record", async () => {
				store.update(ctx.callId, (state) => ({ ...state, orders: state.orders.map((x) => (x.id === o.id ? { ...x, file: made.path.slice(0, ORDER_LIMITS.file), ...(order.noPrices === true ? { noPrices: true as const } : {}) } : x)).map((x) => (x.id === o.id && args.no_prices === false ? (({ noPrices: _, ...rest }) => rest as Order)(x) : x)) }));
				return true;
			});
			const bare = company.name === undefined ? ["Non ho i dati della tua azienda, quindi il documento è senza intestazione: se chi ti scrive vuole, salvali con i dati dell'azienda e lo rifaccio."] : [];
			const email = contact?.email === undefined ? "" : " L'indirizzo del referente del fornitore è nel riquadro.";
			return {
				text: [
					`Fatto: ho fatto il documento dell'ordine ${o.id}${order.noPrices === true ? ", senza prezzi" : ""}; il file è nel riquadro. Non l'ho mandato a nessuno.`,
					fencedOrders([`File: ${made.path}`, ...(contact?.email === undefined ? [] : [`Referente: ${[contact.name, contact.email].filter((x) => x !== undefined).join(", ")}`])].join("\n")),
					`Se chi ti scrive vuole, mandalo con file_send, o per mail al fornitore con il file allegato: la mail parte solo dopo che approva la richiesta.${email} Quando l'ha mandato, me lo dice e lo segno come inviato.`,
					...bare,
					...made.notes,
				].join("\n"),
				count: 1,
			};
		} catch (error) {
			if (error instanceof WorkspaceError || error instanceof DocumentError) return { text: `Errore: non sono riuscita a fare il documento dell'ordine (${error.message}).`, count: 0 };
			throw error;
		}
	}

	async function brief(ctx: ToolContext, loaded: Loaded, day: string): Promise<string> {
		const late = lateOf(loaded, day);
		const reorder = suggestions(loaded.data, day, { cover: ORDER_LIMITS.cover, lead: leadOf(loaded.leads) }).length;
		const lateIds = late.length === 0 ? [] : await ctx.step("claim-late", async () => store.claim(`${ctx.callId}:late`, day, late.map((l) => l.order.id), ORDER_LIMITS.briefPerDay, ORDER_LIMITS.briefAgain));
		const reorderSaid = reorder === 0 ? [] : await ctx.step("claim-reorder", async () => store.claim(`${ctx.callId}:reorder`, day, ["reorder"], 1, 1));
		const mine = late.filter((l) => lateIds.includes(l.order.id));
		const said = mine.length + (reorderSaid.length > 0 ? 1 : 0);
		if (said > 0) await audit(ctx, "brief", said);
		return briefAnswer(mine, reorderSaid.length > 0 ? reorder : 0);
	}

	/** Another agente: how many, nothing more. */
	function agentCounts(loaded: Loaded, day: string): string {
		const open = loaded.orders.filter(isOpen);
		const drafts = open.filter((o) => o.status === "draft").length;
		const late = lateOf(loaded, day).length;
		const reorder = suggestions(loaded.data, day, { cover: ORDER_LIMITS.cover, lead: leadOf(loaded.leads) }).length;
		return `Ordini ai fornitori: ${n1(open.length, "uno aperto", "# aperti")} (${n1(drafts, "una bozza", "# bozze")}, ${n1(open.length - drafts, "uno inviato", "# inviati")}), ${n1(late, "uno oltre il tempo di consegna", "# oltre il tempo di consegna")}; ${n1(reorder, "un articolo", "# articoli")} da riordinare. A un altro agente do solo i conteggi: fornitori, articoli e prezzi no.`;
	}

	async function run(op: OrderOp, args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		switch (op) {
			case "suggest": {
				const cover = coverOf(args);
				if (typeof cover === "string") return { text: cover, count: 0 };
				const list = suggestions(loaded.data, day, { cover, lead: leadOf(loaded.leads) });
				return { text: suggestAnswer(list, cover, loaded.notes), count: list.length };
			}
			case "create":
				return create(args, ctx, loaded, day);
			case "change":
				return change(args, ctx, loaded, day);
			case "mark_sent":
			case "cancel":
				return status(args, ctx, loaded, day, op);
			case "document":
				return document(args, ctx, loaded, day);
			case "list": {
				if (args.all !== undefined && typeof args.all !== "boolean") return { text: "Errore: tutti è sì o no.", count: 0 };
				const shown = loaded.orders.filter((o) => args.all === true || isOpen(o)).sort((a, b) => b.id.localeCompare(a.id));
				if (shown.length === 0) return { text: args.all === true ? "Non c'è ancora nessun ordine ai fornitori." : "Nessun ordine aperto: niente in bozza e niente in arrivo.", count: 0 };
				const late = new Set(lateOf(loaded, day).map((l) => l.order.id));
				return { text: [`${n1(shown.length, "Un ordine", "# ordini")}${args.all === true ? "" : " aperti"}${late.size === 0 ? "" : `, ${n1(late.size, "uno oltre il tempo di consegna", "# oltre il tempo di consegna")}`}:`, fencedOrders([...shown.slice(0, ORDER_LIMITS.shown).map((o) => `${orderRow(o)}${late.has(o.id) ? ", in ritardo" : ""}`), ...(shown.length > ORDER_LIMITS.shown ? [`e altri ${shown.length - ORDER_LIMITS.shown}`] : [])].join("\n"))].join("\n"), count: shown.length };
			}
			case "status": {
				const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
				if (typeof supplier === "string") return { text: supplier, count: 0 };
				let o: Order | string | undefined;
				if (args.order === undefined && supplier !== undefined) o = latestOf(loaded.orders, supplier.key) ?? [`Non c'è un ordine a questo fornitore.`, fencedOrders(supplier.name)].join("\n");
				else o = orderSaid(args, loaded.orders, supplier, () => true, "");
				if (typeof o === "string") return { text: o, count: 0 };
				const lead = leadOf(loaded.leads)(o.supplier.key);
				const state = orderState(o);
				const head = state === "received" ? `L'ordine ${o.id} è arrivato tutto.` : state === "partial" ? `L'ordine ${o.id} è arrivato in parte: nel riquadro cosa manca.` : state === "sent" ? `L'ordine ${o.id} non è ancora arrivato: nessuna fattura caricata in magazzino ha la sua merce.` : state === "draft" ? `L'ordine ${o.id} è ancora una bozza: non risulta inviato.` : `L'ordine ${o.id} è annullato.`;
				return { text: [head, fencedOrders(orderBlock(o, day, lead)), ...(state === "sent" || state === "partial" ? ["La merce arriva in un ordine quando la fattura del fornitore viene caricata in magazzino."] : [])].join("\n"), count: 1 };
			}
			case "export": {
				if (loaded.orders.length === 0) return { text: "Non c'è ancora nessun ordine da mettere nel file.", count: 0 };
				const path = await ctx.step("path", async () => freePath(workspace, `ordini/ordini-al-${day}`, ".csv"));
				const written = await ctx.step("write", async () => (await workspace.write(path, ordersCsv(loaded.orders))).path);
				return { text: `Salvato ${written}: ${n1(loaded.orders.length, "un ordine", "# ordini")}, una riga per articolo, con quanto è arrivato (separatore «;», decimali con la virgola, si apre con Excel). Mandalo con file_send se chi ti scrive lo vuole.`, count: loaded.orders.length };
			}
			case "lead_time": {
				const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
				if (typeof supplier === "string") return { text: supplier, count: 0 };
				if (supplier === undefined) return { text: "Errore: dimmi di quale fornitore è il tempo di consegna.", count: 0 };
				const days = daysSaid(args.days, "il tempo di consegna", ORDER_LIMITS.maxLead);
				if (days === undefined || typeof days === "string") return { text: days ?? "Errore: dimmi in quanti giorni consegna.", count: 0 };
				await ctx.step("lead", async () => {
					store.update(ctx.callId, (state) => ({ ...state, leads: [...state.leads.filter((l) => l.s !== supplier.key), { s: supplier.key, days }] }));
					return true;
				});
				return { text: [`Fatto: questo fornitore consegna in ${n1(days, "un giorno", "# giorni")}. Un ordine inviato che dopo non è arrivato tutto te lo ricordo nel brief.`, fencedOrders(supplier.name)].join("\n"), count: 1 };
			}
		}
	}

	return [
		{
			name: "orders",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...ORDER_OPS] },
					supplier: text(ORDER_LIMITS.name, "create, change, mark_sent, cancel, status, document, lead_time: the supplier, as said or partita IVA"),
					order: text(20, "change, mark_sent, cancel, status, document: the order's number (OR-0001), instead of the supplier"),
					lines: {
						type: "array",
						maxItems: ORDER_LIMITS.lines,
						description: "create: the articles to order (without: what to reorder); change: the lines to set, quantity 0 takes one off",
						items: {
							type: "object",
							properties: {
								item: { type: "string", maxLength: 120, description: "the article of the magazzino: its name as said or MG-0001" },
								quantity: { type: ["number", "string"] },
								unit: { type: "string", maxLength: 10, description: "when not the article's own: its pack («scatole»)" },
								price: { type: ["number", "string"], description: "the price per unit in euros without IVA, only when the person says it" },
							},
							required: ["item", "quantity"],
							additionalProperties: false,
						},
					},
					prefer: { type: "string", enum: ["usual", "cheapest"], description: "create: each article from its usual supplier (default) or the cheapest of the recent prices" },
					cover_days: amount("suggest, create: the days of sales to cover past the minimum (default 30)"),
					days: amount("lead_time: in how many days the supplier delivers"),
					notes: text(ORDER_LIMITS.notes, "change: notes for the supplier («consegna al mattino»)"),
					no_prices: { type: "boolean", description: "change, document: the document without prices (false puts them back)" },
					format: { type: "string", enum: ["pdf", "docx"], description: "document: PDF (default) or Word" },
					all: { type: "boolean", description: "list: every order, the closed ones too" },
					confirm: { type: "boolean", description: "create: true only after the person's yes to the drafts shown" },
					check: text(20, "create with confirm: the check given with the drafts the person said yes to"),
					compact: { type: "boolean", description: "list: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!ORDER_OPS.includes(args.op as OrderOp)) return "Errore: non conosco questa operazione sugli ordini.";
				const op = args.op as OrderOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				// Orders name suppliers, articles and prices: another agente gets counts only.
				if (isAgentTurn(ctx) && !["suggest", "list", "status"].includes(op)) return AGENT_REFUSAL;
				const day = todayIn(timeZone, now());
				try {
					const loaded = await load(ctx);
					if (typeof loaded === "string") return loaded;
					if (isAgentTurn(ctx)) return agentCounts(loaded, day);
					if (op === "list" && args.compact === true) return await brief(ctx, loaded, day);
					const answer = await run(op, args, ctx, loaded, day);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof OrderError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}

