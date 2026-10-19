import { AGENT_CHANNEL } from "../agent-messages.ts";
import { BUDGETS_BROKEN, type BudgetState, type BudgetStore } from "../budget-store.ts";
import { alertsOf, type BudgetFacts, type Progress, progressOf } from "../budget-sums.ts";
import { BUDGET_LIMITS, BUDGET_OPS, type Budget, budgetAgentReads, BudgetError, budgetId, type BudgetOp, type BudgetSubject, type Every, sameTarget, subjectKey } from "../budgets.ts";
import { sourcesOf } from "../business-report-sums.ts";
import { formNote } from "../client-find.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import type { Expense } from "../expenses.ts";
import { cents as expenseCents } from "../expense-sums.ts";
import { euros } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { type Invoice, register } from "../invoices.ts";
import { dayOfIn, todayIn } from "../italian-calendar.ts";
import { withDate } from "../italian-format.ts";
import type { Marker } from "../marker.ts";
import { legalForm, spellingKey } from "../name-keys.ts";
import type { SalesInvoiceStore } from "../sales-invoice-store.ts";
import { ledgerOf, type Supplier, suppliersOf } from "../supplier-sums.ts";
import type { SupplierStore } from "../supplier-store.ts";
import { isProblem } from "../text-input.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { readBudgetAmount, readEvery, readStart, readTarget, type SaidTarget } from "./budget-input.ts";
import { BRIEF_NOTHING, briefAnswer, budgetsCsv, fencedBudgets, listAnswer, NO_BUDGETS, perWords, progressLines, statusAnswer, subjectWords, supplierLine } from "./budget-render.ts";
import { findSupplier } from "./supplier-tools.ts";

/** What changed, for the audit: the op and how many, never what a budget is on, amounts or names. */
export type BudgetEvent = { readonly type: "budgets.changed"; readonly op: "set" | "remove" | "export"; readonly count: number };

export type BudgetToolsOptions = {
	readonly workspace: Workspace;
	readonly store: BudgetStore;
	/** The registers, read only through their own stores: the scadenzario (paid marks, the company), the fatture in uscita, the expenses, the supplier cards. */
	readonly invoices: Pick<InvoiceStore, "read">;
	/** The scadenzario's scanner of the same workspace, shared (one cache); one of its own otherwise. */
	readonly scanner?: InvoiceScanner;
	readonly sales?: Pick<SalesInvoiceStore, "read">;
	readonly expenses: Pick<ExpenseStore, "read">;
	readonly suppliers?: Pick<SupplierStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: BudgetEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Budget e obiettivi the person sets, followed from the registers that exist and never changing them: a spending limit on one expense category, one supplier or all the spending (expenses and supplier invoices paid, each payment once), or an income target on the fatturato (imponibile of the invoices issued, by date) or the incassato (money in, by the day paid), each per month, quarter or year.",
	"What the person says → op: «metti un budget di 300 € al mese per il software» → set (target «software», amount 300, every month); «obiettivo di 60.000 € di fatturato quest'anno» → set (target fatturato, every year); «un tetto di 500 € al mese con Aruba» → set with supplier; «quanto ho speso per il software questo mese rispetto al budget?», «come vado con l'obiettivo di fatturato?», «sono in linea per arrivarci?» → status with target (or supplier); «quali budget sto sforando?» → status without target; «quali budget ho?» → list; «togli il budget viaggi» → remove (target, or id BU-0001); «fammi il file dei budget» → export, then file_send.",
	"Setting a budget again on the same thing for the same kind of period replaces it. How the business is doing (fatturato, margine, a period against another) is business_report: budgets is only for the limits and targets the person set. Estimates are linear and indicative: say so. summary of the brief: status with compact true. Repeat amounts and shares as given, never compute them yourself.",
].join(" ");

/**
 * Budget e obiettivi (budgets.ts): the budgets kept here, every figure read from the other
 * registers through their own stores and the shared scanner, never written. Only set, remove and
 * the export change anything (and the brief's status, which marks its alerts as said). Today is
 * read once per call.
 */
