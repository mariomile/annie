/**
 * I DDT and il magazzino: what a DDT moves when issued (vendita, omaggio and conto visione unload
 * its lines with a voce that is an article, each on its own reason; a reso puts back the goods of
 * the DDT it names, never more than that took out), shown before the yes and done once per DDT and
 * line however many times it runs; and an annulled DDT whose goods never left, put back as a
 * storno of its own scarichi, once. A magazzino that does not read never stops a DDT: the issue
 * completes later. Articles in the fence by name.
 */
import { type Ddt, isIssuedDdt, UNLOADING } from "../ddt.ts";
import type { DdtStore } from "../ddt-store.ts";
import type { ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import type { Marker } from "../marker.ts";
import { type SaleReason, StockError, type StockItem } from "../stock.ts";
import { planSale, type Sale, STOCK_BROKEN, STOCK_FULL, type StockLink } from "../stock-store.ts";
import { qtyOf, stateOf } from "../stock-sums.ts";
import { fencedStock, nameOf, qtyNumber, qtyWords } from "./stock-render.ts";

/** The number a DDT moves the magazzino with: ours, or the client's own DDT of a reso. */
export const stockNumber = (d: Ddt): string => (isIssuedDdt(d) ? d.number : `${d.theirs?.number ?? d.id} del cliente`);

const REASON: Partial<Record<Ddt["causale"], SaleReason>> = { vendita: "vendita", omaggio: "omaggio", conto_visione: "conto_visione" };

/** The DDT as the magazzino takes it: its lines with a voce; a reso puts back the goods of the DDT it names. Undefined when it moves nothing. */
export function ddtSale(d: Ddt, number: string, day: string): Sale | undefined {
	if (!UNLOADING.includes(d.causale) && !(d.causale === "reso" && d.of !== undefined)) return undefined;
	const lines = d.lines.flatMap((l) => (l.item === undefined ? [] : [{ line: l.n, listino: l.item, quantity: l.qty, description: l.description, ...(l.unit === undefined ? {} : { unit: l.unit }) }]));
	if (lines.length === 0) return undefined;
	const reason = REASON[d.causale];
	return { invoice: d.id, number, day, ...(d.causale === "reso" && d.of !== undefined ? { of: d.of } : {}), ...(reason === undefined || reason === "vendita" ? {} : { reason }), lines };
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
export function stockPreview(stock: StockLink | undefined, d: Ddt, day: string, by: Marker): string[] {
	const sale = ddtSale(d, "anteprima", day);
	const back = d.causale === "reso";
	if (sale === undefined) {
		if (UNLOADING.includes(d.causale) && d.lines.every((l) => l.item === undefined)) return ["Nessuna riga è una voce del listino: il magazzino non si muove."];
		if (!UNLOADING.includes(d.causale) && !back) return ["Con questa causale il magazzino non si muove."];
		return [];
	}
	if (stock === undefined) return [];
	const book = stock.read();
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
		if (!back) {
			const under = [...byItem.values()].map(({ item, qty }) => ({ item, qty, there: stateOf(item, book.moves).onHand })).filter((x) => x.there - x.qty < 0n);
			if (under.length > 0) out.push([`${n1(under.length, "Un articolo andrebbe", "# articoli andrebbero")} sotto zero (nel riquadro): dillo a chi ti scrive prima del sì, di solito manca un carico. Il DDT si emette lo stesso.`, fencedStock(under.map((x) => `• ${nameOf(x.item)}: in magazzino ${qtyWords(x.there, x.item.unit)}, ne scarica ${qtyNumber(x.qty)}, andrebbe a ${qtyNumber(x.there - x.qty)}`).join("\n"))].join("\n"));
		}
	} else if (plan.skipped.length === 0) out.push("Nessuna riga è un articolo del magazzino: il magazzino non si muove.");
	out.push(...skippedNote(plan.skipped, back));
	return out;
}

type Stocked = { readonly stop?: "broken" | "full" | "invalid"; readonly rows: string[]; readonly negative: number; readonly skipped: { description: string; why: string }[] };

/** The sale written once under a step: what moved, or why it stopped. */
async function written(stock: StockLink, sale: Sale, by: Marker, ctx: ToolContext, key: string, back: boolean): Promise<Stocked> {
	return ctx.step(key, async (): Promise<Stocked> => {
		try {
			const out = stock.sale(sale, by);
			if ("full" in out) return { stop: "full", rows: [], negative: 0, skipped: [] };
			if (out.broken) return { stop: "broken", rows: [], negative: 0, skipped: [] };
			const mine = out.moved.filter((m) => (m.move.kind === "storno") === back);
			return { rows: mine.map((m) => `• ${nameOf(m.item)}: ${back ? "+" : "−"}${qtyWords(qtyOf(m.move.qty), m.item.unit)}`), negative: back ? 0 : mine.filter((m) => m.negative).length, skipped: out.skipped.map((s) => ({ description: s.description, why: s.why })) };
		} catch (error) {
			if (error instanceof StockError) return { stop: error.message === STOCK_FULL ? "full" : error.message === STOCK_BROKEN ? "broken" : "invalid", rows: [], negative: 0, skipped: [] };
			throw error;
		}
	});
}

/** The magazzino moved by the DDT issued (or the reso recorded), once per DDT and line however many times this runs; then the issue complete. A stop leaves it to complete. */
export async function completeStock(store: DdtStore, stock: StockLink | undefined, d: Ddt, ctx: ToolContext, by: Marker): Promise<{ notes: string[]; done: boolean }> {
	const sale = ddtSale(d, stockNumber(d), d.day);
	const back = d.causale === "reso";
	if (sale === undefined || stock === undefined) {
		store.setStocked(d.id);
		return { notes: [], done: true };
	}
	const r = await written(stock, sale, by, ctx, "stock", back);
	const again = isIssuedDdt(d) ? `Quando è sistemato, si completa emettendo di nuovo il DDT n. ${d.number}: il numero resta quello.` : "Quando è sistemato, si completa registrando di nuovo il reso.";
	const what = back ? "la merce del reso non è rimessa in magazzino" : "le righe non sono scaricate dal magazzino";
	const doc = isIssuedDdt(d) ? "il DDT è emesso" : "il reso è registrato";
	if (r.stop === "full") return { notes: [`Attenzione: il magazzino è pieno di movimenti, quindi ${what}: ${doc}, ma resta da completare. Chi ti scrive può chiudere un anno passato del magazzino. ${again}`], done: false };
	if (r.stop === "broken") return { notes: [`Attenzione: il magazzino non si legge, quindi ${what}: ${doc}, ma resta da completare. ${again}`], done: false };
	if (r.stop === "invalid") return { notes: [`Attenzione: il magazzino non ha accettato questi movimenti, quindi ${what}: ${doc}, ma resta da completare. Va controllato il file del magazzino. ${again}`], done: false };
	store.setStocked(d.id);
	const notes: string[] = [];
	if (r.rows.length > 0) notes.push([back ? `Ho rimesso in magazzino ${n1(r.rows.length, "una riga", "# righe")} del reso:` : `Ho scaricato dal magazzino ${n1(r.rows.length, "una riga", "# righe")} del DDT:`, fencedStock(r.rows.join("\n"))].join("\n"));
	if (r.negative > 0) notes.push(`Attenzione: ${n1(r.negative, "un articolo è", "# articoli sono")} in negativo in magazzino (ne sono usciti più di quelli caricati): ${r.negative === 1 ? "va ricontato" : "vanno ricontati"}, o manca un carico.`);
	notes.push(...skippedNote(r.skipped, back));
	return { notes, done: true };
}

/** Whether the DDT took goods out of the magazzino (its own scarichi there, or archived by a year closed). */
export function unloaded(stock: StockLink | undefined, d: Ddt): boolean {
	const book = stock?.read();
	if (book === undefined || book.broken) return false;
	// After a year of the magazzino is closed, its scarichi live on as archived keys.
	return book.moves.some((m) => m.kind === "scarico" && m.sale?.invoice === d.id) || book.archived.some((a) => a.of === undefined && a.k.startsWith(`${d.id}#`));
}

/**
 * An annulled DDT whose goods never left: its own scarichi put back (a storno of the DDT itself),
 * once per line however many times this runs. A magazzino that does not read is said.
 */
export async function unstock(stock: StockLink | undefined, d: Ddt, day: string, ctx: ToolContext, by: Marker): Promise<string[]> {
	const sale = ddtSale(d, stockNumber(d), day);
	if (stock === undefined || sale === undefined || d.causale === "reso") return [];
	const { reason: _, ...back } = sale;
	const r = await written(stock, { ...back, of: d.id }, by, ctx, "unstock", true);
	if (r.stop !== undefined) return ["Attenzione: il magazzino non si legge (o non accetta altri movimenti), quindi la merce non l'ho rimessa: va rimessa con un conteggio del magazzino quando è sistemato."];
	if (r.rows.length === 0) return ["In magazzino non c'era niente da rimettere per questo DDT."];
	return [[`Ho rimesso in magazzino ${n1(r.rows.length, "una riga", "# righe")} del DDT annullato, perché la merce non è partita:`, fencedStock(r.rows.join("\n"))].join("\n")];
}
