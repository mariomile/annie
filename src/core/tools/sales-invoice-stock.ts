/**
 * The fatture in uscita and il magazzino: what an invoice moves there, shown before the yes and
 * done when it is issued (an invoice unloads the articles its lines sell, a credit note puts them
 * back, once per invoice and line: stock-store.ts planSale and sale, the same mapping both
 * times); the lines that look like an article but are not linked, said; and, at the draft, a line
 * dictated with an article's name linked to its voce, and a line whose voce does not match its
 * description asked about. Names and descriptions only inside the fences.
 */
import type { ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import type { Marker } from "../marker.ts";
import { sameStems, stemsWithin } from "../name-keys.ts";
import { CREDIT_NOTE_TYPE } from "../sales-invoice-rules.ts";
import type { IssuedInvoice, SalesInvoice } from "../sales-invoices.ts";
import { StockError, type StockItem } from "../stock.ts";
import { planSale, type Sale, type StockBook } from "../stock-store.ts";
import { qtyOf, stateOf } from "../stock-sums.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";
import { fenced } from "./sales-invoice-render.ts";
import { fencedStock, nameOf, qtyNumber, qtyWords } from "./stock-render.ts";

/** The invoice as the magazzino takes it: its lines naming a voce, with the invoice it corrects for a credit note; undefined when no line names one. */
export function saleOf(inv: SalesInvoice, number: string, day: string): Sale | undefined {
	const lines = inv.lines.flatMap((l, n) => (l.item === undefined ? [] : [{ line: n + 1, listino: l.item, quantity: l.quantity, description: l.description, ...(l.unit === undefined ? {} : { unit: l.unit }) }]));
	if (lines.length === 0) return undefined;
	const credit = inv.type === CREDIT_NOTE_TYPE;
	if (credit && inv.related === undefined) return undefined;
	return { invoice: inv.id, number, day, ...(credit && inv.related !== undefined ? { of: inv.related.id } : {}), lines };
}

const SKIP_WHY: Readonly<Record<string, string>> = {
	unit: "l'unità della riga non è quella dell'articolo in magazzino",
	quantity: "la quantità della riga non è un numero",
	nothing: "la fattura stornata non le aveva scaricate",
};

function skippedNote(skipped: readonly { description: string; why: string }[], credit: boolean): string[] {
	if (skipped.length === 0) return [];
	const head = credit ? n1(skipped.length, "Una riga non l'ho rimessa in magazzino", "# righe non le ho rimesse in magazzino") : n1(skipped.length, "Una riga non l'ho scaricata dal magazzino", "# righe non le ho scaricate dal magazzino");
	return [[`${head}:`, fenced(skipped.map((s) => `• ${s.description}: ${SKIP_WHY[s.why] ?? s.why}`).join("\n")), `Se ${skipped.length === 1 ? "va" : "vanno"} ${credit ? "rimess" : "scaricat"}${skipped.length === 1 ? "a" : "e"}, dimmi quante unità sono e ${credit ? "le rimetto" : "le scarico"} io.`].join("\n")];
}

/** The lines with no voce whose description is an article's name: said, never moved. */
function unlinkedNote(inv: SalesInvoice, book: StockBook): string[] {
	if (inv.type === CREDIT_NOTE_TYPE) return [];
	const items = book.items.filter((i) => i.removed === undefined);
	const like = inv.lines.filter((l) => l.item === undefined && items.some((i) => sameStems(i.name, l.description)));
	if (like.length === 0) return [];
	return [
		[
			like.length === 1 ? "La riga nel riquadro sembra un articolo del magazzino, ma non è legata a una voce del listino: non l'ho scaricata. Dimmi se va scaricata." : "Le righe nel riquadro sembrano articoli del magazzino, ma non sono legate a voci del listino: non le ho scaricate. Dimmi se vanno scaricate.",
			fenced(like.map((l) => `• ${l.description}`).join("\n")),
		].join("\n"),
	];
}

/**
 * What issuing `draft` would move, for the question before the yes: each article with its
 * quantity, and an article that would go under zero, said with what there is. Nothing when the
 * invoice moves nothing.
 */
export function stockPreview(env: SalesEnv, draft: SalesInvoice, day: string, marker: Marker): string[] {
	if (env.stock === undefined) return [];
	const book = env.stock.read();
	const sale = saleOf(draft, "anteprima", day);
	if (book.broken) return sale === undefined ? [] : ["Attenzione: il magazzino non si legge, quindi questa fattura non potrà scaricare gli articoli venduti finché il file non è sistemato."];
	const out = unlinkedNote(draft, book);
	if (sale === undefined) return out;
	const plan = planSale(book, sale, marker);
	const credit = sale.of !== undefined;
	const byItem = new Map<string, { item: StockItem; qty: bigint }>();
	for (const m of plan.added) {
		const item = book.items.find((i) => i.id === m.item) as StockItem;
		const was = byItem.get(item.id)?.qty ?? 0n;
		byItem.set(item.id, { item, qty: was + qtyOf(m.qty) });
	}
	if (byItem.size > 0) {
		out.push([credit ? "Effetti sul magazzino: questa nota di credito rimette gli articoli nel riquadro." : "Effetti sul magazzino: questa fattura scarica gli articoli nel riquadro.", fencedStock([...byItem.values()].map(({ item, qty }) => `${credit ? "Rimette in magazzino" : "Scarica dal magazzino"}: ${nameOf(item)} ${credit ? "+" : "−"}${qtyWords(qty, item.unit)}`).join("\n"))].join("\n"));
		if (!credit)
			for (const { item, qty } of byItem.values()) {
				const there = stateOf(item, book.moves).onHand;
				if (there - qty < 0n) out.push(`In magazzino ci sono ${qtyWords(there, item.unit)} di ${item.id}: questa fattura ne scarica ${qtyNumber(qty)}, quindi andrebbe a ${qtyNumber(there - qty)}. Dillo a chi ti scrive prima del sì: di solito manca un carico.`);
			}
	}
	out.push(...skippedNote(plan.skipped, credit));
	return out;
}

type StockStep = { readonly broken: boolean; readonly full: boolean; readonly moved: { readonly row: string; readonly negative: boolean }[]; readonly skipped: { readonly description: string; readonly why: string }[]; readonly unlinked: string[] };

/**
 * The magazzino moved by the invoice issued, once per invoice and line however many times this
 * runs. A magazzino that does not read, or is full, leaves the issue to complete (like the hours),
 * and says why.
 */
export async function markStock(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const stock = env.stock;
	if (stock === undefined) return { notes: [], done: true };
	const sale = saleOf(inv, inv.number, inv.date);
	const credit = sale?.of !== undefined;
	const marker = env.marker(ctx);
	const result: StockStep = await ctx.step("stock", async () => {
		const book = stock.read();
		const unlinked = book.broken ? [] : unlinkedNote(inv, book);
		if (sale === undefined) return { broken: false, full: false, moved: [], skipped: [], unlinked };
		try {
			const r = stock.sale(sale, marker);
			if ("full" in r) return { broken: false, full: true, moved: [], skipped: [], unlinked };
			if (r.broken) return { broken: true, full: false, moved: [], skipped: [], unlinked };
			return {
				broken: false,
				full: false,
				moved: r.moved.map((m) => ({ row: `• ${nameOf(m.item)} (${m.item.id}): ${credit ? "+" : "−"}${qtyWords(qtyOf(m.move.qty), m.item.unit)}`, negative: m.negative })),
				skipped: r.skipped.map((s) => ({ description: s.description, why: s.why })),
				unlinked,
			};
		} catch (error) {
			if (error instanceof StockError) return { broken: true, full: false, moved: [], skipped: [], unlinked };
			throw error;
		}
	});
	const again = `Quando è sistemato, si completa emettendo di nuovo questa ${credit ? "nota di credito" : "fattura"}, con lo stesso numero.`;
	if (result.full) return { notes: [`Attenzione: il magazzino è pieno di movimenti, quindi ${credit ? "gli articoli della nota di credito non sono rimessi" : "gli articoli venduti non sono scaricati"}: il documento è emesso, ma l'emissione resta da completare. Chi ti scrive può chiudere un anno passato del magazzino. ${again}`], done: false };
	if (result.broken) return { notes: [`Attenzione: il magazzino non si legge, quindi ${credit ? "gli articoli della nota di credito non sono rimessi" : "gli articoli venduti non sono scaricati"}. ${again}`], done: false };
	const notes: string[] = [];
	if (result.moved.length > 0) notes.push([credit ? `Ho rimesso in magazzino ${n1(result.moved.length, "una riga", "# righe")} della nota di credito:` : `Ho scaricato dal magazzino ${n1(result.moved.length, "una riga venduta", "# righe vendute")}:`, fencedStock(result.moved.map((m) => m.row).join("\n"))].join("\n"));
	const negative = result.moved.filter((m) => m.negative).length;
	if (!credit && negative > 0) notes.push(`Attenzione: ${n1(negative, "un articolo è", "# articoli sono")} in negativo in magazzino (ne sono usciti più di quelli caricati): ${negative === 1 ? "va ricontato" : "vanno ricontati"}, o manca un carico.`);
	notes.push(...skippedNote(result.skipped, credit), ...result.unlinked);
	return { notes, done: true };
}

/**
 * At the draft: a line dictated without a voce whose description is the name of an article that
 * is a voce of the listino gets that voce (so the issue unloads it), said; a line whose voce's
 * name is not in its description is asked about. `lines` as the draft reads them.
 */
export function draftStockLines(env: SalesEnv, lines: unknown): { lines: unknown; notes: string[] } {
	if (!Array.isArray(lines)) return { lines, notes: [] };
	const notes: string[] = [];
	const book = env.stock?.read();
	const articles = book === undefined || book.broken ? [] : book.items.filter((i) => i.removed === undefined && i.listino !== undefined);
	const linked: string[] = [];
	const out = lines.map((raw) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
		const l = raw as Record<string, unknown>;
		if (l.item !== undefined || typeof l.description !== "string") return raw;
		const match = articles.filter((i) => sameStems(i.name, l.description as string));
		if (match.length !== 1) return raw;
		const item = match[0] as StockItem;
		linked.push(`• ${l.description}: ${item.name} (${item.listino})`);
		return { ...l, item: item.listino };
	});
	if (linked.length > 0) notes.push([linked.length === 1 ? "Ho legato la riga nel riquadro alla voce del listino che è un articolo del magazzino: quando la fattura è emessa, si scarica." : "Ho legato le righe nel riquadro alle voci del listino che sono articoli del magazzino: quando la fattura è emessa, si scaricano.", fencedStock(linked.join("\n"))].join("\n"));
	const list = env.priceList?.read();
	if (list !== undefined && !list.broken) {
		const odd = out.flatMap((raw) => {
			if (typeof raw !== "object" || raw === null) return [];
			const l = raw as Record<string, unknown>;
			if (typeof l.item !== "string" || typeof l.description !== "string") return [];
			const voce = list.items.find((i) => i.id === l.item);
			return voce === undefined || stemsWithin(voce.name, l.description) ? [] : [`• la riga «${l.description}» è legata alla voce ${voce.name} (${voce.id}) del listino`];
		});
		if (odd.length > 0) notes.push([`${odd.length === 1 ? "Una riga ha" : "Alcune righe hanno"} una descrizione diversa dalla voce del listino a cui ${odd.length === 1 ? "è legata" : "sono legate"}: è giusto? Chiedilo a chi ti scrive, perché alla fattura emessa la voce muove il magazzino.`, fencedStock(odd.join("\n"))].join("\n"));
	}
	return { lines: out, notes };
}
