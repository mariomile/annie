/**
 * The tool `ddt`: i DDT in uscita. A draft for a client (the lines of the listino or free text,
 * how many, no prices); issued only after the person's yes, when it takes its number of the year
 * and moves the magazzino (vendita, omaggio and conto visione unload the lines with a voce that is
 * an article; a reso puts back the goods of the DDT it names: once per DDT and line, never
 * blocking the issue); annulled, never deleted; its PDF or Word in `ddt/`, never sent; the list,
 * what is still to bill, the CSV, the numbering. The fattura differita that bills them is
 * sales_invoices' (sales-ddt.ts). Another agente gets counts only; the audit only the op and a count.
 */
import { createHash } from "node:crypto";
import type { ClientStore } from "../client-store.ts";
import { type Ddt, DDT_LIMITS, DDT_OPS, DdtError, ddtId, type DdtLine, type DdtOp, type IssuedDdt, isIssuedDdt, UNLOADING } from "../ddt.ts";
import { DDT_BROKEN, type DdtBook, type DdtStore, nextDdtSeq } from "../ddt-store.ts";
import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { Company } from "../invoices.ts";
import { addDays, todayIn } from "../italian-calendar.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import type { PriceItem } from "../price-list.ts";
import type { PriceListStore } from "../price-list-store.ts";
import type { SalesInvoiceStore } from "../sales-invoice-store.ts";
import type { SalesInvoice } from "../sales-invoices.ts";
import { StockError, type StockItem } from "../stock.ts";
import { planSale, type Sale, STOCK_BROKEN, STOCK_FULL, type StockLink } from "../stock-store.ts";
import { qtyOf, stateOf } from "../stock-sums.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { causaleSaid, type ClientSaid, clientSaid, ddtNamed, type LineSaid, linesSaid, ofClient, packagesSaid, transportSaid, weightSaid } from "./ddt-input.ts";
import { briefAnswer, ddtBlock, ddtCsv, ddtMarkdown, ddtRow, ddtTitle, fencedDdt, more } from "./ddt-render.ts";
import { fileSlug } from "./quote-input.ts";
import { clientKey, ddtClientSaid, type DdtInvoices, ddtInvoicesOf, unbilled } from "./sales-ddt.ts";
import { fencedStock, nameOf, qtyNumber, qtyWords } from "./stock-render.ts";

/** What was done, for the audit: the op and how many, never clients, lines or numbers. */
export type DdtEvent = { readonly type: "ddt.used"; readonly op: DdtOp | "brief"; readonly count: number };

export type DdtToolsOptions = {
	readonly workspace: Workspace;
	readonly store: DdtStore;
	/** The fatture in uscita, read only: the customers invoiced, and which DDTs a draft holds or an invoice billed. */
	readonly sales?: Pick<SalesInvoiceStore, "read">;
	readonly clients?: Pick<ClientStore, "read">;
	readonly priceList?: Pick<PriceListStore, "read">;
	/** Il magazzino: a DDT issued unloads (or a reso puts back), once per DDT and line. */
	readonly stock?: StockLink;
	/** The company, for the document's letterhead. */
	readonly company?: Pick<InvoiceStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: DdtEvent) => Promise<void>;
	/** Tests: the clock and the document maker (default: the document worker). */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

const DESCRIPTION = [
	"I DDT in uscita (documenti di trasporto): the goods the person ships to a client, with no prices. Annie never sends a DDT: the person prints it or sends it.",
	"What the person says → op: «fammi il DDT per Rossi: 10 risme e 2 toner» → create with client and lines [{item (a voce of the listino as said) or description (free text), quantity, unit}]; causale vendita unless said (conto visione, reso with of: the DDT the goods come back from, riparazione, omaggio, comodato, lavorazione); transport mittente (the person), destinatario (the client) or vettore with carrier; destination when not the client's address; aspect, packages, weight when said. When Annie is not sure of the client or of a voce, create first shows the draft with a check: show it, and only after the person's yes repeat with confirm true and that check.",
	"«aggiungi 2 toner al DDT», «il trasporto lo fa il corriere Bartolini» → change (ddt or client; lines quantity 0 takes one off) while it is a draft; «emettilo», «sì» after the draft → issue with confirm true, only after the person said yes to what issue showed (it takes the number and unloads the magazzino); «annulla il DDT 12» → cancel (an issued DDT keeps its number); «stampa il DDT», «fammi il PDF del DDT 12» → document (format pdf or docx), then offer file_send; «quali DDT non ho ancora fatturato?» → list with unbilled true (client, month when said); «a che punto è il DDT 12?» → status; «fammi il file dei DDT» → export, then file_send; «numera i DDT come 12», «l'ultimo DDT che ho fatto era il 40» → settings (numbering, last_number).",
	"«fai la fattura differita di ottobre per Rossi» is sales_invoices (draft with ddt true and the month), not this tool. summary of the brief: list with compact true. Repeat quantities as given, never compute them yourself.",
].join(" ");

const AGENT_REFUSAL = "I DDT dicono clienti, merce e indirizzi: a un altro agente do solo quanti sono. Li prepara e li emette chi ti scrive, nella sua conversazione.";

/** A draft as proposed: its client, lines and fields, with the check the person's yes is given on. */
type Proposed = { readonly said: ClientSaid; readonly lines: readonly LineSaid[]; readonly fields: Omit<Ddt, "id" | "status" | "day" | "client" | "lines" | "callId" | "by" | "at"> };

