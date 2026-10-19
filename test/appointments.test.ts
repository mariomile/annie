import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { type Appointment, appointmentCallReads, validAppointment } from "../src/core/appointments.ts";
import { isIssued, type SalesInvoice, validInvoice } from "../src/core/sales-invoices.ts";
import { agent, checkIn, cleanup, EMDASH, fresh, inside, outside, type S, SETTINGS, setup } from "./appointment-fixtures.ts";

afterEach(cleanup);

const rossi = { op: "book", client: "Maria Rossi", services: ["taglio", "piega"], date: "giovedì", time: "15" };
const all = (s: S) => s.store.read().appointments;
const one = (s: S, id = "AP-0001") => all(s).find((a) => a.id === id) as Appointment;

/** An appointment fatto: booked on the clock's day, then the clock moved past it and marked. */
async function doneOn(s: S, client: string, services: string[], date: string, time: string): Promise<void> {
	const saved = s.clock.now;
	s.clock.now = new Date(`${date}T05:00:00Z`);
	const booked = await s.run({ op: "book", client, services, date, time });
	if (!booked.includes("Fatto")) throw new Error(booked);
	s.clock.now = new Date(`${date}T17:30:00Z`);
	const id = all(s).at(-1)?.id as string;
	const done = await s.run({ op: "done", appointment: id });
	if (!done.includes("Fatto")) throw new Error(done);
	s.clock.now = saved;
}

