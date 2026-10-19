/**
 * Lines of a preventivo or a fattura that name a voce of the listino («3 giornate di consulenza»,
 * «LS-0002»), filled from it before the quote or the invoice reads its lines as it always does:
 * description, unit, unit price and VAT (or nature) from the voce; whatever the line gives itself
 * wins, and so does a VAT, nature or reason given for the whole document.
 *
 * Choices, tested:
 * - A phrase that names no voce, or that may be more than one, is never priced: the whole call
 *   comes back with the question (which voce, or the price of one not in the listino).
 * - Prices with VAT included, exactly as quotes take them: a preventivo whose every line is a voce
 *   with VAT included shows the prices as said (prices_include_vat), and one with VAT excluded in a
 *   quote with VAT included is grossed up exactly (to the fourth decimal, as quote lines hold);
 *   elsewhere, and in an invoice (always VAT excluded), the line's amount without VAT is the one a
 *   quote with VAT included would give for it (netLine), and said. The VAT always comes off at the
 *   voce's own rate: a line at another rate (said for the line or the document) keeps the voce's
 *   price without VAT, and that is said too.
 * - Forfettario: the VAT comes from the regime as for every line (0% with its dicitura or N2.2),
 *   never from the voce; the price is the voce's as written.
 */
import { euros } from "./format-words.ts";
import type { InvoiceStore } from "./invoice-store.ts";
import { fencedList, findItems, lineUnit, perUnit, type PriceItem } from "./price-list.ts";
import { PRICE_LIST_BROKEN, type PriceListStore } from "./price-list-store.ts";
import { AMBIGUOUS, decimalText, eurosToCents, halfUp, lineCents, netOf, readDecimal, scaled, scaledDecimal, VAT_RATES, type VatRate } from "./quote-sums.ts";
import { naturaWords, REGIME_FORFETTARIO } from "./sales-invoice-rules.ts";
import { regimeOf } from "./sales-invoices.ts";
import type { TaxStore } from "./tax-store.ts";

/** A VAT, nature or reason given for the whole document: it fills the lines as the document's own reader fills them. */
export type DocVat = { readonly vat?: unknown; readonly natura?: unknown; readonly vatNote?: unknown };

export type LineTarget = {
	readonly kind: "quote" | "invoice";
	/** quote: the prices include VAT as said (true or false), or nothing said (undefined: worked out from the voci). */
	readonly includeVat?: boolean;
	/** The longest description a line holds. */
	readonly descriptionMax: number;
	readonly doc?: DocVat;
};

export type FillTarget = LineTarget & { readonly forfettario: boolean };

export type FilledLines = { readonly lines: unknown[]; readonly includeVat: boolean; readonly notes: readonly string[]; readonly used: number } | { readonly ask: string };

/** Where the listino and the regime are read: quotes pass the company only (their regime is the company's), the others the tax profile too. */
export type ListSource = {
	readonly priceList?: Pick<PriceListStore, "read">;
	readonly company?: Pick<InvoiceStore, "read">;
	readonly taxes?: Pick<TaxStore, "read">;
};

/** Whether the owner is in the forfettario, as sales invoices tell it (sales-invoices.ts regimeOf). */
export function forfettarioOf(src: ListSource): boolean {
	const company = src.company?.read();
	const taxes = src.taxes?.read();
	return regimeOf(company === undefined || company.broken ? undefined : company.company, taxes === undefined || taxes.broken ? undefined : taxes.profile) === REGIME_FORFETTARIO;
}

/**
 * The lines with every voce named filled from the listino, in the owner's regime; or the question
 * (an «Errore: …» when the listino is not here or does not read). Undefined when no line names a
 * voce: the listino is not even read, and the lines go on as they are.
 */
export function listLines(src: ListSource, raw: unknown, t: LineTarget): FilledLines | undefined {
	if (!namesItems(raw)) return undefined;
	if (src.priceList === undefined) return { ask: "Errore: qui non vedo il listino: detta le voci con descrizione e prezzo." };
	const book = src.priceList.read();
	if (book.broken) return { ask: `Errore: ${PRICE_LIST_BROKEN}.` };
	return fillFromList(raw as unknown[], book.items, { ...t, forfettario: forfettarioOf(src) });
}

/** Whether some line names a voce: only then is the listino read. */
export function namesItems(lines: unknown): boolean {
	return Array.isArray(lines) && lines.some((l) => typeof l === "object" && l !== null && !Array.isArray(l) && (l as Record<string, unknown>).item !== undefined);
}

/** A voce in one line of a list: «Sito base (LS-0002): 1.500,00 € a corpo, IVA 22%». */
export function itemShort(i: PriceItem): string {
	return `${i.name}${i.code === undefined ? "" : ` [${i.code}]`} (${i.id}): ${euros(eurosToCents(i.price))} ${perUnit(i.unit)}${i.includesVat === true && i.vat > 0 ? " IVA inclusa" : ""}`;
}

