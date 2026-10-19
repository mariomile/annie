import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { staffCallReads, validAbsence } from "../src/core/staff.ts";
import { agent, cleanup, EMDASH, fresh, inside, outside, type S, setup } from "./staff-fixtures.ts";

afterEach(cleanup);

const all = (s: S) => s.store.read().absences;
const giulia = { op: "absence", person: "Giulia", kind: "ferie", from: "3 agosto", to: "14 agosto" };

describe("absences", () => {
	it("«Giulia è in ferie dal 3 al 14 agosto»: saved, the working days counted (days off and holidays not), the balance an estimate; names only in the fence; audit op and count", async () => {
		const s = setup();
		const text = await s.run(giulia);
		expect(outside(text)).toContain("Fatto: ho segnato ferie dal 03/08/2027 al 14/08/2027 per la persona nel riquadro.");
		expect(outside(text)).toContain("Conto 9 giorni di ferie: i festivi e i suoi giorni di riposo non contano.");
		expect(outside(text)).not.toContain("Giulia");
		expect(outside(text)).not.toContain("AS-0001");
		expect(inside(text)).toContain("Giulia Verdi: ferie dal 03/08/2027 al 14/08/2027");
		expect(all(s)).toHaveLength(1);
		expect(validAbsence(all(s)[0])).toBe(true);
		expect(s.events).toEqual([{ type: "staff.used", op: "absence", count: 1 }]);
		expect(text).not.toMatch(EMDASH);
		// The same call again saves nothing twice.
		const c = fresh("same");
		await s.run({ ...giulia, from: "1 settembre", to: "2 settembre" }, c);
		await s.run({ ...giulia, from: "1 settembre", to: "2 settembre" }, c);
		expect(all(s)).toHaveLength(2);
	});

	it("an overlap is refused and said; only the person's word writes; another agente gets counts and no kinds", async () => {
		const s = setup();
		await s.run(giulia);
		const clash = await s.run({ ...giulia, from: "10 agosto", to: "20 agosto" });
		expect(outside(clash)).toContain("Non l'ho segnata: si sovrappone a un'assenza già segnata (ferie dal 03/08/2027 al 14/08/2027).");
		expect(await s.run({ ...giulia, from: "1 settembre" }, fresh(undefined, "notice"))).toContain("Non segno l'assenza");
		expect(await s.run({ ...giulia, from: "1 settembre" }, fresh(undefined, "scheduled"))).toContain("Non segno l'assenza");
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "domani" });
		const counted = await s.run({ op: "who" }, agent());
		expect(counted).toBe("Personale: oggi 0 assenti, domani un assente. A un altro agente do solo i conteggi: chi e perché no.");
		expect(await s.run({ ...giulia, from: "1 settembre" }, agent())).not.toContain("Fatto");
		expect(await s.run({ op: "absences" }, agent())).not.toMatch(/malattia|ferie|Marco|Giulia/);
		expect(all(s)).toHaveLength(2);
	});

	it("«Marco domani ha un permesso dalle 15»: the rest of his shift, 4 hours; the half day; «altro» with its reason in the fence", async () => {
		const s = setup();
		const text = await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		expect(outside(text)).toContain("Fatto: ho segnato permesso il 20/10/2026 dalle 15 a fine turno");
		expect(outside(text)).toContain("i permessi che restano sono circa 68 ore");
		const half = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "giovedì", half: "pomeriggio" });
		expect(outside(half)).toContain("mezza giornata (pomeriggio)");
		expect(outside(half)).toContain("Conto 0,5 giorni di ferie");
		const lutto = await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "2 novembre", to: "4 novembre", reason: "lutto in famiglia" });
		expect(inside(lutto)).toContain("motivo: lutto in famiglia");
		expect(outside(lutto)).not.toContain("lutto");
	});

	it("«Marco è in malattia da oggi»: open-ended; a diagnosis is never saved; only the protocol", async () => {
		const s = setup();
		const text = await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "oggi", reason: "influenza con febbre", protocol: "influenza" });
		expect(outside(text)).toContain("La diagnosi non la salvo: basta il numero di protocollo del certificato.");
		expect(outside(text)).toContain("malattia dal 19/10/2026, fine non detta");
		const saved = all(s)[0];
		expect(saved).not.toHaveProperty("reason");
		expect(saved).not.toHaveProperty("protocol");
		expect(JSON.stringify(s.store.read())).not.toContain("influenza");
		const change = await s.run({ op: "change", person: "Marco", to: "venerdì", protocol: "123456789" });
		expect(outside(change)).toContain("malattia dal 19/10/2026 al 23/10/2026");
		expect(inside(change)).toContain("protocollo 123456789");
		expect(outside(change)).not.toContain("123456789");
		expect(all(s)[0]?.protocol).toBe("123456789");
	});

	it("change and cancel: kept in the history, the time free again", async () => {
		const s = setup();
		await s.run(giulia);
		const moved = await s.run({ op: "change", person: "Giulia", from: "10 agosto", to: "21 agosto" });
		expect(outside(moved)).toContain("Fatto: ora è ferie dal 10/08/2027 al 21/08/2027");
		expect(await s.run({ op: "cancel", person: "Giulia", on: "12 agosto" }, fresh(undefined, "notice"))).toContain("Non annullo l'assenza");
		const cancel = await s.run({ op: "cancel", person: "Giulia", on: "12 agosto" });
		expect(outside(cancel)).toContain("Fatto: ho annullato ferie dal 10/08/2027 al 21/08/2027");
		expect(all(s)[0]?.cancelled).toBeDefined();
		expect(await s.run(giulia)).toContain("Fatto");
	});
});

