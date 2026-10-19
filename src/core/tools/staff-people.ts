/**
 * The people of the staff tool: add or change a person («assumo Luca da lunedì, 20 ore, mattina»:
 * a first name is enough to start, and what is missing is asked in one question), archive one who
 * left (the last day: out of the shifts, the brief and who works from then on, kept for the
 * summaries), delete one (a proposal with a check first, then under the lock: the person with
 * their absences, shifts and extra hours; not while a resource of the appointments is theirs).
 * Every write only on the person's own word. A role is a short job title, and one that looks like
 * health data is never saved. Names in the fence.
 */
import { createHash } from "node:crypto";
import type { AppointmentSettings } from "../appointments.ts";
import type { ToolContext } from "../engine.ts";
import { addDays } from "../italian-calendar.ts";
import type { Marker } from "../marker.ts";
import { looksHealth, type Person, personId, STAFF_LIMITS, StaffError } from "../staff.ts";
import type { StaffBook, StaffStore } from "../staff-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { requirePersonFor } from "../turn-origin.ts";
import { decimalSaid, isAnswer, personSaid, staffDay, vagueWeek, weekOfPerson } from "./staff-input.ts";
import { fencedStaff, personRow, plainDay } from "./staff-render.ts";

export type Answer = { text: string; count: number };
export type Now = { readonly day: string; readonly minutes: number };

/** What the people's ops need of the tool. */
export type StaffKit = {
	readonly store: StaffStore;
	readonly marker: (ctx: ToolContext) => Marker;
	/** The appointments' settings: the resources a person may be. */
	readonly hours: () => AppointmentSettings | undefined;
};

export const HEALTH_FIELD = (what: string) => `${what} non l'ho salvato: sembra un dato sanitario, e quelli non li scrivo da nessuna parte. Per una malattia mi basta il numero di protocollo del certificato.`;

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** «Intendi questa persona?»: a name only close to one, asked; nothing written. */
export const closeAsk = (p: Person, creating = false): string =>
	["Intendi questa persona? Non si chiama esattamente come è stata detta:", fencedStaff(p.name), `Se chi ti scrive dice di sì, ripeti con il nome scritto come qui.${creating ? " Se invece è una persona nuova con un nome simile, ripeti con new true." : ""}`].join("\n");

const NO_RESOURCE = /^(?:nessuna|nessuno|niente|no|-)?$/i;

