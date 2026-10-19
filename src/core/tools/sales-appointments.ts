/**
 * The fatture in uscita and gli appuntamenti: «fattura gli appuntamenti fatti da Bianchi questo
 * mese» drafts an invoice (TD01, the same draft path) with the client's appointments fatti in the
 * period, not billed, nor in another draft: one line per service, as many as the times it was done,
 * priced from the listino (the voce the service is) or by the person, service by service: never
 * invented. The checks and steps of such an invoice: under the lock (two drafts never bill the same
 * appointment), before a number is taken (no longer fatto, billed elsewhere), and after the issue
 * (the appointments marked billed, once; a credit note for the wrong customer gives them back).
 * Names only inside the fences.
 */
import { APPOINTMENT_LIMITS, type Appointment } from "../appointments.ts";
import { type AppointmentLink, APPOINTMENTS_BROKEN } from "../appointment-store.ts";
import type { ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { italianDate } from "../italian-format.ts";
import { spellingKey } from "../name-keys.ts";
import { type Period, PeriodError, readPeriod } from "../periods.ts";
import { listLines } from "../price-list-lines.ts";
import { CREDIT_NOTE_TYPE, FIELD_LIMITS } from "../sales-invoice-rules.ts";
import type { SalesBook, SalesState } from "../sales-invoice-store.ts";
import { type AppointmentRef, type IssuedInvoice, isIssued, SALES_LIMITS, type SalesInvoice, SalesInvoiceError } from "../sales-invoices.ts";
import { isProblem, readAmount } from "../text-input.ts";
import { clientSaid, isAnswer } from "./appointment-input.ts";
import { findBuyer, type Known } from "./sales-invoice-buyer.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";
import { type GivenLine, readLines } from "./sales-invoice-input.ts";
import { fenced } from "./sales-invoice-render.ts";

/** What an invoice of appointments starts from: the customer, the lines, the appointments, the notes. */
export type AppointmentSource = { readonly known: Known; readonly given: readonly GivenLine[]; readonly appointments: readonly AppointmentRef[]; readonly notes: readonly string[] };

/** Where the appointments stand with the invoices: the draft that holds each, the invoice issued that billed it (but `except`, and an invoice a credit note for the wrong customer took back). */
export function appointmentInvoicesOf(invoices: readonly SalesInvoice[], except?: string): { readonly draft: ReadonlyMap<string, string>; readonly issued: ReadonlyMap<string, string>; readonly released: ReadonlySet<string> } {
	const draft = new Map<string, string>();
	const issued = new Map<string, string>();
	const released = new Set<string>();
	const gone = new Set(invoices.filter((i) => i.type === CREDIT_NOTE_TYPE && i.release === true && isIssued(i)).map((i) => i.related?.id));
	for (const inv of invoices) {
		if (gone.has(inv.id)) for (const a of inv.appointments ?? []) released.add(a.id);
		if (inv.id === except || gone.has(inv.id)) continue;
		for (const a of inv.appointments ?? []) {
			if (isIssued(inv)) issued.set(a.id, inv.number);
			else draft.set(a.id, inv.id);
		}
	}
	// Billed again since: no longer only released.
	for (const id of [...draft.keys(), ...issued.keys()]) released.delete(id);
	return { draft, issued, released };
}

/** The voce billed by the hour: «ora», «ore», «h». */
const HOURLY = /^(?:or[ae]|h|hh)$/i;

/** Minutes in hours, exact decimals: «1,5»; rounded half up to the hundredth when not exact, and said. */
export function hoursOfMinutes(minutes: number): { readonly quantity: string; readonly exact: boolean } {
	const exact = (minutes * 100) % 60 === 0;
	const hundredths = Math.floor((minutes * 200 + 60) / 120);
	const whole = Math.floor(hundredths / 100);
	const cents = hundredths % 100;
	const quantity = cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0").replace(/0$/, "")}`;
	return { quantity, exact };
}

/** The receipt question, asked once in the draft of an invoice of appointments (an open tax point: ADR 0094). */
export const RECEIPT_NOTE = "Il cliente ha già pagato questi appuntamenti, con lo scontrino? Se sì, la fattura va fatta come differita o citando gli scontrini: chiedi al commercialista prima di emetterla.";

/**
 * Dictated lines that bill what an appointment fatto of the same customer, not billed, already
 * is (its voce, or its words): asked, never billed twice (`args.appointments` false: apart).
 */
export function dictatedAppointments(env: SalesEnv, args: Record<string, unknown>, known: Known, given: readonly GivenLine[], book: SalesBook): string | undefined {
	if (env.appointments === undefined || args.appointments === false) return undefined;
	const appts = env.appointments.read();
	if (appts.broken) return undefined;
	const card = known.card?.id;
	const name = spellingKey(known.name);
	const links = appointmentInvoicesOf(book.invoices, typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined);
	const open = appts.appointments.filter((a) => a.status === "done" && a.billed === undefined && !links.issued.has(a.id) && !links.draft.has(a.id) && (card !== undefined && a.client.card !== undefined ? a.client.card === card : spellingKey(a.client.name) === name));
	if (open.length === 0) return undefined;
	const items = new Set(given.map((l) => l.item).filter((x) => x !== undefined));
	const words = given.map((l) => spellingKey(l.description));
	const same = open.filter((a) => a.services.some((sv) => (sv.item !== undefined && items.has(sv.item)) || words.some((w) => w === spellingKey(sv.name) || w.startsWith(`${spellingKey(sv.name)} `))));
	if (same.length === 0) return undefined;
	return `Attenzione: questo cliente ha ${n1(same.length, "un appuntamento fatto e non ancora fatturato", "# appuntamenti fatti e non ancora fatturati")} con un servizio come le voci dettate. Non ho fatto la bozza: se è lo stesso lavoro, conviene fatturare gli appuntamenti, così li segno come fatturati e non si fatturano due volte. Chiedilo a chi ti scrive: se sì, rifai la fattura con gli appuntamenti; se è un lavoro a parte, ripeti dicendo che è a parte.`;
}

/** The service a line bills: its voce, else its words. */
const serviceKey = (s: Appointment["services"][number]) => (s.item !== undefined ? `i:${s.item}` : `n:${spellingKey(s.name)}`);

/** The prices said service by service: [{description, price}]; a map of the service's words to the price, or the answer to give. */
function pricesSaid(raw: unknown): Map<string, string> | string {
	const out = new Map<string, string>();
	if (raw === undefined) return out;
	if (!Array.isArray(raw) || raw.length > SALES_LIMITS.lines) return "Errore: i prezzi sono un elenco, ognuno con il servizio (come te l'ho detto) e il prezzo senza IVA.";
	for (const p of raw) {
		const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
		if (typeof o.description !== "string" || o.description.trim() === "") return "Errore: ogni prezzo dice il servizio, come te l'ho detto, e il prezzo senza IVA.";
		const price = readAmount(o.price, 4, "il prezzo", fenced);
		if (isProblem(price)) return `Errore: ${price.problem}.`;
		if (price === undefined || Number(price) <= 0) return ["Errore: il prezzo di questo servizio è un importo maggiore di zero, senza IVA:", fenced(o.description.slice(0, APPOINTMENT_LIMITS.service))].join("\n");
		out.set(spellingKey(o.description), price);
	}
	return out;
}

/** «Taglio del 02/10, 09/10 e 16/10», shortened to the count when it does not fit. */
function lineWords(name: string, days: readonly string[]): string {
	const list = days.map((d) => italianDate(d).slice(0, 5));
	const full = `${name} del ${list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} e ${list.at(-1)}`}`;
	const max = FIELD_LIMITS.descrizione - 20;
	if (full.length <= max) return full;
	const short = `${name} (${n1(days.length, "un appuntamento", "# appuntamenti")})`;
	return short.length <= max ? short : name.slice(0, max);
}

/**
 * The draft's source for «fattura gli appuntamenti fatti da <cliente> <periodo>»: the client's
 * appointments fatti in the period (default: every one up to today), not billed and in no other
 * draft (but the one `replace` names). Prices from the listino; the others asked.
 */
export function appointmentSource(env: SalesEnv, args: Record<string, unknown>, book: SalesBook, day: string): AppointmentSource | string {
	if (env.appointments === undefined) return "Errore: qui non vedo gli appuntamenti: detta le voci della fattura.";
	const appts = env.appointments.read();
	if (appts.broken) return `Errore: ${APPOINTMENTS_BROKEN}.`;
	if (typeof args.customer !== "string" || args.customer.trim() === "") return "Errore: dimmi di quale cliente fatturare gli appuntamenti.";
	const cardsBook = env.clients?.read();
	const cards = cardsBook === undefined || cardsBook.broken ? [] : cardsBook.cards;
	const who = clientSaid(args.customer, cards, appts.appointments);
	if (isAnswer(who)) return who.answer;
	if (who.close === true) return ["Intendi questo cliente? Non si chiama esattamente così:", fenced(who.client.name), "Chiedi a chi ti scrive se è lui, e ripeti con il nome scritto come qui."].join("\n");
	const key = (c: Appointment["client"]) => c.card ?? `n:${spellingKey(c.name)}`;
	const mine = appts.appointments.filter((a) => key(a.client) === key(who.client));
	if (mine.length === 0) return ["Non trovo appuntamenti per questo cliente:", fenced(who.client.name)].join("\n");
	let period: Pick<Period, "from" | "to" | "label">;
	try {
		period = args.period === undefined ? { from: "0000-01-01", to: day, label: `fino al ${italianDate(day)}` } : readPeriod(String(args.period), day);
	} catch (error) {
		if (error instanceof PeriodError) return `Errore: ${error.message}.`;
		throw error;
	}
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const links = appointmentInvoicesOf(book.invoices, replace);
	const inPeriod = mine.filter((a) => a.day >= period.from && a.day <= period.to && a.day <= day);
	const billTo = typeof args.bill_to === "string" && args.bill_to.trim() !== "" ? args.bill_to.trim() : undefined;
	if (args.bill_to !== undefined && billTo === undefined) return "Errore: dimmi a quale cliente intestare la fattura degli appuntamenti.";
	const open = inPeriod.filter((a) => a.status === "done" && a.billed === undefined && !links.issued.has(a.id) && (billTo === undefined || links.released.has(a.id)));
	const picked = open.filter((a) => !links.draft.has(a.id)).sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
	if (billTo !== undefined && picked.length === 0 && !open.some((a) => links.draft.has(a.id))) return "Errore: a un altro cliente intesto solo gli appuntamenti di una fattura corretta con una nota di credito per cliente sbagliato, già emessa. Per questo cliente non ce ne sono da rifatturare.";
	const stillBooked = inPeriod.filter((a) => a.status === "booked").length;
	const bookedNote = stillBooked === 0 ? [] : [`${n1(stillBooked, "Un appuntamento passato è", "# appuntamenti passati sono")} ancora «fissato»: non ${stillBooked === 1 ? "lo fatturo" : "li fatturo"}. Se ${stillBooked === 1 ? "è stato fatto" : "sono stati fatti"}, segnalo come fatto negli appuntamenti e rifai la fattura.`];
	if (picked.length === 0) {
		const held = [...new Set(open.map((a) => links.draft.get(a.id)).filter((x) => x !== undefined))];
		if (held.length > 0) return `Gli appuntamenti fatti di questo cliente sono già in una bozza di fattura (${held.join(", ")}: non serve dirlo a chi ti scrive): emetti quella, oppure la rifaccio prendendo il suo posto.`;
		return [`Nessun appuntamento fatto da fatturare per questo cliente, ${period.label}: sono già fatturati, oppure non ce ne sono.`, ...bookedNote].join("\n");
	}
	if (picked.length > SALES_LIMITS.hours) return "Errore: sono troppi appuntamenti per una fattura sola: fattura un periodo più corto.";
	// One line per service, as many as the times it was done, in the order first done.
	const groups = new Map<string, { name: string; item?: string; days: string[]; minutes: number }>();
	for (const a of picked) {
		for (const s of a.services) {
			const g = groups.get(serviceKey(s)) ?? { name: s.name, ...(s.item === undefined ? {} : { item: s.item }), days: [], minutes: 0 };
			g.days.push(a.day);
			g.minutes += s.minutes;
			groups.set(serviceKey(s), g);
		}
	}
	if (groups.size > SALES_LIMITS.lines) return `Errore: verrebbero più di ${SALES_LIMITS.lines} righe: fattura un periodo più corto.`;
	const list = env.priceList?.read();
	const voci = list === undefined || list.broken ? [] : list.items;
	const prices = pricesSaid(args.prices);
	if (typeof prices === "string") return prices;
	const asked = [...groups.values()].filter((g) => (g.item === undefined || !voci.some((v) => v.id === g.item)) && !prices.has(spellingKey(g.name)));
	if (asked.length > 0) {
		return [
			`Mi ${n1(asked.length, "manca un prezzo", "mancano # prezzi")} (senza IVA): ${asked.length === 1 ? "il servizio è nel riquadro e non è" : "i servizi sono nel riquadro e non sono"} nel listino. A quanto lo fatturo? Chiedilo a chi ti scrive, non inventarlo, poi rifai la fattura con i prezzi, servizio per servizio.`,
			fenced(asked.map((g) => `• ${g.name}: ${n1(g.days.length, "una volta", "# volte")}`).join("\n")),
		].join("\n");
	}
	const groupsList = [...groups.values()];
	const hourly: string[] = [];
	const raw = groupsList.map((g) => {
		const own = prices.get(spellingKey(g.name));
		const voce = g.item === undefined ? undefined : voci.find((v) => v.id === g.item);
		// A voce priced by the hour bills the minutes, in hours (exact decimals); any other, the times.
		let quantity = String(g.days.length);
		if (voce?.unit !== undefined && HOURLY.test(voce.unit.trim())) {
			const h = hoursOfMinutes(g.minutes);
			quantity = h.quantity;
			hourly.push(`${g.name}: ${g.minutes} minuti, cioè ${h.quantity.replace(".", ",")} ${h.quantity === "1" ? "ora" : "ore"}${h.exact ? "" : " (arrotondato al centesimo)"}`);
		}
		// The person's price wins over the voce's (price-list-lines.ts: what the line gives itself).
		return { description: lineWords(g.name, g.days), quantity, ...(voce === undefined ? {} : { item: voce.id }), ...(own === undefined ? {} : { price: own }) };
	});
	const filled = listLines({ ...(env.priceList === undefined ? {} : { priceList: env.priceList }), company: env.company, taxes: env.taxes }, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: args.vat, natura: args.natura }, keepItem: true });
	if (filled !== undefined && "ask" in filled) return filled.ask;
	const given = readLines(filled?.lines ?? raw);
	if (isProblem(given)) return `Errore: ${given.problem}.`;
	let known: Known;
	if (billTo !== undefined) {
		// The right customer of appointments a credit note for the wrong one gave back.
		const found = findBuyer(billTo, cards, book.invoices);
		if (found.kind === "close") return ["Intendi uno di questi clienti? Non si chiama esattamente così:", fenced(found.candidates.join("\n")), "Chiedi a chi ti scrive a chi va intestata, e ripeti con il nome scritto come qui."].join("\n");
		if (found.kind === "conflict") return ["Errore: questo cliente non torna con i dati che ho:", fenced(found.known.name), "Chiedi a chi ti scrive."].join("\n");
		known = found.kind === "exact" ? found.known : { name: billTo };
	} else {
		const card = who.client.card === undefined ? undefined : cards.find((c) => c.id === who.client.card);
		const found = findBuyer(card?.name ?? who.client.name, cards, book.invoices);
		known = found.kind === "exact" ? { ...found.known, name: card?.name ?? who.client.name } : { name: who.client.name };
	}
	return {
		known,
		given,
		appointments: picked.map((a) => ({ id: a.id, day: a.day })),
		notes: [
			`Fatturo ${n1(picked.length, "un appuntamento fatto", "# appuntamenti fatti")}, ${period.label}: li segno come fatturati quando la fattura è emessa.`,
			...(billTo === undefined ? [] : ["La intesto al cliente giusto, nel riquadro della bozza: gli appuntamenti sono quelli tornati da fatturare con la nota di credito."]),
			...(hourly.length === 0 ? [] : ["Le voci a ore le conto dai minuti degli appuntamenti:", fenced(hourly.map((h) => `• ${h}`).join("\n"))]),
			RECEIPT_NOTE,
			...bookedNote,
			...(filled?.notes ?? []),
			...(prices.size > 0 ? ["Li metto nel listino, i prezzi che mi hai detto, così la prossima volta non te li chiedo? Se chi ti scrive dice di sì, aggiungili al listino: il listino chiede la sua conferma."] : []),
		],
	};
}

/** Under the store's lock: the draft's appointments are in no other draft and no invoice issued. */
export function appointmentsHeld(state: SalesState, refs: readonly AppointmentRef[] | undefined, replace: string | undefined): void {
	if (refs === undefined) return;
	const links = appointmentInvoicesOf(state.invoices, replace);
	const taken = refs.find((a) => links.draft.has(a.id) || links.issued.has(a.id));
	if (taken === undefined) return;
	const issued = links.issued.get(taken.id);
	throw new SalesInvoiceError(issued !== undefined ? `l'appuntamento del ${italianDate(taken.day)} è già nella fattura n. ${issued}` : `l'appuntamento del ${italianDate(taken.day)} intanto è finito in un'altra bozza: emetti quella, oppure rifai questa prendendo il suo posto`);
}