describe("booking", () => {
	it("«fissa Maria Rossi giovedì alle 15 per taglio e piega»: dictated and free, booked at once for an hour; the name and the reference only in the fence; calendar offered when it is there; audit op and count", async () => {
		const s = setup({ calendar: true });
		const text = await s.run(rossi);
		expect(outside(text)).toContain("Fatto: ho fissato l'appuntamento giovedì 22 ottobre dalle 15 alle 16.");
		expect(outside(text)).toContain("Vuoi mandare al cliente un messaggio di conferma?");
		expect(outside(text)).not.toContain("Rossi");
		expect(outside(text)).not.toContain("AP-0001");
		expect(inside(text)).toContain("15:00-16:00 Maria Rossi: Taglio, Piega (rif. AP-0001)");
		expect(inside(text)).toContain("inizio 2026-10-22T15:00, fine 2026-10-22T16:00 (Europe/Rome)");
		expect(outside(text)).toContain("google_calendar_create");
		const a = one(s);
		expect(a).toMatchObject({ status: "booked", client: { name: "Maria Rossi", card: "CL-0001" }, day: "2026-10-22", start: "15:00", minutes: 60 });
		expect(a.services).toEqual([{ name: "Taglio", item: "LS-0001", minutes: 30 }, { name: "Piega", item: "LS-0002", minutes: 30 }]);
		expect(validAppointment(a)).toBe(true);
		expect(s.events).toEqual([{ type: "appointments.used", op: "book", count: 1 }]);
		expect(text).not.toMatch(EMDASH);
		// The same call again books nothing twice.
		const c = fresh("same");
		await s.run({ ...rossi, date: "venerdì" }, c);
		await s.run({ ...rossi, date: "venerdì" }, c);
		expect(all(s)).toHaveLength(2);
	});

	it("«la signora Rossi»: a client only close to a card, or a service whose duration is not known, is proposed with a check; the yes with the check books", async () => {
		const s = setup();
		const text = await s.run({ ...rossi, client: "la signora Rossi", services: ["taglio", "colpi di sole"] });
		expect(outside(text)).toContain("Fisserei questo appuntamento, giovedì 22 ottobre dalle 15 alle 16");
		expect(outside(text)).toContain("il cliente l'ho preso dalla scheda con il nome più vicino");
		expect(outside(text)).toContain("non so quanto dura un servizio: ho contato 30 minuti");
		expect(inside(text)).toContain("Maria Rossi: Taglio, colpi di sole");
		expect(all(s)).toEqual([]);
		expect(await s.run({ ...rossi, client: "la signora Rossi", services: ["taglio", "colpi di sole"], confirm: true, check: "0123456789abcdef" })).toContain("la proposta è cambiata");
		expect(await s.run({ ...rossi, client: "la signora Rossi", services: ["taglio", "colpi di sole"], confirm: true, check: checkIn(text) }, fresh(undefined, "notice"))).toContain("Non fisso l'appuntamento");
		const ok = await s.run({ ...rossi, client: "la signora Rossi", services: ["taglio", "colpi di sole"], confirm: true, check: checkIn(text) });
		expect(outside(ok)).toContain("Fatto: ho fissato l'appuntamento giovedì 22 ottobre dalle 15 alle 16.");
		expect(one(s).client).toEqual({ name: "Maria Rossi", card: "CL-0001", greeting: "signora Rossi" });
	});

	it("a new client is booked as said, and said; «alle 3» is 15:00 and said", async () => {
		const s = setup();
		const text = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "3" });
		expect(outside(text)).toContain("dalle 15 alle 15:30");
		expect(outside(text)).toContain("Il cliente non è tra le schede né tra gli appuntamenti: l'ho scritto come detto.");
		expect(outside(text)).toContain("Ho messo alle 15 (le 3 del pomeriggio).");
		expect(one(s).client).toEqual({ name: "Luca Neri" });
	});

	it("a clash books nothing and proposes the nearest free times; closed days, holidays, outside hours and the past too", async () => {
		const s = setup();
		await s.run(rossi);
		const clash = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "15:30" });
		expect(outside(clash)).toContain("A quell'ora c'è già un appuntamento, dalle 15 alle 16 (chi è nel riquadro): non ho fissato niente.");
		expect(inside(clash)).toContain("Maria Rossi");
		expect(outside(clash)).toContain("Orari liberi vicini: giovedì 22 alle 14:30, alle 16 o alle 16:15. Quale preferisci?");
		expect(outside(clash)).toContain("Se vuoi sovrapporlo, dimmi «fissalo lo stesso».");
		expect(all(s)).toHaveLength(1);
		const sunday = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "domenica", time: "10" });
		expect(outside(sunday)).toContain("La domenica sei chiuso: non ho fissato niente.");
		expect(outside(sunday)).toContain("lunedì 26 alle 9, alle 9:15 o alle 9:30");
		const holiday = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "08/12/2026", time: "10" });
		expect(outside(holiday)).toContain("8 dicembre 2026 è festivo (Immacolata Concezione) e sei chiuso");
		const late = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "18:45" });
		expect(outside(late)).toContain("Alle 18:45 c'è posto solo fino alle 19: l'appuntamento dura mezz'ora e finirebbe alle 19:15, dopo la chiusura. Non ho fissato niente.");
		expect(outside(late)).toContain("alle 18:30");
		const night = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "20:30" });
		expect(outside(night)).toContain("A quell'ora sei chiuso (giovedì 22 sei aperto 9-13 e 14-19): non ho fissato niente.");
		const past = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "oggi", time: "9" });
		expect(past).toBe("Quell'ora è già passata: dimmi un altro giorno o un'altra ora.");
		expect(all(s)).toHaveLength(1);
	});

	it("resources: two at the same time each take one; a third is refused; the one said is kept", async () => {
		const s = setup({ settings: { ...SETTINGS, resources: ["Marco", "Giulia"] } });
		await s.run(rossi);
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "15" });
		expect(all(s).map((a) => a.resource)).toEqual(["Marco", "Giulia"]);
		const third = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "15:15" });
		expect(outside(third)).toContain("A quell'ora c'è già un appuntamento per ogni risorsa che può farlo");
		expect(inside(third)).toContain("(Marco)");
		await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "venerdì", time: "10", resource: "giulia" });
		expect(all(s).at(-1)?.resource).toBe("Giulia");
		expect(await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "venerdì", time: "11", resource: "Paolo" })).toContain("Questa risorsa non la conosco");
	});
	it("the summer-time changes: «now» is read on the business's own clock on 25 October and 29 March, the slots the same as any day", async () => {
		const sunday = { ...SETTINGS, week: { ...SETTINGS.week, "0": [{ from: "09:00", to: "13:00" }] } };
		for (const [instant, day] of [["2026-10-25T08:30:00Z", "25 ottobre"], ["2026-03-29T07:30:00Z", "29 marzo"]] as const) {
			const s = setup({ settings: sunday });
			// 09:30 in Rome either way: CET after the October change, CEST after the March one.
			s.clock.now = new Date(instant);
			expect(await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "oggi", time: "9" })).toContain("Quell'ora è già passata");
			const ok = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "oggi", time: "10" });
			expect(outside(ok)).toContain(`Fatto: ho fissato l'appuntamento oggi, domenica ${day} dalle 10 alle 10:30.`);
			const free = await s.run({ op: "free_slots", minutes: 30 });
			expect(free).toContain("Oggi sei libero dalle 9:30 alle 10 e dalle 10:30 alle 13 (c'è posto per mezz'ora fino alle 12:30).");
		}
	});
});

