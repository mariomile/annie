/**
 * What a quote will hold, from the tool's arguments over the version before (revise) or the last
 * quote to the same customer (create): lines, customer, cassa, ritenuta, bollo, acconto, terms.
 * Gives back the answer instead when something is missing or wrong, and the notes the person
 * should hear (a bollo to consider, a ritenuta on the forfettario, data taken from a past quote).
 */
import type { Company } from "../invoices.ts";
import { DEFAULT_VALID_DAYS, customerKey, QUOTE_LIMITS, type Quote, type QuoteCustomer } from "../quotes.ts";
import { BOLLO_THRESHOLD_CENTS, bolloDue, quoteTotals, zeroRateCents } from "../quote-sums.ts";
import { cleanText, type GivenLine, isProblem, readCassa, readCustomer, readItems, readPercent, readVat, type Wide, withDefaults } from "./quote-input.ts";
import { euros, fenced } from "./quote-render.ts";

export type DraftQuote = Pick<Quote, "validDays" | "customer" | "lines" | "pricesIncludeVat" | "cassa" | "ritenuta" | "bollo" | "deposit" | "delivery" | "terms" | "notes">;

export type Draft = { readonly quote: DraftQuote; readonly notes: readonly string[] };

const ASK_RATE = "«Che aliquota IVA applico: 22%, 10%, 4%, oppure senza IVA (in quel caso dimmi il motivo, per esempio regime forfettario)?»";