/** Why the draft's appointments cannot be billed now: no longer fatto, gone, billed by another invoice. Before a number is taken. */
export function appointmentProblem(env: SalesEnv, draft: SalesInvoice): string | undefined {
	if (draft.appointments === undefined) return undefined;
	if (env.appointments === undefined) return "Errore: qui non vedo gli appuntamenti, quindi non posso segnarli come fatturati.";
	const book = env.appointments.read();
	if (book.broken) return `Errore: ${APPOINTMENTS_BROKEN}.`;
	const links = appointmentInvoicesOf(env.book().invoices, draft.id);
	for (const ref of draft.appointments) {
		const a = book.appointments.find((x) => x.id === ref.id);
		if (a === undefined || a.status !== "done") return `Errore: l'appuntamento del ${italianDate(ref.day)} non risulta più fatto: va rifatta la bozza. Non ho usato nessun numero.`;
		if ((a.billed !== undefined && a.billed.invoice !== draft.id) || links.issued.has(a.id)) return `Errore: l'appuntamento del ${italianDate(ref.day)} è già fatturato${a.billed === undefined ? "" : ` con la fattura n. ${a.billed.number}`}: va rifatta la bozza. Non ho usato nessun numero.`;
	}
	return undefined;
}

/**
 * After the issue, once however many times this runs: the appointments of the invoice marked
 * billed; those of the invoice a credit note for the wrong customer corrects given back to bill.
 * An appointments file that does not read leaves the issue to complete.
 */
