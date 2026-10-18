import { AGENT_CHANNEL } from "../agent-messages.ts";
import { BRIEF_DAYS, CASHFLOW_LIMITS, type CashItem, CashflowError, cashflowCallWrites, parseItemId, signedCents, STALE_BALANCE_DAYS } from "../cashflow.ts";
import { project, type Projection } from "../cashflow-projection.ts";
import { averageSpend, type Hypothetical, hypotheticalFlows, invoiceFlows, itemFlows, type Movement, renewalFlows, unbilledPotential } from "../cashflow-sources.ts";
import { CASHFLOW_BROKEN, type CashflowStore, latestBalance } from "../cashflow-store.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { register } from "../invoices.ts";
import { addDays, daysBetween, todayIn } from "../italian-calendar.ts";
import { italianLongDate as long } from "../italian-format.ts";
import type { RenewalStore } from "../renewal-store.ts";
import type { TimesheetStore } from "../timesheet-store.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { type DayWords, readPastDay } from "./day-input.ts";
import { readHorizon, readHypothetical, readItemFields, readSignedEuros } from "./cashflow-input.ts";
import { briefAnswer, fenced, forecastAnswer, itemLine, listAnswer, projectionCsv, staleLine, type View, whatIfAnswer } from "./cashflow-render.ts";
import { euros } from "./expense-render.ts";
import { isProblem } from "./quote-input.ts";

const CASHFLOW_OPS = ["set_balance", "add_item", "remove_item", "list_items", "forecast", "what_if", "export"] as const;
type Op = (typeof CASHFLOW_OPS)[number];

/** What changed, for the audit: the op and how many (balances, voci, rows), never amounts, names, notes or dates. */
export type CashflowEvent = { readonly type: "cashflow.changed"; readonly op: "set_balance" | "add_item" | "remove_item" | "export"; readonly count: number };

export type CashflowToolsOptions = {
	readonly workspace: Workspace;
	readonly store: CashflowStore;
	/** The other registers, read only: the scadenzario (company and paid marks), the expenses, the renewals, the hours. */
	readonly invoices: Pick<InvoiceStore, "read">;
	/** The scadenzario's scanner of the same workspace, shared (one cache); one of its own otherwise. */
	readonly scanner?: InvoiceScanner;
	readonly expenses: Pick<ExpenseStore, "read">;
	readonly renewals: Pick<RenewalStore, "read">;
	readonly timesheet: Pick<TimesheetStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: CashflowEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Previsione di cassa of the owner: how much money there will be on the bank account, day by day, from the balance they say plus what comes in and goes out (open invoices to collect and to pay by due date, renewals, the average spending of the expenses, the voci added here).",
	"What the person says → op: «ho 3.200 euro sul conto» → set_balance; «quanti soldi avrò a fine mese?», «come sono messo nei prossimi 90 giorni?», «quando vado in rosso?» → forecast (horizon); «posso permettermi un computer da 2000 euro a dicembre?» → what_if (amount, date, name; nothing is saved); «ogni mese mi prendo 1500 di stipendio», «a novembre pago l'F24 di 800», «il cliente X mi paga 2000 a fine mese senza fattura» → add_item.",
	"set_balance: amount (euros on the account, a minus when overdrawn), date (default today, never in the future); alert_below: the balance under which the morning brief warns (default 0, \"\" removes). The forecast starts from the latest balance: when it is old, ask for today's.",
	"add_item: kind entrata | uscita, amount (euros, always positive), name (what it is: stipendio del titolare, F24, rata mutuo…), date (12/11/2026, «il 27», «ogni 27 del mese», «fine mese», «dicembre» = its last day), frequency (mensile, trimestrale, annuale, «ogni 2 mesi»; none: once), until (last day of a recurring voce), note. Only what is not already an invoice, a renewal or an expense. remove_item: id (C-0001). list_items: the balance, the threshold and the voci.",
	"forecast: horizon («fine mese», «30 giorni», «90 giorni», «3 mesi», «fino a dicembre», «fine anno», a date; or days; default 30 days); include_overdue (default true: invoices to collect already overdue counted today, as if paid now; false leaves them out); include_average_spend (default true: the expenses of the last 90 days as a daily estimate); compact true: the brief's line only.",
	`what_if: the same as forecast plus hypothetical voci (amount, date, kind default uscita, frequency, name), or several in items (at most ${CASHFLOW_LIMITS.whatIf}); it answers with the new lowest point and the day in red, and saves nothing.`,
	"export: the daily projection as a CSV for Excel under cassa/ (horizon as forecast); then send it with file_send. Unbilled hours are not counted (not invoiced yet). Repeat amounts and dates as given, never compute them yourself.",
].join(" ");

