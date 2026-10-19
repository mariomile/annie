/**
 * What the person says for a DDT, read and checked: the client (a card, a customer invoiced here,
 * a client of an earlier DDT, or a new one as said), the lines (a voce of the listino or free text,
 * with how many and the unit), the causale, the transport, packages and weight, the DDT named.
 * What does not read comes back as the answer to give, with the words said inside the fence.
 */
import type { ClientCard } from "../clients.ts";
import { type Causale, CAUSALI, type Ddt, DDT_ID, DDT_LIMITS, type DdtClient, ddtId, type DdtLine, isIssuedDdt, type Transport, type TransportBy } from "../ddt.ts";
import { spellingKey } from "../name-keys.ts";
import { findItems, type PriceItem } from "../price-list.ts";
import type { SalesInvoice } from "../sales-invoices.ts";
import { qtyOf, qtyText } from "../stock-sums.ts";
import { cleanText, isProblem, readAmount } from "../text-input.ts";
import { fencedDdt } from "./ddt-render.ts";
import { clientKey, ddtClientSaid } from "./sales-ddt.ts";
import { findBuyer } from "./sales-invoice-buyer.ts";

/** The client found: `form` taken for the same name but the legal form, `fresh` known nowhere (a new one, as said). */
export type ClientSaid = { readonly client: DdtClient; readonly form?: true; readonly fresh?: true };

const oneLine = (a: { street: string; cap: string; town: string; province?: string }) => `${a.street}, ${a.cap} ${a.town}${a.province === undefined ? "" : ` ${a.province}`}`;