export async function markAppointments(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const link: AppointmentLink | undefined = env.appointments;
	if (inv.type === CREDIT_NOTE_TYPE) return releaseAppointments(env, inv, ctx);
	const refs = inv.appointments;
	if (refs === undefined || refs.length === 0) return { notes: [], done: true };
	if (link === undefined) return { notes: ["Attenzione: qui non vedo gli appuntamenti, quindi non li ho segnati come fatturati."], done: false };
	const result = await ctx.step("appointments", async () => {
		if (link.read().broken) return { broken: true, marked: 0, refused: 0 };
		try {
			const r = link.markBilled(
				refs.map((a) => a.id),
				{ invoice: inv.id, number: inv.number, day: inv.date },
			);
			return { broken: false, marked: r.marked.length, refused: r.refused.length };
		} catch {
			return { broken: true, marked: 0, refused: 0 };
		}
	});
	if (result.broken) return { notes: ["Attenzione: gli appuntamenti non si leggono, quindi non li ho segnati come fatturati: la fattura è emessa, ma l'emissione resta da completare. Quando il file è sistemato, si completa emettendo di nuovo questa fattura, con lo stesso numero."], done: false };
	const notes = [`Ho segnato come ${n1(result.marked, "fatturato l'appuntamento", "fatturati i # appuntamenti")} della fattura.`];
	if (result.refused > 0) notes.push(`Attenzione: ${n1(result.refused, "un appuntamento non l'ho segnato", "# appuntamenti non li ho segnati")}: intanto non risulta più fatto o è fatturato con un'altra fattura. Controlla con chi ti scrive.`);
	return { notes, done: true };
}

/** A credit note for the wrong customer of an invoice of appointments, issued: those appointments to bill again. */
async function releaseAppointments(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const of = inv.related;
	if (inv.release !== true || of === undefined) return { notes: [], done: true };
	const original = env.book().invoices.find((i) => i.id === of.id);
	if (original?.appointments === undefined) return { notes: [], done: true };
	const link = env.appointments;
	if (link === undefined) return { notes: ["Attenzione: qui non vedo gli appuntamenti, quindi non li ho rimessi da fatturare."], done: false };
	const n = await ctx.step("appointments-release", async () => {
		if (link.read().broken) return -1;
		try {
			return link.release(of.id);
		} catch {
			return -1;
		}
	});
	if (n < 0) return { notes: ["Attenzione: gli appuntamenti non si leggono, quindi non li ho rimessi da fatturare: la nota di credito è emessa, ma l'emissione resta da completare. Quando il file è sistemato, si completa emettendola di nuovo, con lo stesso numero."], done: false };
	return { notes: [`Gli appuntamenti della fattura n. ${of.number} tornano da fatturare. Ora si rifà la fattura degli stessi appuntamenti intestata al cliente giusto: dimmi a chi va fatta e la preparo.`], done: true };
}
