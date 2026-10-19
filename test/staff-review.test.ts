/** The review of week 75: dates read the right way, the month day by day, hiring and leaving, health data, the appointments told why not (never why). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { looksHealth, type Person, validAbsence, validPerson } from "../src/core/staff.ts";
import { monthRows } from "../src/core/staff-month.ts";
import { protocolSaid, reasonSaid, staffDay, staffDayNoted } from "../src/core/tools/staff-input.ts";
import { agent, checkIn, cleanup, fresh, GIULIA, HOURS, inside, MARK, MARCO, outside, type S, setup } from "./staff-fixtures.ts";

afterEach(cleanup);

const all = (s: S) => s.store.read().absences;
const TODAY = "2026-10-19";

describe("H1: dates read the right way", () => {
	it("«12 ottobre» on 19 October: past for a malattia, extra hours and a balance; the nearest for an absence, asked when unclear; a year not this one said", async () => {
		expect(staffDay("12 ottobre", TODAY, "past")).toBe("2026-10-12");
		// "next" reads only a bare weekday ahead: a day and month is the nearer.
		expect(staffDay("12 ottobre", TODAY, "next")).toBe("2026-10-12");
		expect(staffDay("12 ottobre", TODAY, "nearest")).toBe("2026-10-12");
		expect(staffDay("3 agosto", TODAY, "nearest")).toBe("2026-08-03");
		expect(staffDay("lunedì scorso", TODAY)).toBe("2026-10-12");
		expect(staffDay("venerdì scorso", TODAY)).toBe("2026-10-16");
		expect(staffDay("la settimana scorsa", TODAY)).toBe("2026-10-12");
		expect(staffDay("lunedì", TODAY, "past")).toBe(TODAY);
		expect(staffDay("lunedì", TODAY, "next")).toBe("2026-10-26");
		expect(staffDay("15 aprile", TODAY)).toEqual({ answer: "Errore: il 15 aprile è quello già passato (15/04/2026) o quello che viene (15/04/2027)? Dimmelo con l'anno." });
		expect(staffDayNoted("10 gennaio", TODAY)).toEqual({ day: "2027-01-10", yearless: true, note: "Ho letto il 10 gennaio come 10/01/2027, dell'anno prossimo: se intendevi un altro anno, dimmelo." });
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "12 ottobre", to: "14 ottobre" });
		expect(all(s)[0]).toMatchObject({ from: "2026-10-12", to: "2026-10-14" });
		const extra = await s.run({ op: "extra", person: "Giulia", date: "12 ottobre", hours: 1 });
		expect(outside(extra)).toContain("Fatto: ho segnato 1 ora in più lunedì 12 ottobre");
		expect(s.store.read().extras[0]?.day).toBe("2026-10-12");
		await s.run({ op: "person", person: "Giulia", ferie_left: "10", as_of: "12 ottobre" });
		expect(s.store.read().people[0]?.opening?.day).toBe("2026-10-12");
		const week = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "la settimana scorsa" });
		expect(outside(week)).toContain("Segnato: ferie da lunedì 12 a domenica 18 ottobre");
		const jan = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "11 gennaio", to: "15 gennaio" });
		expect(outside(jan)).toContain("Ho letto l'11 gennaio come 11/01/2027, dell'anno prossimo");
		expect(outside(jan)).not.toContain("restano circa");
		expect(await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "15 aprile" })).toContain("Dimmelo con l'anno.");
		// «dal 28 dicembre al 3 gennaio»: the end in the year after.
		await s.run({ op: "absence", person: "Marco", kind: "ferie", from: "28 dicembre", to: "3 gennaio" });
		expect(all(s).at(-1)).toMatchObject({ from: "2026-12-28", to: "2027-01-03" });
	});
});

describe("UX 1: the month for the consulente, day by day", () => {
	it("a row per day, the codes, Sundays marked; the malattie with the protocol, the other absences, the totals; presenze from the planned shifts", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "03/09/2026", to: "04/09/2026" });
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "08/09/2026", to: "10/09/2026", protocol: "123456789" });
		await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "14/09/2026", start: "9", end: "11", reason: "104" });
		await s.run({ op: "extra", person: "Marco", date: "13/09/2026", hours: 2 });
		await s.run({ op: "export", what: "summary", month: "settembre" });
		const md = s.made.at(-1)?.text ?? "";
		expect(md).toContain("Le presenze sono i turni previsti meno le assenze segnate, non timbrature");
		expect(md).toContain("| Giorno | Orario previsto | Ore | Assenza | Ore in più |");
		expect(md).toContain("| gio 3/9 | 9-13 e 14-18 |  | FE |  |");
		expect(md).toContain("| lun 14/9 | 9-13 e 14-18 | 6 | 104 |  |");
		expect(md).toContain("| dom 13/9 | chiuso |  |  | 2 (domenica) |");
		expect(md).toContain("Malattie: dall'8/9 al 10/9, protocollo 123456789.");
		expect(md).toContain("Altre assenze: L.104 2 ore (il 14/9).");
		expect(md).toContain("Totali: 19 giorni lavorati, 152 ore; ferie 0 giorni; permessi 0 ore; malattia 3 giorni di calendario; ore in più 2 (di cui 2 di domenica o festivo).");
		expect(md).toContain("Codici: FE ferie, PE permesso, MA malattia, LU lutto");
		const csv = readFileSync(join(s.root, "personale/riepilogo-2026-09.csv"), "utf8");
		expect(csv).toContain("Marco Neri;13/09/2026;domenica;chiuso;0;;2;domenica");
		expect(csv).toContain("Marco Neri;08/09/2026;martedì;9-13 e 15-19;0;MA;0;");
	});

	it("the month in course stops at today, and says so; someone hired mid-month from that day", async () => {
		const s = setup();
		await s.run({ op: "person", person: "Luca Bianchi", from: "14/10/2026", week: "lun-ven 9-13" });
		const text = await s.run({ op: "summary", month: "ottobre" });
		expect(outside(text)).toContain("Il riepilogo di ottobre per la consulente è pronto, giorno per giorno");
		expect(outside(text)).toContain("Il mese non è finito: arriva fino a oggi, lunedì 19 ottobre.");
		expect(inside(text)).toContain("Luca Bianchi: In forza dal 14/10/2026. Totali: 4 giorni lavorati, 16 ore");
		await s.run({ op: "export", what: "summary", month: "ottobre", format: "docx" });
		const md = s.made.at(-1)?.text ?? "";
		expect(md).toContain("Il mese non è finito: il riepilogo arriva fino al 19/10/2026.");
		expect(md).not.toContain("20/10");
		expect(md).toContain("In forza dal 14/10/2026.");
		expect(await s.run({ op: "summary", month: "dicembre 2026" })).toContain("quel mese non è ancora cominciato");
	});
});

describe("UX 2: hiring, leaving, archive, delete", () => {
	it("«assumo Luca da lunedì, 20 ore, mattina»: a first name to start, what is missing asked in one question; then the surname and the hours", async () => {
		const s = setup();
		const text = await s.run({ op: "person", person: "Luca", from: "lunedì", weekly_hours: 20, week: "mattina" });
		expect(outside(text)).toContain("Fatto: ho aggiunto la persona nel riquadro al personale, in forza da lunedì 26 ottobre, 20 ore a settimana.");
		expect(outside(text)).toContain("Come fa di cognome? E «mattina» in che orario, per esempio lun-ven 8:30-12:30?");
		const luca = s.store.read().people[2];
		expect(luca).toMatchObject({ name: "Luca", from: "2026-10-26", weeklyHours: "20" });
		expect(luca).not.toHaveProperty("week");
		const named = await s.run({ op: "person", person: "Luca", name: "Luca Bianchi", week: "lun-ven 8:30-12:30" });
		expect(inside(named)).toContain("Luca Bianchi: 20 ore a settimana; lun-ven 8:30-12:30; in forza dal 26/10/2026");
		// Not on the staff before the first day.
		expect(inside(await s.run({ op: "who", date: "martedì" }))).not.toContain("Luca");
		expect(inside(await s.run({ op: "who", date: "26/10/2026" }))).toContain("Luca Bianchi: 8:30-12:30");
		// Ferie for the months on the staff, an estimate.
		await s.run({ op: "person", person: "Luca", ferie_days: 26, rol_hours: 72 });
		const bal = await s.run({ op: "balance", person: "Luca" });
		expect(inside(bal)).toContain("ferie, ne restano circa 4,33 giorni su 4,33 (2 mesi su 12 in forza)");
	});

	it("a name like another's asks; new true adds the person", async () => {
		const s = setup();
		const ask = await s.run({ op: "person", person: "Giulia Verde", role: "cassiera" });
		expect(outside(ask)).toContain("Intendi questa persona?");
		expect(outside(ask)).toContain("ripeti dicendo che è una persona nuova");
		expect(outside(ask)).not.toMatch(/\bnew\b|true/);
		expect(s.store.read().people).toHaveLength(2);
		const made = await s.run({ op: "person", person: "Giulia Verde", role: "cassiera", new: true });
		expect(outside(made)).toContain("Fatto: ho aggiunto la persona");
		expect(s.store.read().people.map((p) => p.name)).toEqual(["Giulia Verdi", "Marco Neri", "Giulia Verde"]);
	});

	it("archive: the last day; out of the shifts, who works and the brief after it, the resource blocked; kept for the summaries", async () => {
		const s = setup();
		expect(await s.run({ op: "archive", person: "Marco", to: "venerdì" }, fresh(undefined, "notice"))).toContain("Non archivio la persona");
		const text = await s.run({ op: "archive", person: "Marco", to: "venerdì" });
		expect(outside(text)).toContain("in forza fino a venerdì 23 ottobre: da sabato 24 ottobre non è più nei turni, nel brief né in chi lavora.");
		expect(outside(text)).toContain("Negli appuntamenti la sua risorsa da quel giorno è bloccata");
		expect(s.store.read().people[1]?.to).toBe("2026-10-23");
		expect(await s.run({ op: "who", date: "sabato" })).toContain("non lavora nessuno");
		expect(s.store.blocksOn("2026-10-24")).toEqual([{ resource: "Marco", from: 0, to: 1440, why: "out" }]);
		const refused = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "sabato", time: "10", resource: "Marco" });
		expect(outside(refused)).toContain("Sabato 24 la risorsa nel riquadro non è nel personale");
	});

	it("delete: a proposal with a check, under the lock; refused while a resource is the person's; the audit the count only", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026" });
		await s.run({ op: "extra", person: "Giulia", date: "ieri", hours: 1 });
		const ask = await s.run({ op: "delete", person: "Giulia" });
		expect(outside(ask)).toContain("Cancello la persona nel riquadro con 1 assenza, 1 giorno di ore in più? Non si torna indietro");
		expect(s.store.read().people).toHaveLength(2);
		expect(await s.run({ op: "delete", person: "Giulia", confirm: true, check: "0000000000000000" })).toContain("il controllo non torna");
		expect(await s.run({ op: "delete", person: "Giulia", confirm: true, check: checkIn(ask) }, fresh(undefined, "notice"))).toContain("Non cancello la persona");
		// Something changed since the proposal: asked again.
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "27/10/2026" });
		expect(await s.run({ op: "delete", person: "Giulia", confirm: true, check: checkIn(ask) })).toContain("il controllo non torna");
		const again = await s.run({ op: "delete", person: "Giulia" });
		s.events.length = 0;
		expect(await s.run({ op: "delete", person: "Giulia", confirm: true, check: checkIn(again) })).toBe("Fatto: ho cancellato la persona, con le sue assenze, le ore in più e i turni cambiati. I file già salvati nella cartella personale/ (turni, riepiloghi per la consulente) la contengono ancora: se non servono più, cancellali tu.");
		const b = s.store.read();
		expect(b.people.map((p) => p.name)).toEqual(["Marco Neri"]);
		expect(b.absences).toHaveLength(0);
		expect(b.extras).toHaveLength(0);
		expect(s.events).toEqual([{ type: "staff.used", op: "delete", count: 1 }]);
		expect(outside(await s.run({ op: "delete", person: "Marco" }))).toContain("Non la cancello: è ancora la risorsa degli appuntamenti nel riquadro.");
		await s.run({ op: "person", person: "Marco", resource: "nessuna" });
		expect(s.store.read().people[0]).not.toHaveProperty("resource");
		expect(await s.run({ op: "delete", person: "Marco" })).toContain("Cancello la persona nel riquadro?");
	});
});

describe("UX 3: a malattia in the ferie", () => {
	it("proposes to shorten the ferie, with a check; the days not taken go back; any other overlap is still refused", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "02/11/2026", to: "06/11/2026" });
		const ask = await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "04/11/2026" });
		expect(outside(ask)).toContain("La persona nel riquadro è in ferie in quei giorni: la malattia interrompe le ferie. Accorcio le ferie da lunedì 2 a venerdì 6 novembre a martedì 3 novembre e segno la malattia da mercoledì 4 novembre? I giorni di ferie non goduti tornano nel suo saldo.");
		expect(all(s)).toHaveLength(1);
		expect(await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "04/11/2026", confirm: true, check: "0000000000000000" })).toContain("il controllo non torna");
		const done = await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "04/11/2026", confirm: true, check: checkIn(ask) });
		expect(outside(done)).toContain("Fatto: ho accorciato le ferie da lunedì 2 a venerdì 6 novembre a martedì 3 novembre e ho segnato malattia da mercoledì 4 novembre, fine non detta");
		expect(all(s)[0]).toMatchObject({ kind: "ferie", from: "2026-11-02", to: "2026-11-03" });
		expect(all(s)[1]).toMatchObject({ kind: "malattia", from: "2026-11-04" });
		expect(inside(await s.run({ op: "balance", person: "Giulia" }))).toContain("ferie, ne restano circa 24 giorni su 26 (in programma 2)");
		// Sick from the first day of the ferie: they are cancelled.
		await s.run({ op: "absence", person: "Marco", kind: "ferie", from: "24/11/2026", to: "27/11/2026" });
		const whole = await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "24/11/2026", to: "25/11/2026" });
		expect(outside(whole)).toContain("Annullo le ferie da martedì 24 a venerdì 27 novembre e segno la malattia da martedì 24 novembre?");
		expect(outside(whole)).toContain("Se dopo la malattia torna in ferie, quelle le segni di nuovo.");
		// A permesso in the ferie: refused.
		expect(outside(await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "26/11/2026", start: "15" }))).toContain("Non l'ho segnata: si sovrappone");
	});
});

describe("M1-M3, UX 4-5: health data", () => {
	it("the reason of an «altro» is a closed list: «malattia del figlio» is a congedo; health or free text never saved", async () => {
		expect(reasonSaid("malattia del figlio")).toBe("congedo malattia figlio");
		expect(reasonSaid("la bambina ha la febbre")).toBe("congedo malattia figlio");
		expect(reasonSaid("104")).toBe("L.104");
		expect(reasonSaid("si sposa")).toBe("matrimoniale");
		expect(reasonSaid("ricovero in ospedale")).toBe("health");
		expect(reasonSaid("gita al mare")).toBe("unknown");
		const s = setup();
		const kid = await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "domani", reason: "malattia del figlio" });
		expect(inside(kid)).toContain("motivo: congedo malattia figlio");
		const sick = await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "giovedì", reason: "ricovero in ospedale" });
		expect(sick).toContain("il motivo sembra un dato sanitario, e non lo scrivo da nessuna parte");
		expect(await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "giovedì", reason: "gita al mare" })).toContain("il motivo di un'altra assenza è uno di questi");
		expect(all(s)).toHaveLength(1);
		expect(JSON.stringify(s.store.read())).not.toMatch(/ospedale|gita/);
		expect(validAbsence({ id: "AS-0001", person: "PE-0001", kind: "altro", from: TODAY, to: TODAY, reason: "lutto in famiglia", callId: "c", ...MARK })).toBe(false);
		// L.104 by the hour.
		const hours = await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "venerdì", start: "9", end: "11", reason: "L.104" });
		expect(outside(hours)).toContain("Segnato: assenza venerdì 23 ottobre dalle 9 alle 11");
		expect(outside(hours)).toContain("Sono 2 ore.");
	});

	it("a role is a short job title; a role or a note that looks like health data is never saved", async () => {
		const s = setup();
		expect(await s.run({ op: "person", person: "Giulia", role: "commessa, cassiera e magazziniera" })).toContain("al più tre parole, senza virgole");
		const role = await s.run({ op: "person", person: "Giulia", role: "in gravidanza" });
		expect(outside(role)).toContain("Il ruolo non l'ho salvato: sembra un dato sanitario");
		expect(s.store.read().people[0]?.role).toBe("commessa");
		const ferie = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026", note: "per la chemio" });
		expect(outside(ferie)).toContain("Le note sulle assenze non le scrivo");
		const extra = await s.run({ op: "extra", person: "Marco", date: "sabato scorso", hours: 1, note: "dopo la visita medica" });
		expect(outside(extra)).toContain("La nota non l'ho salvato");
		const shift = await s.run({ op: "shift", person: "Giulia", date: "sabato", hours: "9-13", note: "copre Marco" });
		expect(outside(shift)).not.toContain("non l'ho salvato");
		await s.run({ op: "shift", person: "Giulia", date: "domenica", hours: "riposo", note: "influenza" });
		const b = s.store.read();
		expect(JSON.stringify(b)).not.toMatch(/chemio|visita medica|gravidanza|influenza/);
		expect(b.shifts.find((x) => x.day === "2026-10-24")?.note).toBe("copre Marco");
		expect(looksHealth("parrucchiere")).toBe(false);
		// A job title passes only as a role: «dal fisioterapista» in a note says something of health.
		expect(looksHealth("fisioterapista", true)).toBe(false);
		expect(looksHealth("fisioterapista")).toBe(true);
		// Checked when said, never when read: a file saved before stays readable.
		expect(validPerson({ ...GIULIA, role: "diabetica" })).toBe(true);
	});

	it("the protocol is digits only, 6 to 12, spaces, «/» and «-» taken out", () => {
		expect(protocolSaid("123 456 789")).toBe("123456789");
		expect(protocolSaid("protocollo 2026/123-456")).toBe("2026123456");
		expect(protocolSaid("PUC 123456")).toBe("bad");
		expect(protocolSaid("12345")).toBe("bad");
		expect(protocolSaid("1234567890123")).toBe("bad");
		expect(protocolSaid("influenza")).toBe("bad");
		expect(validAbsence({ id: "AS-0001", person: "PE-0002", kind: "malattia", from: TODAY, protocol: "ABC123456", callId: "c", ...MARK })).toBe(false);
	});

	it("UX 5: the health note only when a reason or a note was given", async () => {
		const s = setup();
		const plain = await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "oggi" });
		expect(plain).not.toContain("dato sanitario");
		expect(plain).not.toContain("protocollo");
		const noted = await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "oggi", note: "mal di schiena" });
		expect(outside(noted)).toContain("Il motivo non lo scrivo da nessuna parte, è un dato sanitario");
		expect(JSON.stringify(s.store.read())).not.toContain("schiena");
	});

	it("M4: the shifts' file and the brief say «assente», never the kind; the month for the consulente keeps MA", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "27/10/2026", to: "28/10/2026" });
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "29/10/2026" });
		await s.run({ op: "export", what: "shifts" });
		const md = s.made.at(-1)?.text ?? "";
		expect(md).toContain("- Marco Neri: assente");
		expect(md).not.toMatch(/malattia|ferie/);
		await s.run({ op: "export", what: "shifts", format: "csv" });
		const csv = readFileSync(join(s.root, "personale/turni-dal-2026-10-26.csv"), "utf8");
		expect(csv).toContain(";assente");
		expect(csv).not.toMatch(/malattia|ferie/);
		s.clock.now = new Date("2026-10-26T07:00:00Z");
		const brief = await s.run({ op: "who", compact: true });
		expect(brief).toContain("Domani: Marco Neri: assente");
		expect(brief).not.toMatch(/malattia|ferie|protocollo/);
		s.clock.now = new Date("2026-11-02T07:00:00Z");
		await s.run({ op: "export", what: "summary", month: "ottobre" });
		expect(s.made.at(-1)?.text).toContain("| mar 27/10 | 9-13 e 15-19 |  | MA |  |");
	});

	it("UX 5: the brief asks once, ever, about an open malattia of 3 days or more", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "oggi" });
		expect(await s.run({ op: "who", compact: true })).not.toContain("sai fino a quando");
		s.clock.now = new Date("2026-10-21T07:00:00Z");
		const ask = await s.run({ op: "who", compact: true });
		expect(outside(ask)).toContain("una domanda su un'assenza senza fine");
		expect(inside(ask)).toContain("Marco Neri è assente da lunedì 19 ottobre, fine non detta: sai fino a quando?");
		expect(ask).not.toMatch(/malattia|protocollo/);
		s.clock.now = new Date("2026-10-22T07:00:00Z");
		expect(await s.run({ op: "who", compact: true })).not.toContain("sai fino a quando");
	});
});

describe("UX 6-10: ferie counted, balances, the appointments, the brief", () => {
	it("6: the week ferie are counted on is a setting (5 by default, said); closures and days off said apart do not count", async () => {
		const s = setup({ hours: { ...HOURS, closures: [{ from: "2026-12-09", to: "2026-12-09" }] } });
		const five = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "07/12/2026", to: "12/12/2026" });
		expect(outside(five)).toContain("Sono 3 giorni di ferie (lun-ven; Immacolata Concezione non conta; il giorno di chiusura non conta)");
		expect(outside(five)).toContain("Se il vostro contratto conta anche il sabato, dimmelo.");
		expect(await s.run({ op: "settings", ferie_week: 7 })).toContain("5 giorni (lun-ven) o di 6 (lun-sab)");
		expect(outside(await s.run({ op: "settings", ferie_week: 6 }))).toContain("Le ferie si contano su 6 giorni a settimana (lun-sab).");
		expect(s.store.read().settings).toMatchObject({ ferieWeek: 6 });
		const six = await s.run({ op: "absence", person: "Marco", kind: "ferie", from: "14/12/2026", to: "19/12/2026" });
		expect(outside(six)).toContain("Sono 5 giorni di ferie (lun-sab)");
		expect(outside(six)).not.toContain("Se il vostro contratto");
	});

	it("8 and 10: the appointments say the resource is not there, never why; another resource at the same hour first; the rest day and the time off the shift block", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		const refused = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "16", resource: "Marco" });
		expect(outside(refused)).toContain("Domani dalle 15 la risorsa nel riquadro non c'è: con questa risorsa non ho fissato niente.");
		expect(inside(refused)).toContain("• domani alle 16: Giulia");
		// The same hour with another resource comes first.
		expect(inside(refused).split("\n").find((l) => l.startsWith("•"))).toBe("• domani alle 16: Giulia");
		expect(outside(refused)).not.toContain("Marco");
		expect(refused).not.toMatch(/permesso|ferie|malattia/);
		const monday = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "26/10/2026", time: "10", resource: "Marco" });
		expect(outside(monday)).toContain("Il lunedì la risorsa nel riquadro è di riposo: con questa risorsa non ho fissato niente.");
		expect(outside(monday)).toContain("Se invece quel giorno lavora, segna il suo turno nel personale.");
		const pause = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "27/10/2026", time: "14", resource: "Marco" });
		expect(outside(pause)).toContain("Martedì 27 dalle 13 alle 15 la risorsa nel riquadro non è di turno");
		await s.run({ op: "shift", person: "Marco", date: "26/10/2026", hours: "9-13" });
		expect(await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "26/10/2026", time: "10", resource: "Marco" })).toContain("Fatto");
	});

	it("7 and 9: the balance names ROL and ex festività; the brief and the agents never say «0 assenti»", async () => {
		const s = setup();
		expect(inside(await s.run({ op: "balance" }))).toContain("permessi (ROL ed ex festività insieme)");
		const none = await s.run({ op: "who" }, agent());
		expect(none).toBe("Personale: oggi nessuno assente, domani nessuno assente. A un altro agente do solo i conteggi: chi e perché no.");
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "domani" });
		const brief = await s.run({ op: "who", compact: true });
		expect(outside(brief)).toBe("Personale: domani un assente; domani scoperto 14-15.\n");
		expect(brief).not.toContain("0 assenti");
	});
});

describe("LOW", () => {
	it("L1: a change re-checks under the lock that the absence is still there", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026" });
		const c = fresh();
		const racing = { ...c, step: async <T>(key: string, work: () => Promise<T>) => {
			if (key === "change") s.store.update("other", (st) => ({ ...st, absences: st.absences.map((a) => ({ ...a, cancelled: { ...MARK, call: "other" } })) }));
			return work();
		} };
		expect(await s.run({ op: "change", person: "Giulia", on: "26/10/2026", to: "27/10/2026" }, racing)).toContain("intanto questa assenza è stata annullata");
		expect(all(s)[0]?.to).toBe("2026-10-26");
	});

	it("L2: cancel or change with no day and more than one absence to come: asked which", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026" });
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "02/11/2026" });
		const ask = await s.run({ op: "cancel", person: "Giulia" });
		expect(outside(ask)).toContain("questa persona ha più di un'assenza segnata da oggi in poi: dimmi il giorno di quella che intendi.");
		expect(all(s).every((a) => a.cancelled === undefined)).toBe(true);
	});

	it("L7: a half day goes when the kind changes; UX 11: an extra on a holiday is festivo", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "giovedì", half: "mattina" });
		await s.run({ op: "change", person: "Giulia", kind: "malattia" });
		expect(all(s)[0]).toMatchObject({ kind: "malattia", from: "2026-10-22", to: "2026-10-22" });
		expect(all(s)[0]).not.toHaveProperty("half");
		const holiday = await s.run({ op: "extra", person: "Marco", date: "15 agosto", hours: 3 });
		expect(outside(holiday)).toContain("sabato 15 agosto (festivo: Ferragosto)");
		expect(outside(holiday)).toContain("segnate come lavoro di domenica o festivo");
	});

	it("a person without a usual week blocks the resource only with an absence", () => {
		const s = setup({ people: [GIULIA, { ...MARCO, week: undefined }] });
		expect(s.store.blocksOn("2026-10-26")).toEqual([]);
	});
});

describe("Closing verify (week 75)", () => {
	it("M-A: health stems anywhere in a word, job titles pass only as a role, notes short; never checked on read", async () => {
		for (const t of ["fa terapia", "è ricoverata", "ha la febbre", "sta male", "dal medico", "dopo la tac", "visita oncologica", "in convalescenza", "certificato"]) expect(looksHealth(t)).toBe(true);
		for (const t of ["attacco", "simpatica", "empatia", "copre la collega", "parrucchiere"]) expect(looksHealth(t)).toBe(false);
		for (const t of ["farmacista", "psicologa", "medico", "autista", "fisioterapista"]) expect(looksHealth(t, true)).toBe(false);
		expect(looksHealth("dalla psicologa")).toBe(true);
		expect(reasonSaid("congedo di maternità")).toBe("congedo parentale");
		expect(reasonSaid("104 per la disabilità del padre")).toBe("L.104");
		expect(reasonSaid("congedo per malattia")).toBe("health");
		const s = setup();
		const role = await s.run({ op: "person", person: "Giulia", role: "farmacista" });
		expect(outside(role)).toContain("Fatto: ho aggiornato la scheda");
		// Names are not checked: a surname like Medici is a name.
		const named = await s.run({ op: "person", person: "Lucia Medici", role: "commessa" });
		expect(outside(named)).toContain("Fatto: ho aggiunto la persona");
		const ferie = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026", note: "va al mare" });
		expect(outside(ferie)).toContain("Le note sulle assenze non le scrivo");
		expect(all(s).at(-1)?.note).toBeUndefined();
		expect(await s.run({ op: "shift", person: "Giulia", date: "sabato", hours: "9-13", note: "x".repeat(81) })).toContain("la nota è lunga");
		// A file saved before a stem was added stays readable.
		s.store.update("old", (st) => ({ ...st, nextAbsence: 100, shifts: [{ person: "PE-0001", day: "2026-10-24", hours: [], note: "febbre", ...MARK }], absences: [...st.absences, { id: "AS-0099", person: "PE-0001", kind: "ferie", from: "2026-11-02", to: "2026-11-02", note: "dal medico", callId: "old", ...MARK }] }));
		expect(s.store.broken()).toBe(false);
	});

	it("M-B: the protocol is asked in the owner's chat when the end of a malattia is said", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "oggi" });
		const end = await s.run({ op: "change", person: "Marco", to: "giovedì" });
		expect(outside(end)).toContain("Quando hai il certificato, dimmi il numero di protocollo: serve alla consulente.");
		const given = await s.run({ op: "change", person: "Marco", protocol: "123456789" });
		expect(outside(given)).not.toContain("dimmi il numero di protocollo");
	});

	it("N1: a name alone is looked up, never added; more people for one name are said", async () => {
		const s = setup({ people: [GIULIA, MARCO, { id: "PE-0003", name: "Giulia Rossi", ...MARK }] });
		const alone = await s.run({ op: "person", person: "Luca" });
		expect(outside(alone)).toContain("non trovo questa persona");
		expect(s.store.read().people).toHaveLength(3);
		const many = await s.run({ op: "person", person: "Giulia", role: "cassiera" });
		expect(outside(many)).toContain("il nome va bene per più persone");
		expect(s.store.read().people).toHaveLength(3);
		expect(outside(await s.run({ op: "person", person: "Luca", role: "barbiere" }))).toContain("Fatto: ho aggiunto la persona");
		expect(outside(await s.run({ op: "person", person: "Sara", new: true }))).toContain("Fatto: ho aggiunto la persona");
		expect(s.store.read().people).toHaveLength(5);
	});

	it("N2: a new person's first day: a weekday ahead, a day and month the nearer (asked when unclear), the year said", async () => {
		const s = setup();
		await s.run({ op: "person", person: "Luca", new: true, from: "lunedì" });
		expect(s.store.read().people.at(-1)?.from).toBe("2026-10-26");
		await s.run({ op: "person", person: "Sara", new: true, from: "3 novembre" });
		expect(s.store.read().people.at(-1)?.from).toBe("2026-11-03");
		expect(await s.run({ op: "person", person: "Anna", new: true, from: "15 aprile" })).toContain("Dimmelo con l'anno.");
		const jan = await s.run({ op: "person", person: "Anna", new: true, from: "10 gennaio" });
		expect(outside(jan)).toContain("Ho letto il 10 gennaio come 10/01/2027, dell'anno prossimo");
	});

	it("N3: ferie or a permesso more than a week back, said without the year, are asked; yes, already taken, saves them", async () => {
		const s = setup();
		expect(await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "2 giugno", to: "5 giugno" })).toBe("Il 2-5 giugno è già passato: le segno come ferie già fatte, o intendi giugno 2027?");
		expect(await s.run({ op: "absence", person: "Giulia", kind: "permesso", from: "8 settembre", start: "10", end: "12" })).toBe("L'8 settembre è già passato: lo segno come permesso già fatto, o intendi settembre 2027?");
		expect(all(s)).toHaveLength(0);
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "2 giugno", to: "5 giugno", past: true });
		expect(all(s)[0]).toMatchObject({ from: "2026-06-02", to: "2026-06-05" });
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "12 ottobre" });
		expect(all(s)).toHaveLength(2);
		await s.run({ op: "absence", person: "Marco", kind: "ferie", from: "02/06/2026" });
		expect(all(s)).toHaveLength(3);
	});

	it("a malattia's start without its year more than 60 days back is asked", async () => {
		expect(staffDayNoted("25 ottobre", TODAY, "recent")).toEqual({ answer: "Errore: il 25 ottobre è quello già passato (25/10/2025) o quello che viene (25/10/2026)? Dimmelo con l'anno." });
		expect(staffDay("15 ottobre", TODAY, "recent")).toBe("2026-10-15");
		const s = setup();
		expect(await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "25 ottobre" })).toContain("Dimmelo con l'anno.");
		expect(all(s)).toHaveLength(0);
	});

	it("archive from: the first day gone, the last the day before", async () => {
		const s = setup();
		const text = await s.run({ op: "archive", person: "Marco", from: "venerdì" });
		expect(s.store.read().people[1]?.to).toBe("2026-10-22");
		expect(outside(text)).toContain("in forza fino a giovedì 22 ottobre: da venerdì 23 ottobre non è più nei turni");
	});

	it("delete: the check is bound to each absence as it is; the files in personale/ said", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026" });
		const ask = await s.run({ op: "delete", person: "Giulia" });
		expect(outside(ask)).toContain("I file già salvati nella cartella personale/ restano come sono.");
		// Cancelled: the counts are the same, the check is not.
		await s.run({ op: "cancel", person: "Giulia", from: "26/10/2026" });
		expect(await s.run({ op: "delete", person: "Giulia", confirm: true, check: checkIn(ask) })).toContain("il controllo non torna");
		expect(s.store.read().people).toHaveLength(2);
	});

	it("a malattia over ferie and a permesso: says which one blocks, nothing changed", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026", to: "28/10/2026" });
		await s.run({ op: "absence", person: "Giulia", kind: "permesso", from: "29/10/2026", start: "10", end: "12" });
		const text = await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "26/10/2026", to: "29/10/2026" });
		expect(outside(text)).toContain("le ferie di quei giorni le accorcerei, ma c'è anche un'altra assenza che le blocca (permesso giovedì 29 ottobre dalle 10 alle 12)");
		expect(all(s)).toHaveLength(2);
		expect(all(s).every((a) => a.kind !== "malattia")).toBe(true);
	});

	it("the month's totals count only the days on the staff", () => {
		const luca: Person = { id: "PE-0003", name: "Luca Bianchi", week: GIULIA.week, from: "2026-10-15", ...MARK };
		const absences = [
			{ id: "AS-0001", person: "PE-0003", kind: "malattia" as const, from: "2026-10-01", to: "2026-10-20", callId: "a", ...MARK },
			{ id: "AS-0002", person: "PE-0003", kind: "permesso" as const, from: "2026-10-09", to: "2026-10-09", start: "10:00", end: "12:00", callId: "b", ...MARK },
		];
		const [row] = monthRows({ people: [luca], absences, shifts: [] }, [], "2026-10-01", "2026-10-31");
		expect(row?.malattia).toBe(600);
		expect(row?.permesso).toBe(0);
	});

	it("the staff file not read: said once a day on bookings", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "staff.json"), "{ non è json");
		const warn = "il file del personale non si legge";
		expect(await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "11", resource: "Marco" })).toContain(warn);
		expect(await s.book({ op: "book", client: "Bea Neri", services: ["taglio"], date: "domani", time: "15", resource: "Marco" })).not.toContain(warn);
		s.clock.now = new Date("2026-10-20T07:00:00Z");
		expect(await s.book({ op: "book", client: "Carla Blu", services: ["taglio"], date: "domani", time: "11", resource: "Marco" })).toContain(warn);
	});
});