describe("shifts and who works", () => {
	it("«chi lavora sabato?» and «fammi i turni della prossima settimana»: from the usual week less absences and closures, with the gaps", async () => {
		const s = setup();
		const sat = await s.run({ op: "who", date: "sabato" });
		expect(outside(sat)).toContain("Sabato 24 ottobre lavora una persona. Chi e quando è nel riquadro.");
		expect(inside(sat)).toContain("Marco Neri: 9-13 e 15-19");
		await s.run({ op: "absence", person: "Marco", kind: "ferie", from: "31/10/2026" });
		const week = await s.run({ op: "shifts" });
		expect(outside(week)).toContain("I turni dal 26/10/2026 al 01/11/2026");
		expect(outside(week)).toContain("• Lunedì 26 ottobre: una persona al lavoro; scoperto 18-19");
		expect(outside(week)).toContain("• Sabato 31 ottobre: nessuna persona al lavoro".replace("nessuna persona al lavoro", "0 persone al lavoro, un'assenza; scoperto 9-13"));
		expect(outside(week)).toContain("• Domenica 1 novembre: chiuso");
		expect(inside(week)).toContain("Marco Neri: assente (ferie)");
		expect(await s.run({ op: "who", date: "08/12/2026" })).toContain("sei chiuso (Immacolata Concezione)");
	});

	it("a shift said apart, and the extra hours, only on the person's word", async () => {
		const s = setup();
		expect(await s.run({ op: "shift", person: "Giulia", date: "sabato", hours: "9-13" }, fresh(undefined, "notice"))).toContain("Non cambio i turni");
		const shift = await s.run({ op: "shift", person: "Giulia", date: "sabato", hours: "9-13" });
		expect(outside(shift)).toContain("sabato 24 ottobre la persona nel riquadro lavora 9-13");
		expect(inside(await s.run({ op: "who", date: "sabato" }))).toContain("Giulia Verdi: 9-13");
		const extra = await s.run({ op: "extra", person: "Marco", date: "ieri", hours: "2 ore" });
		expect(outside(extra)).toContain("Fatto: ho segnato 2 ore in più ieri");
		expect(await s.run({ op: "extra", person: "Marco", date: "domani", hours: 1 })).toContain("quando sono fatte");
	});
});

describe("balances and the month", () => {
	it("«quante ferie le restano a Giulia?»: an estimate, the year's at once by default; the balance said wins", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026", to: "30/10/2026" });
		const text = await s.run({ op: "balance", person: "Giulia" });
		expect(outside(text)).toContain("saldo annuo, senza maturazione mensile");
		expect(outside(text)).toContain("È una stima: la consulente del lavoro ha il dato ufficiale.");
		expect(inside(text)).toContain("ferie: ne restano circa 21 giorni (26 giorni l'anno; 0 giorni prese, 5 giorni in programma)");
		await s.run({ op: "person", person: "Giulia", ferie_left: "12,5", as_of: "oggi" });
		expect(inside(await s.run({ op: "balance", person: "Giulia" }))).toContain("ferie: ne restano circa 7,5 giorni (dal saldo che mi hai detto");
		await s.run({ op: "settings", monthly: true });
		expect(outside(await s.run({ op: "balance" }))).toContain("maturazione mese per mese");
	});

	it("«mandami il riepilogo ore di ottobre per la consulente del lavoro»: per person; the files in personale/ (CSV formula-safe, PDF), never sent", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "27/10/2026", to: "28/10/2026" });
		await s.run({ op: "extra", person: "Marco", date: "ieri", hours: "1,5" });
		await s.run({ op: "person", person: "Marco", role: "=HYPERLINK(\"x\")" });
		const text = await s.run({ op: "summary", month: "ottobre" });
		expect(inside(text)).toContain("Giulia Verdi: 20 giorni e 160 ore lavorate; malattia 2 giorni");
		expect(inside(text)).toContain("Marco Neri: 23 giorni e 180 ore lavorate; permessi 4 ore; 1,5 ore in più");
		expect(outside(text)).toContain("google_mail_send");
		expect(await s.run({ op: "export", what: "summary", month: "ottobre" }, fresh(undefined, "notice"))).toContain("Non preparo il file");
		const out = await s.run({ op: "export", what: "summary", month: "ottobre" });
		expect(inside(out)).toContain("personale/riepilogo-2026-10.csv");
		expect(inside(out)).toContain("personale/riepilogo-2026-10.pdf");
		expect(outside(out)).toContain("Non l'ho mandato a nessuno");
		const csv = readFileSync(join(s.root, "personale/riepilogo-2026-10.csv"), "utf8");
		expect(csv).toContain("Marco Neri;23;180;0;4;0;0;1,5");
		expect(s.made.at(-1)?.text).toContain("# Riepilogo del personale, ottobre 2026");
		const shifts = await s.run({ op: "export", what: "shifts", format: "csv" });
		expect(inside(shifts)).toContain("personale/turni-dal-2026-10-26.csv");
	});
});