export function createDdtTools(options: DdtToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const make = options.make ?? ((input: MakeInput) => makeDocumentFile(input));
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: DdtEvent["op"], count: number) => {
		await ctx.step(`audit-${op}`, async () => {
			await options.record?.({ type: "ddt.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });

	type Loaded = { readonly book: DdtBook; readonly invoices: readonly SalesInvoice[]; readonly links: DdtInvoices; readonly voci: readonly PriceItem[] };

	function load(): Loaded | string {
		const book = store.read();
		if (book.broken) return `Errore: ${DDT_BROKEN}.`;
		const sales = options.sales?.read();
		const invoices = sales === undefined || sales.broken ? [] : sales.invoices;
		const list = options.priceList?.read();
		return { book, invoices, links: ddtInvoicesOf(invoices), voci: list === undefined || list.broken ? [] : list.items };
	}

	const cards = () => {
		const b = options.clients?.read();
		return b === undefined || b.broken ? [] : b.cards;
	};

	/** The DDT named (ddt), or the client's one `pick` takes, or the only one; or the answer to give. */
	function target(args: Record<string, unknown>, loaded: Loaded, pick: (d: Ddt) => boolean, what: string): Ddt | string {
		const named = ddtNamed(args.ddt, loaded.book.ddts);
		if (named !== undefined) return named;
		let pool = loaded.book.ddts.filter(pick);
		if (args.client !== undefined) {
			const said = cleanText(args.client, DDT_LIMITS.name, "il cliente");
			if (isProblem(said)) return `Errore: ${said.problem}.`;
			const c = ddtClientSaid(said ?? "", loaded.book.ddts);
			if (typeof c === "string") return c;
			if ("none" in c) return ["Non trovo DDT per questo cliente.", fencedDdt(said ?? "")].join("\n");
			pool = ofClient(pool, c);
		}
		pool = [...pool].sort((a, b) => b.id.localeCompare(a.id));
		if (pool.length === 1) return pool[0] as Ddt;
		if (pool.length === 0) return `Non c'è un DDT ${what}${args.client === undefined ? "" : " per questo cliente"}.`;
		return [`Ci sono ${pool.length} DDT ${what}: dimmi quale, con il numero.`, fencedDdt([...pool.slice(0, DDT_LIMITS.shown).map((d) => `• ${ddtRow(d, loaded.links)}`), ...more(pool.length)].join("\n"))].join("\n");
	}

	/** The fields said besides the client and the lines (create: from nothing; change: over the draft's). */
	function fieldsSaid(args: Record<string, unknown>, loaded: Loaded, client: ClientSaid["client"], was?: Ddt): Proposed["fields"] | string {
		const causale = causaleSaid(args.causale);
		if (typeof causale === "object") return causale.answer;
		const transport = transportSaid(args.transport, args.carrier, was?.transport);
		if (typeof transport === "string") return transport;
		const destination = cleanText(args.destination, DDT_LIMITS.destination, "la destinazione");
		if (isProblem(destination)) return `Errore: ${destination.problem}.`;
		const aspect = cleanText(args.aspect, DDT_LIMITS.aspect, "l'aspetto dei beni");
		if (isProblem(aspect)) return `Errore: ${aspect.problem}.`;
		const notes = cleanText(args.notes, DDT_LIMITS.notes, "le note", true);
		if (isProblem(notes)) return `Errore: ${notes.problem}.`;
		const packages = packagesSaid(args.packages);
		if (typeof packages === "string") return packages;
		const weight = weightSaid(args.weight);
		if (typeof weight === "object") return weight.answer;
		const c = causale ?? was?.causale ?? "vendita";
		let of = was?.of;
		if (args.of !== undefined) {
			if (c !== "reso") return "Errore: il DDT da cui torna la merce si dice solo per un reso.";
			const from = ddtNamed(args.of, loaded.book.ddts);
			if (typeof from === "string" || from === undefined) return from ?? "Errore: dimmi da quale DDT torna la merce.";
			if (!isIssuedDdt(from) || from.status !== "issued" || !UNLOADING.includes(from.causale)) return `Errore: il reso torna da un DDT emesso che ha scaricato la merce (vendita, omaggio o conto visione): ${isIssuedDdt(from) ? `il DDT n. ${from.number}` : `la ${from.id}`} non lo è.`;
			if (clientKey(from.client) !== clientKey(client)) return [`Il DDT n. ${from.number} è di un altro cliente: il reso torna da un DDT dello stesso cliente.`, fencedDdt(from.client.name)].join("\n");
			of = from.id;
		}
		if (c !== "reso") of = undefined;
		return {
			causale: c,
			...(transport === undefined ? {} : { transport }),
			...((destination ?? was?.destination) === undefined ? {} : { destination: (destination ?? was?.destination) as string }),
			...((aspect ?? was?.aspect) === undefined ? {} : { aspect: (aspect ?? was?.aspect) as string }),
			...((notes ?? was?.notes) === undefined ? {} : { notes: (notes ?? was?.notes) as string }),
			...((packages ?? was?.packages) === undefined ? {} : { packages: (packages ?? was?.packages) as number }),
			...((weight ?? was?.weight) === undefined ? {} : { weight: (weight ?? was?.weight) as string }),
			...(of === undefined ? {} : { of }),
		};
	}

	const numbered = (lines: readonly LineSaid[]): DdtLine[] => lines.map(({ guess: _, ...l }, i) => ({ ...l, n: i + 1 }));

	const checkOf = (p: Proposed) => createHash("sha256").update(JSON.stringify([p.said.client, p.lines.map((l) => [l.description, l.qty, l.unit ?? "", l.item ?? ""]), p.fields])).digest("hex").slice(0, 16);

	/** What to say the draft lacks before it can be issued, and what a reso without its DDT does not do. */
	function missingNotes(d: Pick<Ddt, "transport" | "causale" | "of">): string[] {
		const out: string[] = [];
		if (d.transport === undefined) out.push("Prima di emetterlo mi serve chi fa il trasporto: tu, il cliente o un corriere (con il suo nome). Chiedilo a chi ti scrive.");
		else if (d.transport.by === "vettore" && d.transport.carrier === undefined) out.push("Prima di emetterlo mi serve il nome del corriere che fa il trasporto. Chiedilo a chi ti scrive.");
		if (d.causale === "reso" && d.of === undefined) out.push("È un reso: se mi dici da quale DDT torna la merce, quando lo emetti la rimetto in magazzino; senza, non la rimetto.");
		return out;
	}

	function proposalText(p: Proposed, first = ""): string {
		const preview: Ddt = { id: "DT-0000", status: "draft", day: "2000-01-01", client: p.said.client, lines: numbered(p.lines), callId: "x", by: "x", at: "x", ...p.fields };
		const why: string[] = [];
		if (p.said.fresh === true) why.push("il cliente non è tra le schede né tra i clienti fatturati: lo scrivo come detto");
		if (p.said.form === true) why.push("il cliente ha lo stesso nome a meno della forma societaria");
		const guessed = p.lines.filter((l) => l.guess === true).length;
		if (guessed > 0) why.push(n1(guessed, "una voce del listino l'ho presa dal nome più vicino a come è stata detta", "# voci del listino le ho prese dal nome più vicino a come sono state dette"));
		return [
			`${first}Preparerei questa bozza di DDT, come nel riquadro: controlla ${why.join("; ")}.`,
			fencedDdt(ddtBlock(preview).replace(/^Bozza DT-0000 \(bozza\)/, "Bozza")),
			...missingNotes(preview),
			`Va bene? Con il sì di chi ti scrive ripeti con la conferma e il controllo ${checkOf(p)}. Il numero il DDT lo prende quando lo emetti.`,
		].join("\n");
	}

	async function create(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const said = clientSaid(args.client, cards(), loaded.invoices, loaded.book.ddts);
		if (typeof said === "string") return { text: said, count: 0 };
		const lines = linesSaid(args.lines, loaded.voci);
		if (typeof lines === "string") return { text: lines, count: 0 };
		const fields = fieldsSaid(args, loaded, said.client);
		if (typeof fields === "string") return { text: fields, count: 0 };
		const p: Proposed = { said, lines, fields };
		// The client and the lines dictated, each found by its very name: the draft is made at once (a draft moves nothing).
		const dictated = said.form !== true && said.fresh !== true && lines.every((l) => l.guess !== true);
		if (!dictated && args.confirm !== true) return { text: proposalText(p), count: 0 };
		const refused = requirePersonFor(ctx, "preparo il DDT");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (!dictated) {
			const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
			if (check === undefined || !/^[0-9a-f]{16}$/.test(check)) return { text: "Errore: per preparare il DDT serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
			if (checkOf(p) !== check) return { text: proposalText(p, "La proposta è cambiata da quando l'hai mostrata: non ho preparato niente. Ecco quella nuova.\n"), count: 0 };
		}
		const by = marker(ctx);
		const id = await ctx.step("create", async () => {
			store.update(ctx.callId, (state) => {
				if (state.ddts.length >= DDT_LIMITS.ddts) throw new DdtError("i DDT sono troppi per salvarne altri");
				const made: Ddt = { id: ddtId(state.nextDdt), status: "draft", day, client: said.client, lines: numbered(lines), callId: ctx.callId, ...fields, ...by };
				return { ...state, nextDdt: state.nextDdt + 1, ddts: [...state.ddts, made] };
			});
			return store.read().ddts.find((d) => d.callId === ctx.callId)?.id ?? "";
		});
		const made = store.read().ddts.find((d) => d.id === id);
		if (made === undefined) return { text: "Errore: la bozza del DDT non risulta salvata.", count: 0 };
		const head = `Fatto: ho preparato la bozza del DDT (${made.id}), come nel riquadro${args.causale === undefined ? ", con causale vendita" : ""}. Non ha ancora un numero: lo prende quando lo emetti, e allora scarico il magazzino.`;
		return { text: [head, fencedDdt(ddtBlock(made, loaded.links)), ...missingNotes(made), "Quando chi ti scrive dice di emetterlo, ti mostro cosa scarica dal magazzino e lo emetto dopo il suo sì."].join("\n"), count: 1 };
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded): Promise<{ text: string; count: number }> {
		const d = target(args, loaded, (x) => x.status === "draft", "in bozza");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status !== "draft") return { text: `Il ${ddtTitle(d)} è ${d.status === "cancelled" ? "annullato" : "già emesso"}: si cambia solo una bozza. Per altra merce, ne preparo uno nuovo.`, count: 0 };
		const said = args.lines === undefined ? [] : linesSaid(args.lines, loaded.voci, true);
		if (typeof said === "string") return { text: said, count: 0 };
		const fields = fieldsSaid(args, loaded, d.client, d);
		if (typeof fields === "string") return { text: fields, count: 0 };
		const refused = requirePersonFor(ctx, `cambio la bozza del DDT ${d.id}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		let lines: DdtLine[] = [...d.lines];
		const same = (a: Pick<DdtLine, "item" | "description">, b: Pick<DdtLine, "item" | "description">) => (a.item !== undefined && a.item === b.item) || (a.item === undefined && b.item === undefined && a.description.toLowerCase() === b.description.toLowerCase());
		for (const l of said) {
			const at = lines.findIndex((x) => same(x, l));
			if (l.qty === "0") {
				if (at >= 0) lines.splice(at, 1);
				continue;
			}
			const { guess: _, ...rest } = l;
			if (at >= 0) lines[at] = { ...rest, n: (lines[at] as DdtLine).n };
			else lines.push({ ...rest, n: 0 });
		}
		if (lines.length === 0) return { text: `Così la bozza ${d.id} resterebbe senza righe: se non serve più, chi ti scrive può dirmi di annullarla.`, count: 0 };
		lines = lines.map((l, i) => ({ ...l, n: i + 1 }));
		const by = marker(ctx);
		await ctx.step("change", async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.ddts.find((x) => x.id === d.id);
				if (cur === undefined || cur.status !== "draft") throw new DdtError(`il DDT ${d.id} non è più una bozza: non l'ho cambiato`);
				const { transport: _t, destination: _d, aspect: _a, notes: _n, packages: _p, weight: _w, of: _o, ...base } = cur;
				const next: Ddt = { ...base, ...fields, lines, edited: by };
				return { ...state, ddts: state.ddts.map((x) => (x.id === d.id ? next : x)) };
			});
			return true;
		});
		const after = store.read().ddts.find((x) => x.id === d.id) as Ddt;
		return { text: [`Fatto: ho cambiato la bozza ${d.id}, ora è così.`, fencedDdt(ddtBlock(after, loaded.links)), ...missingNotes(after)].join("\n"), count: 1 };
	}

	/** The DDT as the magazzino takes it: its lines with a voce; a reso puts back the goods of the DDT it names. Undefined when it moves nothing. */
	function saleOf(d: Ddt, number: string, day: string): Sale | undefined {
		if (!UNLOADING.includes(d.causale) && !(d.causale === "reso" && d.of !== undefined)) return undefined;
		const lines = d.lines.flatMap((l) => (l.item === undefined ? [] : [{ line: l.n, listino: l.item, quantity: l.qty, description: l.description, ...(l.unit === undefined ? {} : { unit: l.unit }) }]));
		if (lines.length === 0) return undefined;
		return { invoice: d.id, number, day, ...(d.causale === "reso" && d.of !== undefined ? { of: d.of } : {}), lines };
	}

	const SKIP_WHY: Readonly<Record<string, string>> = {
		unit: "l'unità della riga non è quella dell'articolo in magazzino",
		pack: "in confezioni, ma le confezioni per quanto ne contiene ognuna non danno un numero preciso di unità",
		quantity: "la quantità della riga non è un numero",
		nothing: "il DDT da cui torna non l'aveva scaricata",
	};

	function skippedNote(skipped: readonly { description: string; why: string }[], back: boolean): string[] {
		if (skipped.length === 0) return [];
		return [[`${n1(skipped.length, `Una riga non ${back ? "la rimetto" : "la scarico"}`, `# righe non ${back ? "le rimetto" : "le scarico"}`)} in magazzino:`, fencedStock(skipped.map((s) => `• ${s.description}: ${SKIP_WHY[s.why] ?? s.why}`).join("\n")), "Se va corretto, si fa con il magazzino (un carico, uno scarico o un conteggio)."].join("\n")];
	}

	/** What issuing `d` would move, for the question before the yes. A magazzino that does not read is said, and never stops the issue. */
	function stockPreview(d: Ddt, day: string, by: Marker): string[] {
		const sale = saleOf(d, "anteprima", day);
		const back = d.causale === "reso";
		if (sale === undefined) {
			if (UNLOADING.includes(d.causale) && d.lines.every((l) => l.item === undefined)) return ["Nessuna riga è una voce del listino: il magazzino non si muove."];
			if (!UNLOADING.includes(d.causale) && !back) return ["Con questa causale il magazzino non si muove."];
			return [];
		}
		if (options.stock === undefined) return [];
		const book = options.stock.read();
		if (book.broken) return [`Attenzione: il magazzino non si legge, quindi le righe ${back ? "non potranno essere rimesse in magazzino" : "non potranno essere scaricate"} finché il file non è sistemato. Il DDT si emette lo stesso.`];
		const plan = planSale(book, sale, by);
		const out: string[] = [];
		const byItem = new Map<string, { item: StockItem; qty: bigint }>();
		for (const m of plan.added) {
			const item = book.items.find((i) => i.id === m.item) as StockItem;
			byItem.set(item.id, { item, qty: (byItem.get(item.id)?.qty ?? 0n) + qtyOf(m.qty) });
		}
		if (byItem.size > 0) {
			out.push([back ? "Effetti sul magazzino: questo reso rimette gli articoli nel riquadro." : "Effetti sul magazzino: questo DDT scarica gli articoli nel riquadro.", fencedStock([...byItem.values()].map(({ item, qty }) => `${back ? "Rimette in magazzino" : "Scarica dal magazzino"}: ${nameOf(item)} ${back ? "+" : "−"}${qtyWords(qty, item.unit)}`).join("\n"))].join("\n"));
			if (!back)
				for (const { item, qty } of byItem.values()) {
					const there = stateOf(item, book.moves).onHand;
					if (there - qty < 0n) out.push(`In magazzino ci sono ${qtyWords(there, item.unit)} di ${item.id}: questo DDT ne scarica ${qtyNumber(qty)}, quindi andrebbe a ${qtyNumber(there - qty)}. Dillo a chi ti scrive prima del sì: di solito manca un carico. Il DDT si emette lo stesso.`);
				}
		} else if (plan.skipped.length === 0) out.push("Nessuna riga è un articolo del magazzino: il magazzino non si muove.");
		out.push(...skippedNote(plan.skipped, back));
		return out;
	}

	type Stocked = { readonly stop?: "broken" | "full" | "invalid"; readonly rows: string[]; readonly negative: number; readonly skipped: { description: string; why: string }[] };

	/** The magazzino moved by the DDT issued, once per DDT and line however many times this runs; then the issue complete. A stop leaves it to complete. */
	async function complete(d: IssuedDdt, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
		const sale = saleOf(d, d.number, d.day);
		const back = d.causale === "reso";
		const stock = options.stock;
		if (sale === undefined || stock === undefined) {
			store.setStocked(d.id);
			return { notes: [], done: true };
		}
		const by = marker(ctx);
		const r = await ctx.step("stock", async (): Promise<Stocked> => {
			try {
				const out = stock.sale(sale, by);
				if ("full" in out) return { stop: "full", rows: [], negative: 0, skipped: [] };
				if (out.broken) return { stop: "broken", rows: [], negative: 0, skipped: [] };
				return { rows: out.moved.map((m) => `• ${nameOf(m.item)} (${m.item.id}): ${back ? "+" : "−"}${qtyWords(qtyOf(m.move.qty), m.item.unit)}`), negative: back ? 0 : out.moved.filter((m) => m.negative).length, skipped: out.skipped.map((s) => ({ description: s.description, why: s.why })) };
			} catch (error) {
				if (error instanceof StockError) return { stop: error.message === STOCK_FULL ? "full" : error.message === STOCK_BROKEN ? "broken" : "invalid", rows: [], negative: 0, skipped: [] };
				throw error;
			}
		});
		const again = `Quando è sistemato, si completa emettendo di nuovo il DDT n. ${d.number}: il numero resta quello.`;
		const what = back ? "la merce del reso non è rimessa in magazzino" : "le righe non sono scaricate dal magazzino";
		if (r.stop === "full") return { notes: [`Attenzione: il magazzino è pieno di movimenti, quindi ${what}: il DDT è emesso, ma l'emissione resta da completare. Chi ti scrive può chiudere un anno passato del magazzino. ${again}`], done: false };
		if (r.stop === "broken") return { notes: [`Attenzione: il magazzino non si legge, quindi ${what}: il DDT è emesso, ma l'emissione resta da completare. ${again}`], done: false };
		if (r.stop === "invalid") return { notes: [`Attenzione: il magazzino non ha accettato questi movimenti, quindi ${what}: il DDT è emesso, ma l'emissione resta da completare. Va controllato il file del magazzino. ${again}`], done: false };
		store.setStocked(d.id);
		const notes: string[] = [];
		if (r.rows.length > 0) notes.push([back ? `Ho rimesso in magazzino ${n1(r.rows.length, "una riga", "# righe")} del reso:` : `Ho scaricato dal magazzino ${n1(r.rows.length, "una riga", "# righe")} del DDT:`, fencedStock(r.rows.join("\n"))].join("\n"));
		if (r.negative > 0) notes.push(`Attenzione: ${n1(r.negative, "un articolo è", "# articoli sono")} in negativo in magazzino (ne sono usciti più di quelli caricati): ${r.negative === 1 ? "va ricontato" : "vanno ricontati"}, o manca un carico.`);
		notes.push(...skippedNote(r.skipped, back));
		return { notes, done: true };
	}

	async function issue(args: Record<string, unknown>, ctx: ToolContext, given: Loaded, day: string): Promise<{ text: string; count: number }> {
		let loaded = given;
		// A call run again after it issued: the same DDT, completed.
		const mine = loaded.book.ddts.find((d): d is IssuedDdt => isIssuedDdt(d) && d.issueCall === ctx.callId);
		if (mine !== undefined) return issuedAnswer(mine, ctx, loaded);
		const d = target(args, loaded, (x) => x.status === "draft" || (isIssuedDdt(x) && x.status === "issued" && x.stocked !== true), "da emettere");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status === "cancelled") return { text: `${ddtTitle(d)}: è annullato, non si emette.`, count: 0 };
		if (isIssuedDdt(d)) {
			if (d.stocked === true) return { text: `Il ${ddtTitle(d)} è già emesso.`, count: 0 };
			const refused = requirePersonFor(ctx, `completo l'emissione del DDT n. ${d.number}`);
			if (refused !== undefined) return { text: refused, count: 0 };
			return issuedAnswer(d, ctx, loaded);
		}
		const missing = missingNotes(d).filter((m) => !m.startsWith("È un reso"));
		if (missing.length > 0) return { text: missing.join("\n"), count: 0 };
		if (args.confirm !== undefined && typeof args.confirm !== "boolean") return { text: "Errore: la conferma è sì o no.", count: 0 };
		const year = Number(day.slice(0, 4));
		// The first DDT of the year with Annie: the last number the person reached before, asked as the invoices ask it.
		const last = args.last_number;
		if (last !== undefined && (typeof last !== "number" || !Number.isInteger(last) || last < 0 || last >= DDT_LIMITS.perYear)) return { text: "Errore: il numero dell'ultimo DDT è un numero intero, 0 se non ce n'è nessuno.", count: 0 };
		const issuedIn = (y: number) => loaded.book.ddts.some((x) => isIssuedDdt(x) && x.year === y);
		const allLastYear = day.slice(5, 7) === "01" && issuedIn(year - 1) && (loaded.book.settings?.lastBefore?.[String(year - 1)] ?? 0) === 0;
		if (last === undefined && !issuedIn(year) && loaded.book.settings?.lastBefore?.[String(year)] === undefined && !allLastYear) return { text: `È il primo DDT che emetti con me nel ${year}: qual è il numero dell'ultimo DDT che hai fatto quest'anno? Se nessuno, parto da 1. Chiedilo a chi ti scrive, poi rifai con la sua risposta (prima di emettere ti mostro il DDT).`, count: 0 };
		if (last !== undefined && issuedIn(year)) return { text: `Nel ${year} ho già emesso DDT, quindi la numerazione va avanti da quelli.`, count: 0 };
		if (last !== undefined) {
			const refused = requirePersonFor(ctx, "fisso da che numero partono i DDT");
			if (refused !== undefined) return { text: refused, count: 0 };
			const by = marker(ctx);
			await ctx.step("first", async () => {
				store.update(`${ctx.callId}:first`, (state) => {
					if (state.ddts.some((x) => isIssuedDdt(x) && x.year === year)) return state;
					return { ...state, settings: { ...(state.settings ?? {}), ...by, lastBefore: { ...(state.settings?.lastBefore ?? {}), [String(year)]: last as number } } };
				});
				return true;
			});
			loaded = { ...loaded, book: store.read() };
		}
		const next = nextDdtSeq(loaded.book, year);
		const numberNow = loaded.book.settings?.numbering === "plain" ? String(next) : `${next}/${year}`;
		if (args.confirm !== true) {
			return {
				text: [
					`Emetterei questo DDT con la data di oggi: prende il numero ${numberNow}. Una volta emesso non si cancella più, si può solo annullare (e il numero resta).`,
					fencedDdt(ddtBlock(d, loaded.links)),
					...stockPreview(d, day, marker(ctx)),
					...missingNotes(d),
					"Ripeti a chi ti scrive i dati del riquadro e chiedi conferma: lo emetto solo dopo il suo sì.",
				].join("\n"),
				count: 0,
			};
		}
		// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
		const refused = requirePersonFor(ctx, "emetto il DDT");
		if (refused !== undefined) return { text: refused, count: 0 };
		const id = await ctx.step("issue", async () => store.issue(d.id, ctx.callId, day, marker(ctx)).id);
		const issued = store.read().ddts.find((x): x is IssuedDdt => x.id === id && isIssuedDdt(x));
		if (issued === undefined) return { text: "Errore: il DDT non risulta emesso.", count: 0 };
		return issuedAnswer(issued, ctx, loaded);
	}

	async function issuedAnswer(d: IssuedDdt, ctx: ToolContext, loaded: Loaded): Promise<{ text: string; count: number }> {
		// Counted once: on the run that completes the issue, never on a run after it.
		const before = store.read().ddts.find((x) => x.id === d.id)?.stocked === true;
		const done = await complete(d, ctx);
		const after = (store.read().ddts.find((x) => x.id === d.id) ?? d) as IssuedDdt;
		const out = [`Fatto: ho emesso il ${ddtTitle(after)}, come nel riquadro.`, fencedDdt(ddtBlock(after, loaded.links)), ...done.notes];
		if (done.done) {
			if (after.causale === "vendita") out.push("Quando fai la fattura differita del mese, questo DDT ci entra da solo; va emessa entro il 15 del mese dopo.");
			out.push("Vuoi il PDF da stampare o da mandare? Non lo mando a nessuno da sola.");
		}
		return { text: out.join("\n"), count: done.done && !before ? 1 : 0 };
	}

	async function cancel(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded): Promise<{ text: string; count: number }> {
		const d = target(args, loaded, (x) => x.status !== "cancelled", "aperto");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status === "cancelled") return { text: `${ddtTitle(d)}: è già annullato.`, count: 0 };
		const billed = d.billed?.number ?? loaded.links.issued.get(d.id);
		if (billed !== undefined) return { text: `Il ${ddtTitle(d)} è già fatturato con la fattura n. ${billed}: non si annulla. Se la merce è tornata, si fa un DDT di reso; per la fattura, una nota di credito.`, count: 0 };
		const draft = loaded.links.draft.get(d.id);
		if (draft !== undefined) return { text: `Il ${ddtTitle(d)} è nella bozza di fattura ${draft}: prima va tolta quella bozza (o rifatta senza questo DDT), poi lo annullo.`, count: 0 };
		const refused = requirePersonFor(ctx, isIssuedDdt(d) ? `annullo il DDT n. ${d.number}` : `annullo la bozza del DDT ${d.id}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const by = marker(ctx);
		await ctx.step("cancel", async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.ddts.find((x) => x.id === d.id);
				if (cur === undefined || cur.status === "cancelled") return state;
				return { ...state, ddts: state.ddts.map((x) => (x.id === d.id ? { ...cur, status: "cancelled" as const, cancelled: by } : x)) };
			});
			return true;
		});
		if (!isIssuedDdt(d)) return { text: `Annullata la bozza ${d.id}: nessun numero è stato usato.`, count: 1 };
		const out = [`Annullato il DDT n. ${d.number}: resta nell'elenco come annullato, con il suo numero, che non si usa più.`];
		const moved = options.stock?.read();
		if (moved !== undefined && !moved.broken && moved.moves.some((m) => m.sale?.invoice === d.id)) out.push(d.causale === "reso" ? "La merce di questo reso era stata rimessa in magazzino: se non è tornata davvero, va corretto con un conteggio del magazzino. Non lo cambio da sola." : "La merce di questo DDT era stata scaricata dal magazzino: se non è partita, va rimessa con un conteggio del magazzino. Non lo cambio da sola.");
		return { text: out.join(" "), count: 1 };
	}

	async function document(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded): Promise<{ text: string; count: number }> {
		const d = target(args, loaded, (x) => x.status === "issued", "emesso");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status === "cancelled") return { text: `${ddtTitle(d)}: è annullato, non ne faccio il documento.`, count: 0 };
		if (!isIssuedDdt(d)) return { text: `Il DDT ${d.id} è ancora una bozza: prima va emesso (prende il numero), poi lo stampo. Vuoi che te lo mostri per emetterlo?`, count: 0 };
		const format = args.format === undefined ? "pdf" : args.format;
		if (format !== "pdf" && format !== "docx") return { text: "Errore: il documento è PDF o Word.", count: 0 };
		const refused = requirePersonFor(ctx, `faccio il documento del DDT n. ${d.number}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const book = options.company?.read();
		const company: Partial<Company> = book === undefined || book.broken ? {} : (book.company ?? {});
		const ext = `.${format}`;
		try {
			// The file made before is written again only when it is one of ours, under ddt/.
			const mine = d.file !== undefined && d.file.endsWith(ext) && /^ddt\/[^/\\]+$/.test(d.file) && !d.file.includes("..");
			const slug = fileSlug(d.client.name);
			const path = await ctx.step("path", async () => (mine ? (d.file as string) : await freePath(workspace, `ddt/DDT-${d.number.replace("/", "-")}${slug === "" ? "" : `-${slug}`}`, ext)));
			const made = await ctx.step("file", async () => {
				const doc = await make({ format, text: ddtMarkdown(d, company), name: `DDT ${d.number}`, pictures: [], now: now().getTime() });
				return { path: (await workspace.write(path, doc.data)).path, notes: [...doc.notes] };
			});
			await ctx.step("record", async () => {
				store.update(ctx.callId, (state) => ({ ...state, ddts: state.ddts.map((x) => (x.id === d.id ? { ...x, file: made.path.slice(0, DDT_LIMITS.file) } : x)) }));
				return true;
			});
			const bare = company.name === undefined ? ["Non ho i dati della tua azienda, quindi il documento è senza intestazione: dimmi ragione sociale, indirizzo e partita IVA e li salvo, poi lo rifaccio."] : [];
			return { text: [`Ecco il ${format === "pdf" ? "PDF" : "documento Word"} del DDT n. ${d.number}: il file è nel riquadro. Non l'ho mandato a nessuno; se vuoi te lo mando qui.`, fencedDdt(`File: ${made.path}`), ...bare, ...made.notes].join("\n"), count: 1 };
		} catch (error) {
			if (error instanceof WorkspaceError || error instanceof DocumentError) return { text: `Errore: non sono riuscita a fare il documento del DDT (${error.message}).`, count: 0 };
			throw error;
		}
	}

	function list(args: Record<string, unknown>, loaded: Loaded, day: string): { text: string; count: number } {
		if (args.unbilled !== undefined && typeof args.unbilled !== "boolean") return { text: "Errore: da fatturare è sì o no.", count: 0 };
		if (args.all !== undefined && typeof args.all !== "boolean") return { text: "Errore: tutti è sì o no.", count: 0 };
		let pool: Ddt[] = [...loaded.book.ddts];
		let whose = "";
		if (args.client !== undefined) {
			const said = cleanText(args.client, DDT_LIMITS.name, "il cliente");
			if (isProblem(said)) return { text: `Errore: ${said.problem}.`, count: 0 };
			const c = ddtClientSaid(said ?? "", loaded.book.ddts);
			if (typeof c === "string") return { text: c, count: 0 };
			if ("none" in c) return { text: ["Non trovo DDT per questo cliente.", fencedDdt(said ?? "")].join("\n"), count: 0 };
			pool = ofClient(pool, c);
			whose = " di questo cliente";
		}
		if (args.month !== undefined) {
			const m = cleanText(args.month, 7, "il mese");
			if (isProblem(m) || m === undefined || !/^\d{4}-\d{2}$/.test(m)) return { text: "Errore: il mese è come 2026-10.", count: 0 };
			pool = pool.filter((d) => d.day.slice(0, 7) === m);
		}
		if (args.unbilled === true) {
			const open = pool.filter((d) => unbilled(d, loaded.links)).sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
			if (open.length === 0) return { text: `Nessun DDT di vendita da fatturare${whose}: sono tutti in una fattura.`, count: 0 };
			const late = open.filter((d) => day > `${d.day.slice(0, 7)}-31` && day.slice(0, 7) !== d.day.slice(0, 7)).length;
			const held = open.filter((d) => loaded.links.draft.has(d.id)).length;
			const clients = new Set(open.map((d) => clientKey(d.client))).size;
			const head = `${n1(open.length, "Un DDT di vendita", "# DDT di vendita")} da fatturare${whose}, ${n1(clients, "di un cliente", "di # clienti")}${held === 0 ? "" : ` (${n1(held, "uno è già", "# sono già")} in una bozza di fattura)`}:`;
			const tail = late === 0 ? [] : [`${n1(late, "Uno è", "# sono")} dei mesi passati: la fattura differita va emessa entro il 15 del mese dopo i DDT. Chiedimi «fai la fattura differita di <mese> per <cliente>».`];
			return { text: [head, fencedDdt([...open.slice(0, DDT_LIMITS.shown).map((d) => `• ${ddtRow(d, loaded.links)}`), ...more(open.length)].join("\n")), ...tail].join("\n"), count: open.length };
		}
		const year = day.slice(0, 4);
		const shown = pool.filter((d) => (args.all === true ? true : d.status !== "cancelled" && (d.status === "draft" || d.day.slice(0, 4) === year))).sort((a, b) => b.id.localeCompare(a.id));
		if (shown.length === 0) return { text: args.all === true ? `Non c'è ancora nessun DDT${whose}.` : `Nessun DDT${whose} quest'anno, e nessuna bozza.`, count: 0 };
		const drafts = shown.filter((d) => d.status === "draft").length;
		return { text: [`${n1(shown.length, "Un DDT", "# DDT")}${whose}${args.all === true ? "" : ` del ${year} e in bozza`} (${n1(drafts, "una bozza", "# bozze")}):`, fencedDdt([...shown.slice(0, DDT_LIMITS.shown).map((d) => `• ${ddtRow(d, loaded.links)}`), ...more(shown.length)].join("\n"))].join("\n"), count: shown.length };
	}

	function status(args: Record<string, unknown>, loaded: Loaded): { text: string; count: number } {
		const d = target(args, loaded, (x) => x.status !== "cancelled", "aperto");
		if (typeof d === "string") return { text: d, count: 0 };
		const extra = isIssuedDdt(d) && d.status === "issued" && d.stocked !== true ? ["L'emissione non è completa (il magazzino non si era mosso): si completa emettendolo di nuovo."] : [];
		return { text: [`Ecco il ${isIssuedDdt(d) ? ddtTitle(d) : `DDT in bozza ${d.id}`}:`, fencedDdt([ddtBlock(d, loaded.links), ...(d.file === undefined ? [] : [`File: ${d.file}`])].join("\n")), ...extra].join("\n"), count: 1 };
	}

	async function exportCsv(ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const all = loaded.book.ddts;
		if (all.length === 0) return { text: "Non c'è ancora nessun DDT da mettere nel file.", count: 0 };
		const path = await ctx.step("path", async () => freePath(workspace, `ddt/ddt-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, ddtCsv(all, loaded.links))).path);
		return { text: [`Salvato il file dei DDT: ${n1(all.length, "un DDT", "# DDT")}, una riga per voce, con lo stato (separatore «;», decimali con la virgola, si apre con Excel). Il percorso è nel riquadro; mandalo con file_send se chi ti scrive lo vuole.`, fencedDdt(written)].join("\n"), count: all.length };
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const thisYear = Number(day.slice(0, 4));
		if (args.numbering !== undefined && args.numbering !== "plain" && args.numbering !== "year") return { text: "Errore: il numero del DDT si scrive come «12/2026» o come «12».", count: 0 };
		const year = typeof args.year === "number" && Number.isInteger(args.year) ? args.year : thisYear;
		const last = args.last_number;
		if (last !== undefined && (typeof last !== "number" || !Number.isInteger(last) || last < 0 || last >= DDT_LIMITS.perYear)) return { text: "Errore: il numero dell'ultimo DDT è un numero intero, 0 se non ce n'è nessuno.", count: 0 };
		const shownNow = (book: DdtBook) => {
			const numbering = book.settings?.numbering;
			const next = nextDdtSeq(book, thisYear);
			return `I DDT sono numerati ${numbering === "plain" ? "1, 2, 3… (oppure 1/2026, 2/2026 se preferisci)" : `1/${thisYear}, 2/${thisYear}… (oppure 1, 2, 3 se preferisci)`}: il prossimo sarà il ${numbering === "plain" ? String(next) : `${next}/${thisYear}`}.`;
		};
		if (args.numbering === undefined && last === undefined) return { text: shownNow(loaded.book), count: 0 };
		// How the DDTs are numbered, and from which number: the person's own word (ADR 0088).
		const refused = requirePersonFor(ctx, "cambio la numerazione dei DDT");
		if (refused !== undefined) return { text: refused, count: 0 };
		const issuedIn = (y: number) => loaded.book.ddts.some((d) => isIssuedDdt(d) && d.year === y);
		if (args.numbering !== undefined && args.numbering !== (loaded.book.settings?.numbering ?? "year") && issuedIn(thisYear)) return { text: `Nel ${thisYear} ho già emesso DDT con questa numerazione: si può cambiare da gennaio, prima del primo DDT del ${thisYear + 1}. Non ho cambiato niente.`, count: 0 };
		if (last !== undefined && issuedIn(year)) return { text: `Nel ${year} ho già emesso DDT, quindi la numerazione va avanti da quelli: l'ultimo numero prima di me si può dire solo prima del primo DDT dell'anno. Non ho cambiato niente.`, count: 0 };
		const by = marker(ctx);
		await ctx.step("settings", async () => {
			store.update(ctx.callId, (state) => {
				if (last !== undefined && state.ddts.some((d) => isIssuedDdt(d) && d.year === year)) throw new DdtError(`nel ${year} intanto è stato emesso un DDT: l'ultimo numero prima di me non si cambia più`);
				return { ...state, settings: { ...(state.settings ?? {}), ...by, ...(args.numbering === undefined ? {} : { numbering: args.numbering as "plain" | "year" }), ...(last === undefined ? {} : { lastBefore: { ...(state.settings?.lastBefore ?? {}), [String(year)]: last as number } }) } };
			});
			return true;
		});
		return { text: `Fatto, ho salvato. ${shownNow(store.read())}`, count: 1 };
	}

	async function brief(ctx: ToolContext, loaded: Loaded, day: string): Promise<string> {
		const last = addDays(`${day.slice(0, 7)}-01`, -1).slice(0, 7);
		const open = loaded.book.ddts.filter((d) => unbilled(d, loaded.links) && d.day.slice(0, 7) === last);
		const stale = loaded.book.ddts.filter((d) => d.status === "draft" && d.at < new Date(now().getTime() - DDT_LIMITS.staleDays * 86_400_000).toISOString()).length;
		const wanted = [...(open.length > 0 ? [`unbilled:${last}`] : []), ...(stale > 0 ? ["stale"] : [])];
		const said = wanted.length === 0 ? [] : await ctx.step("claim", async () => store.claim(ctx.callId, day, wanted));
		const clients = [...new Map(open.map((d) => [clientKey(d.client), d.client.name])).values()];
		const count = said.length;
		if (count > 0) await audit(ctx, "brief", count);
		return briefAnswer(said.includes(`unbilled:${last}`) ? { month: last, count: open.length, clients } : undefined, said.includes("stale") ? stale : 0, day);
	}

	/** Another agente: how many, nothing more. */
	function agentCounts(loaded: Loaded): string {
		const drafts = loaded.book.ddts.filter((d) => d.status === "draft").length;
		const open = loaded.book.ddts.filter((d) => unbilled(d, loaded.links)).length;
		return `DDT: ${n1(drafts, "una bozza", "# bozze")}, ${n1(open, "uno di vendita da fatturare", "# di vendita da fatturare")}. A un altro agente do solo i conteggi: clienti, merce e numeri no.`;
	}

	async function run(op: DdtOp, args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		switch (op) {
			case "create":
				return create(args, ctx, loaded, day);
			case "change":
				return change(args, ctx, loaded);
			case "issue":
				return issue(args, ctx, loaded, day);
			case "cancel":
				return cancel(args, ctx, loaded);
			case "document":
				return document(args, ctx, loaded);
			case "list":
				return list(args, loaded, day);
			case "status":
				return status(args, loaded);
			case "export":
				return exportCsv(ctx, loaded, day);
			case "settings":
				return settings(args, ctx, loaded, day);
		}
	}

	const lineSchema = {
		type: "object",
		properties: {
			item: text(120, "a voce of the listino, as said or LS-0001"),
			description: text(DDT_LIMITS.description, "free text, when it is not a voce of the listino"),
			quantity: { type: ["number", "string"], description: "how many; 0 takes the line off (change)" },
			unit: text(DDT_LIMITS.unit, "«risme», «pz», «kg»; default the voce's"),
		},
		required: ["quantity"],
		additionalProperties: false,
	};

	return [
		{
			name: "ddt",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...DDT_OPS] },
					client: text(DDT_LIMITS.name, "create: the client as said, partita IVA, or card id CL-0001; change, issue, cancel, document, status, list: whose DDT"),
					ddt: text(30, "change, issue, cancel, document, status: the DDT's number («12/2026», «12») or the draft's id (DT-0001)"),
					lines: { type: "array", maxItems: DDT_LIMITS.lines, items: lineSchema, description: "create: the goods; change: the lines to set" },
					causale: text(30, "vendita (default), conto visione, reso, riparazione, omaggio, comodato, lavorazione"),
					of: text(30, "create, change with causale reso: the DDT the goods come back from"),
					transport: { type: "string", enum: ["mittente", "destinatario", "vettore"], description: "who carries the goods: the person (mittente), the client (destinatario), a carrier (vettore)" },
					carrier: text(DDT_LIMITS.carrier, "the carrier's name, with transport vettore"),
					destination: text(DDT_LIMITS.destination, "where the goods go, when not the client's address"),
					aspect: text(DDT_LIMITS.aspect, "aspetto esteriore dei beni («scatole», «pallet»)"),
					packages: { type: ["integer", "string"], description: "numero colli" },
					weight: { type: ["number", "string"], description: "peso in kg" },
					notes: text(DDT_LIMITS.notes, "notes on the DDT"),
					confirm: { type: "boolean", description: "create: true only after the person's yes to the proposal; issue: true only after the person's yes to what was shown" },
					check: text(20, "create with confirm: the check given with the proposal"),
					format: { type: "string", enum: ["pdf", "docx"], description: "document: PDF (default) or Word" },
					unbilled: { type: "boolean", description: "list: only the vendita DDTs not invoiced yet" },
					month: text(7, "list: the month, as 2026-10"),
					all: { type: "boolean", description: "list: every DDT, the annulled ones and the past years too" },
					compact: { type: "boolean", description: "list: the brief's line only" },
					numbering: { type: "string", enum: ["plain", "year"], description: "settings: «12» or «12/2026» (default)" },
					last_number: { type: "integer", minimum: 0, maximum: DDT_LIMITS.perYear - 1, description: "settings, issue: the number of the last DDT the person made this year before Annie (0: none), as the person says it" },
					year: { type: "integer", minimum: 2000, maximum: 2100, description: "settings: the year of last_number" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!DDT_OPS.includes(args.op as DdtOp)) return "Errore: non conosco questa operazione sui DDT.";
				const op = args.op as DdtOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				// DDTs name clients, goods and addresses: another agente gets counts only.
				if (isAgentTurn(ctx) && !["list", "status"].includes(op)) return AGENT_REFUSAL;
				const day = todayIn(timeZone, now());
				try {
					const loaded = load();
					if (typeof loaded === "string") return loaded;
					if (isAgentTurn(ctx)) return agentCounts(loaded);
					if (op === "list" && args.compact === true) return await brief(ctx, loaded, day);
					const answer = await run(op, args, ctx, loaded, day);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof DdtError) return `Errore: ${error.message}.`;
					if (error instanceof StockError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}