/** The client `raw` names: the clients' cards and the customers invoiced here first, then the clients of earlier DDTs; a new one as said. */
export function clientSaid(raw: unknown, cards: readonly ClientCard[], invoices: readonly SalesInvoice[], ddts: readonly Ddt[]): ClientSaid | string {
	const said = cleanText(raw, DDT_LIMITS.name, "il cliente");
	if (isProblem(said)) return `Errore: ${said.problem}.`;
	if (said === undefined) return "Errore: dimmi a quale cliente va il DDT.";
	const found = findBuyer(said, cards, invoices);
	if (found.kind === "close") return ["Intendi uno di questi? Non so dire quale:", fencedDdt(found.candidates.map((c) => `• ${c}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui o con la sua partita IVA."].join("\n");
	if (found.kind === "exact" || found.kind === "conflict") {
		const k = found.known;
		const vat = k.card?.vat ?? k.previous?.vat;
		const cf = k.card?.cf ?? k.previous?.cf;
		const address = k.card?.address ?? (k.previous === undefined ? undefined : oneLine(k.previous.address));
		const client: DdtClient = { name: k.card?.name ?? k.name, ...(vat === undefined ? {} : { vat }), ...(cf === undefined ? {} : { cf }), ...(k.card === undefined ? {} : { card: k.card.id }), ...(address === undefined ? {} : { address: address.slice(0, DDT_LIMITS.destination) }) };
		return found.kind === "exact" && found.form === true ? { client, form: true } : { client };
	}
	const earlier = ddtClientSaid(said, ddts);
	if (typeof earlier === "string") return earlier;
	if (!("none" in earlier)) return { client: earlier };
	return { client: { name: said }, fresh: true };
}

/** A line said: its description, quantity (canonical), unit, voce; `guess` when the voce was taken from words only close to its name. */
export type LineSaid = Omit<DdtLine, "n"> & { readonly guess?: true };

/** The lines said: [{item or description, quantity, unit}]; a quantity of 0 only where `zero` allows (a change that takes a line off). */
export function linesSaid(raw: unknown, voci: readonly PriceItem[], zero = false): LineSaid[] | string {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > DDT_LIMITS.lines) return `Errore: le righe sono un elenco (al massimo ${DDT_LIMITS.lines}), ognuna con la voce del listino o la descrizione, e quanti.`;
	const out: LineSaid[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) return "Errore: ogni riga ha la voce o la descrizione, e quanti.";
		const { item, description, quantity, unit } = entry as Record<string, unknown>;
		const itemSaid = cleanText(item, 120, "la voce del listino");
		if (isProblem(itemSaid)) return `Errore: ${itemSaid.problem}.`;
		const text = cleanText(description, DDT_LIMITS.description, "la descrizione");
		if (isProblem(text)) return `Errore: ${text.problem}.`;
		if (itemSaid === undefined && text === undefined) return "Errore: ogni riga dice la voce del listino o la descrizione della merce.";
		let voce: PriceItem | undefined;
		let guess = false;
		if (itemSaid !== undefined) {
			const f = findItems(voci, itemSaid);
			if (f.kind === "exact") {
				voce = f.item;
				guess = f.slip === true;
			} else if (f.kind !== "none" && f.items.length === 1) {
				voce = f.items[0] as PriceItem;
				guess = true;
			} else if (f.kind === "none") return ["Questa voce non è nel listino: se va scritta così, dimmelo e la metto come descrizione libera (senza voce non si scarica dal magazzino).", fencedDdt(itemSaid)].join("\n");
			else return ["Nel listino ci sono più voci così: dimmi quale.", fencedDdt(f.items.slice(0, 10).map((i) => `• ${i.id} ${i.name}`).join("\n"))].join("\n");
		} else if (text !== undefined) {
			// Free text with a voce's very name: that voce, so the issue unloads it.
			const same = voci.filter((v) => spellingKey(v.name) === spellingKey(text));
			if (same.length === 1) voce = same[0];
		}
		const q = readAmount(quantity, 3, "la quantità", fencedDdt);
		if (isProblem(q)) return `Errore: ${q.problem}.`;
		if (q === undefined) return "Errore: ogni riga dice quanti.";
		if ((Number(q) === 0 && !zero) || Number(q) < 0 || Number(q) > DDT_LIMITS.maxQuantity) return "Errore: la quantità è un numero maggiore di zero, al più 3 decimali.";
		const u = cleanText(unit, DDT_LIMITS.unit, "l'unità");
		if (isProblem(u)) return `Errore: ${u.problem}.`;
		const lineUnit = u ?? voce?.unit;
		const desc = (text ?? voce?.name ?? "").slice(0, DDT_LIMITS.description);
		out.push({ description: desc, qty: qtyText(qtyOf(q)), ...(lineUnit === undefined ? {} : { unit: lineUnit }), ...(voce === undefined ? {} : { item: voce.id }), ...(guess ? { guess: true as const } : {}) });
	}
	return out;
}

const CAUSALE_SAID: Readonly<Record<string, Causale>> = { vendita: "vendita", conto_visione: "conto_visione", visione: "conto_visione", reso: "reso", riparazione: "riparazione", omaggio: "omaggio", comodato: "comodato", comodato_d_uso: "comodato", lavorazione: "lavorazione", conto_lavorazione: "lavorazione" };

/** The causale as said («conto visione», «reso»); undefined when not said. */
export function causaleSaid(raw: unknown): Causale | undefined | { readonly answer: string } {
	if (raw === undefined) return undefined;
	const key = typeof raw === "string" ? raw.trim().toLowerCase().replace(/['’\s-]+/g, "_") : "";
	const c = CAUSALE_SAID[key];
	return c ?? { answer: `Errore: la causale del trasporto è una di queste: ${CAUSALI.map((x) => x.replace("_", " ")).join(", ")}.` };
}

const BY_SAID: Readonly<Record<string, TransportBy>> = { mittente: "mittente", noi: "mittente", io: "mittente", destinatario: "destinatario", cliente: "destinatario", vettore: "vettore", corriere: "vettore", spedizioniere: "vettore" };

/** Who carries the goods, and the carrier's name; undefined when nothing is said. */
export function transportSaid(by: unknown, carrier: unknown, was?: Transport): Transport | undefined | string {
	const name = cleanText(carrier, DDT_LIMITS.carrier, "il vettore");
	if (isProblem(name)) return `Errore: ${name.problem}.`;
	if (by === undefined && name === undefined) return was;
	const said = by === undefined ? (name !== undefined ? "vettore" : undefined) : BY_SAID[typeof by === "string" ? by.trim().toLowerCase() : ""];
	if (said === undefined) return "Errore: il trasporto è a cura del mittente (tu), del destinatario (il cliente) o di un vettore (un corriere, con il nome).";
	if (said !== "vettore" && name !== undefined) return "Errore: il nome del vettore va solo con il trasporto a cura di un vettore.";
	const carrierName = name ?? (said === "vettore" && was?.by === "vettore" ? was.carrier : undefined);
	return { by: said, ...(carrierName === undefined ? {} : { carrier: carrierName }) };
}

/** Packages: a whole number from 1; undefined when not said. */
export function packagesSaid(raw: unknown): number | undefined | string {
	if (raw === undefined) return undefined;
	const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d{1,5}\s*$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isInteger(n) || n < 1 || n > DDT_LIMITS.packages) return `Errore: i colli sono un numero intero, da 1 a ${DDT_LIMITS.packages}.`;
	return n;
}

/** The weight in kg (canonical, three decimals at most); undefined when not said. */
export function weightSaid(raw: unknown): string | undefined | { readonly answer: string } {
	if (raw === undefined) return undefined;
	const w = readAmount(raw, 3, "il peso", fencedDdt);
	if (w === undefined || isProblem(w) || Number(w) <= 0 || Number(w) > DDT_LIMITS.maxWeight) return { answer: "Errore: il peso è in kg, un numero maggiore di zero, al più 3 decimali." };
	return qtyText(qtyOf(w));
}

/** The DDT named: «DT-0003» (a draft), «12/2026» or «12» (issued; the latest year with that number), «DDT 12». */
export function ddtNamed(raw: unknown, ddts: readonly Ddt[]): Ddt | string | undefined {
	const said = cleanText(raw, 30, "il DDT");
	if (isProblem(said)) return `Errore: ${said.problem}.`;
	if (said === undefined) return undefined;
	const t = said.trim().replace(/^(?:ddt|d\.d\.t\.)\s*(?:n\.?|numero)?\s*/i, "");
	const id = /^dt\s*-?\s*0*(\d{1,6})$/i.exec(t);
	if (id !== null) {
		const key = ddtId(Number(id[1]));
		const d = DDT_ID.test(key) ? ddts.find((x) => x.id === key) : undefined;
		return d ?? ["Non trovo questo DDT: dimmi il suo numero («12/2026») o il cliente.", fencedDdt(said)].join("\n");
	}
	const m = /^(\d{1,5})(?:\s*\/\s*(\d{4}))?$/.exec(t);
	if (m === null) return ["Non trovo questo DDT: dimmi il suo numero («12/2026») o il cliente.", fencedDdt(said)].join("\n");
	const seq = Number(m[1]);
	const year = m[2] === undefined ? undefined : Number(m[2]);
	const found = ddts.filter((d) => isIssuedDdt(d) && d.seq === seq && (year === undefined || d.year === year)).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
	return found[0] ?? ["Non trovo un DDT emesso con questo numero.", fencedDdt(said)].join("\n");
}

/** The DDTs of the client said, newest first. */
export function ofClient(ddts: readonly Ddt[], client: DdtClient): Ddt[] {
	const key = clientKey(client);
	return ddts.filter((d) => clientKey(d.client) === key).sort((a, b) => b.id.localeCompare(a.id));
}
