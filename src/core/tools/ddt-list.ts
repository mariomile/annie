/**
 * What the tool `ddt` reads: the DDTs as loaded with the invoices that hold or bill them and the
 * resi that came back; the DDT a request names; the list (all, or what is still to bill, with the
 * late months and the conto visione still out), one DDT's status, the brief's months and stale
 * drafts, and another agente's counts. Names, goods and numbers only inside the fences.
 */
import { type Ddt, DDT_LIMITS, dueDayOf, isIssuedDdt } from "../ddt.ts";
import type { DdtBook } from "../ddt-store.ts";
import { n1 } from "../format-words.ts";
import { italianLongDate } from "../italian-format.ts";
import type { PriceItem } from "../price-list.ts";
import type { SalesInvoice } from "../sales-invoices.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { ddtNamed, ofClient } from "./ddt-input.ts";
import { ddtBlock, ddtRow, ddtTitle, fencedDdt, more, type UnbilledMonth, visioneWords } from "./ddt-render.ts";
import { clientKey, ddtClientSaid, type DdtInvoices, type Returns, unbilled } from "./sales-ddt.ts";

/** What a request works on: the DDTs, the invoices and where the DDTs stand with them, the resi, the listino. */
export type Loaded = { readonly book: DdtBook; readonly invoices: readonly SalesInvoice[]; readonly links: DdtInvoices; readonly returns: Returns; readonly voci: readonly PriceItem[] };

/** The DDT named (ddt), or the client's one `pick` takes, or the only one; or the answer to give. */
export function target(args: Record<string, unknown>, loaded: Loaded, pick: (d: Ddt) => boolean, what: string): Ddt | string {
	const named = ddtNamed(args.ddt, loaded.book.ddts);
	if (named !== undefined) return named;
	let pool = loaded.book.ddts.filter(pick);
	if (args.client !== undefined) {
		const said = cleanText(args.client, DDT_LIMITS.name, "il cliente");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		const c = ddtClientSaid(said ?? "", loaded.book.ddts);
		if (typeof c === "string") return c;
		if ("none" in c) return ["Non trovo DDT per questo cliente.", fencedDdt(said ?? "")].join("\n");
		pool = ofClient(pool, c);
	}
	pool = [...pool].sort((a, b) => b.id.localeCompare(a.id));
	if (pool.length === 1) return pool[0] as Ddt;
	if (pool.length === 0) return `Non c'è un DDT ${what}${args.client === undefined ? "" : " per questo cliente"}.`;
	return [`Ci sono ${pool.length} DDT ${what}: dimmi quale, con il numero o il cliente (le bozze per il cliente e il giorno).`, fencedDdt([...pool.slice(0, DDT_LIMITS.shown).map((d) => `• ${ddtRow(d, loaded.links)}`), ...more(pool.length)].join("\n"))].join("\n");
}

const monthWords = (month: string) => italianLongDate(`${month}-01`).replace(/^1 /, "").replace(/ \d{4}$/, "");

/** The list: every DDT of this year and the drafts (all: every one), or what is still to bill. */
export function list(args: Record<string, unknown>, loaded: Loaded, day: string): { text: string; count: number } {
	if (args.unbilled !== undefined && typeof args.unbilled !== "boolean") return { text: "Errore: da fatturare è sì o no.", count: 0 };
	if (args.all !== undefined && typeof args.all !== "boolean") return { text: "Errore: tutti è sì o no.", count: 0 };
	let pool: Ddt[] = [...loaded.book.ddts];
	let whose = "";
	if (args.client !== undefined) {
		const said = cleanText(args.client, DDT_LIMITS.name, "il cliente");
		if (isProblem(said)) return { text: `Errore: ${said.problem}.`, count: 0 };
		const c = ddtClientSaid(said ?? "", loaded.book.ddts);
		if (typeof c === "string") return { text: c, count: 0 };
		if ("none" in c) return { text: ["Non trovo DDT per questo cliente.", fencedDdt(said ?? "")].join("\n"), count: 0 };
		pool = ofClient(pool, c);
		whose = " per questo cliente";
	}
	if (args.month !== undefined) {
		const m = cleanText(args.month, 7, "il mese");
		if (isProblem(m) || m === undefined || !/^\d{4}-\d{2}$/.test(m)) return { text: "Errore: il mese è come 2026-10.", count: 0 };
		pool = pool.filter((d) => d.day.slice(0, 7) === m);
	}
	if (args.unbilled === true) return unbilledList(pool, loaded, day, whose);
	const year = day.slice(0, 4);
	const shown = pool.filter((d) => (args.all === true ? true : d.status !== "cancelled" && (d.status === "draft" || d.day.slice(0, 4) === year))).sort((a, b) => b.id.localeCompare(a.id));
	if (shown.length === 0) return { text: args.all === true ? `Non c'è ancora nessun DDT${whose}.` : `Nessun DDT${whose} quest'anno, e nessuna bozza.`, count: 0 };
	const drafts = shown.filter((d) => d.status === "draft").length;
	return { text: [`${n1(shown.length, "Un DDT", "# DDT")}${whose}${args.all === true ? "" : ` del ${year} e in bozza`} (${n1(drafts, "una bozza", "# bozze")}):`, fencedDdt([...shown.slice(0, DDT_LIMITS.shown).map((d) => `• ${ddtRow(d, loaded.links)}`), ...more(shown.length)].join("\n"))].join("\n"), count: shown.length };
}