describe("move, cancel, no-show, done", () => {
	it("«sposta Rossi a venerdì stessa ora»: moved, the time kept, where it was remembered; a notice cannot; a clash moves nothing", async () => {
		const s = setup();
		await s.run(rossi);
		expect(await s.run({ op: "move", client: "Maria Rossi", date: "venerdì" }, fresh(undefined, "notice"))).toContain("Non sposto l'appuntamento");
		const text = await s.run({ op: "move", client: "Maria Rossi", date: "venerdì" });
		expect(outside(text)).toContain("Fatto: ho spostato l'appuntamento da giovedì 22 ottobre alle 15 a venerdì 23 ottobre alle 15 (fino alle 16).");
		expect(one(s)).toMatchObject({ day: "2026-10-23", start: "15:00", moved: { from: "2026-10-22 15:00" } });
		expect(validAppointment(one(s))).toBe(true);
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "venerdì", time: "17" });
		const clash = await s.run({ op: "move", client: "Maria Rossi", time: "16:30" });
		expect(outside(clash)).toContain("non l'ho spostato");
		expect(one(s).start).toBe("15:00");
	});

	it("«Rossi ha disdetto»: kept as disdetto, the time free again; «non si è presentata» only once begun; «fatti tutti quelli di oggi»", async () => {
		const s = setup();
		await s.run(rossi);
		const cancel = await s.run({ op: "cancel", client: "Maria Rossi" });
		expect(outside(cancel)).toContain("Fatto: ho segnato come disdetto l'appuntamento di giovedì 22 ottobre alle 15. Resta nello storico del cliente");
		expect(one(s).status).toBe("cancelled");
		expect(one(s).closed).toBeDefined();
		const again = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "15" });
		expect(again).toContain("Fatto");
		expect(await s.run({ op: "no_show", client: "Bianchi" })).toContain("già cominciato");
		s.clock.now = new Date("2026-10-22T14:00:00Z");
		const noShow = await s.run({ op: "no_show", client: "Bianchi" });
		expect(outside(noShow)).toContain("Fatto: ho segnato che il cliente non si è presentato all'appuntamento di oggi, giovedì 22 ottobre alle 15. Resta nello storico. È la prima volta che non si presenta.");
		await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "oggi", time: "16:30" });
		await s.run({ op: "book", client: "Anna Verdi", services: ["piega"], date: "oggi", time: "17" });
		expect(await s.run({ op: "done", all: true }, fresh(undefined, "scheduled"))).toContain("Non segno l'appuntamento come fatto");
		s.clock.now = new Date("2026-10-22T16:00:00Z");
		const done = await s.run({ op: "done", all: true });
		expect(outside(done)).toContain("Fatto: ho segnato come fatti 2 appuntamenti oggi, giovedì 22 ottobre.");
		expect(all(s).map((a) => a.status)).toEqual(["cancelled", "no_show", "done", "done"]);
		expect(s.events.filter((e) => e.op === "done")).toEqual([{ type: "appointments.used", op: "done", count: 2 }]);
	});
});

