/**
 * Lines of a preventivo or a fattura that name a voce of the listino («3 giornate di consulenza»,
 * «LS-0002»), filled from it before the quote or the invoice reads its lines as it always does:
 * description, unit, unit price and VAT (or nature) from the voce; whatever the line gives itself
 * wins. Pure: the listino is read by the caller.
 *
 * Choices, tested:
 * - A phrase that names no voce, or that may be more than one, is never priced: the whole call
 *   comes back with the question (which voce, or the price of one not in the listino).
 * - Prices with VAT included, exactly as quotes take them: a preventivo whose every line is a voce
 *   with VAT included shows the prices as said (prices_include_vat), and one with VAT excluded in a
 *   quote with VAT included is grossed up exactly (to the fourth decimal, as quote lines hold);
 *   elsewhere, and in an invoice (always VAT excluded), the price with VAT is taken apart to the
 *   line's decimals (quote-sums.ts netOf for the cents), and said.
 * - Forfettario: the VAT comes from the regime as for every line (0% with its dicitura or N2.2),
 *   never from the voce; the price is the voce's as written.
 */
import { euros } from "./format-words.ts";
import { fencedList, findItems, lineUnit, perUnit, type PriceItem } from "./price-list.ts";
import { eurosToCents, halfUp } from "./quote-sums.ts";
import { naturaWords } from "./sales-invoice-rules.ts";

export type LineTarget = {
	readonly kind: "quote" | "invoice";
	readonly forfettario: boolean;
	/** quote: the prices include VAT as said (true or false), or nothing said (undefined: worked out from the voci). */
	readonly includeVat?: boolean;
	/** The longest description a line holds. */
	readonly descriptionMax: number;
};

export type FilledLines = { readonly lines: unknown[]; readonly includeVat: boolean; readonly notes: readonly string[]; readonly used: number } | { readonly ask: string };

/** Whether some line names a voce: only then is the listino read. */
export function namesItems(lines: unknown): boolean {
	return Array.isArray(lines) && lines.some((l) => typeof l === "object" && l !== null && !Array.isArray(l) && (l as Record<string, unknown>).item !== undefined);
}

/** A voce in one line of a list: «Sito base (LS-0002): 1.500,00 € a corpo, IVA 22%». */
export function itemShort(i: PriceItem): string {
	return `${i.name}${i.code === undefined ? "" : ` [${i.code}]`} (${i.id}): ${euros(eurosToCents(i.price))} ${perUnit(i.unit)}${i.includesVat === true && i.vat > 0 ? " IVA inclusa" : ""}`;
}

/** `cents` × (100 + rate) / 100 at 4 decimals: exact. */
function grossDecimal(cents: bigint, rate: number): string {
	return decimal(cents * BigInt(100 + rate), 4);
}

/** Gross `cents` without VAT at `rate`, half up to `scale` decimals. */
function netDecimal(cents: bigint, rate: number, scale: number): string {
	return decimal(halfUp(cents * 10n ** BigInt(scale - 2) * 100n, BigInt(100 + rate)), scale);
}

/** A scaled integer as a canonical decimal: 1234500n at 4 → «123.45». */
function decimal(value: bigint, scale: number): string {
	const digits = value.toString().padStart(scale + 1, "0");
	const fraction = digits.slice(-scale).replace(/0+$/, "");
	const integer = digits.slice(0, -scale);
	return fraction === "" ? integer : `${integer}.${fraction}`;
}

/** The lines with every voce named filled in, or the question to ask. */
export function fillFromList(raw: readonly unknown[], items: readonly PriceItem[], t: LineTarget): FilledLines {
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
		else asks.push(`• ${quoted} può essere: ${f.items.slice(0, 8).map(itemShort).join("; ")}`);
		return undefined;
	});
	if (asks.length > 0) {
		const doc = t.kind === "quote" ? "il preventivo" : "la bozza della fattura";
		return {
			ask: [
				`Non ho fatto ${doc}: nel listino alcune voci non sono chiare.`,
				fencedList(asks.join("\n")),
				"Chiedi a chi ti scrive quale voce intende (poi rifai con item uguale al suo codice LS) e, per quelle che non ci sono, il prezzo: non inventarlo e non sceglierlo tu. Se vuole, le aggiungo al listino con price_list op add.",
			].join("\n"),
		};
	}
	const named = found.filter((f): f is PriceItem => f !== undefined);
	// Nothing said of VAT in a quote: the voci's own way, when every line is a voce with VAT included.
	const includeVat = t.kind === "invoice" ? false : (t.includeVat ?? (!t.forfettario && named.length === raw.length && named.every((i) => i.includesVat === true && i.vat > 0)));
	const notes: string[] = [];
	const taken: string[] = [];
	const lines = raw.map((line, n) => {
		const item = found[n];
		if (item === undefined) return line;
		const o = line as Record<string, unknown>;
		const { item: _said, ...own } = o;
		const quantity = own.quantity === undefined ? "1" : String(own.quantity);
		const out: Record<string, unknown> = { ...own };
		if (own.description === undefined) {
			const full = item.description === undefined ? item.name : `${item.name}: ${item.description}`;
			out.description = full.length <= t.descriptionMax ? full : item.name;
		}
		if (own.unit === undefined) {
			const unit = lineUnit(item.unit, quantity);
			if (unit !== undefined) out.unit = unit;
		}
		const ownVat = own.vat !== undefined || own.vat_note !== undefined || own.natura !== undefined;
		if (!t.forfettario && !ownVat) {
			out.vat = item.vat;
			if (item.vat === 0 && item.natura !== undefined) {
				if (t.kind === "quote") out.vat_note = naturaWords(item.natura);
				else out.natura = item.natura;
			}
		}
		if (own.price === undefined) {
			const cents = eurosToCents(item.price);
			const rate = typeof out.vat === "number" ? out.vat : item.vat;
			if (t.forfettario) {
				out.price = item.price;
				if (item.includesVat === true && item.vat > 0) notes.push(`${item.name} (${item.id}) nel listino ha il prezzo IVA inclusa: nel regime forfettario l'IVA non c'è, quindi ho messo il prezzo com'è scritto. Chiedi a chi ti scrive se va bene.`);
			} else if (includeVat) {
				const asSaid = item.includesVat === true && rate === item.vat;
				out.price = asSaid || item.vat === 0 ? item.price : grossDecimal(item.includesVat === true ? halfUp(cents * 100n, BigInt(100 + item.vat)) : cents, rate);
			} else if (item.includesVat === true && item.vat > 0) {
				const net = netDecimal(cents, item.vat, t.kind === "quote" ? 4 : 8);
				out.price = net;
				notes.push(`${item.name} (${item.id}) nel listino è ${euros(cents)} IVA inclusa: qui va senza IVA, ${net.replace(".", ",")} € a unità (l'IVA tolta come nei preventivi IVA inclusa).`);
			} else out.price = item.price;
		}
		taken.push(item.id);
		return out;
	});
	if (slips.length > 0) notes.unshift(`Ho preso dal listino le voci più vicine a come sono state dette: ${fencedList(slips.join("\n"))}`);
	if (includeVat && t.includeVat === undefined && named.length > 0) notes.push("I prezzi di queste voci nel listino sono IVA inclusa: il preventivo li mostra così.");
	return { lines, includeVat, notes, used: taken.length };
}
