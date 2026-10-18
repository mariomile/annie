/**
 * The estratto conto's writes to the other registers, each only on the person's yes: confirming a
 * match marks the invoice (or the instalment) paid on the bank's day through the scadenzario,
 * refusing keeps the movement unexplained, an unexplained outgoing becomes an expense through the
 * expenses' own add, and the statement's closing balance becomes the cashflow's balance through its
 * store. Every write is a step of the call, so a call run again writes nothing twice; an invoice
 * already marked paid is never marked again.
 */
import { BANK_LIMITS, type BankMatch, type BankMovement, BankError, isLive, type MatchTarget, movementCents } from "../bank.ts";
import type { BankBook, BankStore } from "../bank-store.ts";
import type { CashflowStore } from "../cashflow-store.ts";
import { latestBalance } from "../cashflow-store.ts";
import type { ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { CATEGORIES, type Category, matchCategory } from "../expenses.ts";
import { euros } from "../format-words.ts";
import type { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { Invoice } from "../invoices.ts";
import { withDate } from "../italian-format.ts";
import { centsDecimal } from "../quote-sums.ts";
import type { RenewalStore } from "../renewal-store.ts";
import type { TaxStore } from "../tax-store.ts";
import { isProblem } from "../text-input.ts";
import type { Workspace } from "../workspace.ts";
import { fenced, readIds } from "./bank-input.ts";
import { signed } from "./bank-render.ts";
import type { ExpenseSeam } from "./expense-tools.ts";

/** What changed, for the audit: the op and how many, never descriptions, amounts, dates or IBANs. */
export type BankEvent = { readonly type: "bank.changed"; readonly op: "import" | "confirm" | "refuse" | "to_expense" | "set_balance" | "settings" | "export"; readonly count: number };

export type BankToolsOptions = {
	readonly workspace: Workspace;
	readonly store: BankStore;
	/** The scadenzario: the company (its IBANs) and the paid marks, read; marked paid only on a confirm. */
	readonly invoices: Pick<InvoiceStore, "read" | "mark">;
	/** The workspace's scanner, shared (one cache); one of its own otherwise. */
	readonly scanner?: InvoiceScanner;
	readonly expenses: Pick<ExpenseStore, "read">;
	/** The expenses' own add: to_expense records through it. */
	readonly expenseSeam?: ExpenseSeam;
	readonly renewals: Pick<RenewalStore, "read">;
	/** The cashflow's balances: read, and set only on a set_balance confirmed. */
	readonly cashflow: Pick<CashflowStore, "read" | "setBalance">;
	/** The tax profile, read: the F24 estimates a movement is tied to. */
	readonly taxes?: Pick<TaxStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: BankEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

export type BankDeps = {
	readonly options: BankToolsOptions;
	readonly store: BankStore;
	readonly now: () => Date;
	readonly today: () => string;
	readonly who: (ctx: ToolContext) => string;
	readonly audit: (ctx: ToolContext, op: BankEvent["op"], count: number) => Promise<void>;
	readonly readable: () => BankBook;
	readonly register: (ctx: ToolContext) => Promise<Invoice[]>;
};

type Pick2 = { readonly movement: BankMovement; readonly target: MatchTarget; readonly strong?: true };

const isInvoice = (t: Pick<MatchTarget, "kind">) => t.kind === "invoice_in" || t.kind === "invoice_out";

/**
 * Mark the invoices of `picks` paid on the bank's day, then set the matches to `state`. What was
 * marked paid meanwhile by hand (not by this movement) is not marked again: its proposal goes, and
 * the movement is unexplained. Returns how many were confirmed and the words for the others.
 */
export async function applyPicks(d: BankDeps, ctx: ToolContext, picks: readonly Pick2[], state: "confirmed" | "auto", callId: string): Promise<{ readonly done: number; readonly notes: string[] }> {
	const notes: string[] = [];
	const ok: Pick2[] = [];
	const dropped: string[] = [];
	const reg = picks.some((p) => isInvoice(p.target)) ? await d.register(ctx) : [];
	for (const p of picks) {
		if (!isInvoice(p.target)) {
			ok.push(p);
			continue;
		}
		const inv = reg.find((i) => i.key === p.target.target);
		if (inv === undefined) {
			notes.push(`${p.movement.id}: la fattura non la trovo più nel workspace, non segno niente.`);
			dropped.push(p.movement.id);
			continue;
		}
		const ours = (n: number) => {
			const paid = inv.instalments.find((r) => r.n === n)?.paid;
			return paid !== undefined && paid.source === "bank" && paid.on === p.movement.date;
		};
		const targets = p.target.instalment === undefined ? inv.instalments.filter((r) => r.extra !== true).map((r) => r.n) : [p.target.instalment];
		const open = targets.filter((n) => inv.instalments.find((r) => r.n === n)?.paid === undefined);
		if (open.length === 0 && !targets.every(ours)) {
			notes.push(`${p.movement.id}: ${fenced(p.target.label)} era già segnata pagata: non la segno di nuovo e il movimento resta da spiegare.`);
			dropped.push(p.movement.id);
			continue;
		}
		// The whole invoice in one mark when none of it was paid; else each open instalment, so an instalment paid before keeps its own day.
		const whole = p.target.instalment === undefined && open.length === inv.instalments.length;
		for (const n of whole ? [undefined] : open) {
			await ctx.step(`mark:${p.movement.id}:${n ?? "all"}`, async () => {
				const r = d.options.invoices.mark({ invoice: inv.key, count: inv.instalments.length, ...(n === undefined ? {} : { instalment: n }), paid: true, on: p.movement.date, source: "bank", by: d.who(ctx), at: d.now().toISOString() });
				return r.changed;
			});
		}
		ok.push(p);
	}
	const at = d.now().toISOString();
	await ctx.step(`apply:${callId}`, async () => {
		d.store.update(callId, (s) => {
			const done = new Map(ok.map((p) => [p.movement.id, p]));
			const gone = new Set(dropped);
			const kept = s.matches.filter((m) => !(isLive(m) && (done.has(m.movement) || gone.has(m.movement))));
			const made: BankMatch[] = ok.map((p) => ({ movement: p.movement.id, ...targetOf(p.target), state, ...(p.strong === true ? { strong: true as const } : {}), by: d.who(ctx), at }));
			return { ...s, matches: [...kept, ...made] };
		});
		return true;
	});
	return { done: ok.length, notes };
}

/** confirm: the proposals named (ids, a choice for an «ask»), or all the sure ones (all true). */
export async function confirmOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const ids = readIds(args.ids, BANK_LIMITS.batch);
	if (isProblem(ids)) return `Errore: ${ids.problem}.`;
	if (ids === undefined && args.all !== true) return "Errore: dimmi quali movimenti confermare (ids) o all true per tutte le proposte sicure.";
	const choice = args.choice;
	if (choice !== undefined && (!Number.isInteger(choice) || (choice as number) < 1 || (choice as number) > BANK_LIMITS.candidates)) return `Errore: choice è il numero della possibilità, da 1 a ${BANK_LIMITS.candidates}.`;
	if (choice !== undefined && ids?.length !== 1) return "Errore: choice va con un solo movimento in ids.";
	const book = d.readable();
	const byId = new Map(book.movements.map((m) => [m.id, m]));
	const live = new Map(book.matches.filter(isLive).map((m) => [m.movement, m]));
	const picks: Pick2[] = [];
	const notes: string[] = [];
	let weak = 0;
	const wanted = ids ?? book.matches.filter((m) => m.state === "proposed").map((m) => m.movement);
	for (const id of wanted) {
		const movement = byId.get(id);
		const m = live.get(id);
		if (movement === undefined) notes.push(`${id}: non c'è tra i movimenti caricati.`);
		else if (m === undefined) notes.push(`${id}: non ha una proposta da confermare.`);
		else if (m.state === "auto" || m.state === "confirmed") notes.push(`${id}: era già abbinato.`);
		else if (m.state === "ask") {
			const c = choice === undefined ? undefined : m.candidates?.[(choice as number) - 1];
			if (c === undefined) notes.push(`${id}: ha più possibilità, chiedi quale e ripeti con choice.`);
			else picks.push({ movement, target: c });
		} else if (ids === undefined && m.strong !== true) weak++;
		else picks.push({ movement, target: targetOf(m), ...(m.strong === true ? { strong: true as const } : {}) });
	}
	if (picks.length === 0) return [notes.length === 0 ? "Non ci sono proposte da confermare." : "Non ho confermato niente.", ...notes, ...(weak > 0 ? [weakNote(weak)] : [])].join("\n");
	if (picks.length > BANK_LIMITS.batch) return `Errore: al più ${BANK_LIMITS.batch} conferme alla volta: dai gli ids.`;
	const r = await applyPicks(d, ctx, picks, "confirmed", ctx.callId);
	if (r.done > 0) await d.audit(ctx, "confirm", r.done);
	const invoices = picks.filter((p) => isInvoice(p.target)).length;
	return [`Fatto: ${r.done === 1 ? "un abbinamento confermato" : `${r.done} abbinamenti confermati`}${invoices > 0 ? "; le fatture sono segnate incassate o pagate con il giorno della banca" : ""}.`, ...notes, ...r.notes, ...(weak > 0 ? [weakNote(weak)] : [])].join("\n");
}

const weakNote = (n: number) => `${n === 1 ? "Una proposta coincide" : `${n} proposte coincidono`} solo per l'importo: non le confermo tutte insieme, chiedi a chi ti scrive e conferma con ids.`;

/** refuse: the proposals named stay unexplained; the target refused is not proposed again for that movement. */
export async function refuseOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const ids = readIds(args.ids, BANK_LIMITS.batch);
	if (isProblem(ids)) return `Errore: ${ids.problem}.`;
	if (ids === undefined) return "Errore: dimmi quali proposte scartare (ids).";
	const book = d.readable();
	const live = new Map(book.matches.filter((m) => m.state === "proposed" || m.state === "ask").map((m) => [m.movement, m]));
	const found = ids.filter((id) => live.has(id));
	if (found.length === 0) return "Non c'è una proposta da scartare per quei movimenti (un abbinamento già confermato non si scarta da qui).";
	const at = d.now().toISOString();
	await ctx.step("apply", async () => {
		d.store.update(ctx.callId, (s) => ({
			...s,
			matches: s.matches.flatMap((m): BankMatch[] => {
				if (!found.includes(m.movement) || !(m.state === "proposed" || m.state === "ask")) return [m];
				const targets: MatchTarget[] = m.state === "ask" ? [...(m.candidates ?? [])] : [m as MatchTarget];
				return targets.map((t) => ({ movement: m.movement, state: "refused", kind: t.kind, ...(t.target === undefined ? {} : { target: t.target }), ...(t.instalment === undefined ? {} : { instalment: t.instalment }), label: t.label, by: d.who(ctx), at }));
			}),
		}));
		return true;
	});
	await d.audit(ctx, "refuse", found.length);
	return `Fatto: ${found.length === 1 ? "proposta scartata" : `${found.length} proposte scartate`}; ${found.length === 1 ? "il movimento resta" : "i movimenti restano"} senza spiegazione e non la ripropongo.`;
}

/** to_expense: unexplained outgoings as expenses, through the expenses' own add; only with confirm true. */
export async function toExpenseOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const seam = d.options.expenseSeam;
	if (seam === undefined) return "Errore: il registro delle spese non è disponibile qui.";
	const ids = readIds(args.ids, BANK_LIMITS.batch);
	if (isProblem(ids)) return `Errore: ${ids.problem}.`;
	if (ids === undefined && args.all !== true) return "Errore: dimmi quali uscite registrare come spese (ids) o all true per tutte quelle senza spiegazione.";
	for (const k of ["category", "supplier"] as const) if (args[k] !== undefined && (typeof args[k] !== "string" || (args[k] as string).trim() === "" || (args[k] as string).length > 120)) return `Errore: ${k} è un testo breve.`;
	if (args.supplier !== undefined && ids?.length !== 1) return "Errore: supplier va con un solo movimento.";
	const said = args.category === undefined ? undefined : matchCategory(args.category as string);
	if (args.category !== undefined && said === undefined) return `Errore: category è una di queste: ${CATEGORIES.join(", ")}.`;
	const book = d.readable();
	const live = new Set(book.matches.filter(isLive).map((m) => m.movement));
	const out = book.movements.filter((m) => m.amount.startsWith("-") && !live.has(m.id) && (ids === undefined || ids.includes(m.id)));
	const skipped = (ids ?? []).filter((id) => !out.some((m) => m.id === id));
	if (out.length === 0) return "Non ci sono uscite senza spiegazione tra quelle indicate: le entrate e i movimenti già abbinati non diventano spese.";
	const chosen = out.slice(0, BANK_LIMITS.batch);
	const plan = chosen.map((m) => ({ m, category: (said ?? matchCategory(m.description) ?? "altro") as Category }));
	if (args.confirm !== true) {
		return [`Registrerei ${plan.length === 1 ? "questa spesa" : `queste ${plan.length} spese`}, con il giorno e l'importo della banca:`, fenced(plan.map((p) => `${p.m.id} · ${withDate("il", p.m.date)} · ${euros(-movementCents(p.m.amount))} · ${p.m.description} → ${p.category}`).join("\n")), "Chiedi a chi ti scrive se va bene; solo dopo il sì ripeti con confirm true."].join("\n");
	}
	const made: { id: string; expense: string; label: string }[] = [];
	const problems: string[] = [];
	for (const p of plan) {
		// Each expense its own call key and steps: run again, the same expense is found, not recorded twice.
		const sub: ToolContext = { ...ctx, callId: `${ctx.callId}:${p.m.id}`, step: (key, work) => ctx.step(`${p.m.id}:${key}`, work) };
		const input = { amount: centsDecimal(-movementCents(p.m.amount)), date: p.m.date, category: p.category, ...(args.supplier === undefined ? {} : { supplier: (args.supplier as string).trim() }), note: `Dall'estratto conto: ${p.m.description}`.slice(0, 500), source: "bank" as const };
		const problem = seam.check(input, sub);
		if (problem !== undefined) {
			problems.push(`${p.m.id}: ${problem}`);
			continue;
		}
		const r = await seam.record(input, sub);
		if ("problem" in r) problems.push(`${p.m.id}: ${r.problem}`);
		else made.push({ id: p.m.id, expense: r.id, label: `spesa ${r.id} (dall'estratto conto)` });
	}
	if (made.length > 0) {
		const at = d.now().toISOString();
		await ctx.step("apply", async () => {
			d.store.update(ctx.callId, (s) => ({ ...s, matches: [...s.matches.filter((m) => !(m.state === "hint" && made.some((x) => x.id === m.movement))), ...made.map((x): BankMatch => ({ movement: x.id, state: "confirmed", kind: "expense", target: x.expense, label: x.label, expense: x.expense, by: d.who(ctx), at }))] }));
			return true;
		});
		await d.audit(ctx, "to_expense", made.length);
	}
	const lines = [made.length === 0 ? "Non ho registrato spese." : `Fatto: ${made.length === 1 ? `registrata la spesa ${made[0]?.expense}` : `registrate ${made.length} spese (${made.map((x) => x.expense).join(", ")})`}, con il giorno e l'importo della banca.`];
	if (problems.length > 0) lines.push(fenced(problems.join("\n")));
	if (skipped.length > 0) lines.push(`${skipped.join(", ")}: non ${skipped.length === 1 ? "è un'uscita" : "sono uscite"} senza spiegazione, ${skipped.length === 1 ? "lasciata" : "lasciate"} stare.`);
	if (out.length > chosen.length) lines.push(`Ne restano ${out.length - chosen.length}: al più ${BANK_LIMITS.batch} per volta.`);
	return lines.join("\n");
}