describe("reading the agenda", () => {
	it("«quando ho un'ora libera giovedì pomeriggio?»: the start times around the appointments", async () => {
		const s = setup();
		await s.run(rossi);
		const text = await s.run({ op: "free_slots", date: "giovedì", window: "pomeriggio", minutes: "un'ora" });
		expect(text).toBe("Giovedì 22 pomeriggio sei libero dalle 14 alle 15 e dalle 16 alle 19 (c'è posto per un'ora fino alle 18).");
		const sunday = await s.run({ op: "free_slots", date: "domenica", minutes: 30 });
		expect(sunday).toContain("La domenica sei chiuso.");
		expect(await s.run({ op: "free_slots", date: "giovedì" }, fresh())).toContain("ho cercato 30 minuti");
		const none = setup({ settings: null });
		expect(await none.run({ op: "free_slots", date: "giovedì" })).toContain("Non so ancora gli orari di apertura");
	});

	it("«cosa ho domani?», the week: counts and hours outside, who in the fence, the free gaps", async () => {
		const s = setup();
		await s.run({ ...rossi, date: "domani", time: "10" });
		await s.run({ op: "book", client: "Bianchi", services: ["colore"], date: "domani", time: "15" });
		const text = await s.run({ op: "agenda", date: "domani" });
		expect(outside(text)).toContain("• Domani, martedì 20 ottobre: 2 appuntamenti, dalle 10 alle 16:30");
		expect(outside(text)).toContain("Libero: 9-10, 11-13, 14-15, 16:30-19.");
		expect(outside(text)).not.toContain("Rossi");
		expect(inside(text)).toContain("10:00-11:00 Maria Rossi: Taglio, Piega (rif. AP-0001)");
		expect(inside(text)).toContain("15:00-16:30 Officina Bianchi Prova Srl: Colore (rif. AP-0002)");
		const week = await s.run({ op: "agenda", week: true });
		expect(outside(week)).toContain("• Oggi, lunedì 19 ottobre: nessun appuntamento");
		expect(outside(week)).toContain("• Domenica 25 ottobre: nessun appuntamento (la domenica sei chiuso)");
	});

	it("a client's history: visits, no-shows, what they usually do", async () => {
		const s = setup();
		await doneOn(s, "Maria Rossi", ["taglio", "piega"], "2026-10-02", "10");
		await doneOn(s, "Maria Rossi", ["taglio", "piega"], "2026-10-09", "10");
		await doneOn(s, "Maria Rossi", ["colore"], "2026-10-16", "10");
		await s.run(rossi);
		const text = await s.run({ op: "history", client: "Maria Rossi" });
		expect(outside(text)).toContain("3 visite fatte, 0 «non presentato», 0 disdette; il prossimo è giovedì 22 ottobre alle 15.");
		expect(inside(text)).toContain("Di solito fa: Taglio, Piega (2 volte su 3)");
		expect(inside(text)).toContain("16/10/2026 10:00-11:30 Maria Rossi: Colore [fatto]");
	});
});