export function createPeopleOps(kit: StaffKit) {
	const { store, marker, hours } = kit;

	/** A role: a short job title, at most 3 words, no commas; health data never. */
	function roleSaid(raw: unknown): { role?: string; note?: string } | string {
		const r = cleanText(raw, STAFF_LIMITS.role, "il ruolo");
		if (isProblem(r)) return `Errore: ${r.problem}.`;
		if (r === undefined) return {};
		if (looksHealth(r)) return { note: HEALTH_FIELD("Il ruolo") };
		if (/[,;]/.test(r) || r.split(/\s+/).length > 3) return "Errore: il ruolo è un nome di mestiere corto, come «commessa» o «parrucchiere»: al più tre parole, senza virgole.";
		return { role: r };
	}

	async function person(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const said = typeof args.person === "string" ? args.person : undefined;
		if (said === undefined) return { text: "Errore: dimmi il nome della persona.", count: 0 };
		if (args.new !== undefined && typeof args.new !== "boolean") return { text: "Errore: new è sì o no.", count: 0 };
		const creating = args.new === true;
		const found = b.people.length === 0 || creating ? undefined : personSaid(said, b.people);
		if (found !== undefined && !isAnswer(found) && found.close === true) return { text: closeAsk(found.person, true), count: 0 };
		const current = found === undefined || isAnswer(found) ? undefined : found.person;
		const fields: Record<string, unknown> = {};
		const unset: string[] = [];
		const notes: string[] = [];
		const asks: string[] = [];
		if (args.role !== undefined) {
			const r = roleSaid(args.role);
			if (typeof r === "string") return { text: r, count: 0 };
			if (r.role !== undefined) fields.role = r.role;
			if (r.note !== undefined) notes.push(r.note);
		}
		const decimals: [string, string, number, string][] = [
			["weekly_hours", "weeklyHours", STAFF_LIMITS.weeklyHours, "le ore a settimana"],
			["ferie_days", "ferieDays", STAFF_LIMITS.ferieDays, "i giorni di ferie l'anno"],
			["rol_hours", "rolHours", STAFF_LIMITS.rolHours, "le ore di permesso l'anno"],
		];
		for (const [arg, key, max, what] of decimals) {
			const v = decimalSaid(args[arg], max, what);
			if (isAnswer(v)) return { text: v.answer, count: 0 };
			if (v !== undefined) fields[key] = v;
		}
		if (args.week !== undefined) {
			const vague = vagueWeek(args.week);
			if (vague !== undefined) asks.push(`E «${vague}» in che orario, per esempio lun-ven 8:30-12:30?`);
			else {
				const w = weekOfPerson(args.week, current?.week);
				if (isAnswer(w)) return { text: w.answer, count: 0 };
				fields.week = w;
			}
		}
		if (args.ferie_left !== undefined || args.rol_left !== undefined) {
			const ferie = decimalSaid(args.ferie_left, STAFF_LIMITS.ferieDays * 3, "le ferie che restano");
			if (isAnswer(ferie)) return { text: ferie.answer, count: 0 };
			const rol = decimalSaid(args.rol_left, STAFF_LIMITS.rolHours * 3, "le ore di permesso che restano");
			if (isAnswer(rol)) return { text: rol.answer, count: 0 };
			// The day of a balance said is past (or today).
			const day = args.as_of === undefined ? at.day : staffDay(args.as_of, at.day, "past");
			if (isAnswer(day)) return { text: day.answer, count: 0 };
			fields.opening = { day, ...(ferie === undefined ? {} : { ferie }), ...(rol === undefined ? {} : { rol }) };
		}
		if (args.resource !== undefined) {
			const r = typeof args.resource === "string" && NO_RESOURCE.test(args.resource.trim()) ? undefined : cleanText(args.resource, STAFF_LIMITS.resource, "la risorsa");
			if (isProblem(r)) return { text: `Errore: ${r.problem}.`, count: 0 };
			if (r === undefined) unset.push("resource");
			else {
				const known = hours()?.resources ?? [];
				const match = known.find((k) => k.toLowerCase() === r.toLowerCase());
				if (match === undefined) return { text: ["Errore: negli appuntamenti non c'è una risorsa con questo nome: aggiungila prima lì, nelle impostazioni degli appuntamenti.", fencedStaff(r)].join("\n"), count: 0 };
				if (b.people.some((p) => p.id !== current?.id && p.resource?.toLowerCase() === match.toLowerCase())) return { text: ["Errore: questa risorsa degli appuntamenti è già di un'altra persona.", fencedStaff(match)].join("\n"), count: 0 };
				fields.resource = match;
			}
		}
		for (const [arg, key] of [["from", "from"], ["to", "to"]] as const) {
			if (args[arg] === undefined) continue;
			// «assumo Luca da lunedì»: the Monday to come.
			const day = staffDay(args[arg], at.day, arg === "from" && current === undefined ? "next" : "nearest");
			if (isAnswer(day)) return { text: day.answer, count: 0 };
			fields[key] = day;
		}
		const from = (fields.from ?? current?.from) as string | undefined;
		const to = (fields.to ?? current?.to) as string | undefined;
		if (from !== undefined && to !== undefined && to < from) return { text: "Errore: l'ultimo giorno viene prima dell'assunzione: dimmeli di nuovo.", count: 0 };
		let name = current?.name;
		if (current === undefined || args.name !== undefined) {
			const n = cleanText(args.name ?? said, STAFF_LIMITS.name, "il nome");
			if (isProblem(n) || n === undefined) return { text: "Errore: dimmi il nome della persona.", count: 0 };
			if (b.people.some((p) => p.id !== current?.id && p.name.toLowerCase() === n.toLowerCase())) return { text: ["Errore: c'è già una persona con questo nome: aggiungi il cognome, o dimmi se è lei.", fencedStaff(n)].join("\n"), count: 0 };
			name = n;
			if (current !== undefined && n !== current.name) fields.name = n;
		}
		if (Object.keys(fields).length === 0 && unset.length === 0 && current !== undefined) return { text: ["La scheda è nel riquadro.", fencedStaff(personRow(current)), ...notes, ...asks].join("\n"), count: 0 };
		const refused = requirePersonFor(ctx, "cambio i dati del personale");
		if (refused !== undefined) return { text: refused, count: 0 };
		const by = marker(ctx);
		let id = current?.id ?? "";
		await ctx.step("person", async () => {
			store.update(ctx.callId, (state) => {
				if (current !== undefined) {
					return {
						...state,
						people: state.people.map((p) => {
							if (p.id !== current.id) return p;
							const next: Record<string, unknown> = { ...p, ...fields, ...by };
							for (const k of unset) delete next[k];
							return next as Person;
						}),
					};
				}
				if (state.people.length >= STAFF_LIMITS.people) throw new StaffError("il personale è troppo per aggiungere altre persone");
				id = personId(state.nextPerson);
				return { ...state, nextPerson: state.nextPerson + 1, people: [...state.people, { id, name: name as string, ...fields, ...by } as Person] };
			});
			return true;
		});
		const saved = store.read().people.find((p) => (current === undefined ? p.name === name : p.id === current.id));
		if (current === undefined && (name ?? "").split(/\s+/).length < 2) asks.unshift("Come fa di cognome?");
		if (current === undefined && saved?.week === undefined && asks.every((a) => !a.startsWith("E «"))) asks.push("E che orario fa di solito, per esempio lun-ven 9-13 e 14-18?");
		const since = saved?.from === undefined ? "" : `, in forza da ${plainDay(saved.from, at.day)}`;
		const contract = saved?.weeklyHours === undefined || current !== undefined ? "" : `, ${saved.weeklyHours.replace(".", ",")} ore a settimana`;
		const head = current === undefined ? `Fatto: ho aggiunto la persona nel riquadro al personale${since}${contract}.` : "Fatto: ho aggiornato la scheda, come nel riquadro.";
		const later = asks.length > 0 || saved?.ferieDays !== undefined || saved?.opening?.ferie !== undefined ? [] : ["Se vuoi tenere il conto delle ferie e dei permessi, dimmi quanti giorni e quante ore le spettano l'anno, o quante gliene restano oggi."];
		return { text: [head, fencedStaff(saved === undefined ? "" : personRow(saved)), ...notes, ...(asks.length === 0 ? [] : [asks.join(" ")]), ...later].join("\n"), count: 1 };
	}

	/** Someone who left: the last day (default today); kept for the summaries. */
	async function archive(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "archivio la persona");
		if (refused !== undefined) return { text: refused, count: 0 };
		const w = personSaid(args.person, b.people);
		if (isAnswer(w)) return { text: w.answer, count: 0 };
		if (w.close === true) return { text: closeAsk(w.person), count: 0 };
		const day = staffDay(args.to ?? args.date ?? "oggi", at.day, "nearest");
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		if (w.person.from !== undefined && day < w.person.from) return { text: "Errore: l'ultimo giorno viene prima dell'assunzione: dimmelo di nuovo.", count: 0 };
		const by = marker(ctx);
		await ctx.step("archive", async () => {
			store.update(ctx.callId, (state) => ({ ...state, people: state.people.map((p) => (p.id === w.person.id ? { ...p, to: day, ...by } : p)) }));
			return true;
		});
		return {
			text: [
				`Fatto: la persona nel riquadro resta nello storico, in forza fino a ${plainDay(day, at.day)}: da ${plainDay(addDays(day, 1), at.day)} non è più nei turni, nel brief né in chi lavora. Le sue assenze e le ore restano per i riepiloghi.`,
				fencedStaff(w.person.name),
				...(w.person.resource === undefined ? [] : ["Negli appuntamenti la sua risorsa da quel giorno è bloccata: se non serve più, toglila dalle impostazioni degli appuntamenti."]),
			].join("\n"),
			count: 1,
		};
	}

	/** What a deletion takes along, for the check: bound to the person and to what is there now. */
	const takes = (b: Pick<StaffBook, "absences" | "extras" | "shifts">, id: string) => ({ absences: b.absences.filter((a) => a.person === id).length, extras: b.extras.filter((e) => e.person === id).length, shifts: b.shifts.filter((s) => s.person === id).length });

	/** Delete a person and what is theirs: a proposal with a check first; never while a resource of the appointments is theirs. */
	async function remove(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook): Promise<Answer> {
		const refused = requirePersonFor(ctx, "cancello la persona");
		if (refused !== undefined) return { text: refused, count: 0 };
		const w = personSaid(args.person, b.people);
		if (isAnswer(w)) return { text: w.answer, count: 0 };
		if (w.close === true) return { text: closeAsk(w.person), count: 0 };
		const p = w.person;
		if (p.resource !== undefined) return { text: ["Non la cancello: è ancora la risorsa degli appuntamenti nel riquadro. Prima togli il legame (dimmi che non è più una risorsa degli appuntamenti), poi la cancello.", fencedStaff(`${p.name}: «${p.resource}»`)].join("\n"), count: 0 };
		const t = takes(b, p.id);
		const check = hash(["delete", p.id, t]);
		const parts = [t.absences === 0 ? undefined : `${t.absences} ${t.absences === 1 ? "assenza" : "assenze"}`, t.extras === 0 ? undefined : `${t.extras} ${t.extras === 1 ? "giorno" : "giorni"} di ore in più`, t.shifts === 0 ? undefined : `${t.shifts} ${t.shifts === 1 ? "turno cambiato" : "turni cambiati"}`].filter((x) => x !== undefined);
		const what = parts.length === 0 ? "" : ` con ${parts.join(", ")}`;
		const ask = [`Cancello la persona nel riquadro${what}? Non si torna indietro, e i riepiloghi dei mesi passati non l'avranno più: se vuoi solo che non sia più nei turni, meglio archiviarla con l'ultimo giorno.`, fencedStaff(personRow(p)), `Se chi ti scrive dice di sì, ripeti con la conferma e il controllo ${check}.`].join("\n");
		if (args.confirm !== true) return { text: ask, count: 0 };
		const given = typeof args.check === "string" ? args.check.trim().toLowerCase() : "";
		if (given !== check) return { text: `Errore: il controllo non torna: non ho cancellato niente.\n${ask}`, count: 0 };
		await ctx.step("delete", async () => {
			store.update(ctx.callId, (state) => {
				const now = state.people.find((x) => x.id === p.id);
				if (now === undefined) return state;
				if (now.resource !== undefined || hash(["delete", p.id, takes(state, p.id)]) !== check) throw new StaffError("intanto i dati di questa persona sono cambiati: non ho cancellato niente. Chiedi di nuovo la proposta");
				return { ...state, people: state.people.filter((x) => x.id !== p.id), absences: state.absences.filter((a) => a.person !== p.id), extras: state.extras.filter((e) => e.person !== p.id), shifts: state.shifts.filter((s) => s.person !== p.id) };
			});
			return true;
		});
		return { text: "Fatto: ho cancellato la persona, con le sue assenze, le ore in più e i turni cambiati.", count: 1 };
	}

	return { person, archive, remove };
}

