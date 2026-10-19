/**
 * Who the parties of the registers are, one rule for the clients (client-sums.ts) and the
 * suppliers (supplier-sums.ts): the cards the person made, then the records of the registers. One
 * party is one card, or else one partita IVA, codice fiscale or name (the timesheet's rule: no
 * case, accents nor punctuation, the legal form counts). A name with no partita IVA also joins
 * the one party whose name is the same without the legal form, when it has the same legal form or
 * none and it is the only such party: «Rossi» and «Rossi S.r.l.» are one; «Rossi Srl» and «Rossi
 * SpA» stay two. Two homonyms with two partite IVA are two. The name shown is the card's, else the
 * one the person wrote, else the file's.
 */
import { sameBusiness, spellingKey } from "./name-keys.ts";

/** What a card brings to the grouping. */
export type PartyCard = { readonly id: string; readonly name: string; readonly aliases: readonly string[]; readonly vat?: string; readonly cf?: string };

/** One record of a register: its tax ids and name as written, whether the person wrote it, and the record itself. */
export type PartyRecord<T> = { readonly vat?: string; readonly cf?: string; readonly name?: string; readonly person: boolean; readonly item: T };

/** One party: its card when there is one, and its records, in the order they were placed. */
export type PartyGroup<C, T> = {
	/** The card's id, else «vat:…», «cf:…» or «nome:…». */
	readonly key: string;
	readonly card?: C;
	readonly name: string;
	readonly nameFrom: "card" | "person" | "file";
	readonly vat?: string;
	readonly cf?: string;
	/** Every spelling seen for it, as written. */
	readonly names: readonly string[];
	readonly items: readonly T[];
};

type Group<C, T> = { key: string; card?: C; personName?: string; fileName?: string; vat?: string; cf?: string; names: string[]; items: T[] };