describe("reminders", () => {
	it("«fammi il messaggio di promemoria per domani»: one per client, the business named, contacts only from the cards, all in the fence, never sent", async () => {
		const s = setup();
		const asked = await s.run({ ...rossi, client: "la signora Rossi", date: "domani", time: "10" });
		await s.run({ ...rossi, client: "la signora Rossi", date: "domani", time: "10", confirm: true, check: checkIn(asked) });
		await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "domani", time: "11" });
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "domani", time: "12" });
		const text = await s.run({ op: "reminders" });
		expect(outside(text)).toContain("Ho preparato 3 promemoria per domani, nel riquadro. Non mando niente da sola.");
		expect(outside(text)).toContain("Per un cliente con il cellulare c'è il link: lo tocchi e WhatsApp apre il messaggio già scritto, poi lo mandi tu.");
		expect(outside(text)).toContain("Un numero nella scheda non sembra un cellulare: niente link");
		expect(outside(text)).toContain("Un cliente non ha né il numero né l'email nella scheda: vuoi che glielo aggiunga? Intanto il testo si copia e si manda da WhatsApp, SMS o mail.");
		const message = "Buongiorno signora Rossi, le ricordiamo l'appuntamento da Salone Prova martedì 20 ottobre alle 10, per taglio e piega. Se non riesce a venire, ci risponda a questo messaggio. Grazie, a presto!";
		expect(inside(text)).toContain(message);
		expect(inside(text)).toContain(`https://wa.me/393330000001?text=${encodeURIComponent(message)}`);
		expect(inside(text)).toContain("maria.rossi@example.invalid");
		expect(inside(text)).not.toContain("wa.me/39020000002");
		expect(inside(text)).toContain("Buongiorno Luca Neri,");
		expect(inside(text)).not.toContain("domani");
		expect(outside(text)).toContain("google_mail_send");
		expect(outside(text)).not.toContain("example.invalid");
		expect(outside(text)).not.toContain("wa.me");
		expect(outside(text)).not.toContain("Rossi");
		expect(text).not.toMatch(EMDASH);
		expect(s.store.read().appointments.every((a) => a.status === "booked")).toBe(true);
	});
});

describe("the brief, other agents, the CSV, the settings", () => {
	it("the brief's line once a day: today's count, the first appointment, the gaps; yesterday's still fissato", async () => {
		const s = setup();
		await s.run({ ...rossi, date: "oggi", time: "11" });
		s.clock.now = new Date("2026-10-19T05:00:00Z");
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "domani", time: "9" });
		await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "domani", time: "15" });
		s.clock.now = new Date("2026-10-20T05:00:00Z");
		const text = await s.run({ op: "agenda", compact: true });
		expect(outside(text)).toContain("Appuntamenti di oggi: 2, il primo alle 9 (chi e per cosa nel riquadro).");
		expect(outside(text)).toContain("Libero: 9:30-13, 14-15, 15:30-19.");
		expect(outside(text)).toContain("Ieri un appuntamento è ancora da segnare: dimmi «fatto», oppure se non è venuto.");
		expect(inside(text)).toContain("Officina Bianchi Prova Srl");
		expect(await s.run({ op: "agenda", compact: true })).toBe("Appuntamenti: niente da segnalare.");
		expect(s.events.filter((e) => e.op === "brief")).toEqual([{ type: "appointments.used", op: "brief", count: 2 }]);
		expect(BRIEF_INSTRUCTION).toContain("appointments (agenda)");
		expect(appointmentCallReads({ op: "agenda", compact: true })).toBe(true);
		expect(appointmentCallReads({ op: "book" })).toBe(false);
		expect(appointmentCallReads({ op: "export" })).toBe(false);
		const [gated] = readOnlyInBriefs([s.tool], async () => true);
		expect(await gated?.execute(rossi, fresh())).toContain("nella chat del brief del mattino Annie legge soltanto");
	});

	it("another agente gets counts only; it books nothing", async () => {
		const s = setup();
		await s.run({ ...rossi, date: "domani", time: "10" });
		expect(await s.run({ op: "agenda" }, agent())).toBe("Appuntamenti: oggi 0, domani 1. A un altro agente do solo i conteggi: clienti e servizi no.");
		expect(await s.run(rossi, agent())).toContain("a un altro agente do solo quanti sono");
		expect(all(s)).toHaveLength(1);
	});

	it("the CSV is formula-safe, in appuntamenti/", async () => {
		const s = setup();
		await s.run({ ...rossi, notes: "=HYPERLINK(\"x\")" });
		const text = await s.run({ op: "export" });
		const path = inside(text).trim();
		expect(path).toMatch(/^appuntamenti\/appuntamenti-al-2026-10-19\.csv$/);
		const csv = readFileSync(join(s.root, path), "utf8");
		expect(csv).toContain("'=HYPERLINK");
		expect(csv).toContain("Maria Rossi");
	});

	it("settings: hours with breaks, a closure that warns of the appointments in it, durations linked to the listino; shown when nothing is said", async () => {
		const s = setup({ settings: null });
		const none = await s.run({ ...rossi, minutes: 60 });
		expect(outside(none)).toContain("Non conosco ancora gli orari di apertura, quindi non ho controllato che tu sia aperto: dimmeli in una riga, come «mar-sab 9-13 e 14-19, chiuso domenica e lunedì».");
		// Said once a day.
		expect(await s.run({ ...rossi, date: "venerdì", minutes: 60 })).not.toContain("orari di apertura");
		const text = await s.run({ op: "settings", business: "Salone Prova", hours: [{ days: "mar-sab", open: "9-13, 14:30-19" }, { days: "lunedì", open: "chiuso" }], services: [{ name: "taglio", minutes: 45 }], closure_from: "22/10/2026", closure_to: "24/10/2026", closure_note: "ferie" });
		expect(outside(text)).toContain("Fatto, ho salvato.");
		expect(outside(text)).toContain("Orari: mar-sab 9-13 e 14:30-19; chiuso domenica e lunedì.");
		expect(outside(text)).toContain("Chiusure: dal 22/10/2026 al 24/10/2026.");
		expect(outside(text)).toContain("Attenzione: 2 appuntamenti fissati cadono quando ora sei chiuso (nel riquadro): vanno spostati o disdetti. Vuoi che prepari un messaggio per avvisarli e proporre un'altra data?");
		expect(inside(text)).toContain("• Taglio: 45 minuti");
		expect(s.store.read().settings?.services).toEqual([{ name: "Taglio", item: "LS-0001", minutes: 45 }]);
		expect(await s.run({ op: "settings", slot: 30 }, fresh(undefined, "notice"))).toContain("Non cambio gli orari");
		expect(outside(await s.run({ op: "settings" }))).toContain("Un appuntamento si fissa ogni 15 minuti.");
		expect(await s.run({ op: "settings", hours: [{ days: "mar", open: "13-9" }] })).toContain("non capisco questi orari");
	});
});

