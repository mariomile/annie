/**
 * The estratto conto's writes to the other registers, each only on the person's yes: confirming a
 * match marks the invoice (or the instalment) paid on the bank's day through the scadenzario,
 * refusing keeps the movement unexplained, an unexplained outgoing becomes an expense through the
 * expenses' own add, and the statement's closing balance becomes the cashflow's balance through its
 * store. Every write is a step of the call, so a call run again writes nothing twice; an invoice
 * already marked paid is never marked again.
 */
import { BANK_LIMITS, type BankMatch, type BankMovement, BankError, dayWords, delDay, EXPENSE_DAYS, isLive, type MatchTarget, statementOf } from "../bank.ts";
import { statementAt } from "../cashflow-sources.ts";
import { latestBalance } from "../cashflow-store.ts";
import type { ToolContext } from "../engine.ts";
import { CATEGORIES, type Category, matchCategory } from "../expenses.ts";
import { euros } from "../format-words.ts";
import { daysBetween, dayOfIn, MONTH_NAMES } from "../italian-calendar.ts";
import { withDate } from "../italian-format.ts";
import { centsDecimal, eurosToCents, unitsToCents } from "../quote-sums.ts";
import { isProblem } from "../text-input.ts";
import { fenced, readIds } from "./bank-input.ts";
import { isWeak, markedWords, signed, twins } from "./bank-render.ts";
import type { BankDeps } from "./bank-tools.ts";
import { requirePersonFor } from "../turn-origin.ts";

/** A movement and what the person (or the setting) chose for it. */
export type ChosenMatch = { readonly movement: BankMovement; readonly target: MatchTarget; readonly strong?: true };

const isInvoice = (t: Pick<MatchTarget, "kind">) => t.kind === "invoice_in" || t.kind === "invoice_out";

/** Only the target of a match or a candidate: never its old state, author or time. */
function targetOf(m: Partial<MatchTarget>): MatchTarget {
	return { kind: m.kind as MatchTarget["kind"], label: m.label ?? "", ...(m.target !== undefined ? { target: m.target } : {}), ...(m.instalment !== undefined ? { instalment: m.instalment } : {}) };
}

/**
 * Mark the invoices of `chosen` paid on the bank's day, then set the matches to `state`. What was
 * marked paid meanwhile by hand (not by this movement) is not marked again: its proposal goes, and
 * the movement is unexplained. Returns what was confirmed and the words for the others.
 */
export async function applyPicks(d: BankDeps, ctx: ToolContext, chosen: readonly ChosenMatch[], state: "confirmed" | "auto", callId: string): Promise<{ readonly done: readonly ChosenMatch[]; readonly notes: string[] }> {
	const notes: string[] = [];
	const ok: ChosenMatch[] = [];
	const dropped: string[] = [];
	const reg = chosen.some((p) => isInvoice(p.target)) ? await d.register(ctx) : [];
	for (const p of chosen) {
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
			const done = new Set(ok.map((p) => p.movement.id));
			const gone = new Set(dropped);
			const kept = s.matches.filter((m) => !(isLive(m) && (done.has(m.movement) || gone.has(m.movement))));
			const made: BankMatch[] = ok.map((p) => ({ movement: p.movement.id, ...targetOf(p.target), state, ...(p.strong === true ? { strong: true as const } : {}), by: d.who(ctx), at }));
			return { ...s, matches: [...kept, ...made] };
		});
		return true;
	});
	return { done: ok, notes };
}

/** At most these invoices named in a confirm's answer; the others counted. */
const NAMED = 5;