/** set_balance: the closing balance of the latest statement (or of import_id) as the cashflow's balance; only with confirm true. */
export async function setBalanceOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const book = d.readable();
	const withClosing = book.imports.filter((i) => i.closing !== undefined);
	const asked = typeof args.import_id === "string" ? args.import_id.trim().toUpperCase() : undefined;
	const wanted = asked !== undefined ? withClosing.find((i) => i.id === asked) : [...withClosing].sort((a, b) => (a.closing?.date ?? "").localeCompare(b.closing?.date ?? "")).at(-1);
	if (wanted?.closing === undefined) return "Gli estratti conto caricati non dicono il saldo finale: chiedi a chi ti scrive quanto ha sul conto e salvalo con cashflow op set_balance.";
	const closing = wanted.closing;
	const cash = d.options.cashflow.read();
	if (cash.broken) return "Errore: la previsione di cassa (cashflow.json) non si legge: non salvo il saldo.";
	const newer = latestBalance(cash.balances);
	const amountText = signed(movementCents(closing.amount)).replace(/^\+/, "");
	if (args.confirm !== true) return `Il saldo finale dell'estratto conto è ${amountText} ${withDate("al", closing.date)}. Chiedi a chi ti scrive se vuole salvarlo come saldo della previsione di cassa; solo dopo il sì ripeti con confirm true.${newer !== undefined && newer.date > closing.date ? ` C'è già un saldo più recente (${withDate("del", newer.date)}): la previsione continuerà a partire da quello.` : ""}`;
	if (closing.date > d.today()) throw new BankError("il saldo dell'estratto conto ha una data futura: non lo salvo");
	await ctx.step("cashflow", async () => {
		d.options.cashflow.setBalance({ amount: closing.amount, date: closing.date, by: d.who(ctx), at: d.now().toISOString(), callId: ctx.callId }, undefined);
		return true;
	});
	const at = d.now().toISOString();
	await ctx.step("apply", async () => {
		d.store.update(ctx.callId, (s) => ({ ...s, imports: s.imports.map((i) => (i.id === wanted.id ? { ...i, balanceSet: { by: d.who(ctx), at } } : i)) }));
		return true;
	});
	await d.audit(ctx, "set_balance", 1);
	return `Fatto: il saldo della previsione di cassa è ${amountText} ${withDate("al", closing.date)}, dall'estratto conto.${newer !== undefined && newer.date > closing.date ? ` C'era già un saldo più recente (${withDate("del", newer.date)}): la previsione parte ancora da quello.` : ""}`;
}


/** Only the target of a match or a candidate: never its old state, author or time. */
function targetOf(m: Partial<MatchTarget>): MatchTarget {
	return { kind: m.kind as MatchTarget["kind"], label: m.label ?? "", ...(m.target !== undefined ? { target: m.target } : {}), ...(m.instalment !== undefined ? { instalment: m.instalment } : {}) };
}