describe("billing the appointments done", () => {
	it("«fattura gli appuntamenti fatti da Bianchi questo mese»: one line per service from the listino, a service with no voce asked; held by the draft, billed only at issue, never twice", async () => {
		const s = setup();
		await doneOn(s, "Bianchi", ["taglio", "piega"], "2026-10-02", "10");
		await doneOn(s, "Bianchi", ["taglio"], "2026-10-09", "10");
		await doneOn(s, "Bianchi", ["colore"], "2026-10-16", "10");
		await doneOn(s, "Maria Rossi", ["taglio"], "2026-10-16", "15");
		// A past one never marked: said, not billed.
		s.clock.now = new Date("2026-10-13T05:00:00Z");
		await s.run({ op: "book", client: "Bianchi", services: ["piega"], date: "oggi", time: "11" });
		s.clock.now = new Date("2026-10-19T08:00:00Z");
		const asked = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, period: "questo mese", recipient_code: "ZZZ0001" });
		expect(outside(asked)).toContain("Mi manca un prezzo (senza IVA): il servizio è nel riquadro e non è nel listino. A quanto lo fatturo?");
		expect(inside(asked)).toContain("• Colore: una volta");
		expect(s.sales.read().invoices).toEqual([]);
		const text = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, period: "questo mese", recipient_code: "ZZZ0001", vat: 22, prices: [{ description: "colore", price: "60" }] });
		expect(outside(text)).toContain("Fatturo 3 appuntamenti fatti");
		expect(outside(text)).toContain("Un appuntamento passato è ancora «fissato»: non lo fatturo.");
		const draft = s.sales.read().invoices[0] as SalesInvoice;
		expect(draft.appointments?.map((a) => a.id)).toEqual(["AP-0001", "AP-0002", "AP-0003"]);
		expect(draft.lines.map((l) => [l.description, l.quantity, l.price, l.item])).toEqual([
			["Taglio del 02/10 e 09/10", "2", "25", "LS-0001"],
			["Piega del 02/10", "1", "15", "LS-0002"],
			["Colore del 16/10", "1", "60", undefined],
		]);
		expect(draft.buyer.name).toBe("Officina Bianchi Prova Srl");
		expect(validInvoice(draft)).toBe(true);
		expect(all(s).every((a) => a.billed === undefined)).toBe(true);
		const twice = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, period: "questo mese", recipient_code: "ZZZ0001", vat: 22, prices: [{ description: "colore", price: "60" }] });
		expect(twice).toContain("sono già in una bozza di fattura (BZ-0001: non serve dirlo a chi ti scrive)");
		const issued = await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		expect(issued).toContain("Ho segnato come fatturati i 3 appuntamenti della fattura.");
		expect(one(s, "AP-0001").billed).toEqual({ invoice: "BZ-0001", number: "1", day: "2026-10-19" });
		expect(one(s, "AP-0004").billed).toBeUndefined();
		const inv = s.sales.read().invoices[0] as SalesInvoice;
		expect(isIssued(inv) && inv.finished).toBe(true);
		// Issued again: nothing marked twice; a new draft finds nothing to bill.
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		expect(one(s, "AP-0001").billed?.invoice).toBe("BZ-0001");
		const none = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, period: "questo mese", recipient_code: "ZZZ0001" });
		expect(none).toContain("Nessun appuntamento fatto da fatturare per questo cliente");
		const history = await s.run({ op: "history", client: "Bianchi" });
		expect(inside(history)).toContain("[fatto, fatturato con la n. 1]");
	});

	it("an appointment no longer fatto stops the issue before a number; a credit note for the wrong customer gives them back to bill", async () => {
		const s = setup();
		await doneOn(s, "Bianchi", ["taglio"], "2026-10-02", "10");
		await s.sell({ op: "draft", customer: "Bianchi", appointments: true, recipient_code: "ZZZ0001" });
		s.store.update("tamper", (st) => ({ ...st, appointments: st.appointments.map((a) => ({ ...a, status: "cancelled" as const })) }));
		expect(await s.sell({ op: "issue", draft: "BZ-0001", confirm: true })).toContain("non risulta più fatto: va rifatta la bozza. Non ho usato nessun numero.");
		s.store.update("untamper", (st) => ({ ...st, appointments: st.appointments.map((a) => ({ ...a, status: "done" as const })) }));
		expect(await s.sell({ op: "issue", draft: "BZ-0001", confirm: true })).toContain("Ho segnato come fatturato l'appuntamento della fattura.");
		const credit = await s.sell({ op: "credit_note", invoice: "1", wrong_customer: true });
		expect(credit).toContain("gli appuntamenti della fattura n. 1 tornano da fatturare");
		const nc = s.sales.read().invoices.find((i) => i.related !== undefined) as SalesInvoice;
		expect(nc.release).toBe(true);
		const done = await s.sell({ op: "issue", draft: nc.id, confirm: true });
		expect(done).toContain("Gli appuntamenti della fattura n. 1 tornano da fatturare");
		expect(one(s).billed).toBeUndefined();
	});
});

describe("routing", () => {
	it("the instructions and the description send appointments here, the fiscal agenda and Annie's own reminders elsewhere", () => {
		const s = setup();
		expect(DEFAULT_INSTRUCTIONS).toContain("appointments");
		expect(DEFAULT_INSTRUCTIONS).toMatch(/fissa la signora Rossi/);
		expect(s.tool.description).toContain("fiscal_agenda");
		expect(s.tool.description).toContain("schedule_create");
		expect(s.tool.description).toContain("«fattura gli appuntamenti fatti da Bianchi questo mese» is sales_invoices");
		expect(s.tool.description).not.toMatch(EMDASH);
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(EMDASH);
	});
});
