/**
 * What the listino reads from a call: a voce's fields (the price in euros to the cent, «1.250»
 * asked never guessed; the VAT as a rate or a nature; the unit folded to its singular; a code of
 * the person's own), a change of price (a percent or an amount, up or down). A problem comes back
 * in words; what the person typed is echoed only inside the listino's fence.
 */
import { readEuros, readSignedEuros } from "../money-input.ts";
import { fencedList, isCode, PRICE_LIST_LIMITS, type PriceChange, type PriceItem, unitOf } from "../price-list.ts";
import { eurosToCents, VAT_RATES, type VatRate } from "../quote-sums.ts";
import { FORFETTARIO_NATURA, NATURE, type Natura } from "../sales-invoice-rules.ts";
import { cleanText, isProblem, type Problem, readAmount } from "../text-input.ts";

/** A price in euros to the cent, more than zero. */
export function readPrice(value: unknown, what = "il prezzo"): string | undefined | Problem {
	const read = readEuros(value, {
		fence: fencedList,
		max: PRICE_LIST_LIMITS.maxPrice,
		foreign: `${what} è in un'altra valuta: il listino tiene i prezzi in euro (convertilo con exchange_rate)`,
		negative: `${what} non può essere negativo`,
		zero: `${what} è zero: una voce gratuita non va nel listino`,
	});
	// The reader names the amount by its parameter: here it is the price, in words.
	return isProblem(read) ? { problem: read.problem.replace(/^amount: /, `${what}: `) } : read;
}

/** The VAT as said: a rate (22, «22%») or a nature («N2.2», «n4»); 0 needs its nature. */
export function readVatSaid(value: unknown): { readonly vat: VatRate; readonly natura?: Natura } | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value === "string" && /^\s*n\s*\d/i.test(value)) {
		const n = value.trim().toUpperCase().replace(/\s+/g, "");
		return NATURE.includes(n as Natura) ? { vat: 0, natura: n as Natura } : { problem: "la natura è un codice come N2.2 (regime forfettario), N4 (esente) o N2.1, come lo dice chi ti scrive" };
	}
	const read = readAmount(typeof value === "string" ? value.replace("%", "") : value, 2, "l'IVA", fencedList);
	if (read === undefined || isProblem(read)) return read;
	const rate = Number(read) as VatRate;
	if (!VAT_RATES.includes(rate)) return { problem: `l'aliquota IVA è una di queste: ${VAT_RATES.join(", ")}, oppure una natura come N2.2` };
	if (rate === 0) return { problem: "con IVA 0 serve la natura: N2.2 nel regime forfettario, N4 se esente, come la dice chi ti scrive. Non sceglierla tu" };
	return { vat: rate };
}

/** A voce's fields as given; `""` removes code, description or unit (update). */
export type GivenFields = {
	name?: string;
	price?: string;
	unit?: string | null;
	vat?: { vat: VatRate; natura?: Natura };
	code?: string | null;
	description?: string | null;
	includesVat?: boolean;
};

export function readFields(args: Record<string, unknown>): GivenFields | Problem {
	const out: GivenFields = {};
	const name = cleanText(args.name, PRICE_LIST_LIMITS.name, "il nome");
	if (isProblem(name)) return name;
	if (name !== undefined) out.name = name;
	const price = readPrice(args.price);
	if (isProblem(price)) return price;
	if (price !== undefined) out.price = price;
	for (const [key, max, label] of [
		["unit", 30, "l'unità"],
		["code", PRICE_LIST_LIMITS.code, "il codice"],
		["description", PRICE_LIST_LIMITS.description, "la descrizione"],
	] as const) {
		if (args[key] === "") {
			out[key] = null;
			continue;
		}
		const text = cleanText(args[key], max, label);
		if (isProblem(text)) return text;
		if (text === undefined) continue;
		if (key === "unit") {
			const unit = unitOf(text);
			if (unit.length > PRICE_LIST_LIMITS.unit) return { problem: `l'unità è troppo lunga per la fattura (al massimo ${PRICE_LIST_LIMITS.unit} caratteri): per esempio ora, giornata, pezzo, mese, forfait` };
			out.unit = unit;
		} else if (key === "code") {
			if (!isCode(text)) return { problem: "il codice è fatto di lettere, cifre e . _ / -, senza spazi, e non come LS-0001 (quelli li do io)" };
			out.code = text;
		} else out.description = text;
	}
	const vat = readVatSaid(args.vat);
	if (isProblem(vat)) return vat;
	if (vat !== undefined) out.vat = vat;
	if (args.prices_include_vat !== undefined) {
		if (typeof args.prices_include_vat !== "boolean") return { problem: "prices_include_vat è sì o no" };
		out.includesVat = args.prices_include_vat;
	}
	return out;
}