/** Every party: the cards first, then the parties without one, by the order they were met. The records with a tax id are placed first: a name alone then joins the party they made. */
export function groupParties<C extends PartyCard, T>(cards: readonly C[], records: readonly PartyRecord<T>[]): PartyGroup<C, T>[] {
	const groups: Group<C, T>[] = [];
	/** The partite IVA the registers give to names of one business: a name alone is linked to one only when there is only one. */
	const vatsOf = (names: readonly string[]): Set<string> => new Set(records.flatMap((r) => (r.vat !== undefined && r.name !== undefined && names.some((n) => sameBusiness(n, r.name as string)) ? [r.vat] : [])));
	const byVat = new Map<string, Group<C, T>>();
	const byCf = new Map<string, Group<C, T>>();
	const byName = new Map<string, Group<C, T>>();
	const index = (g: Group<C, T>, name?: string) => {
		if (g.vat !== undefined && !byVat.has(g.vat)) byVat.set(g.vat, g);
		if (g.cf !== undefined && !byCf.has(g.cf)) byCf.set(g.cf, g);
		const k = name === undefined ? "" : spellingKey(name);
		if (k !== "" && !byName.has(k)) byName.set(k, g);
		if (name !== undefined && !g.names.includes(name)) g.names.push(name);
	};
	/** The one group a name may be without its legal form (sameBusiness); undefined when none or more than one. */
	const oneBusiness = (name: string, only: (g: Group<C, T>) => boolean): Group<C, T> | undefined => {
		const found = new Set(groups.filter((g) => only(g) && g.names.some((n) => sameBusiness(n, name))));
		return found.size === 1 ? [...found][0] : undefined;
	};
	/** The group of a record: by partita IVA, codice fiscale, then name (only into a party with no partita IVA or the same), then the one business. */
	const find = (vat: string | undefined, cf: string | undefined, name: string | undefined): Group<C, T> | undefined => {
		const v = vat === undefined ? undefined : byVat.get(vat);
		if (v !== undefined) return v;
		const c = cf === undefined ? undefined : byCf.get(cf);
		if (c !== undefined) return c;
		const k = name === undefined ? "" : spellingKey(name);
		const n = k === "" ? undefined : byName.get(k);
		// Two homonyms with two partite IVA or two codici fiscali are two parties.
		if (n !== undefined && (vat === undefined || n.vat === undefined || n.vat === vat) && (cf === undefined || n.cf === undefined || n.cf === cf)) return n;
		if (name === undefined || k === "") return undefined;
		// A name without a partita IVA joins the one party that is the same business; a record with one joins only a party without any.
		if (vat === undefined && cf === undefined) return oneBusiness(name, () => true);
		// A party with no tax id (a bare name on a card) takes a partita IVA only when its business has just one in the registers.
		const bare = oneBusiness(name, (g) => g.vat === undefined && g.cf === undefined);
		return bare !== undefined && vatsOf(bare.names).size <= 1 ? bare : undefined;
	};
	const place = (vat: string | undefined, cf: string | undefined, name: string | undefined, person: boolean): Group<C, T> | undefined => {
		if (vat === undefined && cf === undefined && (name === undefined || spellingKey(name) === "")) return undefined;
		let g = find(vat, cf, name);
		if (g === undefined) {
			g = { key: vat !== undefined ? `vat:${vat}` : cf !== undefined ? `cf:${cf}` : `nome:${spellingKey(name ?? "")}`, names: [], items: [] };
			groups.push(g);
		}
		// A name joined to a party links it to the partita IVA it brings.
		if (g.vat === undefined && vat !== undefined) g.vat = vat;
		if (g.cf === undefined && cf !== undefined) g.cf = cf;
		if (name !== undefined && name.trim() !== "") {
			if (person) g.personName ??= name;
			else g.fileName ??= name;
		}
		index(g, name);
		return g;
	};
	for (const card of cards) {
		const g: Group<C, T> = { key: card.id, card, names: [], items: [], ...(card.vat === undefined ? {} : { vat: card.vat }), ...(card.cf === undefined ? {} : { cf: card.cf }) };
		groups.push(g);
		for (const n of [card.name, ...card.aliases]) index(g, n);
	}
	for (const r of [...records.filter((x) => x.vat !== undefined || x.cf !== undefined), ...records.filter((x) => x.vat === undefined && x.cf === undefined)]) {
		const g = place(r.vat, r.cf, r.name, r.person);
		if (g !== undefined) g.items.push(r.item);
	}
	return groups.map((g) => ({
		key: g.key,
		...(g.card === undefined ? {} : { card: g.card }),
		name: g.card?.name ?? g.personName ?? g.fileName ?? g.names[0] ?? (g.vat === undefined ? g.key : `P.IVA ${g.vat}`),
		nameFrom: g.card !== undefined ? "card" : g.personName !== undefined ? "person" : "file",
		...(g.vat === undefined ? {} : { vat: g.vat }),
		...(g.cf === undefined ? {} : { cf: g.cf }),
		names: g.names,
		items: g.items,
	}));
}

/** Tax ids and name of a record, the missing ones left out. */
export function partyOf(vat: string | undefined, cf: string | undefined, name: string | undefined): { vat?: string; cf?: string; name?: string } {
	return { ...(vat === undefined ? {} : { vat }), ...(cf === undefined ? {} : { cf }), ...(name === undefined ? {} : { name }) };
}

/** What lookalikeParties compares: the key, the names and the tax ids of a party. */
export type NamedParty = { readonly key: string; readonly name: string; readonly names: readonly string[]; readonly vat?: string; readonly cf?: string };

/**
 * The other parties that may be this one, not joined (there were two of them): the same business
 * by name (sameBusiness), and no partita IVA or codice fiscale that says otherwise. To be asked.
 * `anyTax`: those with another tax id too (a homonym, or someone using the name: a fraud's sign).
 */
export function lookalikeParties<P extends NamedParty>(parties: readonly P[], party: P, o: { readonly anyTax?: boolean } = {}): P[] {
	const mine = [party.name, ...party.names];
	return parties.filter((p) => {
		if (p.key === party.key) return false;
		if (o.anyTax !== true && party.vat !== undefined && p.vat !== undefined && party.vat !== p.vat) return false;
		if (o.anyTax !== true && party.cf !== undefined && p.cf !== undefined && party.cf !== p.cf) return false;
		return [p.name, ...p.names].some((n) => mine.some((m) => sameBusiness(m, n)));
	});
}
