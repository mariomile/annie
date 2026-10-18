/**
 * The list of preventivi in the chat: the latest version of each, filtered by status or by the
 * customer's words, newest first, with the totals. Names are fenced: they come from the person.
 */
import { addDays } from "../italian-calendar.ts";
import { baseOrder, latest, matchesCustomer, QUOTE_LIMITS, QUOTE_SOON_DAYS, type Quote, shownStatus, validUntil } from "../quotes.ts";
import { euros, fenced, listLine, type QuoteView, totalsOf } from "./quote-render.ts";

export const FILTERS = ["aperti", "in_scadenza", "accettati", "rifiutati", "scaduti", "tutti"] as const;
type Filter = (typeof FILTERS)[number];

const LIST_MAX = 15;

const count = (n: number) => (n === 1 ? "1 preventivo" : `${n} preventivi`);

export function listAnswer(quotes: readonly Quote[], args: Record<string, unknown>, v: QuoteView): string {
	const filter: Filter = FILTERS.includes(args.filter as Filter) ? (args.filter as Filter) : "aperti";
	const words = typeof args.customer === "string" ? args.customer : undefined;
	if (words !== undefined && words.length > QUOTE_LIMITS.name) return `Errore: customer è troppo lungo (al massimo ${QUOTE_LIMITS.name} caratteri).`;
	const current = latest(quotes).filter((q) => words === undefined || matchesCustomer(q, words));
	const soon = addDays(v.today, QUOTE_SOON_DAYS);
	const wanted: Record<Filter, (q: Quote) => boolean> = {
		aperti: (q) => shownStatus(q, v.today) === "open",
		in_scadenza: (q) => shownStatus(q, v.today) === "open" && validUntil(q) <= soon,
		accettati: (q) => q.status === "accepted",
		rifiutati: (q) => q.status === "declined",
		scaduti: (q) => shownStatus(q, v.today) === "expired",
		tutti: () => true,
	};
	const shown = current.filter(wanted[filter]).sort((a, b) => {
		const [ay, an] = baseOrder(a);
		const [by, bn] = baseOrder(b);
		return by - ay || bn - an;
	});
	const expired = filter === "aperti" ? current.filter(wanted.scaduti).length : 0;
	const tail = expired === 0 ? "" : `\nScaduti senza risposta: ${expired} (chiedimi i preventivi scaduti per vederli).`;
	const whose = words === undefined ? "" : " di quel cliente";
	const label = filter === "in_scadenza" ? "in scadenza" : filter;
	if (shown.length === 0) {
		const none = filter === "tutti" ? "salvato" : filter === "in_scadenza" ? `in scadenza nei prossimi ${QUOTE_SOON_DAYS} giorni` : filter.replace(/i$/, "o");
		return `Nessun preventivo ${none}${whose}.${tail}`;
	}
	const more = shown.length > LIST_MAX ? `\ne altri ${shown.length - LIST_MAX}` : "";
	const head = `Preventivi${filter === "tutti" ? "" : ` ${label}`}${whose}: ${shown.length}, dal più recente.`;
	const sum = (qs: readonly Quote[], what: string) => `Totale ${what}: ${euros(qs.reduce((s, q) => s + totalsOf(q).total, 0n))} (${count(qs.length)}).`;
	// All statuses together: one sum would add the accepted to the declined; each status apart.
	const groups: [string, Quote[]][] = filter === "tutti" ? [["aperti", shown.filter(wanted.aperti)], ["accettati", shown.filter(wanted.accettati)]] : [[label, shown]];
	const totals = groups.filter(([, qs]) => qs.length > 0).map(([what, qs]) => sum(qs, what));
	const total = totals.length === 0 ? "" : `\n${totals.join(" ")}`;
	return `${head}\n${fenced(`${shown.slice(0, LIST_MAX).map((q) => listLine(q, v)).join("\n")}${more}`)}${total}${tail}`;
}
