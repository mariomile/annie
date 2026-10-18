/**
 * The client a person names, against the names already used: one rule for every op of the
 * timesheet. The same name without case, accents and punctuation, legal form included, is the
 * same client («rossi srl» is «Rossi S.r.l.»), said with the spelling already used. Anything less
 * is only close: the same name with another legal form or none («Rossi» and «Rossi Srl»), or one
 * name inside the other («Rossi» and «Mario Rossi»), or a slip of a letter («Laura Ner» and
 * «Laura Neri»). A close name is never taken for the client:
 * recording, it is suggested; billing, it is refused with the candidates; reading, the one
 * candidate is used and said.
 */
import { businessKey, keyWithin, nearKey, spellingKey } from "./name-keys.ts";

export type ClientResolution =
	/** The same client: `name` is the spelling already used; `respelled` when it differs from the one said. */
	| { readonly kind: "exact"; readonly name: string; readonly respelled: boolean }
	/** Names close to the one said, none the same: at most five, most likely first. */
	| { readonly kind: "close"; readonly candidates: readonly string[] }
	| { readonly kind: "none" };

/** Close names shown at most. */
const MAX_CANDIDATES = 5;

/** Names close to `said` among `known`, one per spelling: the same name with another legal form, or one inside the other. */
export function closeClients(said: string, known: readonly string[]): string[] {
	const base = businessKey(said);
	const spelling = spellingKey(said);
	const out = new Map<string, string>();
	for (const k of known) {
		const ks = spellingKey(k);
		if (ks === spelling || out.has(ks)) continue;
		const kb = businessKey(k);
		if (base !== "" && (kb === base || keyWithin(base, kb) || nearKey(base, kb))) out.set(ks, k);
	}
	return [...out.values()].slice(0, MAX_CANDIDATES);
}

/** The client `said` names among `known` (most likely first). */
export function resolveClient(said: string, known: readonly string[]): ClientResolution {
	const spelling = spellingKey(said);
	if (spelling === "") return { kind: "none" };
	const exact = known.find((k) => spellingKey(k) === spelling);
	if (exact !== undefined) return { kind: "exact", name: exact, respelled: exact !== said };
	const candidates = closeClients(said, known);
	return candidates.length === 0 ? { kind: "none" } : { kind: "close", candidates };
}