export function createBudgetTools(options: BudgetToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const scanner = options.scanner ?? new InvoiceScanner(workspace);
	const dayOf = dayOfIn(timeZone);
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: BudgetEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "budgets.changed", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	return [
		{
			name: "budgets",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...BUDGET_OPS] },
					target: text(60, "set, remove, status: an expense category as said («software», «viaggi», «carburante»), «tutto» (all the spending), «fatturato» or «incassato»"),
					supplier: text(BUDGET_LIMITS.name, "set, remove, status: a supplier instead of target: name as said, partita IVA or card id FO-0001"),
					amount: { type: ["number", "string"], description: "set: euros, as said («300», «60.000», «60k»)" },
					every: { type: "string", enum: ["month", "quarter", "year"], description: "set: per month, quarter or year (default: month for spending, year for a target); remove: which one, when there are two" },
					start: text(40, "set: from when it counts, if not now: «novembre», «2027», «01/11/2026»"),
					id: text(12, "remove, status: the budget's id, BU-0001"),
					compact: { type: "boolean", description: "status: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!BUDGET_OPS.includes(args.op as BudgetOp)) return "Errore: non conosco questa operazione sui budget.";
				const op = args.op as BudgetOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è true o false.";
				// Another agente's request is not the person's word: the figures only, nothing else.
				const agent = ctx.thread?.channel === AGENT_CHANNEL;
				if (agent && !budgetAgentReads(args)) return "Errore: a un altro agente do solo come vanno i budget, in cifre e percentuali: non li cambio, non do i nomi dei fornitori e non esporto. Il resto lo chiede chi ti scrive, nella sua conversazione.";
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "set":
							return await set(args, ctx, day);
						case "remove":
							return await remove(args, ctx);
						case "status":
							return args.compact === true ? await brief(ctx, day) : await status(args, ctx, day, agent);
						case "list":
							return listAnswer(budgets());
						case "export":
							return await exportCsv(ctx, day);
					}
				} catch (error) {
					if (error instanceof BudgetError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function budgets(): readonly Budget[] {
		const book = store.read();
		if (book.broken) throw new BudgetError(BUDGETS_BROKEN);
		return book.budgets;
	}

	type Loaded = { readonly facts: BudgetFacts; readonly suppliers: readonly Supplier[]; readonly notes: string[] };

	/** Every register, read once; one that does not read is said, never guessed, and nothing is written. */
	async function load(ctx: ToolContext, day: string): Promise<Loaded> {
		const notes: string[] = [];
		const book = options.invoices.read();
		let invoices: Invoice[] | undefined;
		if (book.broken) notes.push("Lo stato delle fatture non si legge: fatture emesse e ricevute qui non ci sono.");
		else {
			const scan = await scanner.scan(ctx.signal, (t) => ctx.progress(t));
			invoices = register(scan.invoices, book.paid, book.company, book.reminders);
			if (book.company === undefined && invoices.length > 0) notes.push("Non so ancora qual è la tua azienda nelle fatture: senza, non distinguo le emesse dalle ricevute e qui non ci sono.");
		}
		const salesBook = options.sales?.read();
		if (salesBook?.broken === true) notes.push("Le fatture in uscita non si leggono: il loro fatturato qui non c'è.");
		const expenseBook = options.expenses.read();
		if (expenseBook.broken) notes.push("Il registro delle spese non si legge: le spese qui non ci sono.");
		const cardBook = options.suppliers?.read();
		const expenses: readonly Expense[] | undefined = expenseBook.broken ? undefined : expenseBook.expenses;
		const sources = sourcesOf(
			{
				...(invoices === undefined ? {} : { invoices }),
				...(salesBook?.broken === true ? {} : { sales: salesBook?.invoices ?? [] }),
				...(expenses === undefined ? {} : { expenses }),
				marks: [],
				tax: { kind: "none", why: "no_regime" },
			},
			day,
			dayOf,
		);
		const suppliers = suppliersOf({ cards: cardBook === undefined || cardBook.broken ? [] : cardBook.cards, invoices: invoices ?? [], expenses: expenses ?? [], renewals: [] });
		const ledger = ledgerOf(invoices ?? [], expenses ?? [], dayOf);
		const supplierOf = (s: Extract<BudgetSubject, { kind: "supplier" }>): Supplier | undefined => {
			if (s.vat !== undefined) return suppliers.find((x) => x.vat === s.vat);
			if (s.cf !== undefined) return suppliers.find((x) => x.cf === s.cf);
			if (s.card !== undefined) return suppliers.find((x) => x.card?.id === s.card);
			const found = findSupplier(suppliers, s.name);
			return found.kind === "exact" ? found.supplier : undefined;
		};
		return { facts: { sources, ledger, supplierOf }, suppliers, notes };
	}

	/** The supplier said for a budget: the one found (with a note when only its legal form differs), or the answer to give instead. */
	function supplierSaid(suppliers: readonly Supplier[], said: string): { subject: Extract<BudgetSubject, { kind: "supplier" }>; note?: string } | string {
		const found = findSupplier(suppliers, said);
		if (found.kind === "none") return ["Non trovo questo fornitore tra schede, fatture ricevute e spese:", fencedBudgets(said), "Chiedi a chi ti scrive come si chiama nelle fatture, o la partita IVA."].join("\n");
		if (found.kind === "close") {
			return [
				found.candidates.length === 1 ? "Intendi questo fornitore? Nessuno si chiama esattamente così, ma questo ha un nome simile:" : "Intendi uno di questi? Nessun fornitore si chiama esattamente così; quelli con un nome simile sono:",
				fencedBudgets(found.candidates.map((c) => `• ${c.name}${c.vat === undefined ? "" : ` (partita IVA ${c.vat})`}`).join("\n")),
				`Chiedi a chi ti scrive ${found.candidates.length === 1 ? "se è lui" : "quale"}, e ripeti con il nome scritto come qui o con la partita IVA.`,
			].join("\n");
		}
		const s = found.supplier;
		const subject: Extract<BudgetSubject, { kind: "supplier" }> = {
			kind: "supplier",
			name: s.name.slice(0, BUDGET_LIMITS.name),
			...(s.vat !== undefined ? { vat: s.vat } : s.cf !== undefined ? { cf: s.cf } : s.card !== undefined ? { card: s.card.id } : {}),
		};
		return { subject, ...(found.form === true ? { note: formNote("fornitore", legalForm(said) !== undefined) } : {}) };
	}

	async function set(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const target = readTarget(args);
		if (target === undefined) return "Errore: dimmi su cosa è il budget: una categoria delle spese, un fornitore, tutto, fatturato o incassato.";
		if (isProblem(target)) return `Errore: ${target.problem}.`;
		const amount = readBudgetAmount(args.amount);
		if (amount === undefined) return "Errore: dimmi quanto, in euro.";
		if (isProblem(amount)) return `Errore: ${amount.problem}.`;
		const said = readEvery(args.every);
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		const start = readStart(args.start, day);
		if (isProblem(start)) return `Errore: ${start.problem}.`;
		budgets();
		const loaded = await load(ctx, day);
		let subject: BudgetSubject;
		const notes: string[] = [];
		if ("supplier" in target) {
			const found = supplierSaid(loaded.suppliers, target.supplier);
			if (typeof found === "string") return found;
			subject = found.subject;
			if (found.note !== undefined) notes.push(found.note);
		} else subject = target.subject;
		const every: Every = said ?? (subject.kind === "income" ? "year" : "month");
		const by = marker(ctx);
		const applied = await ctx.step("apply", async () => {
			let id = "";
			let replaced = false;
			const wrote = store.update(
				ctx.callId,
				(state): BudgetState => {
					const old = state.budgets.find((b) => sameTarget(b, { subject, every }));
					replaced = old !== undefined;
					if (old === undefined && state.budgets.length >= BUDGET_LIMITS.budgets) throw new BudgetError(`ci sono già ${BUDGET_LIMITS.budgets} budget, il massimo: togline qualcuno prima`);
					id = old?.id ?? budgetId(state.nextId);
					const made: Budget = { id, subject, amount, every, ...(start === undefined ? {} : { start }), callId: ctx.callId, ...(old === undefined ? by : { by: old.by, at: old.at, edited: by }) };
					return old === undefined ? { nextId: state.nextId + 1, budgets: [...state.budgets, made] } : { ...state, budgets: state.budgets.map((b) => (b.id === id ? made : b)) };
				},
			);
			if (!wrote) {
				// Run again: the budget this call set.
				const mine = budgets().find((b) => b.callId === ctx.callId);
				return { id: mine?.id ?? "", replaced: false };
			}
			return { id, replaced };
		});
		await audit(ctx, "set", 1);
		const saved = budgets().find((b) => b.id === applied.id);
		if (saved === undefined) return "Fatto.";
		const income = saved.subject.kind === "income";
		const lines = [
			`Fatto, ${applied.replaced ? `ho aggiornato ${income ? "l'obiettivo" : "il budget"}` : income ? "nuovo obiettivo" : "nuovo budget"} ${saved.id}: ${subjectWords(saved.subject)}${saved.subject.kind === "supplier" ? " (nel riquadro)" : ""}, ${euros(expenseCents(saved.amount))} ${perWords(saved.every)}${saved.start === undefined ? "" : `, ${withDate("dal", saved.start)}`}.`,
			...notes,
		];
		lines.push(...progressLines(progressOf(saved, loaded.facts, day)).slice(0, 2));
		lines.push(...loaded.notes);
		const inside = supplierLine(saved);
		if (inside !== undefined) lines.push(fencedBudgets(inside));
		return lines.join("\n");
	}

	/** The budgets `args` names: by id, by target (and kind of period when said), or by supplier. */
	async function named(args: Record<string, unknown>, ctx: ToolContext, day: string, all: readonly Budget[]): Promise<{ list: Budget[]; what: string } | string> {
		if (args.id !== undefined) {
			const id = typeof args.id === "string" ? args.id.trim().toUpperCase() : "";
			const b = all.find((x) => x.id === id);
			return b === undefined ? "Errore: non c'è un budget con questo numero." : { list: [b], what: id };
		}
		const target: SaidTarget | undefined | { problem: string } = readTarget(args);
		if (target === undefined) return { list: [...all], what: "" };
		if (isProblem(target)) return `Errore: ${target.problem}.`;
		const every = readEvery(args.every);
		if (isProblem(every)) return `Errore: ${every.problem}.`;
		let keys: string[];
		if ("supplier" in target) {
			const loaded = await load(ctx, day);
			const found = supplierSaid(loaded.suppliers, target.supplier);
			const said = spellingKey(target.supplier);
			// A supplier no longer in the registers is still found by the name it was set with.
			const byName = all.filter((b) => b.subject.kind === "supplier" && spellingKey(b.subject.name) === said).map((b) => subjectKey(b.subject));
			if (typeof found === "string" && byName.length === 0) return found;
			keys = [...byName, ...(typeof found === "string" ? [] : [subjectKey(found.subject)])];
		} else keys = [subjectKey(target.subject)];
		const list = all.filter((b) => keys.includes(subjectKey(b.subject)) && (every === undefined || b.every === every));
		return { list, what: "supplier" in target ? "fornitore" : subjectWords(target.subject) };
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const day = todayIn(timeZone, now());
		// A call run again after it removed: the same answer, from the step.
		const all = budgets();
		const found = args.id === undefined && args.target === undefined && args.supplier === undefined ? "Errore: dimmi quale budget togliere: su cosa è, o il suo numero (BU-0001)." : await named(args, ctx, day, all);
		const done = store.read().calls.includes(ctx.callId);
		if (typeof found === "string" && !done) return found;
		const list = typeof found === "string" ? [] : found.list;
		if (!done && list.length === 0) return "Non c'è un budget su questo: non c'è niente da togliere.";
		if (!done && list.length > 1) return [`Ci sono ${list.length} budget su questo: quale tolgo?`, ...list.map((b) => `• ${b.id}: ${subjectWords(b.subject)}, ${euros(expenseCents(b.amount))} ${perWords(b.every)}`), "Ripeti con il numero del budget."].join("\n");
		const gone = list[0];
		const said = await ctx.step("apply", async () => {
			if (gone === undefined) return "";
			store.update(ctx.callId, (state) => ({ ...state, budgets: state.budgets.filter((b) => b.id !== gone.id) }));
			return `${gone.id}: ${subjectWords(gone.subject)}, ${euros(expenseCents(gone.amount))} ${perWords(gone.every)}`;
		});
		await audit(ctx, "remove", 1);
		return said === "" ? "Fatto, il budget è tolto." : `Fatto, ho tolto il budget ${said}.`;
	}

	async function status(args: Record<string, unknown>, ctx: ToolContext, day: string, agent: boolean): Promise<string> {
		const all = budgets();
		if (all.length === 0) return NO_BUDGETS;
		const found = await named(args, ctx, day, all);
		if (typeof found === "string") return found;
		if (found.list.length === 0) return `Non c'è un budget su questo. ${listAnswer(all)}`;
		const loaded = await load(ctx, day);
		return statusAnswer(
			found.list.map((b) => progressOf(b, loaded.facts, day)),
			{ agent, notes: loaded.notes },
		);
	}

	/** The brief's line: the alerts not said yet in this period, marked said (each once). */
	async function brief(ctx: ToolContext, day: string): Promise<string> {
		const all = budgets();
		if (all.length === 0) return BRIEF_NOTHING;
		const loaded = await load(ctx, day);
		const progress: Progress[] = all.map((b) => progressOf(b, loaded.facts, day));
		const wanted = progress.flatMap((p) => alertsOf(p).map((level) => ({ budget: p.budget.id, period: p.period.slug, level })));
		if (wanted.length === 0) return BRIEF_NOTHING;
		const claims = await ctx.step("claim", async () => store.claim(ctx.callId, wanted));
		return briefAnswer(claims, progress);
	}

	async function exportCsv(ctx: ToolContext, day: string): Promise<string> {
		const all = budgets();
		if (all.length === 0) return NO_BUDGETS;
		const loaded = await load(ctx, day);
		const csv = budgetsCsv(all.map((b) => progressOf(b, loaded.facts, day)));
		// The name only from today's date, under budget/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `budget/budget-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		await audit(ctx, "export", all.length);
		return [`Salvato ${written}: ${all.length === 1 ? "un budget" : `${all.length} budget`}, con quanto speso o incassato nel periodo in corso, la percentuale, quanto resta e la stima a fine periodo (separatore «;», si apre con Excel).`, ...loaded.notes, "Mandalo con file_send se chi ti scrive lo vuole."].join("\n");
	}
}
