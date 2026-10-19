/**
 * The tool `recurring_invoices`: le fatture ricorrenti (canoni). The person says once «canone
 * mensile di manutenzione 300 € a Rossi srl»; every period Annie prepares the sales invoice DRAFT
 * (recurring-invoice-run.ts, with sales_invoices' own draft builder) and says so in the
 * conversation it was set in. She never issues, numbers or sends it: the person issues it with
 * sales_invoices. Another agente gets only how many there are and the monthly amount, never a
 * customer; the audit only the op and a count.
 */
import { AGENT_CHANNEL } from "../agent-messages.ts";
import { type Candidate, FORM_NOTE, findNamed } from "../client-find.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import { todayIn } from "../italian-calendar.ts";
import { withDate } from "../italian-format.ts";
import type { Marker } from "../marker.ts";
import { RECURRING_BROKEN, type RecurringState } from "../recurring-invoice-store.ts";
import { CADENCE_NAMES, CADENCE_WORDS, type Cadence, type DueDay, periodLabel, periodOn, RECURRING_LIMITS, RECURRING_OPS, type RecurringCustomer, RecurringError, type RecurringLine, type RecurringOp, type RecurringTerms, type Run, type Schedule, scheduleId, within } from "../recurring-invoices.ts";
import { FIELD_LIMITS, RITENUTA_CAUSALI } from "../sales-invoice-rules.ts";
import { isIssued, SalesInvoiceError } from "../sales-invoices.ts";
import { cleanText } from "../text-input.ts";
import { WorkspaceError } from "../workspace.ts";
import { isProblem, periodCents, readCadence, readCount, readDay, readMonth, readNote, readScheduleLines, readTerms } from "./recurring-invoice-input.ts";
import { agentAnswer, fencedRecurring, listAnswer, NO_SCHEDULES, nextDue, type Shown, showAnswer } from "./recurring-invoice-render.ts";
import { draftCallId, preparePeriod, type RecurringEnv, type RecurringEvent } from "./recurring-invoice-run.ts";
import { findBuyer } from "./sales-invoice-buyer.ts";
import { readBuyerFields } from "./sales-invoice-input.ts";

export type { RecurringEvent } from "./recurring-invoice-run.ts";

export type RecurringToolsOptions = RecurringEnv & {
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
};

const DESCRIPTION = [
	"Le fatture ricorrenti (canoni): an invoice to the same customer every month, two months, quarter, six months or year. Annie prepares the sales invoice DRAFT of each period by herself, on its day, and says so in this conversation; she never issues it, never numbers it and never sends it: the person issues it with sales_invoices after seeing it.",
	"What the person says → op: «canone mensile di manutenzione 300 € a Rossi srl dal 1° ottobre» → add (customer, lines [{description «Canone di manutenzione», price 300}], cadence monthly, day 1, start «ottobre»); «ogni trimestre, a fine mese» → cadence quarterly, day «fine mese»; «per 12 mesi», «fino a dicembre 2027» → count or end; a voce of the listino → a line with item; «quali canoni ho?» → list; «fammi vedere il canone di Rossi» → show (customer, or id RI-0001); «sospendi / riprendi il canone di Rossi» → pause / resume; «porta il canone di Rossi a 350» → change with amount (a schedule of one line) or lines; «togli il canone di Rossi» → remove; «prepara adesso la fattura del canone di Rossi», «riprova» → run_now (the period of today; never two drafts for the same period).",
	"The period is added to each line's description («Canone di manutenzione, ottobre 2026», «…, 4º trimestre 2026») unless the description has {mese} or {periodo}; the note may have them too. The customer must be a client's card or a customer already invoiced: a new one is saved first with clients, or invoiced once. The draft's terms (vat, natura, ritenuta, cassa, bollo_to_client, payment_days, method, iban) as sales_invoices takes them, only as the person says them. Repeat amounts and dates as given, never compute them yourself.",
].join(" ");

/**
 * Le fatture ricorrenti: the schedules kept here; each period's draft made by the sweep or by
 * run_now with the same env (recurring-invoice-run.ts). Today is read once per call.
 */