describe("the appointments link", () => {
	it("an absence blocks the person's resource; never forced; the appointments it falls on are listed with the offer to move them", async () => {
		const s = setup();
		await s.book({ op: "book", client: "Luca Bianchi", services: ["taglio"], date: "domani", time: "16", resource: "Marco" });
		const text = await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		expect(outside(text)).toContain("Attenzione: in quei giorni c'è un appuntamento con questa persona (nel riquadro). Vuoi che lo sposti?");
		expect(inside(text)).toContain("20/10/2026 16:00 Luca Bianchi");
		const refused = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "17", resource: "Marco" });
		expect(outside(refused)).toContain("La risorsa in quell'orario è assente (chi è nel riquadro): non ho fissato niente. Un'assenza non si scavalca.");
		expect(refused).not.toContain("fissalo lo stesso");
		const forced = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "17", resource: "Marco", force: true, force_check: "0123456789abcdef" });
		expect(forced).not.toContain("Fatto");
		// Without a resource said, the one there takes it.
		const other = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "17" });
		expect(inside(other)).toContain("(Giulia)");
		const free = await s.book({ op: "free_slots", date: "domani", resource: "Marco", minutes: 30, window: "pomeriggio" });
		expect(free).not.toContain("dalle 15");
		expect(await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "11", resource: "Marco" })).toContain("Fatto");
	});
});

describe("the brief, the file, routing", () => {
	it("once a day: who is off today and tomorrow, absences starting this week, tomorrow's gaps", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "giovedì", to: "venerdì" });
		const text = await s.run({ op: "who", compact: true });
		expect(outside(text)).toBe("Personale: oggi 0 assenti, domani un assente, un'assenza comincia più avanti in settimana; domani scoperto 18-19.\n");
		expect(inside(text)).toContain("Domani: Marco Neri: 9-13 (permesso il resto)");
		expect(inside(text)).toContain("In settimana: Giulia Verdi: ferie dal 22/10/2026 al 23/10/2026");
		expect(await s.run({ op: "who", compact: true })).toBe("Personale: niente da segnalare.");
		expect(BRIEF_INSTRUCTION).toContain("staff (who)");
		expect(staffCallReads({ op: "who", compact: true })).toBe(true);
		expect(staffCallReads({ op: "absence" })).toBe(false);
		expect(staffCallReads({ op: "export" })).toBe(false);
		const [gated] = readOnlyInBriefs([s.tool], async () => true);
		expect(await gated?.execute(giulia, fresh())).toContain("nella chat del brief del mattino Annie legge soltanto");
	});

	it("a file that does not read: one quiet line in the brief, never written over", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "staff.json"), "{ non è json");
		expect(await s.run({ op: "who", compact: true })).toBe("Personale: il file non si legge, guarda il runbook.");
		expect(await s.run(giulia)).toContain("staff.json.bak");
		expect(readFileSync(join(s.dir, "staff.json"), "utf8")).toBe("{ non è json");
		// The appointments go on without the absences.
		expect(s.store.blocksOn("2026-10-20")).toEqual([]);
	});

	it("a new person; a resource only one of the appointments'; first names", async () => {
		const s = setup();
		const text = await s.run({ op: "person", person: "Sara Gialli", role: "apprendista", weekly_hours: "30", week: "lun-ven 9-15", ferie_days: 26 });
		expect(outside(text)).toContain("Fatto: ho aggiunto la persona al personale");
		expect(inside(text)).toContain("Sara Gialli: apprendista; 30 ore a settimana; lun-ven 9-15; ferie 26 giorni l'anno");
		expect(await s.run({ op: "person", person: "Sara", resource: "Poltrona 9" })).toContain("negli appuntamenti non c'è una risorsa");
		expect(await s.run({ op: "person", person: "Sara", resource: "Marco" })).toContain("è già di un'altra persona");
		expect(await s.run({ op: "person", person: "Luca" })).toContain("nome e cognome");
		expect(await s.run({ op: "absence", person: "Paolo", kind: "ferie", from: "domani" })).toContain("non trovo questa persona");
	});

	it("routing: the instructions and the description keep staff apart from appointments, agents and Annie's users", () => {
		const s = setup();
		expect(DEFAULT_INSTRUCTIONS).toContain("tenere il personale di una piccola attività, cioè le persone che ci lavorano e non gli utenti di Annie né gli agenti del board (staff:");
		expect(DEFAULT_INSTRUCTIONS).toContain("mai la diagnosi");
		expect(s.tool.description).toContain("«Giulia è in ferie dal 3 al 14 agosto»");
		expect(s.tool.description).toContain("not the people who use Annie");
		expect(s.tool.description).not.toMatch(EMDASH);
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(EMDASH);
	});
});