/** «segnate incassate la fattura 21 di Rossi (3 ottobre) e la 23 di Verdi (6 ottobre); segnata pagata la N-88 di Tipografia Neri (10 ottobre)»; past NAMED, «e altre 3 (list con status matched)». */
function markedSentence(done: readonly ChosenMatch[]): string {
	let first = true;
	const invoices = [...done.filter((p) => p.target.kind === "invoice_in"), ...done.filter((p) => p.target.kind === "invoice_out")];
	const named = invoices.slice(0, NAMED);
	const rest = invoices.length - named.length;
	const group = (kind: "invoice_in" | "invoice_out", one: string, many: string) => {
		const list = named.filter((p) => p.target.kind === kind);
		if (list.length === 0) return [];
		const items = list.map((p) => {
			const w = markedWords(p.target.label, p.movement.date, first);
			first = false;
			return w;
		});
		return [`${list.length === 1 ? one : many} ${items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`}`];
	};
	const said = [...group("invoice_in", "segnata incassata", "segnate incassate"), ...group("invoice_out", "segnata pagata", "segnate pagate")].join("; ");
	return rest === 0 ? said : `${said}; e ${rest === 1 ? "un'altra" : `altre ${rest}`} (list con status matched)`;
}

/** confirm: the proposals named (ids, a choice for an «ask»), or all the sure ones (all true); one that matches only the amount needs weak_ok. */
export async function confirmOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const ids = readIds(args.ids, BANK_LIMITS.batch);
	if (isProblem(ids)) return `Errore: ${ids.problem}.`;
	if (ids === undefined && args.all !== true) return "Errore: dimmi quali movimenti confermare (ids) o all true per tutte le proposte sicure.";
	const choice = args.choice;
	if (choice !== undefined && (!Number.isInteger(choice) || (choice as number) < 1 || (choice as number) > BANK_LIMITS.candidates)) return `Errore: choice è il numero della possibilità, da 1 a ${BANK_LIMITS.candidates}.`;
	if (choice !== undefined && ids?.length !== 1) return "Errore: choice va con un solo movimento in ids.";
	if (args.weak_ok !== undefined && (args.weak_ok !== true || ids?.length !== 1)) return "Errore: weak_ok true va con un solo movimento in ids, dopo il sì di chi ti scrive su quello.";
	const book = d.readable();
	const byId = new Map(book.movements.map((m) => [m.id, m]));
	const live = new Map(book.matches.filter(isLive).map((m) => [m.movement, m]));
	const chosen: ChosenMatch[] = [];
	const notes: string[] = [];
	const weak: string[] = [];
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
			else chosen.push({ movement, target: c });
		} else if (isWeak(m) && args.weak_ok !== true) weak.push(`${id}: ${signed(eurosToCents(movement.amount))} ${withDate("del", movement.date)} → ${m.label}`);
		else chosen.push({ movement, target: targetOf(m), ...(m.strong === true ? { strong: true as const } : {}) });
	}
	const weakLines = weak.length === 0 ? [] : [`${weak.length === 1 ? "Questa proposta coincide solo per l'importo: non la confermo" : "Queste proposte coincidono solo per l'importo: non le confermo"} insieme alle altre. Chiedi a chi ti scrive una per una, con l'importo e il giorno; dopo il sì su una, ripeti con quell'id e weak_ok true.`, fenced(weak.join("\n"))];
	if (chosen.length === 0) return [notes.length === 0 && weak.length === 0 ? "Non ci sono proposte da confermare." : "Non ho confermato niente.", ...notes, ...weakLines].join("\n");
	if (chosen.length > BANK_LIMITS.batch) return `Errore: al più ${BANK_LIMITS.batch} conferme alla volta: dai gli ids.`;
	// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
	const notPerson = requirePersonFor(ctx, "confermo gli abbinamenti della banca (fatture segnate pagate o incassate)");
	if (notPerson !== undefined) return notPerson;
	const r = await applyPicks(d, ctx, chosen, "confirmed", ctx.callId);
	if (r.done.length > 0) {
		await d.audit(ctx, "confirm", r.done.length);
		await d.rehint(ctx);
	}
	const marked = markedSentence(r.done);
	const others = r.done.filter((p) => !isInvoice(p.target)).length;
	const head = r.done.length === 0 ? "Non ho confermato niente." : `Fatto: ${r.done.length === 1 ? "un abbinamento confermato" : `${r.done.length} abbinamenti confermati`}${marked === "" ? "" : ", con il giorno della banca"}${others > 0 && marked !== "" ? ` (${others === 1 ? "uno non è una fattura" : `${others} non sono fatture`})` : ""}.`;
	return [head, ...(marked === "" ? [] : [fenced(`${marked}.`)]), ...notes, ...r.notes, ...weakLines].join("\n");
}

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
				const targets: MatchTarget[] = m.state === "ask" ? [...(m.candidates ?? [])] : [targetOf(m)];
				return targets.map((t) => ({ movement: m.movement, state: "refused", ...targetOf(t), by: d.who(ctx), at }));
			}),
		}));
		return true;
	});
	await d.audit(ctx, "refuse", found.length);
	await d.rehint(ctx);
	return `Fatto: ${found.length === 1 ? "proposta scartata" : `${found.length} proposte scartate`}; ${found.length === 1 ? "il movimento resta" : "i movimenti restano"} senza spiegazione e non la ripropongo.`;
}

/** to_expense: unexplained outgoings as expenses, through the expenses' own add; only with confirm true; one like an expense already recorded, or charged twice, only with anyway. */
export async function toExpenseOp(d: BankDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const seam = d.options.expenseSeam;
	if (seam === undefined) return "Errore: il registro delle spese non è disponibile qui.";
	const ids = readIds(args.ids, BANK_LIMITS.batch);
	if (isProblem(ids)) return `Errore: ${ids.problem}.`;
	if (ids === undefined && args.all !== true) return "Errore: dimmi quali uscite registrare come spese (ids) o all true per tutte quelle senza spiegazione.";
	for (const k of ["category", "supplier"] as const) if (args[k] !== undefined && (typeof args[k] !== "string" || (args[k] as string).trim() === "" || (args[k] as string).length > 120)) return `Errore: ${k} è un testo breve.`;
	if (args.supplier !== undefined && ids?.length !== 1) return "Errore: supplier va con un solo movimento.";
	if (args.anyway !== undefined && (args.anyway !== true || ids === undefined)) return "Errore: anyway true va con gli ids che chi ti scrive ha confermato.";
	const said = args.category === undefined ? undefined : matchCategory(args.category as string);
	if (args.category !== undefined && said === undefined) return `Errore: category è una di queste: ${CATEGORIES.join(", ")}.`;
	const book = d.readable();
	const live = new Set(book.matches.filter(isLive).map((m) => m.movement));
	const out = book.movements.filter((m) => m.amount.startsWith("-") && !live.has(m.id) && (ids === undefined || ids.includes(m.id)));
	const skipped = (ids ?? []).filter((id) => !out.some((m) => m.id === id));
	if (out.length === 0) return "Non ci sono uscite senza spiegazione tra quelle indicate: le entrate e i movimenti già abbinati non diventano spese.";
	const ex = d.options.expenses.read();
	const recorded = ex.broken ? [] : ex.expenses;
	const doubled = new Set(twins(book.movements).flatMap(([a, b]) => [a.id, b.id]));
	const chosen = out.slice(0, BANK_LIMITS.batch);
	const plan = chosen.map((m) => {
		const cents = -eurosToCents(m.amount);
		const like = recorded.find((e) => eurosToCents(e.amount) === cents && Math.abs(daysBetween(e.date, m.date)) <= EXPENSE_DAYS);
		const warn = like !== undefined ? ` (forse c'è già la spesa ${like.id} ${delDay(like.date)}: chiedi prima)` : doubled.has(m.id) ? " (forse addebito doppio: chiedi prima)" : "";
		return { m, cents, warn, category: (said ?? matchCategory(m.description) ?? "altro") as Category };
	});
	const line = (p: (typeof plan)[number]) => `${p.m.id} · ${dayWords(p.m.date)} · ${euros(p.cents)} · ${p.m.description} → ${p.category}${p.warn}`;
	if (args.confirm !== true) {
		return [`Registrerei ${plan.length === 1 ? "questa spesa" : `queste ${plan.length} spese`}, con il giorno e l'importo della banca:`, fenced(plan.map(line).join("\n")), `Chiedi a chi ti scrive se va bene; solo dopo il sì ripeti con confirm true.${plan.some((p) => p.warn !== "") ? " Quelle con «chiedi prima» le registro solo se lo conferma per ognuna: ripeti con i loro ids, confirm true e anyway true." : ""}`].join("\n");
	}
	// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
	const notPerson = requirePersonFor(ctx, "registro le spese dall'estratto conto");
	if (notPerson !== undefined) return notPerson;
	const held = plan.filter((p) => p.warn !== "" && args.anyway !== true);
	const made: { id: string; expense: string; label: string }[] = [];
	const problems: string[] = [];
	for (const p of plan.filter((x) => !held.includes(x))) {
		// Each expense its own call key and steps: run again, the same expense is found, not recorded twice.
		const sub: ToolContext = { ...ctx, callId: `${ctx.callId}:${p.m.id}`, step: (key, work) => ctx.step(`${p.m.id}:${key}`, work) };
		const input = { amount: centsDecimal(p.cents), date: p.m.date, category: p.category, ...(args.supplier === undefined ? {} : { supplier: (args.supplier as string).trim() }), note: `Dall'estratto conto: ${p.m.description}`.slice(0, 500), source: "bank" as const };
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
	if (held.length > 0) lines.push("Non ho registrato queste, perché somigliano a una spesa già registrata o a un addebito doppio: chiedi a chi ti scrive e, se vuole, ripeti con i loro ids, confirm true e anyway true.", fenced(held.map(line).join("\n")));
	if (problems.length > 0) lines.push(fenced(problems.join("\n")));
	if (skipped.length > 0) lines.push(`${skipped.join(", ")}: non ${skipped.length === 1 ? "è un'uscita" : "sono uscite"} senza spiegazione, ${skipped.length === 1 ? "lasciata" : "lasciate"} stare.`);
	if (out.length > chosen.length) lines.push(`Ne restano ${out.length - chosen.length}: al più ${BANK_LIMITS.batch} per volta.`);
	return lines.join("\n");
}

/**
 * Invoices marked paid by hand after the statement's closing day whose payment the statement shows
 * (cashflow-sources.ts inStatement: the same signed amount from the invoice's day to the closing
 * day, unexplained or held by that invoice, a mere proposal only when no other open invoice has
 * that amount): it is in the balance already.
 */
async function handMarked(d: BankDeps, ctx: ToolContext, closingDate: string): Promise<string[]> {
	const book = d.readable();
	const statement = statementOf(book.movements, book.matches);
	const dayOf = dayOfIn(d.options.timeZone);
	const out: string[] = [];
	const invoices = await d.register(ctx);
	for (const inv of invoices) {
		if (inv.credit || inv.doc.integration || inv.side === undefined) continue;
		for (const r of inv.instalments) {
			if (r.paid === undefined || r.paid.on !== undefined || r.amount === undefined || dayOf(r.paid.at) <= closingDate) continue;
			const cents = unitsToCents(r.amount) * (inv.side === "active" ? 1n : -1n);
			const m = book.movements[statementAt(inv, cents, closingDate, statement, invoices)];
			if (m !== undefined) out.push(`fattura ${inv.doc.number ?? "senza numero"}: segnata ${inv.side === "active" ? "incassata" : "pagata"} a mano ${withDate("il", dayOf(r.paid.at))}, ma nell'estratto conto c'è ${m.id} dello stesso importo ${withDate("del", m.date)}`);
		}
	}
	return out.slice(0, 10);
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
	const latest = latestBalance(cash.balances);
	const newer = latest !== undefined && latest.date > closing.date ? latest : undefined;
	const amountText = euros(eurosToCents(closing.amount));
	const short = (date: string) => withDate("del", date).replace(/ \d{4}$/, "");
	const newerAmount = newer === undefined ? "" : euros(eurosToCents(newer.amount));
	const marks = await handMarked(d, ctx, closing.date);
	const markLines = marks.length === 0 ? [] : ["Attenzione: queste fatture le avevi segnate a mano dopo la chiusura dell'estratto conto, ma il loro importo c'è già prima: sono già nel saldo e la previsione non le conta di nuovo. Se sono quei movimenti, dillo a chi ti scrive.", fenced(marks.join("\n"))];
	if (args.confirm !== true) {
		const head = newer === undefined ? `Il saldo finale dell'estratto conto è ${amountText} ${withDate("al", closing.date)}. Chiedi a chi ti scrive se vuole salvarlo come saldo della previsione di cassa; solo dopo il sì ripeti con confirm true.` : `Il saldo finale dell'estratto conto è ${amountText} ${withDate("al", closing.date)}. Hai già un saldo più recente (${newerAmount} ${short(newer.date)}): salvare quello di ${MONTH_NAMES[Number(closing.date.slice(5, 7)) - 1]} non cambia la previsione, non serve.`;
		return [head, ...markLines].join("\n");
	}
	// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
	const notPerson = requirePersonFor(ctx, "salvo il saldo dall'estratto conto");
	if (notPerson !== undefined) return notPerson;
	if (closing.date > d.today()) throw new BankError("il saldo dell'estratto conto ha una data futura: non lo salvo");
	await ctx.step("cashflow", async () => {
		d.options.cashflow.setBalance({ amount: closing.amount, date: closing.date, by: d.who(ctx), at: d.now().toISOString(), callId: ctx.callId, source: "bank" }, undefined);
		return true;
	});
	const at = d.now().toISOString();
	await ctx.step("apply", async () => {
		d.store.update(ctx.callId, (s) => ({ ...s, imports: s.imports.map((i) => (i.id === wanted.id ? { ...i, balanceSet: { by: d.who(ctx), at } } : i)) }));
		return true;
	});
	await d.audit(ctx, "set_balance", 1);
	const head = newer === undefined ? `Fatto: il saldo della previsione di cassa è ${amountText} ${withDate("al", closing.date)}, dall'estratto conto.` : `Salvato anche il saldo ${short(closing.date)} (${amountText}); la previsione parte comunque da quello ${short(newer.date)} (${newerAmount}).`;
	return [head, ...markLines].join("\n");
}
