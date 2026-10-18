import { AGENT_CHANNEL } from "../agent-messages.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import type { Category as ExpenseCategory } from "../expenses.ts";
import { addDays, todayIn } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import { DateError, readDate } from "../dates.ts";
import { agendaOf, nextDue, noticeDeadline, readDue, remindDays } from "../renewal-dates.ts";
import { costsOf } from "../renewal-sums.ts";
import { RENEWALS_BROKEN, type RenewalStore } from "../renewal-store.ts";
import { CATEGORIES, type Category, findRenewals, lookalike, matchCategory, METHODS, parseRenewalId, RENEWAL_LIMITS, type Renewal, RenewalError, renewalCallReads, renewalId, soonestFirst } from "../renewals.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { type DayWords, readPastDay } from "./day-input.ts";
import type { RecordExpense } from "./expense-tools.ts";
import { isProblem } from "./quote-input.ts";
import { applyFields, editsSomething, readFields, readPeriodAmount, type RenewalDraft } from "./renewal-input.ts";
import { briefAnswer, fenced, listAnswer, renewalLine, renewalsCsv, summaryAnswer, upcomingAnswer } from "./renewal-render.ts";

const RENEWAL_OPS = ["add", "list", "upcoming", "summary", "renewed", "paid", "cancel", "reactivate", "edit", "remove", "export"] as const;
type Op = (typeof RENEWAL_OPS)[number];

const STATUSES = ["active", "cancelled", "all"] as const;
type Status = (typeof STATUSES)[number];

/** The longest look ahead of upcoming: a year and a day. */
const MAX_DAYS = 366;

/** What changed, for the audit: the op and how many renewals (or rows), never names, amounts, dates, notes or paths. */
export type RenewalEvent = { readonly type: "renewal.changed"; readonly op: "add" | "edit" | "renewed" | "cancel" | "reactivate" | "remove" | "export"; readonly count: number };

/**
 * The expenses' category of a renewal's payment (record_expense): the same where the expenses have
 * it, the closest otherwise, «altro» where there is none (insurance, memberships, licences,
 * service contracts). The person can change it with expenses op edit.
 */
export const EXPENSE_CATEGORY: Readonly<Record<Category, ExpenseCategory>> = {
	"software e abbonamenti": "software e abbonamenti",
	"dominio e hosting": "software e abbonamenti",
	assicurazione: "altro",
	"affitto e leasing": "affitto e utenze",
	utenze: "affitto e utenze",
	"telefono e internet": "telefono e internet",
	"associazioni e quote": "altro",
	"licenze e permessi": "altro",
	"contratti di servizio": "altro",
	altro: "altro",
};

export type RenewalToolsOptions = {
	readonly workspace: Workspace;
	readonly store: RenewalStore;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: RenewalEvent) => Promise<void>;
	/** The expenses' own add (expense-tools.ts expensesOf): record_expense's only way to record a payment. */
	readonly recordExpense?: RecordExpense;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Rinnovi e abbonamenti of the owner: recurring costs and deadlines that renew (software subscriptions, domains and hosting, insurance: auto, RC professionale, casa; rent and leasing, utilities, phone and internet, memberships, licences, contracts with tacit renewal and a notice period). Use it when they say something expires or renews («l'assicurazione dell'auto scade il 12 marzo, 480 euro l'anno», «Canva 12 euro al mese, carta»), ask what expires soon or what they spend on subscriptions, or say they paid or cancelled one.",
	"add: name (required: what renews), due (required: the next due date: 12/03/2027, «12 marzo» = its next occurrence, a month alone «giugno» = its last day), frequency (mensile, bimestrale, trimestrale, semestrale, annuale, biennale, «ogni 18 mesi»; a number is months; default annuale), amount (euros of one period, VAT included, as written), provider, category, auto_renew (true when it renews by itself: subscriptions charged on a card, contracts with tacit renewal), notice_days (the disdetta notice in days: «disdetta 30 giorni prima» = 30), remind_days (days before to tell in the brief; default 7 for monthly, 14 up to 5 months, 30 for 6 months and longer), method, note, document (the workspace path of the contract or policy you read with file_read: pass the fields you read from it).",
	`category: ${CATEGORIES.join(", ")} (polizza, fibra, dominio, Canva… are understood; otherwise guessed from the name, or altro).`,
	"list: status active (default) | cancelled | all, category; soonest due first. upcoming: what needs doing in the next days (default 30): overdue, «da disdire entro» (disdetta deadlines), «si rinnova» (tacit renewals), «da pagare»; compact true: the brief's line only.",
	"summary: the yearly cost of the active renewals and its monthly average, per category, the biggest, those without an amount.",
	"renewed (or paid): the person says it was paid or renewed: the due date moves one period on from the due date itself (never from today), once per call; record_expense true also records the payment in the expenses (amount: what was paid, when different from the renewal's amount; paid_on: the day paid, default today). Only when the person says so.",
	"A due date gone is never moved by itself: it shows as overdue until the person says it was paid (renewed) or cancelled (cancel). cancel: the disdetta was sent (date: when, default today; ends: the last day it is in force); it stays in the list as cancelled. reactivate: undo a cancel (due: the new next due date).",
	"edit: id + only what changes (\"\" removes provider, amount, notice_days, remind_days, method, note or document). remove: id (R-0001): deletes it for good, only when the person asks. id: the renewal's id (R-0001) or words of its name.",
	"export: a CSV for Excel under rinnovi/ (status, default all); then send it with file_send. Repeat dates, amounts and totals as given, never compute them yourself. For a reminder at an exact time use schedule_create; the morning brief already tells what is due.",
].join(" ");

