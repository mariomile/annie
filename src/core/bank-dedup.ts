/**
 * Which rows of a statement file are movements loaded already, pure. A row is the same movement
 * as a kept one with its hash (day, cents, description), each kept movement standing for one row
 * at most. On a miss, another export of the same account (another format or header: its layout)
 * may describe the same movement differently: a kept movement of an import with another layout,
 * covering that day, of the same day and amount, whose description shares a meaningful word of 4
 * or more letters (the bank's generic words do not count) or is empty, is that movement. The same
 * day and amount with a wholly different description is new, and said: maybe loaded.
 */
import type { BankImport, BankMovement } from "./bank.ts";
import type { ParsedRow } from "./bank-parse.ts";
import { centsDecimal } from "./quote-sums.ts";
import { fold } from "./text-match.ts";

/** Words every bank writes: they never tell two movements are the same. */
const GENERIC = new Set(["bonifico", "bonifici", "favore", "pagamento", "pagamenti", "addebito", "addebiti", "accredito", "accrediti", "disposizione", "disposto", "sepa", "istantaneo", "ordinante", "beneficiario", "carta", "credito", "debito", "operazione", "causale", "banca", "conto", "importo", "commissioni", "valuta", "saldo", "fattura", "riferimento", "incasso", "versamento", "ricevuto", "eseguito", "emesso", "presso", "tramite", "vostro", "nostro", "transfer", "payment", "card", "from", "iban", "senza", "descrizione"]);

/** The meaningful words of a description: 4 or more letters, not the bank's generic ones. */
export function longWords(text: string): Set<string> {
	return new Set(
		fold(text)
			.split(/[^a-z]+/)
			.filter((w) => w.length >= 4 && !GENERIC.has(w)),
	);
}

export type RowFate = { readonly kind: "loaded" } | { readonly kind: "new"; readonly seq: number; readonly maybe?: string };

const empty = (t: string) => t.trim() === "" || t === "(senza descrizione)";

/** The fate of each row of a file with `layout`, against the movements kept and their imports. */
export function rowFates(kept: readonly BankMovement[], imports: readonly BankImport[], rows: readonly ParsedRow[], layout: string): RowFate[] {
	const byHash = new Map<string, BankMovement[]>();
	const lastSeq = new Map<string, number>();
	for (const m of [...kept].sort((a, b) => a.seq - b.seq)) {
		byHash.set(m.hash, [...(byHash.get(m.hash) ?? []), m]);
		lastSeq.set(m.hash, Math.max(lastSeq.get(m.hash) ?? 0, m.seq));
	}
	const records = new Map(imports.map((i) => [i.id, i]));
	const format = layout.split(":")[0];
	// Another export: another layout, or (an import recorded before layouts) another format.
	const otherLayout = (i: BankImport) => (i.layout === undefined ? i.format !== format : i.layout !== layout);
	const absorbed = new Set<string>();
	const said = new Set<string>();
	return rows.map((r): RowFate => {
		const twin = byHash.get(r.hash)?.find((m) => !absorbed.has(m.id));
		if (twin !== undefined) {
			absorbed.add(twin.id);
			return { kind: "loaded" };
		}
		const amount = centsDecimal(r.cents);
		const alike = kept.filter((m) => {
			const i = records.get(m.importId);
			return !absorbed.has(m.id) && m.date === r.date && m.amount === amount && m.hash !== r.hash && i !== undefined && i.from <= r.date && r.date <= i.to && otherLayout(i);
		});
		const words = longWords(r.description);
		const same = alike.find((m) => empty(m.description) || empty(r.description) || [...longWords(m.description)].some((w) => words.has(w)));
		if (same !== undefined) {
			absorbed.add(same.id);
			return { kind: "loaded" };
		}
		const seq = (lastSeq.get(r.hash) ?? 0) + 1;
		lastSeq.set(r.hash, seq);
		const maybe = alike.find((m) => !said.has(m.id));
		if (maybe !== undefined) said.add(maybe.id);
		return { kind: "new", seq, ...(maybe === undefined ? {} : { maybe: maybe.id }) };
	});
}
