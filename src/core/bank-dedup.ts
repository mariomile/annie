/**
 * Which rows of a statement file are movements loaded already, pure. A row is the same movement
 * as a kept one with its hash (day, cents, description) or a hash it stood for before (`aliases`:
 * a row of another export it took, a copy dropped by the op same), each kept movement standing for
 * one row at most. On a miss, another export of the same account (another format or header: its
 * layout) may describe the same movement differently: a kept movement of an import with another
 * layout, covering that day, of the same day and amount is that movement when its description is
 * the same text, else when it shares meaningful words of 4 or more letters (the bank's generic
 * words do not count; the pair sharing most goes first, whatever the order of the rows) or one of
 * the two is empty. A row left new with a kept movement of the same day and amount, of any layout,
 * not taken by its hash or its text, is said: maybe loaded.
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

/** loaded: the row is the kept movement `into`; new: its n-th of the hash, and a kept movement it may be. */
export type RowFate = { readonly kind: "loaded"; readonly into: string } | { readonly kind: "new"; readonly seq: number; readonly maybe?: string };

const empty = (t: string) => t.trim() === "" || t === "(senza descrizione)";
const plain = (t: string) => fold(t).replace(/\s+/g, " ").trim();

/** The fate of each row of a file with `layout`, against the movements kept and their imports. */
export function rowFates(kept: readonly BankMovement[], imports: readonly BankImport[], rows: readonly ParsedRow[], layout: string): RowFate[] {
	const byHash = new Map<string, BankMovement[]>();
	const lastSeq = new Map<string, number>();
	for (const m of [...kept].sort((a, b) => a.seq - b.seq)) {
		for (const h of [m.hash, ...(m.aliases ?? [])]) byHash.set(h, [...(byHash.get(h) ?? []), m]);
		lastSeq.set(m.hash, Math.max(lastSeq.get(m.hash) ?? 0, m.seq));
	}
	const records = new Map(imports.map((i) => [i.id, i]));
	const format = layout.split(":")[0];
	// Another export: another layout, or (an import recorded before layouts) another format.
	const otherLayout = (i: BankImport) => (i.layout === undefined ? i.format !== format : i.layout !== layout);
	const absorbed = new Set<string>();
	// Taken by a row sharing words only: it may still be another row's, and is said.
	const unsure = new Set<string>();
	const fates: (RowFate | undefined)[] = rows.map(() => undefined);
	const take = (k: number, m: BankMovement) => {
		absorbed.add(m.id);
		fates[k] = { kind: "loaded", into: m.id };
	};
	// 1. The hash twins, in the file's order.
	rows.forEach((r, k) => {
		const twin = byHash.get(r.hash)?.find((m) => !absorbed.has(m.id));
		if (twin !== undefined) take(k, twin);
	});
	// The kept movements a row may be: same day and amount, another hash, of an import covering the day.
	const sameDay = (r: ParsedRow, crossOnly: boolean) => {
		const amount = centsDecimal(r.cents);
		return kept.filter((m) => {
			const i = records.get(m.importId);
			return (!absorbed.has(m.id) || (!crossOnly && unsure.has(m.id))) && m.date === r.date && m.amount === amount && m.hash !== r.hash && i !== undefined && i.from <= r.date && r.date <= i.to && (!crossOnly || otherLayout(i));
		});
	};
	// 2. Another export, the same text.
	rows.forEach((r, k) => {
		if (fates[k] !== undefined) return;
		const same = sameDay(r, true).find((m) => plain(m.description) === plain(r.description));
		if (same !== undefined) take(k, same);
	});
	// 3. Another export, the pair sharing most meaningful words first (an empty description pairs last); ties in the file's order.
	const pairs: { k: number; m: BankMovement; score: number; at: number }[] = [];
	rows.forEach((r, k) => {
		if (fates[k] !== undefined) return;
		const words = longWords(r.description);
		sameDay(r, true).forEach((m, at) => {
			const score = [...longWords(m.description)].filter((w) => words.has(w)).length;
			if (score > 0 || empty(m.description) || empty(r.description)) pairs.push({ k, m, score, at });
		});
	});
	pairs.sort((a, b) => b.score - a.score || a.k - b.k || a.at - b.at);
	for (const p of pairs) {
		if (fates[p.k] !== undefined || absorbed.has(p.m.id)) continue;
		take(p.k, p.m);
		unsure.add(p.m.id);
	}
	// 4. The rest is new, said when a kept movement of any layout has its day and amount.
	const said = new Set<string>();
	return rows.map((r, k): RowFate => {
		const fate = fates[k];
		if (fate !== undefined) return fate;
		const seq = (lastSeq.get(r.hash) ?? 0) + 1;
		lastSeq.set(r.hash, seq);
		const maybe = sameDay(r, false).find((m) => !said.has(m.id));
		if (maybe !== undefined) said.add(maybe.id);
		return { kind: "new", seq, ...(maybe === undefined ? {} : { maybe: maybe.id }) };
	});
}