export function createRecurringInvoiceTools(options: RecurringToolsOptions): AnnieTool[] {
	const env: RecurringEnv = options;
	const { store, timeZone, sales } = env;
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: env.now().toISOString() });
	const audit = async (ctx: ToolContext, op: RecurringEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step(`audit-${op}`, async () => {
			await env.record?.({ type: "recurring_invoices.changed", op, count });
			return true;
		});
	};
	const src = { ...(sales.priceList === undefined ? {} : { priceList: sales.priceList }), company: sales.company, taxes: sales.taxes };
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const line = {
		type: "object",
		properties: {
			item: text(120, "a voce of the listino (price_list): its name as said or LS-0001; its price is the listino's at each draft"),
			description: text(FIELD_LIMITS.descrizione - RECURRING_LIMITS.label, "as said, without the period (added by itself); {mese} or {periodo} to place it"),
			quantity: { type: ["number", "string"], description: "default 1" },
			unit: text(FIELD_LIMITS.unitaMisura, "«ore», «pz»"),
			price: { type: ["number", "string"], description: "unit price, VAT excluded" },
			discount: { type: ["number", "string"], description: "percent" },
			vat: { type: ["number", "string"], description: "this line's rate, when it differs" },
			natura: text(5, "this line's nature at 0%"),
			reference: text(FIELD_LIMITS.riferimentoNormativo, "the law of a 0% line, as said"),
			advance: { type: "boolean", description: "a spesa anticipata in nome e per conto del cliente (N1)" },
		},
		additionalProperties: false,
	};
	return [
		{
			name: "recurring_invoices",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...RECURRING_OPS] },
					id: text(12, "show, pause, resume, change, remove, run_now: the recurring invoice's id, RI-0001"),
					customer: text(200, "add: the customer as said, partita IVA, or card id CL-0001; show, pause, resume, change, remove, run_now: whose recurring invoice"),
					vat_number: text(40, "add: the customer's partita IVA, to tell apart two customers of the same name"),
					cf: text(20, "add: the customer's codice fiscale, the same"),
					lines: { type: "array", maxItems: RECURRING_LIMITS.lines, items: line, description: "add, change: the lines of every invoice" },
					amount: { type: ["number", "string"], description: "change: the new price of a recurring invoice with one line" },
					cadence: { type: "string", enum: [...CADENCE_NAMES], description: "add, change: every month, two months, quarter, six months, year" },
					day: { type: ["integer", "string"], description: "add, change: the day of the month the draft is prepared, 1 to 28, or «fine mese» (default 1)" },
					start: text(40, "add, change: the first month invoiced, «ottobre», «ottobre 2026», «2026-10» (default this month)"),
					end: text(40, "add, change: the last month a period may start in, as said; «mai» clears it"),
					count: { type: ["integer", "string"], description: "add, change: how many invoices in all; «mai» clears it" },
					note: text(RECURRING_LIMITS.note, "add, change: the invoice's causale, with {mese} or {periodo} if wanted; «niente» clears it"),
					vat: { type: ["number", "string"], description: "add, change: VAT rate of the lines (22, 10, 5, 4, 0)" },
					natura: text(5, "add, change: nature of the 0% lines"),
					reference: text(FIELD_LIMITS.riferimentoNormativo, "add, change: the law of the 0% lines, as said"),
					ritenuta: { anyOf: [{ type: "boolean" }, { type: "string", enum: [...RITENUTA_CAUSALI] }], description: "add, change: only as the person says" },
					cassa: {
						type: "object",
						properties: { kind: { type: "string", enum: ["rivalsa_inps", "contributo_integrativo"] }, type: text(4, "TC01…TC21, for a cassa"), rate: { type: ["number", "string"] } },
						required: ["kind"],
						additionalProperties: false,
					},
					bollo_to_client: { type: "boolean" },
					split_payment: { type: "boolean" },
					payment_days: { type: "integer", minimum: 0, maximum: 365 },
					end_of_month: { type: "boolean" },
					method: text(20, "bonifico (default), contanti, assegno, carta, riba, rid, pagopa"),
					iban: text(40, "default the first IBAN saved with the company"),
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!RECURRING_OPS.includes(args.op as RecurringOp)) return "Errore: non conosco questa operazione sulle fatture ricorrenti.";
				const op = args.op as RecurringOp;
				// Another agente's request is not the person's word: the totals only, never by a customer.
				const agent = ctx.thread?.channel === AGENT_CHANNEL;
				if (agent && (op !== "list" || args.customer !== undefined || args.id !== undefined)) {
					return "Errore: a un altro agente do solo quante fatture ricorrenti ci sono e quanto valgono al mese, in tutto. Non le cambio, non preparo bozze e non dico per quali clienti; il resto lo chiede chi ti scrive, nella sua conversazione.";
				}
				const day = todayIn(timeZone, env.now());
				try {
					switch (op) {
						case "add":
							return await add(args, ctx, day);
						case "list":
							return agent ? agentAnswer(schedules().map((s) => shown(s, day))) : listAnswer(schedules().map((s) => shown(s, day)));
						case "show":
							return show(args, day);
						case "pause":
						case "resume":
							return await setStatus(args, ctx, day, op);
						case "change":
							return await change(args, ctx, day);
						case "remove":
							return await remove(args, ctx);
						case "run_now":
							return await runNow(args, ctx, day);
					}
				} catch (error) {
					if (error instanceof RecurringError || error instanceof SalesInvoiceError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function book() {
		const b = store.read();
		if (b.broken) throw new RecurringError(RECURRING_BROKEN);
		return b;
	}

	function schedules(): readonly Schedule[] {
		return book().schedules;
	}

	function runsOf(id: string): readonly Run[] {
		return book().runs.filter((r) => r.schedule === id);
	}

	function shown(s: Schedule, day: string): Shown {
		const runs = runsOf(s.id);
		const last = [...runs].sort((a, b) => (a.period < b.period ? -1 : 1)).at(-1);
		const cents = periodCents(src, s);
		const next = nextDue(s, day, new Set(runs.map((r) => r.period)));
		return { schedule: s, ...(cents === undefined ? {} : { cents }), ...(last === undefined ? {} : { last }), ...(next === undefined ? {} : { next }) };
	}

	/** The customer said for a new recurring invoice: a card, or a customer already invoiced; else what to say. */
	function customerOf(args: Record<string, unknown>, notes: string[]): RecurringCustomer | string {
		const said = cleanText(args.customer, 200, "il cliente");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi a quale cliente va la fattura ricorrente.";
		const fields = readBuyerFields(args);
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		const cardBook = sales.clients?.read();
		const cards = cardBook === undefined || cardBook.broken ? [] : cardBook.cards;
		const salesBook = sales.store.read();
		const invoices = salesBook.broken ? [] : salesBook.invoices;
		const found = findBuyer(said, cards, invoices, { ...(fields.vat === undefined ? {} : { vat: fields.vat }), ...(fields.cf === undefined ? {} : { cf: fields.cf }) });
		if (found.kind === "close") return ["Intendi uno di questi? Non so dire quale:", fencedRecurring(found.candidates.map((c) => `• ${c}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui o con la sua partita IVA."].join("\n");
		if (found.kind === "conflict") return [fencedRecurring(`${found.known.name} che conosco ha ${found.id}.`), "Chiedi a chi ti scrive se è lo stesso cliente: se sì, ripeti senza quella partita IVA o codice fiscale; se è un altro, va salvato prima tra i clienti."].join("\n");
		if (found.kind === "none") {
			return [
				"Non trovo questo cliente tra le schede dei clienti né tra quelli già fatturati:",
				fencedRecurring(said),
				"Per preparare ogni volta la bozza servono i suoi dati per la fattura elettronica (partita IVA o codice fiscale, indirizzo, codice destinatario o PEC): chiedili a chi ti scrive e salvalo prima tra i clienti (o fagli prima una fattura), poi metto la fattura ricorrente.",
			].join("\n");
		}
		if (found.form === true) notes.push(FORM_NOTE);
		const k = found.known;
		if (k.card !== undefined) return { name: k.card.name.slice(0, 200), card: k.card.id };
		const b = k.previous;
		return { name: k.name.slice(0, 200), ...(b?.vat === undefined ? {} : { vat: b.vat }), ...(b?.cf === undefined ? {} : { cf: b.cf }) };
	}

	type Shape = Pick<Schedule, "customer" | "lines" | "terms" | "cadence" | "day" | "start" | "end" | "count" | "note">;

	/** The schedule as said now, over the one kept (a change); what to say instead when something does not read. */
	function shapeOf(args: Record<string, unknown>, day: string, notes: string[], kept?: Schedule): Shape | string {
		const customer = kept !== undefined && args.customer === undefined ? kept.customer : customerOf(args, notes);
		if (typeof customer === "string") return customer;
		const terms = readTerms(args, kept?.terms);
		if (isProblem(terms)) return `Errore: ${terms.problem}.`;
		let lines: readonly RecurringLine[] | undefined = kept?.lines;
		if (args.lines !== undefined || kept === undefined) {
			const read = readScheduleLines(src, args.lines, terms);
			if (isProblem(read)) return `Errore: ${read.problem}.`;
			if ("ask" in read) return read.ask;
			lines = read;
		} else if (args.amount !== undefined) {
			if (lines === undefined || lines.length !== 1) return "Errore: questa fattura ricorrente ha più voci: dimmi tutte le voci con i prezzi nuovi.";
			const read = readScheduleLines(src, [{ ...lines[0], price: args.amount }], terms);
			if (isProblem(read)) return `Errore: ${read.problem}.`;
			if ("ask" in read) return read.ask;
			lines = read;
		} else if (args.vat !== undefined || args.natura !== undefined) {
			// The lines read again with the terms now: a voce whose rate no longer fits is said now.
			const read = readScheduleLines(src, lines, terms);
			if (isProblem(read)) return `Errore: ${read.problem}.`;
			if ("ask" in read) return read.ask;
		}
		const cadence = readCadence(args.cadence);
		if (isProblem(cadence)) return `Errore: ${cadence.problem}.`;
		if (cadence === undefined && kept === undefined) return "Errore: dimmi ogni quanto: ogni mese, ogni due mesi, ogni trimestre, ogni sei mesi o ogni anno.";
		const dueDay = readDay(args.day);
		if (isProblem(dueDay)) return `Errore: ${dueDay.problem}.`;
		const start = readMonth(args.start, day, "first", "il primo mese");
		if (isProblem(start)) return `Errore: ${start.problem}.`;
		const end = readMonth(args.end, day, "last", "l'ultimo mese", true);
		if (isProblem(end)) return `Errore: ${end.problem}.`;
		const count = readCount(args.count);
		if (isProblem(count)) return `Errore: ${count.problem}.`;
		const note = readNote(args.note);
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const first = start ?? kept?.start ?? day.slice(0, 7);
		const last = end === null ? undefined : (end ?? kept?.end);
		// «mai» for the end clears the number of invoices too: it never ends.
		const many = count === null || end === null ? undefined : (count ?? kept?.count);
		if (last !== undefined && last < first) return "Errore: l'ultimo mese viene prima del primo.";
		const text = note === null ? undefined : (note ?? kept?.note);
		return {
			customer,
			lines: lines as readonly RecurringLine[],
			terms,
			cadence: (cadence ?? kept?.cadence) as Cadence,
			day: (dueDay ?? kept?.day ?? 1) as DueDay,
			start: first,
			...(last === undefined ? {} : { end: last }),
			...(many === undefined ? {} : { count: many }),
			...(text === undefined ? {} : { note: text }),
		};
	}

	function customerKey(c: RecurringCustomer): string {
		return c.card ?? c.vat ?? c.cf ?? `name:${c.name.toLowerCase()}`;
	}

	function sameShape(a: Shape, b: Shape): boolean {
		return customerKey(a.customer) === customerKey(b.customer) && a.cadence === b.cadence && JSON.stringify(a.lines) === JSON.stringify(b.lines);
	}

	function sameAll(a: Shape, b: Shape): boolean {
		return (["customer", "lines", "terms", "cadence", "day", "start", "end", "count", "note"] as const).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
	}

	async function add(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const done = schedules().find((s) => s.callId === ctx.callId);
		if (done !== undefined) return answerFor("Fatto, nuova fattura ricorrente", done, day, []);
		const notes: string[] = [];
		const shape = shapeOf(args, day, notes);
		if (typeof shape === "string") return shape;
		const twin = schedules().find((s) => sameShape(s, shape));
		if (twin !== undefined) return answerFor(`C'è già una fattura ricorrente uguale, non ne ho fatta un'altra: ${twin.id}`, twin, day, ["Se è un'altra davvero, dimmi cosa cambia."]);
		const thread = ctx.thread !== undefined && ctx.thread.channel !== AGENT_CHANNEL ? { channel: ctx.thread.channel, threadId: ctx.thread.threadId } : undefined;
		const by = marker(ctx);
		const id = await ctx.step("apply", async () => {
			let made = "";
			const outcome = store.update(ctx.callId, (state): RecurringState => {
				if (state.schedules.length >= RECURRING_LIMITS.schedules) throw new RecurringError(`ci sono già ${RECURRING_LIMITS.schedules} fatture ricorrenti, il massimo: togline qualcuna prima`);
				made = scheduleId(state.nextId);
				const s: Schedule = { ...by, id: made, ...shape, status: "active", from: day, ...(thread === undefined ? {} : { thread }), callId: ctx.callId };
				return { nextId: state.nextId + 1, schedules: [...state.schedules, s] };
			});
			return outcome === "rerun" ? (schedules().find((s) => s.callId === ctx.callId)?.id ?? "") : made;
		});
		await audit(ctx, "add", 1);
		const saved = schedules().find((s) => s.id === id);
		return saved === undefined ? "Fatto." : answerFor("Fatto, nuova fattura ricorrente", saved, day, notes);
	}

	function answerFor(head: string, s: Schedule, day: string, notes: readonly string[]): string {
		const x = shown(s, day);
		const body = showAnswer(x).split("\n");
		const first = body.shift() ?? "";
		return [`${head} ${first}`, ...body, ...notes, "Ogni periodo preparo la bozza e lo dico qui: la emette chi ti scrive, dopo averla vista. Non la emetto e non la mando io."].join("\n");
	}

	/** The schedule `args` names: by id, else by customer (the one they have); what to say otherwise. */
	function named(args: Record<string, unknown>, verb: string): Schedule | string {
		const all = schedules();
		if (all.length === 0) return NO_SCHEDULES;
		if (args.id !== undefined) {
			const id = typeof args.id === "string" ? args.id.trim().toUpperCase() : "";
			return all.find((s) => s.id === id) ?? "Errore: non c'è una fattura ricorrente con questo numero.";
		}
		if (args.customer === undefined) {
			if (all.length === 1) return all[0] as Schedule;
			return `Errore: dimmi quale fattura ricorrente ${verb}: il cliente o il numero (RI-0001).`;
		}
		const said = cleanText(args.customer, 200, "il cliente");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		// One candidate per customer: its recurring invoices together.
		const groups = new Map<string, Schedule[]>();
		for (const s of all) groups.set(customerKey(s.customer), [...(groups.get(customerKey(s.customer)) ?? []), s]);
		const candidates: Candidate<Schedule[]>[] = [...groups.values()].map((list) => {
			const c = (list[0] as Schedule).customer;
			return { item: list, names: [c.name], ...(c.vat === undefined ? {} : { vat: c.vat.replace(/^IT/, "") }), ...(c.cf === undefined ? {} : { cf: c.cf }), ...(c.card === undefined ? {} : { ids: [c.card] }) };
		});
		const found = findNamed(candidates, said ?? "", 200);
		if (found.kind === "none") return ["Non c'è una fattura ricorrente per questo cliente:", fencedRecurring(said ?? ""), listAnswer(all.map((s) => shown(s, todayIn(timeZone, env.now()))))].join("\n");
		if (found.kind === "close") {
			const list = found.candidates.flat();
			// Among the person's own recurring invoices one close name is the one meant: its id is in every answer.
			if (list.length === 1) return list[0] as Schedule;
			return ["Intendi una di queste? Non so dire quale:", fencedRecurring(list.map((s) => `• ${s.id}: ${s.customer.name}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il numero (RI-0001)."].join("\n");
		}
		const list = found.item;
		if (list.length === 1) return list[0] as Schedule;
		return [`Questo cliente ha ${list.length} fatture ricorrenti: quale ${verb}?`, ...list.map((s) => `• ${s.id}: ${periodLabel({ cadence: "monthly" }, s.start)}, ${CADENCE_WORDS[s.cadence]}`), "Ripeti con il numero (RI-0001)."].join("\n");
	}

	function show(args: Record<string, unknown>, day: string): string {
		if (args.id === undefined && args.customer === undefined) return listAnswer(schedules().map((s) => shown(s, day)));
		const s = named(args, "vedere");
		return typeof s === "string" ? s : showAnswer(shown(s, day));
	}

	async function setStatus(args: Record<string, unknown>, ctx: ToolContext, day: string, op: "pause" | "resume"): Promise<string> {
		const done = book().calls.includes(ctx.callId);
		const s = named(args, op === "pause" ? "sospendere" : "riprendere");
		if (typeof s === "string") return s;
		const status = op === "pause" ? "paused" : "active";
		if (!done && s.status === status) return op === "pause" ? `${s.id} è già in pausa: non preparo bozze finché non la riprendi.` : `${s.id} è già attiva.`;
		const by = marker(ctx);
		await ctx.step("apply", async () => {
			store.update(ctx.callId, (state) => ({ ...state, schedules: state.schedules.map((x) => (x.id === s.id ? { ...x, status, ...(op === "resume" ? { from: day } : {}), edited: by } : x)) }));
			return true;
		});
		await audit(ctx, op, 1);
		const now = schedules().find((x) => x.id === s.id) ?? s;
		if (op === "pause") return `Fatto, ${s.id} è in pausa: non preparo bozze finché non la riprendi. Le bozze già preparate restano.`;
		const next = shown(now, day).next;
		return `Fatto, ${s.id} riprende${next === undefined ? ", ma i suoi periodi sono finiti" : `: la prossima bozza è di ${periodLabel(now, periodOn(now, next) ?? now.start)}, ${next === day ? "oggi stesso" : withDate("il", next)}`}. I periodi passati mentre era in pausa non li preparo.`;
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const s = named(args, "cambiare");
		if (typeof s === "string") return s;
		if (book().calls.includes(ctx.callId)) return answerFor("Fatto, ho cambiato", s, day, []);
		const notes: string[] = [];
		// The customer named here is whose it is, not a new one.
		const shape = shapeOf({ ...args, customer: undefined }, day, notes, s);
		if (typeof shape === "string") return shape;
		const by = marker(ctx);
		const outcome = await ctx.step("apply", async () =>
			store.update(ctx.callId, (state) => {
				const old = state.schedules.find((x) => x.id === s.id);
				if (old === undefined) throw new RecurringError("la fattura ricorrente non c'è più");
				if (sameAll(old, shape)) return state;
				const { end: _e, count: _c, note: _n, ...rest } = old;
				const next: Schedule = { ...rest, ...shape, edited: by };
				return { ...state, schedules: state.schedules.map((x) => (x.id === s.id ? next : x)) };
			}),
		);
		if (outcome === "unchanged") return answerFor("Era già così, non ho cambiato niente:", s, day, []);
		await audit(ctx, "change", 1);
		const saved = schedules().find((x) => x.id === s.id) ?? s;
		return answerFor("Fatto, ho cambiato", saved, day, [...notes, "Vale dalle prossime bozze: quelle già preparate restano come sono."]);
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const done = book().calls.includes(ctx.callId);
		if (done) return "Fatto, la fattura ricorrente è tolta. Le bozze già preparate restano.";
		const s = named(args, "togliere");
		if (typeof s === "string") return s;
		await ctx.step("apply", async () => {
			store.update(ctx.callId, (state) => ({ ...state, schedules: state.schedules.filter((x) => x.id !== s.id) }));
			return true;
		});
		await audit(ctx, "remove", 1);
		return `Fatto, ho tolto la fattura ricorrente ${s.id}: non preparo più bozze. Quelle già preparate restano tra le bozze delle fatture.`;
	}

	/** The draft of today's period, now: once per period (a period already drafted is said); one that failed is tried again. */
	async function runNow(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const s = named(args, "preparare");
		if (typeof s === "string") return s;
		const period = periodOn(s, day);
		if (period === undefined) return `${s.id} comincia da ${periodLabel({ cadence: "monthly" }, s.start)}: la prima bozza la preparo allora.`;
		if (!within(s, period)) return `I periodi di ${s.id} sono finiti: non ci sono altre bozze da preparare.`;
		const label = periodLabel(s, period);
		const p = await preparePeriod(env, s, period, { retry: true, signal: ctx.signal });
		if (p.kind !== "handled") store.markTold(s.id, period);
		if (p.kind === "drafted") return [`Fatto, ho preparato la bozza ${p.draft.id} del canone di ${label} (fattura ricorrente ${s.id}). È solo una bozza, senza numero: la emette chi ti scrive, dopo averla vista.`, p.answer].join("\n");
		if (p.kind === "failed") return [`Non ho potuto preparare la bozza del canone di ${label} (fattura ricorrente ${s.id}). Ecco cosa manca, dalla preparazione della bozza:`, p.run.why ?? "", "Quando è sistemato, posso riprovare."].join("\n");
		const run = p.run;
		if (run.state === "drafted") {
			const inv = sales.store.read().invoices.find((i) => i.callId === draftCallId(s, period));
			if (inv !== undefined && isIssued(inv)) return `La fattura del canone di ${label} è già emessa (n. ${inv.number}): non ne preparo un'altra per lo stesso periodo.`;
			return `La bozza del canone di ${label} è già pronta: ${run.draft ?? inv?.id ?? ""}. Non ne preparo un'altra per lo stesso periodo.`;
		}
		return `La bozza del canone di ${label} è in preparazione: riprova tra poco.`;
	}
}
