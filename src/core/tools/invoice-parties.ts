/**
 * The scadenzario's `by_party` answer: what is open and paid per supplier or customer, each
 * party's credit notes off its own amount, and one party in detail with its IBAN.
 */
import type { FatturaParty } from "../fattura-pa.ts";
import { validIban } from "../iban.ts";
import { type Credit, eur, isZero, netted, nettedText, type Share, sumsText } from "../invoice-sums.ts";
import { addTo, type Invoice, matchesParty, openAmount, paidAmount, partyKey, type Side, type Sums, vatOf } from "../invoices.ts";
import { type Bucket, creditLine, dueRow, type Row } from "./invoice-due.ts";
import { answer, fenced, footer, type Loaded, type ReadArgs, type View } from "./invoice-fence.ts";
import { byName, MAX_ROWS, otherParty, partyName, short } from "./invoice-words.ts";

/** One party's invoices in by_party: what is open and paid, the credit notes still to take off. */
type PartyGroup = {
	readonly side?: Side;
	readonly supplier: FatturaParty;
	readonly customer: FatturaParty;
	readonly open: Sums;
	readonly paid: Sums;
	readonly credit: Sums;
	openInvoices: number;
	readonly rows: Row[];
	readonly credits: Credit[];
	readonly invoices: Invoice[];
};

function groupParty(g: PartyGroup): FatturaParty {
	return g.side === "active" ? g.customer : g.supplier;
}

export function share(g: PartyGroup): Share {
	return { gross: g.open, credit: g.credit, notes: g.credits.length };
}

export function byPartyAnswer(loaded: Loaded, args: ReadArgs, view: View): string {
	const { party } = args;
	const groups = partyGroups(loaded.invoices, args);
	if (groups.size === 0) {
		const of = party === undefined ? "" : ` di ${fenced(party)}`;
		return `Non trovo fatture${of} tra le ${loaded.invoices.length} del workspace${party === undefined ? "" : ": prova con un'altra parola del nome o con la partita IVA"}.`;
	}
	type PartySection = { readonly title: string; readonly side?: Side; readonly list: PartyGroup[] };
	const sections: PartySection[] = [
		{ title: "Da pagare", side: "passive", list: [] },
		{ title: "Da incassare", side: "active", list: [] },
		{ title: "Fornitore e cliente", list: [] },
	];
	for (const g of groups.values()) sections.find((s) => s.side === g.side)?.list.push(g);
	const sortName = (g: PartyGroup) => partyName(g.side === undefined && args.group === "clienti" ? g.customer : groupParty(g));
	const lines: string[] = [];
	let shown = 0;
	for (const section of sections) {
		if (section.list.length === 0) continue;
		section.list.sort((a, b) => Number(eur(netted([share(b)]).net) - eur(netted([share(a)]).net)) || byName(sortName(a), sortName(b)));
		lines.push("", `${section.title}:`);
		for (const g of section.list) {
			if (shown >= MAX_ROWS) break;
			shown++;
			lines.push(`• ${partyLine(g)}`);
		}
	}
	if (groups.size > shown) lines.push(`E altre ${groups.size - shown} controparti non mostrate: filtra con party.`);
	const only = party !== undefined && groups.size === 1 ? ([...groups.values()][0] as PartyGroup) : undefined;
	if (only !== undefined) lines.push(...onePartyLines(only, view));
	// The totals by side, only when the company is known: what is to pay is never added to what is to collect.
	const all = [...groups.values()];
	const total = (side: Side) => sumsText(netted(all.filter((g) => g.side === side).map(share)).net);
	const pay = all.some((g) => g.side === "passive") ? `da pagare ${total("passive")}` : undefined;
	const collect = all.some((g) => g.side === "active") ? `da incassare ${total("active")}` : undefined;
	const said = [pay, collect].filter((x) => x !== undefined);
	if (said.length > 0 && only === undefined) lines.push("", `Totale aperto: ${said.join("; ")} (ogni nota di credito scalata dalla sua controparte).`);
	const head = `Fatture per controparte${party === undefined ? "" : `, «${short(party)}»`} (fatture trovate: ${loaded.invoices.length}).`;
	return answer(head, lines, footer(loaded, view));
}