/** A rate as a line or a document gives it: 22, «10», «10%»; undefined when it is not one. */
function rateOf(v: unknown): VatRate | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{1,2}\s*%?\s*$/.test(v) ? Number(v.replace("%", "")) : Number.NaN;
	return VAT_RATES.includes(n as VatRate) ? (n as VatRate) : undefined;
}

/** A quantity or a discount as the line gives it, canonical; undefined when it does not read. */
function decimalOf(v: unknown, decimals: number): string | undefined {
	if (typeof v !== "number" && typeof v !== "string") return undefined;
	const read = readDecimal(v, decimals);
	return read === undefined || read === AMBIGUOUS ? undefined : read;
}

/**
 * The unit price without VAT, to the fourth decimal as quote lines hold, of a line of `quantity`
 * (less `discount`) of a voce at `gross` with VAT included at `rate` (the voce's own): chosen so
 * that the line's amount is the amount without VAT of the same line with VAT included (quote-sums.ts
 * netOf of its lineCents), as a quote with VAT included takes it apart. When no 4-decimal price
 * gives it exactly (a very large quantity), the nearest one: `off` is the line's difference in
 * cents (0 when exact). Undefined when the quantity or the discount does not read.
 */
export function netLine(gross: string, quantity: unknown, discount: unknown, rate: VatRate): { readonly price: string; readonly net: bigint; readonly gross: bigint; readonly off: bigint } | undefined {
	const q = decimalOf(quantity ?? "1", 3);
	const d = discount === undefined ? undefined : decimalOf(discount, 2);
	if (q === undefined || (discount !== undefined && d === undefined)) return undefined;
	const line = (price: string) => lineCents({ quantity: q, price, vat: rate, ...(d === undefined ? {} : { discount: d }) });
	const grossTotal = line(gross);
	const target = netOf(grossTotal, rate);
	const denominator = scaled(q, 3) * (10_000n - (d === undefined ? 0n : scaled(d, 2)));
	if (target <= 0n || denominator <= 0n) return undefined;
	const first = halfUp(target * 1_000_000_000n, denominator);
	let best: { price: string; net: bigint; off: bigint } | undefined;
	for (const step of [0n, -1n, 1n, -2n, 2n, -3n, 3n]) {
		const p = first + step;
		if (p <= 0n) continue;
		const price = scaledDecimal(p, 4);
		const net = line(price);
		const off = net - target;
		if (off === 0n) return { price, net, gross: grossTotal, off };
		if (best === undefined || (off < 0n ? -off : off) < (best.off < 0n ? -best.off : best.off)) best = { price, net, off };
	}
	const nearest = best ?? { price: scaledDecimal(1n, 4), net: line("0.0001"), off: line("0.0001") - target };
	return { ...nearest, gross: grossTotal };
}