/** The quote's content, or the answer saying what is missing. `quotes`: all saved, to take a returning customer's data. */
export function draftOf(args: Record<string, unknown>, context: { readonly previous?: Quote; readonly company: Company; readonly quotes: readonly Quote[] }): Draft | string {
	const { previous, company } = context;
	const forfettario = company.regime === "forfettario";
	const vat = readVat(args.vat, "vat");
	if (isProblem(vat)) return `Errore: ${vat.problem}.`;
	const vatNote = cleanText(args.vat_note, QUOTE_LIMITS.vatNote, "vat_note");
	if (isProblem(vatNote)) return `Errore: ${vatNote.problem}.`;
	const discount = readPercent(args.discount, "discount");
	if (isProblem(discount)) return `Errore: ${discount.problem}.`;
	const wide: Wide = { ...(vat === undefined ? {} : { vat }), ...(vatNote === undefined ? {} : { vatNote }), ...(discount === undefined ? {} : { discount }) };

	if (previous === undefined && args.add_items !== undefined) return "Errore: add_items serve per aggiungere voci a un preventivo che c'è già (op revise); qui usa items.";
	if (args.items !== undefined && args.add_items !== undefined) return "Errore: items sostituisce tutte le voci, add_items le aggiunge: usane uno.";
	let given: GivenLine[];
	if (args.items !== undefined || previous === undefined) {
		const items = readItems(args.items);
		if (isProblem(items)) return `Errore: ${items.problem}.`;
		given = items;
	} else {
		const kept = previous.lines.map((l): GivenLine => ({ ...l, own: false }));
		const added = args.add_items === undefined ? [] : readItems(args.add_items, "add_items");
		if (isProblem(added)) return `Errore: ${added.problem}.`;
		if (kept.length + added.length > QUOTE_LIMITS.lines) return `Errore: al massimo ${QUOTE_LIMITS.lines} voci in un preventivo.`;
		given = [...kept, ...added];
	}
	const lines = withDefaults(given, wide, forfettario);
	if (isProblem(lines)) return `Errore: ${lines.problem}.`;
	if ("missing" in lines) {
		return `Non ho ancora fatto il preventivo: manca l'aliquota IVA di queste voci: ${fenced(lines.missing.map((d) => `• ${d}`).join("\n"))}\nChiedi a chi ti scrive, nominando le voci: ${ASK_RATE} Non sceglierla tu.`;
	}

	const notes: string[] = [];
	let old: QuoteCustomer | undefined = previous?.customer;
	if (previous === undefined && typeof args.customer === "string") {
		const reused = pastCustomer(context.quotes, args.customer, args);
		if (reused !== undefined) {
			old = reused.customer;
			notes.push(`Ho ripreso ${reused.what} del cliente dal suo preventivo ${reused.from}.`);
		}
	}
	const customer = readCustomer(args, old);
	if (isProblem(customer)) return `Errore: ${customer.problem}.`;
	if (customer.vat === undefined && customer.fiscal === undefined) notes.push("Non ho partita IVA né codice fiscale del cliente: se è un privato, chiedigli il codice fiscale (in fattura servirà).");

	const terms = cleanText(args.terms, QUOTE_LIMITS.terms, "terms", true);
	if (isProblem(terms)) return `Errore: ${terms.problem}.`;
	const remarks = cleanText(args.notes, QUOTE_LIMITS.notes, "notes", true);
	if (isProblem(remarks)) return `Errore: ${remarks.problem}.`;
	const delivery = cleanText(args.delivery, QUOTE_LIMITS.delivery, "delivery");
	if (isProblem(delivery)) return `Errore: ${delivery.problem}.`;
	const validDays = typeof args.valid_days === "number" ? args.valid_days : (previous?.validDays ?? DEFAULT_VALID_DAYS);
	if (!Number.isInteger(validDays) || validDays < 1 || validDays > QUOTE_LIMITS.maxValidDays) return `Errore: valid_days è un numero di giorni da 1 a ${QUOTE_LIMITS.maxValidDays}.`;
	for (const flag of ["ritenuta", "bollo", "prices_include_vat"] as const) if (args[flag] !== undefined && typeof args[flag] !== "boolean") return `Errore: ${flag} è true o false.`;
	const includeVat = typeof args.prices_include_vat === "boolean" ? args.prices_include_vat : previous?.pricesIncludeVat === true;
	const ritenuta = typeof args.ritenuta === "boolean" ? args.ritenuta : previous?.ritenuta === true;
	let bollo = typeof args.bollo === "boolean" ? args.bollo : previous?.bollo === true;
	const givenCassa = readCassa(args.cassa);
	if (isProblem(givenCassa)) return `Errore: ${givenCassa.problem}.`;
	const cassa = givenCassa ?? previous?.cassa;
	if (cassa !== undefined && includeVat) return "Errore: con i prezzi IVA inclusa non aggiungo la cassa: chiedi a chi ti scrive i prezzi senza IVA.";
	const deposit = readPercent(args.deposit, "deposit");
	if (isProblem(deposit)) return `Errore: ${deposit.problem}.`;
	const depositKept = deposit === null ? undefined : (deposit ?? previous?.deposit);

	const plain = quoteTotals(lines, { includeVat, ...(cassa === undefined ? {} : { cassa }) });
	if (bollo && !bolloDue(plain)) {
		if (args.bollo === true) return `Errore: il bollo da 2 € si applica quando gli importi senza IVA superano ${euros(BOLLO_THRESHOLD_CENTS)}; qui sono ${euros(zeroRateCents(plain))}. Non l'ho aggiunto: dillo a chi ti scrive.`;
		bollo = false;
		notes.push(`Ho tolto il bollo: gli importi senza IVA non superano più ${euros(BOLLO_THRESHOLD_CENTS)}.`);
	}
	if (!bollo && bolloDue(plain)) notes.push(`Gli importi senza IVA superano ${euros(BOLLO_THRESHOLD_CENTS)}: di solito in fattura va il bollo da 2 €. Se chi ti scrive lo vuole nel preventivo, rifallo con bollo true; non deciderlo tu.`);
	if (ritenuta && forfettario) notes.push("Di solito sui compensi in regime forfettario la ritenuta d'acconto non si applica: l'ho messa perché è stata chiesta, ma chiedi conferma a chi ti scrive.");
	for (const rate of plain.byDifference) notes.push(`Per far tornare i prezzi IVA inclusa, l'IVA al ${rate}% è calcolata per differenza: può differire di un centesimo dal ${rate}% dell'imponibile.`);

	const keptTerms = terms ?? previous?.terms;
	const keptNotes = remarks ?? previous?.notes;
	const keptDelivery = delivery ?? previous?.delivery;
	const quote: DraftQuote = {
		validDays,
		customer,
		lines,
		...(includeVat ? { pricesIncludeVat: true as const } : {}),
		...(cassa === undefined ? {} : { cassa }),
		...(ritenuta ? { ritenuta: true as const } : {}),
		...(bollo ? { bollo: true as const } : {}),
		...(depositKept === undefined ? {} : { deposit: depositKept }),
		...(keptDelivery === undefined ? {} : { delivery: keptDelivery }),
		...(keptTerms === undefined ? {} : { terms: keptTerms }),
		...(keptNotes === undefined ? {} : { notes: keptNotes }),
	};
	return { quote, notes };
}

/** The tax id, address and email of the last quote to a customer with this name, for what the call does not give. */
function pastCustomer(quotes: readonly Quote[], name: string, args: Record<string, unknown>): { customer: QuoteCustomer; what: string; from: string } | undefined {
	const key = customerKey(name);
	if (key === "") return undefined;
	const past = [...quotes].reverse().find((q) => customerKey(q.customer.name) === key);
	if (past === undefined) return undefined;
	const c = past.customer;
	const taken: string[] = [];
	if (args.tax_id === undefined && c.vat !== undefined) taken.push("P.IVA");
	if (args.tax_id === undefined && c.fiscal !== undefined) taken.push("codice fiscale");
	if (args.address === undefined && c.address !== undefined) taken.push("indirizzo");
	if (args.email === undefined && c.email !== undefined) taken.push("email");
	if (taken.length === 0) return undefined;
	const what = taken.length === 1 ? (taken[0] as string) : `${taken.slice(0, -1).join(", ")} e ${taken.at(-1)}`;
	return { customer: c, what, from: past.number };
}
