/**
 * Taking movements out of the estratto conto, each only on the person's yes: `same` drops a copy
 * of a movement loaded twice (the «forse già caricati» of an import), `remove_import` a whole file
 * loaded by mistake. Their matches and proposals go with them. A movement whose confirmation wrote
 * another register (an invoice marked paid, an expense recorded) is never taken out: it is said.
 * The kept movement of same remembers the copy's hash (aliases), so loading its file again brings
 * nothing back; a movement of the removed file that a later file has too (seenIn) stays, of that file.
 */
import { BANK_LIMITS, type BankMatch, type BankMovement, cappedList, delDay, isLive, withSeen } from "../bank.ts";
import type { BankState } from "../bank-store.ts";
import type { ToolContext } from "../engine.ts";
import { withDate } from "../italian-format.ts";
import { eurosToCents } from "../quote-sums.ts";
import { isProblem } from "../text-input.ts";
import { fenced, readIds } from "./bank-input.ts";
import { signed } from "./bank-render.ts";
import type { BankDeps } from "./bank-tools.ts";

/** Whether a movement's live match wrote another register: confirmed, or an invoice marked by itself. */
function wrote(m: BankMatch | undefined): boolean {
	return m !== undefined && (m.state === "confirmed" || (m.state === "auto" && (m.kind === "invoice_in" || m.kind === "invoice_out")));
}

/** The state without these movements and their matches. */
function without(s: BankState, ids: ReadonlySet<string>): BankState {
	return { ...s, movements: s.movements.filter((m) => !ids.has(m.id)), matches: s.matches.filter((m) => !ids.has(m.movement)) };
}

/** `kept` standing for `copy` too: the copy's hashes as aliases, its imports as seen. */
function absorb(kept: BankMovement, copy: BankMovement): BankMovement {
	const aliases = cappedList(kept.aliases, [copy.hash, ...(copy.aliases ?? [])], BANK_LIMITS.aliases, kept.hash);
	return withSeen({ ...kept, ...(aliases === undefined ? {} : { aliases }) }, [copy.importId, ...(copy.seenIn ?? [])]);
}

const row = (m: BankMovement) => `${m.id} ${delDay(m.date)}: ${signed(eurosToCents(m.amount))}, ${m.description}`;

/** same: two movements that are one; the copy (the later, unless only the later is confirmed) goes. */
export async function sameOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const ids = readIds(args.ids, 2);
	if (isProblem(ids)) return `Errore: ${ids.problem}.`;
	if (ids?.length !== 2) return "Errore: same vuole due movimenti in ids: quello caricato prima e la sua copia.";
	const book = d.readable();
	const [a, b] = ids.map((id) => book.movements.find((m) => m.id === id));
	if (a === undefined || b === undefined) return "Errore: uno dei due movimenti non c'è tra quelli caricati.";
	if (a.date !== b.date || a.amount !== b.amount) return "Non sono lo stesso movimento: il giorno o l'importo sono diversi, non tolgo niente.";
	const live = new Map(book.matches.filter(isLive).map((m) => [m.movement, m]));
	const [older, newer] = Number(a.id.slice(2)) < Number(b.id.slice(2)) ? [a, b] : [b, a];
	if (wrote(live.get(older.id)) && wrote(live.get(newer.id))) return `Errore: ${older.id} e ${newer.id} sono confermati tutti e due (fatture segnate o spese registrate): non tolgo niente da qui.`;
	const [kept, copy] = wrote(live.get(newer.id)) ? [newer, older] : [older, newer];
	if (args.confirm !== true) return [`Tolgo ${copy.id} come copia di ${kept.id}, con le sue proposte:`, fenced([row(copy), row(kept)].join("\n")), "Chiedi a chi ti scrive se sono proprio lo stesso movimento; solo dopo il sì ripeti con confirm true."].join("\n");
	await ctx.step("apply", async () => {
		// The kept one stands for the copy from now on: its hash and its imports, so loading that file again brings nothing back.
		d.store.update(ctx.callId, (s) => {
			const rest = without(s, new Set([copy.id]));
			return { ...rest, movements: rest.movements.map((m) => (m.id === kept.id ? absorb(m, copy) : m)) };
		});
		return true;
	});
	await d.audit(ctx, "same", 1);
	return `Fatto: tolto ${copy.id}, la copia di ${kept.id}; i totali lo contano una volta sola.`;
}

/** remove_import: a file loaded by mistake, its movements and their matches; never when one of them is confirmed. */
export async function removeImportOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const asked = typeof args.import_id === "string" ? args.import_id.trim().toUpperCase() : undefined;
	if (asked === undefined || asked === "") return "Errore: dimmi quale estratto conto togliere (import_id, come I-0002; summary dice l'ultimo).";
	const book = d.readable();
	const record = book.imports.find((i) => i.id === asked);
	if (record === undefined) return `Errore: non c'è un estratto conto ${fenced(asked.slice(0, 12))} tra quelli caricati.`;
	const live = new Map(book.matches.filter(isLive).map((m) => [m.movement, m]));
	const others = new Set(book.imports.filter((i) => i.id !== record.id).map((i) => i.id));
	const mine = book.movements.filter((m) => m.importId === record.id);
	// A movement a later file has too stays, now of the latest of those files.
	const home = new Map(
		mine.flatMap((m) => {
			const later = (m.seenIn ?? []).filter((id) => others.has(id)).at(-1);
			return later === undefined ? [] : [[m.id, later] as const];
		}),
	);
	const gone = mine.filter((m) => !home.has(m.id));
	const locked = gone.filter((m) => wrote(live.get(m.id)));
	if (locked.length > 0) return `Non lo tolgo: ${locked.length === 1 ? "questo movimento è confermato" : "questi movimenti sono confermati"} (fatture segnate o spese registrate): ${locked.slice(0, BANK_LIMITS.listed).map((m) => m.id).join(", ")}${locked.length > BANK_LIMITS.listed ? "…" : ""}. Se va tolto davvero, prima va tolta a mano la conferma nel registro.`;
	const homes = [...new Set(home.values())].sort();
	const staying = home.size === 0 ? "" : `; ${home.size === 1 ? "uno resta perché c'è" : `${home.size} restano perché ci sono`} anche in ${homes.join(", ")}`;
	const what = `l'estratto conto ${record.id} (${withDate("dal", record.from)} ${withDate("al", record.to)}, ${mine.length === 1 ? "un movimento" : `${mine.length} movimenti`} portati da quel file${staying})`;
	if (args.confirm !== true) return `Tolgo ${what}, con le loro proposte. Chiedi a chi ti scrive se va bene; solo dopo il sì ripeti con confirm true.`;
	await ctx.step("apply", async () => {
		d.store.update(ctx.callId, (s) => {
			const rest = without(s, new Set(gone.map((m) => m.id)));
			const movements = rest.movements.map((m) => {
				const to = home.get(m.id);
				if (to !== undefined) return withSeen({ ...m, importId: to }, []);
				return m.seenIn?.includes(record.id) === true ? withSeen({ ...m, seenIn: m.seenIn.filter((id) => id !== record.id) }, []) : m;
			});
			return { ...rest, movements, imports: s.imports.filter((i) => i.id !== record.id) };
		});
		return true;
	});
	await d.audit(ctx, "remove_import", gone.length);
	return `Fatto: tolto ${what}.`;
}