const BALANCE_DAY: DayWords = { field: "date è il giorno del saldo", future: "il saldo si dice per oggi o un giorno passato" };

/**
 * La previsione di cassa (cashflow.ts): the balance and the voci kept here; the forecast and the
 * what_if from the other registers, read only; the daily CSV. Amounts, dates and ids are this
 * tool's; names of clients, suppliers, renewals and voci, and notes, are fenced.
 */
export function createCashflowTools(options: CashflowToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const scanner = options.scanner ?? new InvoiceScanner(workspace);
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const today = () => todayIn(timeZone, now());
	const audit = async (ctx: ToolContext, op: CashflowEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "cashflow.changed", op, count });
			return true;
		});
	};
	const amount = { type: ["number", "string"] };
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const hypothetical = {
		type: "object",
		properties: { amount, date: text(60, "the day"), kind: text(20, "entrata | uscita, default uscita"), frequency: { ...amount, description: "mensile, trimestrale…; none: once" }, name: text(CASHFLOW_LIMITS.name, "what it is") },
		required: ["amount", "date"],
		additionalProperties: false,
	};
	return [
		{
			name: "cashflow",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...CASHFLOW_OPS] },
					amount: { ...amount, description: "set_balance: euros on the account (a minus when overdrawn); add_item, what_if: euros of the voce, positive" },
					date: text(60, "set_balance: the day of the balance (default today); add_item, what_if: the day of the voce"),
					alert_below: { ...amount, description: "set_balance: the brief warns below this balance; \"\" removes" },
					kind: text(20, "add_item, what_if: entrata | uscita"),
					name: text(CASHFLOW_LIMITS.name, "add_item, what_if: what it is"),
					frequency: { ...amount, description: "add_item, what_if: mensile, bimestrale, trimestrale, semestrale, annuale, «ogni N mesi»; none: once" },
					until: text(60, "add_item: the last day of a recurring voce"),
					note: text(CASHFLOW_LIMITS.note, "add_item: a note of the person's"),
					id: text(40, "remove_item: the voce's id, C-0001"),
					items: { type: "array", maxItems: CASHFLOW_LIMITS.whatIf, items: hypothetical, description: "what_if: several hypothetical voci" },
					horizon: text(60, "forecast, what_if, export: «fine mese», «90 giorni», «3 mesi», «fino a dicembre», «fine anno», a date; default 30 days"),
					days: { type: "integer", minimum: 1, maximum: CASHFLOW_LIMITS.maxDays, description: "forecast, what_if, export: days ahead instead of horizon" },
					include_overdue: { type: "boolean", description: "forecast, what_if, export: count invoices to collect already overdue today (default true)" },
					include_average_spend: { type: "boolean", description: "forecast, what_if, export: the average daily spending of the last 90 days as an estimate (default true)" },
					compact: { type: "boolean", description: "forecast: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!CASHFLOW_OPS.includes(args.op as Op)) return `Errore: op è una di queste: ${CASHFLOW_OPS.join(", ")}.`;
				const op = args.op as Op;
				// Another agente's request is not the person's word: it reads, it never sets, adds, removes or writes a file.
				if (ctx.thread?.channel === AGENT_CHANNEL && cashflowCallWrites(args)) {
					return "Errore: in una richiesta di un altro agente non cambio il saldo, non aggiungo o tolgo voci e non esporto la cassa: lo fa chi ti scrive, nella sua conversazione.";
				}
				try {
					switch (op) {
						case "set_balance":
							return await setBalance(args, ctx);
						case "add_item":
							return await addItem(args, ctx);
						case "remove_item":
							return await removeItem(args, ctx);
						case "list_items":
							return listItems();
						case "forecast":
							return await forecast(args, ctx);
						case "what_if":
							return await whatIf(args, ctx);
						case "export":
							return await exportCsv(args, ctx);
					}
				} catch (error) {
					if (error instanceof CashflowError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function readable() {
		const book = store.read();
		if (book.broken) throw new CashflowError(CASHFLOW_BROKEN);
		return book;
	}

	async function setBalance(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const balance = readSignedEuros(args.amount, fenced, "amount");
		if (isProblem(balance)) return `Errore: ${balance.problem}.`;
		let alert: string | null | undefined;
		if (args.alert_below === "" || args.alert_below === null) alert = null;
		else {
			const read = readSignedEuros(args.alert_below, fenced, "alert_below");
			if (isProblem(read)) return `Errore: ${read.problem}.`;
			alert = read;
		}
		if (balance === undefined && alert === undefined) return "Errore: dimmi il saldo del conto (amount), o la soglia sotto cui avvisare (alert_below).";
		const day = readPastDay(args.date, today(), BALANCE_DAY);
		if (isProblem(day)) return `Errore: ${day.problem}.`;
		if (balance === undefined && args.date !== undefined) return "Errore: date va con amount, il saldo di quel giorno.";
		await ctx.step("apply", async () => {
			store.setBalance(balance === undefined ? undefined : { amount: balance, date: day.date, by: who(ctx), at: now().toISOString(), callId: ctx.callId }, alert);
			return true;
		});
		await audit(ctx, "set_balance", 1);
		const book = readable();
		const latest = latestBalance(book.balances);
		const lines: string[] = [];
		if (balance !== undefined) {
			lines.push(`Fatto, saldo del ${long(day.date)}: ${listAmount(balance)}.`);
			if (latest !== undefined && latest.date > day.date) lines.push(`C'è già un saldo più recente, del ${long(latest.date)}: la previsione parte da quello.`);
			const stale = latest === undefined ? undefined : staleLine(latest, today(), STALE_BALANCE_DAYS);
			if (stale !== undefined) lines.push(stale);
		}
		if (alert === null) lines.push("Tolta la soglia: il brief avvisa solo se il saldo previsto va sotto zero.");
		else if (alert !== undefined) lines.push(`Il brief avvisa se nei prossimi ${BRIEF_DAYS} giorni il saldo previsto scende sotto ${listAmount(alert)}.`);
		lines.push("Per sapere come va nei prossimi giorni, op forecast.");
		return lines.join("\n");
	}

	function listAmount(value: string): string {
		return euros(signedCents(value));
	}

	async function addItem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		// This call recorded its voce already (run again after a stop): its audit, then the same answer.
		const saved = readable().items.find((i) => i.callId === ctx.callId);
		if (saved !== undefined) {
			await audit(ctx, "add_item", 1);
			return added(saved, []);
		}
		const name = typeof args.name === "string" ? args.name.trim() : "";
		if (name === "") return "Errore: serve name, cos'è la voce (stipendio del titolare, F24, rata del mutuo, incasso dal cliente…).";
		if (name.length > CASHFLOW_LIMITS.name) return `Errore: name è al massimo ${CASHFLOW_LIMITS.name} caratteri.`;
		const note = typeof args.note === "string" && args.note.trim() !== "" ? args.note.trim() : undefined;
		if (note !== undefined && note.length > CASHFLOW_LIMITS.note) return `Errore: note è al massimo ${CASHFLOW_LIMITS.note} caratteri.`;
		const fields = readItemFields(args, today(), fenced);
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		const item = await ctx.step("save", async () =>
			store.add(ctx.callId, (id) => ({
				id,
				kind: fields.kind,
				amount: fields.amount,
				name,
				date: fields.date,
				...(fields.months === undefined ? {} : { months: fields.months, day: fields.day as number }),
				...(fields.until === undefined ? {} : { until: fields.until }),
				...(note === undefined ? {} : { note }),
				by: who(ctx),
				at: now().toISOString(),
				callId: ctx.callId,
			})),
		);
		await audit(ctx, "add_item", 1);
		return added(item, fields.notes);
	}

	function added(i: CashItem, notes: readonly string[]): string {
		return [`Aggiunta la voce ${i.id}. Ripeti date e importo come sono scritti.`, fenced(itemLine(i, today())), ...notes, "Entra nella previsione (op forecast); si toglie con op remove_item."].join("\n");
	}

	async function removeItem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const n = typeof args.id === "string" ? parseItemId(args.id) : undefined;
		if (n === undefined) return "Errore: indica la voce con id, per esempio C-0001 (le vedi con op list_items).";
		const id = `C-${String(n).padStart(4, "0")}`;
		const line = await ctx.step("resolve", async () => {
			const item = readable().items.find((i) => i.id === id);
			return item === undefined ? null : itemLine(item, today());
		});
		const result = await ctx.step("apply", async () => store.remove(id));
		if (result === "unknown") return `Errore: non trovo la voce ${id}. Guarda l'elenco con op list_items.`;
		if (result === "gone" && line === null) return `La voce ${id} era già stata tolta.`;
		await audit(ctx, "remove_item", 1);
		return `Fatto, tolta la voce ${id}; il suo numero non sarà riusato.${line === null ? "" : `\n${fenced(line)}`}`;
	}

	function listItems(): string {
		const book = readable();
		return listAnswer(latestBalance(book.balances), book.alertBelow === undefined ? undefined : signedCents(book.alertBelow), book.items, today());
	}

	type Gathered = { readonly movements: readonly Movement[]; readonly dailySpend: bigint; readonly view: View; readonly somethingToForecast: boolean };

	/** What every register says from today to `end`, read only. */
	async function gather(ctx: ToolContext, end: string, o: { includeOverdue: boolean; includeAverage: boolean }): Promise<Gathered | string> {
		const day = today();
		const book = readable();
		const balance = latestBalance(book.balances);
		if (balance === undefined) return "Errore: per la previsione serve il saldo del conto. Chiedi a chi ti scrive quanto ha sul conto oggi e salvalo con op set_balance (amount).";
		const scan = await scanner.scan(ctx.signal, (t) => ctx.progress(t));
		const invoiceBook = options.invoices.read();
		const invoices = invoiceBook.broken ? [] : register(scan.invoices, invoiceBook.paid, invoiceBook.company, invoiceBook.reminders);
		const inv = invoiceFlows(invoices, day, end, o.includeOverdue);
		const renewalBook = options.renewals.read();
		const ren = renewalBook.broken ? undefined : renewalFlows(renewalBook.renewals, day, end);
		const expenseBook = options.expenses.read();
		const average = o.includeAverage && !expenseBook.broken ? averageSpend(expenseBook.expenses, renewalBook.renewals, day) : undefined;
		const hours = options.timesheet.read();
		const potential = hours.broken ? undefined : unbilledPotential(hours.entries, hours.rates);
		const movements = [...inv.movements, ...(ren?.movements ?? []), ...itemFlows(book.items, day, end)];
		const notes: string[] = [];
		if (o.includeAverage && average !== undefined && average.count === 0) notes.push("Nessuna spesa registrata negli ultimi 90 giorni: niente spesa media nella previsione.");
		if (!o.includeAverage) notes.push("Spesa media esclusa (include_average_spend false): contate solo fatture, rinnovi e voci.");
		const view: View = {
			today: day,
			balance,
			...(book.alertBelow === undefined ? {} : { alertBelow: signedCents(book.alertBelow) }),
			includeOverdue: o.includeOverdue,
			invoices: inv,
			invoiceNotes: { companySet: invoiceBook.company !== undefined, broken: invoiceBook.broken, unread: scan.unread.length, found: invoices.length },
			...(ren === undefined ? {} : { renewals: ren }),
			renewalsBroken: renewalBook.broken,
			...(average === undefined || average.count === 0 ? {} : { average }),
			expensesBroken: expenseBook.broken,
			...(potential === undefined ? {} : { potential }),
			notes,
		};
		const openInvoices = invoices.some((i) => !i.paid && i.side !== undefined && !i.doc.integration);
		const activeRenewals = renewalBook.renewals.some((r) => r.status === "active");
		return { movements, dailySpend: average?.count === 0 ? 0n : (average?.perDay ?? 0n), view, somethingToForecast: openInvoices || activeRenewals };
	}

	function flags(args: Record<string, unknown>): { includeOverdue: boolean; includeAverage: boolean } | string {
		for (const k of ["include_overdue", "include_average_spend", "compact"]) if (args[k] !== undefined && typeof args[k] !== "boolean") return `Errore: ${k} è true o false.`;
		return { includeOverdue: args.include_overdue !== false, includeAverage: args.include_average_spend !== false };
	}

	function startOf(view: View): bigint {
		return signedCents(view.balance.amount);
	}

	async function forecast(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const f = flags(args);
		if (typeof f === "string") return f;
		const day = today();
		if (args.compact === true) {
			const book = readable();
			const balance = latestBalance(book.balances);
			if (balance === undefined) return briefAnswer(undefined, { today: day, somethingToForecast: false });
			const g = await gather(ctx, addDays(day, BRIEF_DAYS), { includeOverdue: true, includeAverage: true });
			if (typeof g === "string") return g;
			const p = project(startOf(g.view), g.movements, day, addDays(day, BRIEF_DAYS), g.dailySpend);
			return briefAnswer(p, { balance, today: day, ...(g.view.alertBelow === undefined ? {} : { alertBelow: g.view.alertBelow }), somethingToForecast: g.somethingToForecast });
		}
		const horizon = readHorizon(args.horizon, args.days, day);
		if (isProblem(horizon)) return `Errore: ${horizon.problem}.`;
		const g = await gather(ctx, horizon.end, f);
		if (typeof g === "string") return g;
		return forecastAnswer(project(startOf(g.view), g.movements, day, horizon.end, g.dailySpend), g.view);
	}

	async function whatIf(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const f = flags(args);
		if (typeof f === "string") return f;
		const day = today();
		const raw: unknown[] = Array.isArray(args.items) ? args.items : [];
		if (args.amount !== undefined || args.date !== undefined) raw.unshift({ amount: args.amount, date: args.date, ...(args.kind === undefined ? {} : { kind: args.kind }), ...(args.frequency === undefined ? {} : { frequency: args.frequency }), ...(args.name === undefined ? {} : { name: args.name }) });
		if (raw.length === 0) return "Errore: dimmi l'ipotesi: amount e date (e kind, frequency, name), o più ipotesi in items.";
		if (raw.length > CASHFLOW_LIMITS.whatIf) return `Errore: al massimo ${CASHFLOW_LIMITS.whatIf} ipotesi per volta.`;
		const hyps: Hypothetical[] = [];
		for (const r of raw) {
			const h = readHypothetical(r, day, fenced);
			if (isProblem(h)) return `Errore: ${h.problem}.`;
			hyps.push(h);
		}
		const horizon = readHorizon(args.horizon, args.days, day);
		if (isProblem(horizon)) return `Errore: ${horizon.problem}.`;
		// Not said: far enough to see a month past the last hypothesis, within a year and a day.
		let end = horizon.end;
		if (!horizon.said) {
			const last = hyps.reduce((d, h) => (h.date > d ? h.date : d), day);
			const wanted = addDays(last, BRIEF_DAYS);
			const cap = addDays(day, CASHFLOW_LIMITS.maxDays);
			if (wanted > end) end = wanted > cap ? cap : wanted;
		}
		const outside = hyps.filter((h) => h.date > end);
		if (outside.length > 0) return `Errore: l'ipotesi del ${long(outside[0]?.date as string)} cade dopo la fine della previsione (${long(end)}): allarga horizon.`;
		const g = await gather(ctx, end, f);
		if (typeof g === "string") return g;
		const start = startOf(g.view);
		const base = project(start, g.movements, day, end, g.dailySpend);
		const withThem = project(start, [...g.movements, ...hypotheticalFlows(hyps, day, end)], day, end, g.dailySpend);
		return whatIfAnswer(base, withThem, hyps, g.view);
	}

	async function exportCsv(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const f = flags(args);
		if (typeof f === "string") return f;
		const day = today();
		const horizon = readHorizon(args.horizon, args.days, day);
		if (isProblem(horizon)) return `Errore: ${horizon.problem}.`;
		const g = await gather(ctx, horizon.end, f);
		if (typeof g === "string") return g;
		const p: Projection = project(startOf(g.view), g.movements, day, horizon.end, g.dailySpend);
		const csv = projectionCsv(p, g.view.balance.date, day);
		// The name only from today's date, under cassa/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `cassa/previsione-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		const rows = csv.split("\r\n").length - 4;
		await audit(ctx, "export", rows);
		return `Salvato ${written} (dal ${long(day)} al ${long(horizon.end)}, ${daysBetween(day, horizon.end) + 1} giorni; separatore «;», decimali con la virgola, si apre con Excel). Saldo previsto il ${long(horizon.end)}: ${euros(p.end)}. Mandalo con file_send se chi ti scrive lo vuole.`;
	}
}