/** A new voce from the fields: name, price and VAT needed (the forfettario's N2.2 when not said). `missing`: what to ask. */
export function newItem(f: GivenFields, forfettario: boolean): Omit<PriceItem, "id" | "by" | "at"> | { readonly missing: readonly string[] } {
	const vat = f.vat ?? (forfettario ? { vat: 0 as const, natura: FORFETTARIO_NATURA } : undefined);
	const missing = [...(f.name === undefined ? ["il nome della voce"] : []), ...(f.price === undefined ? ["il prezzo (per unità)"] : []), ...(vat === undefined ? ["l'aliquota IVA (22, 10, 5, 4) o la natura se è senza IVA"] : [])];
	if (missing.length > 0 || vat === undefined || f.name === undefined || f.price === undefined) return { missing };
	return {
		name: f.name,
		price: f.price,
		vat: vat.vat,
		...(vat.natura === undefined ? {} : { natura: vat.natura }),
		...(f.unit === undefined || f.unit === null ? {} : { unit: f.unit }),
		...(f.code === undefined || f.code === null ? {} : { code: f.code }),
		...(f.description === undefined || f.description === null ? {} : { description: f.description }),
		...(f.includesVat === true && vat.vat > 0 ? { includesVat: true as const } : {}),
	};
}

/** A voce with the fields changed; the same object when nothing changes. */
export function changedItem(i: PriceItem, f: GivenFields): PriceItem {
	const next: Record<string, unknown> = { ...i };
	if (f.name !== undefined) next.name = f.name;
	if (f.price !== undefined) next.price = f.price;
	if (f.vat !== undefined) {
		next.vat = f.vat.vat;
		if (f.vat.natura === undefined) delete next.natura;
		else next.natura = f.vat.natura;
	}
	for (const key of ["unit", "code", "description"] as const) {
		if (f[key] === null) delete next[key];
		else if (f[key] !== undefined) next[key] = f[key];
	}
	if (f.includesVat !== undefined) {
		if (f.includesVat) next.includesVat = true;
		else delete next.includesVat;
	}
	if (next.vat === 0) delete next.includesVat;
	const same = JSON.stringify(Object.entries(next).sort()) === JSON.stringify(Object.entries(i).sort());
	return same ? i : (next as PriceItem);
}

/** The change of a price_change: a percent (10, «+10%», «-5%») or an amount in euros («+50», -20), not both. */
export function readChange(args: Record<string, unknown>): PriceChange | Problem {
	if ((args.percent === undefined) === (args.amount === undefined)) return { problem: "dimmi di quanto cambiano i prezzi: una percentuale (percent, come 10 o -5) oppure un importo in euro (amount, come 50 o -20), non tutti e due" };
	// A plus in front says up, as no sign does; the minus is the signed reader's (money-input.ts).
	const unplus = (v: unknown, what: string) => readSignedEuros(typeof v === "string" ? v.replace(/^\s*\+\s*/, "").replace(/\s*%\s*$/, "") : v, fencedList, what);
	if (args.percent !== undefined) {
		const read = unplus(args.percent, "la percentuale");
		if (read === undefined || isProblem(read)) return read ?? { problem: "manca la percentuale" };
		const down = read.startsWith("-");
		const percent = down ? read.slice(1) : read;
		if (Number(percent) <= 0 || (down && Number(percent) >= 100) || Number(percent) > 500) return { problem: "la percentuale va da più di 0 a 500 in aumento, a meno di 100 in calo" };
		return { percent, down };
	}
	const read = unplus(args.amount, "l'importo");
	if (read === undefined || isProblem(read)) return read ?? { problem: "manca l'importo" };
	const cents = eurosToCents(read);
	if (cents === 0n) return { problem: "l'importo è zero: i prezzi resterebbero uguali" };
	if ((cents < 0n ? -cents : cents) > BigInt(PRICE_LIST_LIMITS.maxPrice) * 100n) return { problem: `l'importo è oltre ${PRICE_LIST_LIMITS.maxPrice.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return { cents };
}