/** What is still to bill: oldest first, the conto visione flagged with its days; the late months said. */
function unbilledList(pool: readonly Ddt[], loaded: Loaded, day: string, whose: string): { text: string; count: number } {
	const open = pool.filter((d) => unbilled(d, loaded.links, loaded.returns)).sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
	if (open.length === 0) return { text: `Non hai DDT di vendita da fatturare${whose}.`, count: 0 };
	const held = open.filter((d) => loaded.links.draft.has(d.id)).length;
	const clients = new Set(open.map((d) => clientKey(d.client))).size;
	const head = `${n1(open.length, "Un DDT", "# DDT")} da fatturare${whose}, ${n1(clients, "di un cliente", "di # clienti")}${held === 0 ? "" : ` (${n1(held, "uno è già", "# sono già")} in una bozza di fattura)`}:`;
	const rows = open.slice(0, DDT_LIMITS.shown).map((d) => `• ${ddtRow(d, loaded.links)}${d.causale === "conto_visione" ? `, ${visioneWords(d, day)}` : ""}`);
	const late = [...new Set(open.filter((d) => d.causale === "vendita" && !loaded.links.draft.has(d.id) && day > dueDayOf(d.day)).map((d) => d.day.slice(0, 7)))].sort();
	const tail = late.length === 0 ? [] : [`Sono in ritardo quelli di ${late.map(monthWords).join(" e di ")}: la fattura differita va emessa entro il 15 del mese dopo i DDT (${late.map((m) => `per ${monthWords(m)} entro il ${italianLongDate(dueDayOf(`${m}-01`))}`).join(", ")}). Chiedimi «fai la fattura differita di ${monthWords(late[0] as string)} per <cliente>».`];
	return { text: [head, fencedDdt([...rows, ...more(open.length)].join("\n")), ...tail].join("\n"), count: open.length };
}

/** One DDT, in full. */
export function status(args: Record<string, unknown>, loaded: Loaded): { text: string; count: number } {
	const d = target(args, loaded, (x) => x.status !== "cancelled", "aperto");
	if (typeof d === "string") return { text: d, count: 0 };
	const extra = d.status === "issued" && d.stocked !== true ? ["L'emissione non è completa (il magazzino non si era mosso): si completa emettendolo di nuovo."] : [];
	return { text: [`Ecco ${isIssuedDdt(d) ? `il ${ddtTitle(d)}` : `la ${ddtTitle(d)}`}:`, fencedDdt([ddtBlock(d, loaded.links, loaded.book.ddts), ...(d.file === undefined ? [] : [`File: ${d.file}`])].join("\n")), ...extra].join("\n"), count: 1 };
}

/** The brief's months (every one before this, with vendita DDTs to bill, oldest first) and the drafts older than a week. */
export function briefData(loaded: Loaded, day: string, now: Date): { readonly months: UnbilledMonth[]; readonly stale: number } {
	const open = loaded.book.ddts.filter((d) => unbilled(d, loaded.links, loaded.returns) && d.causale === "vendita" && d.day.slice(0, 7) < day.slice(0, 7));
	const byMonth = new Map<string, Ddt[]>();
	for (const d of open) byMonth.set(d.day.slice(0, 7), [...(byMonth.get(d.day.slice(0, 7)) ?? []), d]);
	const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, ddts]) => ({ month, count: ddts.length, clients: [...new Map(ddts.map((d) => [clientKey(d.client), d.client.name])).values()] }));
	const stale = loaded.book.ddts.filter((d) => d.status === "draft" && d.at < new Date(now.getTime() - DDT_LIMITS.staleDays * 86_400_000).toISOString()).length;
	return { months, stale };
}

/** Another agente: how many, nothing more. */
export function agentCounts(loaded: Loaded): string {
	const drafts = loaded.book.ddts.filter((d) => d.status === "draft").length;
	const open = loaded.book.ddts.filter((d) => unbilled(d, loaded.links, loaded.returns)).length;
	return `DDT: ${n1(drafts, "una bozza", "# bozze")}, ${n1(open, "uno da fatturare", "# da fatturare")}. A un altro agente do solo i conteggi: clienti, merce e numeri no.`;
}