const RENEWAL_PAID_DAY: DayWords = { field: "paid_on è il giorno del pagamento", future: "un pagamento si registra quando è fatto" };
const CANCEL_DAY: DayWords = { field: "date è il giorno della disdetta", future: "una disdetta si registra quando è mandata" };

/** Whether a renewal already holds exactly `draft` (its id, state and who did it aside). */
function sameDraft(draft: RenewalDraft, r: Renewal): boolean {
	const { id: _i, by: _b, at: _a, callId: _c, edited: _e, status: _s, cancelled: _x, lastRoll: _l, ...rest } = r;
	const canon = (o: object) => JSON.stringify(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
	return canon(draft) === canon(rest);
}

/**
 * Rinnovi (renewals.ts): recorded from a sentence or a contract read, listed, what is coming up,
 * the yearly cost, paid or renewed (one period on, and the payment as an expense when asked),
 * cancelled and reactivated, changed, removed, exported. Dates, amounts and ids are this tool's;
 * names, providers, notes and paths come from the person and are fenced.
 */
export function createRenewalTools(options: RenewalToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const today = () => todayIn(timeZone, now());
	const audit = async (ctx: ToolContext, op: RenewalEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "renewal.changed", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", minLength: 1, maxLength: max, description });
	const amount = { type: ["number", "string"] };
	return [
		{
			name: "renewals",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...RENEWAL_OPS] },
					id: text(RENEWAL_LIMITS.name, "renewed, cancel, reactivate, edit: the renewal's id (R-0001) or words of its name; remove: the id"),
					name: { type: "string", maxLength: RENEWAL_LIMITS.name, description: "add, edit: what renews, e.g. «Assicurazione auto», «Canva Pro», «Dominio rossi.it»" },
					provider: { type: "string", maxLength: RENEWAL_LIMITS.provider, description: "add, edit: who is paid (compagnia, fornitore)" },
					category: { type: "string", maxLength: 60, description: `add, edit, list: ${CATEGORIES.join(", ")}` },
					amount: { ...amount, description: "add, edit: euros of one period, VAT included; renewed: what was paid, for the expense, when different" },
					frequency: { ...amount, description: "add, edit: mensile, bimestrale, trimestrale, semestrale, annuale, biennale, «ogni 18 mesi»; a number is months" },
					due: text(60, "add, edit, reactivate: the next due date: 12/03/2027, «12 marzo», «giugno»"),
					auto_renew: { type: "boolean", description: "add, edit: true when it renews by itself (tacit renewal, card charged automatically)" },
					notice_days: { ...amount, description: "add, edit: days of notice for the disdetta before the due date" },
					remind_days: { ...amount, description: "add, edit: days before the due date (or the disdetta deadline) the brief starts telling" },
					method: { type: "string", maxLength: 60, description: `add, edit: ${METHODS.join(", ")}` },
					note: { type: "string", maxLength: RENEWAL_LIMITS.note, description: "add, edit: a note of the person's" },
					document: { type: "string", maxLength: RENEWAL_LIMITS.document, description: "add, edit: the workspace path of the contract or policy" },
					status: { type: "string", enum: [...STATUSES], description: "list: default active; export: default all" },
					days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: "upcoming: how many days ahead, default 30" },
					compact: { type: "boolean", description: "upcoming: the brief's line only (each renewal within its own reminder days, and the overdue)" },
					record_expense: { type: "boolean", description: "renewed: also record the payment in the expenses; default false" },
					paid_on: text(40, "renewed with record_expense: the day paid, default today"),
					date: text(40, "cancel: the day the disdetta was sent, default today"),
					ends: text(40, "cancel: the last day it is in force, if said"),
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!RENEWAL_OPS.includes(args.op as Op)) return `Errore: op è una di queste: ${RENEWAL_OPS.join(", ")}.`;
				const op = args.op as Op;
				// Another agente's request is not the person's word: it reads, it never records, changes or writes a file.
				if (ctx.thread?.channel === AGENT_CHANNEL && !renewalCallReads(args)) {
					return "Errore: in una richiesta di un altro agente non aggiungo, non cambio e non esporto rinnovi: lo fa chi ti scrive, nella sua conversazione.";
				}
				try {
					switch (op) {
						case "add":
							return await add(args, ctx);
						case "list":
							return list(args);
						case "upcoming":
							return upcoming(args);
						case "summary":
							return summary();
						case "renewed":
						case "paid":
							return await renewed(args, ctx);
						case "cancel":
							return await cancel(args, ctx);
						case "reactivate":
							return await reactivate(args, ctx);
						case "edit":
							return await edit(args, ctx);
						case "remove":
							return await remove(args, ctx);
						case "export":
							return await exportCsv(args, ctx);
					}
				} catch (error) {
					if (error instanceof RenewalError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function readable(): readonly Renewal[] {
		const book = store.read();
		if (book.broken) throw new RenewalError(RENEWALS_BROKEN);
		return book.renewals;
	}

	/** The one renewal an id or a name names (among those `which` allows), or the answer saying why not. */
	function pick(args: Record<string, unknown>, which: "active" | "cancelled" | "any"): Renewal | string {
		if (typeof args.id !== "string" || args.id.trim() === "") return "Errore: indica il rinnovo con id, per esempio R-0001, o con il suo nome.";
		const all = readable();
		const found = findRenewals(all, args.id);
		const allowed = found.filter((r) => which === "any" || r.status === which);
		if (allowed.length === 1) return allowed[0] as Renewal;
		if (allowed.length > 1) return `Errore: più rinnovi corrispondono:\n${fenced(allowed.slice(0, 10).map((r) => renewalLine(r, today())).join("\n"))}\nChiedi a chi ti scrive quale, poi rifai con id.`;
		const other = found[0];
		if (other !== undefined && found.length === 1) {
			if (which === "active") return `Errore: il rinnovo ${other.id} è disdetto. Se chi ti scrive vuole riprenderlo, prima op reactivate.`;
			if (which === "cancelled") return `Errore: il rinnovo ${other.id} è già attivo.`;
		}
		return `Errore: non trovo il rinnovo ${fenced(args.id.slice(0, 40))} tra i ${all.length} registrati. Guarda l'elenco con op list (status all).`;
	}

	/** What to say about a renewal's disdetta deadline gone while its due date is still ahead. */
	function deadlineGone(r: Renewal): string[] {
		const by = noticeDeadline(r);
		if (by === undefined || by >= today() || r.due < today()) return [];
		return [`Il termine per la disdetta era il ${italianDate(by)}: la scadenza del ${italianDate(r.due)} si rinnova. Dillo a chi ti scrive: «Per questa scadenza il termine di disdetta è passato (era il ${italianDate(by)}).»`];
	}

	async function add(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		// This call recorded its renewal already (run again after a stop): say it again, never record it twice.
		const saved = readable().find((r) => r.callId === ctx.callId);
		if (saved !== undefined) return added(saved, []);
		const fields = await readFields(args, { today: today(), workspace, editing: false });
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		const applied = applyFields(fields);
		if (isProblem(applied)) return `Errore: ${applied.problem}.`;
		const { draft, notes } = applied;
		const id = await ctx.step("save", async () => store.add(ctx.callId, (n) => ({ id: n, ...draft, status: "active", by: who(ctx), at: now().toISOString(), callId: ctx.callId })).id);
		await audit(ctx, "add", 1);
		const all = readable();
		const renewal = all.find((r) => r.id === id);
		if (renewal === undefined) return `Errore: il rinnovo ${id} non c'è più.`;
		const twin = lookalike(all, renewal);
		const warning = twin === undefined ? [] : [`Attenzione: sembra lo stesso di ${twin} (stesso nome). Chiedi a chi ti scrive: «Mi sembra lo stesso di ${twin}: è un doppione? Se sì, lo tolgo.» Solo se dice sì, togli questo con op remove.`];
		return added(renewal, [...warning, ...notes, ...deadlineGone(renewal)]);
	}

	function added(r: Renewal, notes: readonly string[]): string {
		const by = noticeDeadline(r);
		const when = by === undefined ? "della scadenza" : "della scadenza e della disdetta";
		const hints = [
			...notes,
			...(r.amount === undefined ? ["Importo non indicato: se chi ti scrive lo sa, aggiungilo con op edit (amount), così entra nei costi."] : []),
			`Nel brief del mattino lo segnalo da ${remindDays(r)} giorni prima ${when}.`,
		];
		return [`Aggiunto il rinnovo ${r.id}. Ripeti date e importo come sono scritti.`, fenced(renewalLine(r, today())), ...hints].join("\n");
	}

	function list(args: Record<string, unknown>): string {
		if (args.status !== undefined && !STATUSES.includes(args.status as Status)) return `Errore: status è uno di questi: ${STATUSES.join(", ")}.`;
		const status = (args.status ?? "active") as Status;
		let category: Category | undefined;
		if (typeof args.category === "string" && args.category.trim() !== "") {
			category = matchCategory(args.category);
			if (category === undefined) return `Errore: non riconosco la categoria. Sono queste: ${CATEGORIES.join(", ")}.`;
		}
		const shown = readable()
			.filter((r) => (status === "all" || r.status === status) && (category === undefined || r.category === category))
			.sort(soonestFirst);
		return listAnswer(shown, { status, ...(category === undefined ? {} : { category }) }, today());
	}

	function upcoming(args: Record<string, unknown>): string {
		const all = readable();
		const day = today();
		if (args.compact === true) return briefAnswer(agendaOf(all, day, addDays(day, MAX_DAYS), "remind"), day);
		const days = args.days === undefined ? 30 : args.days;
		if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) return `Errore: days è un numero di giorni da 1 a ${MAX_DAYS}.`;
		return upcomingAnswer(agendaOf(all, day, addDays(day, days)), days, day);
	}

	function summary(): string {
		const active = readable().filter((r) => r.status === "active");
		return summaryAnswer(costsOf(active), active.length);
	}

	async function renewed(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const found = pick(args, "active");
		// A rerun of a call that rolled it: said again, never rolled twice.
		if (typeof found === "string") {
			const done = readable().find((r) => r.lastRoll?.callId === ctx.callId);
			if (done === undefined) return found;
			return rolledAnswer(done, args, ctx);
		}
		if (found.lastRoll?.callId === ctx.callId) return rolledAnswer(found, args, ctx);
		if (args.record_expense === true) {
			if (options.recordExpense === undefined) return "Errore: qui non posso registrare la spesa: rinnova senza record_expense e registra la spesa con expenses op add.";
			const paid = readPeriodAmount(args.amount);
			if (isProblem(paid)) return `Errore: ${paid.problem}.`;
			if (paid === undefined && found.amount === undefined) return "Errore: per registrare la spesa serve l'importo pagato (amount): il rinnovo non ce l'ha. Chiedi a chi ti scrive quanto ha pagato.";
			const day = readPastDay(args.paid_on, today(), RENEWAL_PAID_DAY);
			if (isProblem(day)) return `Errore: ${day.problem}.`;
		}
		await ctx.step("roll", async () => {
			store.edit(found.id, (r) => {
				if (r.lastRoll?.callId === ctx.callId) return r;
				if (r.status !== "active") throw new RenewalError(`il rinnovo ${r.id} è disdetto: prima op reactivate`);
				const to = nextDue(r);
				return { ...r, due: to, lastRoll: { callId: ctx.callId, from: r.due, to, by: who(ctx), at: now().toISOString() } };
			});
			return true;
		});
		await audit(ctx, "renewed", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		return rolledAnswer(renewal, args, ctx);
	}

	/** The answer after a roll (the first time or on a rerun), with the expense recorded when asked. */
	async function rolledAnswer(r: Renewal, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const from = r.lastRoll?.from ?? r.due;
		const lines = [`Fatto: ${r.id} segnato come pagato o rinnovato. La prossima scadenza ora è il ${italianDate(r.due)} (era il ${italianDate(from)}).`, fenced(renewalLine(r, today()))];
		if (r.due < today()) lines.push(`Anche la scadenza del ${italianDate(r.due)} è passata: chiedi a chi ti scrive se ha pagato anche quella; se sì, rifai op renewed.`);
		if (args.record_expense === true && options.recordExpense !== undefined) {
			const paid = readPeriodAmount(args.amount);
			const amount = (isProblem(paid) ? undefined : paid) ?? r.amount;
			const day = readPastDay(args.paid_on, today(), RENEWAL_PAID_DAY);
			if (amount === undefined || isProblem(day)) lines.push("La spesa non l'ho registrata: manca l'importo o il giorno del pagamento non va bene. Registrala con expenses op add.");
			else {
				const expense = await options.recordExpense({ amount, date: day.date, category: EXPENSE_CATEGORY[r.category], supplier: r.provider ?? r.name, ...(r.method === undefined ? {} : { method: r.method }), note: `Rinnovo ${r.id}` }, ctx);
				if ("problem" in expense) lines.push(`Il rinnovo è segnato, ma la spesa non l'ho registrata: ${expense.problem}. Registrala con expenses op add.`);
				else lines.push(`Registrata anche la spesa ${expense.id}:`, fenced(expense.line));
			}
		}
		return lines.join("\n");
	}

	async function cancel(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const found = pick(args, "active");
		if (typeof found === "string") {
			const done = readable().find((r) => r.status === "cancelled" && typeof args.id === "string" && findRenewals([r], args.id).length === 1);
			return done?.cancelled === undefined ? found : `Il rinnovo ${done.id} era già segnato come disdetto il ${italianDate(done.cancelled.on)}.`;
		}
		const on = readPastDay(args.date, today(), CANCEL_DAY);
		if (isProblem(on)) return `Errore: ${on.problem}.`;
		let ends: string | undefined;
		if (args.ends !== undefined) {
			if (typeof args.ends !== "string") return "Errore: ends è una data, come 31/12/2026.";
			try {
				ends = readDate(args.ends, today(), { rule: "next" }).date;
			} catch (error) {
				if (error instanceof DateError) return `Errore: ends: ${error.message}.`;
				throw error;
			}
		}
		const by = noticeDeadline(found);
		await ctx.step("cancel", async () => {
			store.edit(found.id, (r) => (r.status === "cancelled" ? r : { ...r, status: "cancelled", cancelled: { on: on.date, ...(ends === undefined ? {} : { ends }), by: who(ctx), at: now().toISOString() } }));
			return true;
		});
		await audit(ctx, "cancel", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		const late = by !== undefined && on.date > by && found.due >= on.date ? [`Il termine per la disdetta era il ${italianDate(by)}: chiedi a chi ti scrive di verificare con il fornitore se vale già per la scadenza del ${italianDate(found.due)}. Digli: «La disdetta è arrivata dopo il termine del ${italianDate(by)}: controlla con il fornitore se la scadenza del ${italianDate(found.due)} si paga ancora.»`] : [];
		return [`Fatto, ${renewal.id} segnato come disdetto: resta nell'elenco dei disdetti e non lo segnalo più.`, fenced(renewalLine(renewal, today())), ...late].join("\n");
	}

	async function reactivate(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const found = pick(args, "cancelled");
		if (typeof found === "string") return found;
		let due: { date: string; day: number } | undefined;
		if (args.due !== undefined) {
			const read = readDue(args.due, today());
			if (isProblem(read)) return `Errore: ${read.problem}.`;
			due = read;
		}
		await ctx.step("reactivate", async () => {
			store.edit(found.id, (r) => {
				if (r.status === "active") return r;
				const { cancelled: _c, ...rest } = r;
				return { ...rest, status: "active", ...(due === undefined ? {} : { due: due.date, day: due.day }), edited: { by: who(ctx), at: now().toISOString() } };
			});
			return true;
		});
		await audit(ctx, "reactivate", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		const late = renewal.due < today() ? [`La scadenza del ${italianDate(renewal.due)} è passata: chiedi a chi ti scrive la prossima scadenza e correggila con op edit (due).`] : [];
		return [`Fatto, ${renewal.id} è di nuovo attivo.`, fenced(renewalLine(renewal, today())), ...late].join("\n");
	}

	async function edit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const found = pick(args, "any");
		if (typeof found === "string") return found;
		if (!editsSomething(args)) return "Errore: dimmi cosa cambia nel rinnovo (nome, fornitore, categoria, importo, frequenza, scadenza, rinnovo tacito, preavviso, promemoria, pagamento, nota o documento).";
		const fields = await readFields(args, { today: today(), workspace, editing: true });
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		// Checked first on the renewal as read, to answer plainly; applied under the lock to the renewal as saved then.
		const check = applyFields(fields, found);
		if (isProblem(check)) return `Errore: ${check.problem}.`;
		if (sameDraft(check.draft, found)) return `Niente da cambiare: il rinnovo ${found.id} è già così.\n${fenced(renewalLine(found, today()))}`;
		const notes = await ctx.step("apply", async () => {
			let said: string[] = [];
			store.edit(found.id, (r) => {
				const applied = applyFields(fields, r);
				if (isProblem(applied)) throw new RenewalError(applied.problem);
				said = applied.notes;
				const keep = { id: r.id, by: r.by, at: r.at, status: r.status, ...(r.callId === undefined ? {} : { callId: r.callId }), ...(r.cancelled === undefined ? {} : { cancelled: r.cancelled }), ...(r.lastRoll === undefined ? {} : { lastRoll: r.lastRoll }) };
				return { ...keep, ...applied.draft, edited: { by: who(ctx), at: now().toISOString() } };
			});
			return said;
		});
		await audit(ctx, "edit", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		return [`Fatto, il rinnovo ${renewal.id} ora è:`, fenced(renewalLine(renewal, today())), ...notes, ...(renewal.status === "active" ? deadlineGone(renewal) : [])].join("\n");
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const n = typeof args.id === "string" ? parseRenewalId(args.id) : undefined;
		if (n === undefined) return "Errore: per togliere un rinnovo indica il suo id, per esempio R-0001 (guarda l'elenco con op list status all). Per una disdetta usa op cancel, che lo tiene nello storico.";
		const id = renewalId(n);
		const line = await ctx.step("resolve", async () => {
			const r = readable().find((x) => x.id === id);
			return r === undefined ? null : renewalLine(r, today());
		});
		const result = await ctx.step("apply", async () => store.remove(id));
		if (result === "unknown") return `Errore: non trovo il rinnovo ${id}. Guarda l'elenco con op list (status all).`;
		if (result === "gone") return `Il rinnovo ${id} era già stato tolto.`;
		await audit(ctx, "remove", 1);
		return `Fatto, tolto il rinnovo ${id}; il suo numero non sarà riusato.${line === null ? "" : `\n${fenced(line)}`}`;
	}

	async function exportCsv(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		if (args.status !== undefined && !STATUSES.includes(args.status as Status)) return `Errore: status è uno di questi: ${STATUSES.join(", ")}.`;
		const status = (args.status ?? "all") as Status;
		const rows = readable()
			.filter((r) => status === "all" || r.status === status)
			.sort(soonestFirst);
		if (rows.length === 0) return "Nessun rinnovo da esportare.";
		const day = today();
		// The name only from today's date, under rinnovi/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `rinnovi/rinnovi-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, renewalsCsv(rows, day))).path);
		await audit(ctx, "export", rows.length);
		return `Salvato ${written} (${rows.length === 1 ? "1 rinnovo" : `${rows.length} rinnovi`}; separatore «;», decimali con la virgola, si apre con Excel). Mandalo con file_send se chi ti scrive lo vuole.`;
	}
}