/** The groups of by_party: by side and party when the side is known, by supplier and customer otherwise. */
function partyGroups(invoices: readonly Invoice[], args: ReadArgs): Map<string, PartyGroup> {
	const { party, side } = args;
	const groups = new Map<string, PartyGroup>();
	for (const invoice of invoices) {
		if (invoice.doc.integration || (side !== undefined && invoice.side !== side)) continue;
		if (party !== undefined && !matchesParty(otherParty(invoice), party) && (invoice.side !== undefined || !matchesParty(invoice.customer, party))) continue;
		const key = invoice.side === undefined ? `dir:${partyKey(invoice.supplier)}>${partyKey(invoice.customer)}` : `${invoice.side}:${partyKey(otherParty(invoice))}`;
		let group = groups.get(key);
		if (group === undefined) {
			const known = invoice.side === undefined ? {} : { side: invoice.side };
			group = { ...known, supplier: invoice.supplier, customer: invoice.customer, open: new Map(), paid: new Map(), credit: new Map(), openInvoices: 0, rows: [], credits: [], invoices: [] };
			groups.set(key, group);
		}
		const currency = invoice.doc.currency;
		if (invoice.credit) {
			if (!invoice.paid) {
				const units = openAmount(invoice);
				addTo(group.credit, currency, units);
				group.credits.push({ invoice, units });
			}
			continue;
		}
		group.invoices.push(invoice);
		addTo(group.open, currency, openAmount(invoice));
		addTo(group.paid, currency, paidAmount(invoice));
		if (!invoice.paid) {
			group.openInvoices++;
			for (const instalment of invoice.instalments) if (instalment.paid === undefined && instalment.extra !== true) group.rows.push({ invoice, instalment });
		}
	}
	return groups;
}

/** One party asked about: its open instalments without its name, its credit notes, its IBAN once. */
function onePartyLines(only: PartyGroup, view: View): string[] {
	const { today } = view;
	if (only.rows.length + only.credits.length === 0) return [];
	const lines = ["", "Rate aperte:"];
	only.rows.sort((a, b) => (a.instalment.due ?? "9999").localeCompare(b.instalment.due ?? "9999"));
	const bucket: Bucket = { key: "", customer: only.customer, suppliers: [only.supplier], rows: only.rows, overdue: [], undated: [], credits: [] };
	for (const row of only.rows.slice(0, MAX_ROWS)) lines.push(dueRow(row, bucket, { today, oneParty: true, timeZone: view.timeZone }));
	if (only.rows.length > MAX_ROWS) lines.push(`E altre ${only.rows.length - MAX_ROWS} rate.`);
	for (const credit of only.credits) lines.push(`• ${creditLine(credit, true, today)}`);
	const iban = only.side === "active" ? undefined : ibanLine(only.supplier, only.invoices.filter((i) => !i.paid));
	if (iban !== undefined) lines.push(iban);
	return lines;
}

/**
 * «Alfa Forniture S.r.l. (IT02987650013): aperto 3.529,15 € (3.629,15 € meno la nota di credito
 * di 100,00 €) su 2 fatture; pagato 500,00 €»; without the company, «da Alfa a Beta: …».
 */
function partyLine(g: PartyGroup): string {
	const named = (p: FatturaParty) => {
		const vat = vatOf(p);
		return `${partyName(p)}${vat === undefined ? "" : ` (${vat})`}`;
	};
	const who = g.side === undefined ? `da ${named(g.supplier)} a ${named(g.customer)}` : named(groupParty(g));
	const notes = g.credits.length;
	const paid = isZero(g.paid) ? "" : `; pagato ${sumsText(g.paid)}`;
	if (g.openInvoices === 0) {
		const credit = notes === 0 ? "" : `; ${notes === 1 ? "nota di credito" : "note di credito"} da scalare: ${sumsText(g.credit)}`;
		return `${who}: ${notes === 0 ? "niente di aperto" : "nessuna fattura aperta"}${credit}${paid}`;
	}
	const invoices = g.openInvoices === 1 ? "una fattura" : `${g.openInvoices} fatture`;
	return `${who}: aperto ${nettedText(netted([share(g)]))} su ${invoices}${paid}`;
}

/** «IBAN Alfa Forniture S.r.l.: IT60X0542811101000000123456», the open invoices' IBANs once, an invalid one said. */
export function ibanLine(party: FatturaParty, invoices: readonly Invoice[]): string | undefined {
	const open = invoices.flatMap((i) => i.instalments.filter((n) => n.paid === undefined && n.iban !== undefined).map((n) => n.iban as string));
	const ibans = [...new Set(open.map((i) => i.replace(/\s+/g, "").toUpperCase()))];
	if (ibans.length === 0) return undefined;
	// Checked on paper (ISO 13616): one that fails is said, never given as if good.
	const shown = ibans.slice(0, 3).map((i) => (validIban(i) === undefined ? `${i} (IBAN non valido: le cifre di controllo non tornano, verificalo prima di pagare)` : i));
	return `IBAN ${partyName(party)}: ${shown.join(", ")}${ibans.length > 3 ? ` e altri ${ibans.length - 3}` : ""}`;
}