/** The lines with every voce named filled in, or the question to ask. Pure: the listino is the caller's. */
export function fillFromList(raw: readonly unknown[], items: readonly PriceItem[], t: FillTarget): FilledLines {
	const asks: string[] = [];
	const slips: string[] = [];
	const found = raw.map((line): PriceItem | undefined => {
		if (typeof line !== "object" || line === null || Array.isArray(line)) return undefined;
		const said = (line as Record<string, unknown>).item;
		if (said === undefined) return undefined;
		if (typeof said !== "string" || said.trim() === "") {
			asks.push("• una voce senza nome: item è il nome o il codice della voce del listino");
			return undefined;
		}
		const f = findItems(items, said.slice(0, 120));
		const quoted = `«${said.trim().slice(0, 120)}»`;
		if (f.kind === "exact") {
			if (f.slip === true) slips.push(`${quoted}: ${f.item.name} (${f.item.id})`);
			return f.item;
		}
		if (f.kind === "none") asks.push(`• ${quoted}: non c'è nel listino`);
		else if (f.items.length === 1) asks.push(`• ${quoted}: nel listino c'è una voce simile: ${itemShort(f.items[0] as PriceItem)}. È questa?`);
		else asks.push(`• ${quoted}: nel listino ci sono più voci simili: ${f.items.slice(0, 8).map(itemShort).join("; ")}. Quale intendi?`);
		return undefined;
	});
	if (asks.length > 0) return { ask: askAbout(t.kind, asks) };
	const named = found.filter((f): f is PriceItem => f !== undefined);
	// Nothing said of VAT in a quote: the voci's own way, when every line is a voce with VAT included.
	const includeVat = t.kind === "invoice" ? false : (t.includeVat ?? (!t.forfettario && named.length === raw.length && named.every((i) => i.includesVat === true && i.vat > 0)));
	// In an invoice a nature for the whole document says VAT 0 (its reader puts the lines at 0 with it): the voce's rate never fills them.
	const docVat = t.doc?.vat !== undefined || (t.kind === "invoice" && t.doc?.natura !== undefined);
	const docNature = t.doc?.natura !== undefined || t.doc?.vatNote !== undefined;
	const docRate = rateOf(t.doc?.vat) ?? (t.kind === "invoice" && t.doc?.natura !== undefined ? 0 : undefined);
	const notes: string[] = [];
	const asWritten: string[] = [];
	const takenApart: string[] = [];
	const otherRate: string[] = [];
	const lines = raw.map((line, n) => {
		const item = found[n];
		if (item === undefined) return line;
		const { item: _said, ...own } = line as Record<string, unknown>;
		const quantity = own.quantity === undefined ? "1" : String(own.quantity);
		const out: Record<string, unknown> = { ...own };
		if (own.description === undefined) {
			const full = item.description === undefined ? item.name : `${item.name} (${item.description})`;
			out.description = full.length <= t.descriptionMax ? full : item.name;
		}
		if (own.unit === undefined) {
			const unit = lineUnit(item.unit, quantity);
			if (unit !== undefined) out.unit = unit;
		}
		const ownVat = own.vat !== undefined || own.vat_note !== undefined || own.natura !== undefined;
		// The document's VAT, nature or reason fills the line as the document's reader fills it: the voce's never over it.
		if (!t.forfettario && !ownVat && docVat && t.kind === "invoice" && t.doc?.vat === undefined) out.vat = 0;
		if (!t.forfettario && !ownVat && !docVat) {
			out.vat = item.vat;
			if (item.vat === 0 && item.natura !== undefined && !docNature) {
				if (t.kind === "quote") out.vat_note = naturaWords(item.natura);
				else out.natura = item.natura;
			}
		}
		if (own.price === undefined) {
			const cents = eurosToCents(item.price);
			const rate = rateOf(own.vat) ?? docRate ?? item.vat;
			if (t.forfettario) {
				out.price = item.price;
				if (item.includesVat === true && item.vat > 0) asWritten.push(itemShort(item));
			} else if (includeVat) {
				const net = item.includesVat === true ? netOf(cents, item.vat) : cents;
				out.price = item.includesVat === true && rate === item.vat ? item.price : scaledDecimal(net * BigInt(100 + rate), 4);
			} else if (item.includesVat === true && item.vat > 0) {
				// The VAT comes off at the voce's own rate: its price without VAT is the same whatever the line's rate.
				const taken = netLine(item.price, own.quantity, own.discount, item.vat);
				if (taken === undefined) out.price = scaledDecimal(halfUp(cents * 10_000n, BigInt(100 + item.vat)), 4);
				else {
					out.price = taken.price;
					const q = decimalOf(own.quantity ?? "1", 3) ?? quantity;
					const unit = lineUnit(item.unit, q);
					const off = taken.off === 0n ? "" : ` (${euros(taken.off < 0n ? -taken.off : taken.off)} ${taken.off < 0n ? "in meno" : "in più"}: con questa quantità nessun prezzo per unità a quattro decimali torna al centesimo)`;
					takenApart.push(`${itemShort(item)}: ${unit === undefined ? `${decimalText(q)} × ` : `${decimalText(q)} ${unit}, `}${euros(taken.net)} senza IVA${off}`);
				}
			} else out.price = item.price;
			if (!t.forfettario && item.includesVat === true && item.vat > 0 && rate !== item.vat) otherRate.push(`${itemShort(item)}: nel listino con l'IVA al ${item.vat}%, qui la riga è al ${rate}%`);
		}
		return out;
	});
	if (slips.length > 0) notes.push(`Ho preso dal listino le voci più vicine a come sono state dette: ${fencedList(slips.join("\n"))}`);
	if (takenApart.length > 0)
		notes.push(
			[
				"Nel listino queste voci sono IVA inclusa: qui le ho messe senza IVA, togliendo l'IVA dal totale della riga.",
				fencedList(takenApart.join("\n")),
				"L'imponibile di ogni riga è quello del prezzo del listino senza IVA; il totale del documento può differire di un centesimo dai prezzi del listino con IVA.",
			].join("\n"),
		);
	if (otherRate.length > 0) notes.push(["Queste voci hanno nel listino un'altra aliquota: il prezzo senza IVA è quello del listino, l'IVA è quella della riga. Controlla con chi ti scrive che l'aliquota sia giusta.", fencedList(otherRate.join("\n"))].join("\n"));
	if (asWritten.length > 0) notes.push(["Queste voci nel listino hanno il prezzo IVA inclusa:", fencedList(asWritten.join("\n")), "Nel regime forfettario l'IVA non c'è, quindi ho messo il prezzo com'è scritto. Chiedi a chi ti scrive se va bene."].join("\n"));
	if (includeVat && t.includeVat === undefined && named.length > 0) notes.push("I prezzi di queste voci nel listino sono IVA inclusa: il preventivo li mostra così.");
	return { lines, includeVat, notes, used: named.length };
}

const docName = (kind: LineTarget["kind"]) => (kind === "quote" ? "il preventivo" : "la bozza della fattura");

function askAbout(kind: LineTarget["kind"], asks: readonly string[]): string {
	return [
		`Non ho fatto ${docName(kind)}: nel listino alcune voci non sono chiare.`,
		fencedList(asks.join("\n")),
		"Chiedi a chi ti scrive quale voce intende (poi rifai con item uguale al suo codice LS) e, per quelle che non ci sono, il prezzo: non inventarlo e non sceglierlo tu. Se vuole, le aggiungo al listino con price_list op add.",
	].join("\n");
}
