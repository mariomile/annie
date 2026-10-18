/**
 * The tool `sales_invoices`: le fatture elettroniche in uscita. A draft from an accepted quote,
 * from the hours not yet billed or from the lines the person dictates (sales-invoice-draft.ts); a
 * credit note (TD04) for an invoice issued; the draft issued only after the person's yes
 * (sales-invoice-issue.ts), which gives the number, writes the FatturaPA XML in `fatture/emesse/`
 * and the courtesy PDF beside it; the list of a year with its totals. Nothing is sent to the SdI
 * and nothing is mailed: the person uploads the file, or mails it with the approval flow.
 * Another agente gets only the year's counts and totals; the audit only the op and a count.
 */
import { AGENT_CHANNEL } from "../agent-messages.ts";
import type { ClientStore } from "../client-store.ts";
import { dueDates } from "../dates.ts";
import { makeDocumentFile } from "../document-reader.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { todayIn } from "../italian-calendar.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import type { QuoteStore } from "../quote-store.ts";
import { CREDIT_NOTE_TYPE, FIELD_LIMITS, RITENUTA_CAUSALI, STALE_DRAFT_DAYS } from "../sales-invoice-rules.ts";
import { SALES_BROKEN, type SalesBook, type SalesInvoiceStore } from "../sales-invoice-store.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type IssuedInvoice, invoiceNumber, isIssued, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, salesAgentReads } from "../sales-invoices.ts";
import type { TaxStore } from "../tax-store.ts";
import type { TimesheetStore } from "../timesheet-store.ts";
import type { Workspace } from "../workspace.ts";
import { WorkspaceError } from "../workspace.ts";
import { creditNote, draft } from "./sales-invoice-draft.ts";
import { issue } from "./sales-invoice-issue.ts";
import { agentListAnswer, briefLine, fenced, invoiceLines, listAnswer } from "./sales-invoice-render.ts";

const SALES_OPS = ["draft", "credit_note", "show", "list", "issue", "remove", "settings"] as const;
type Op = (typeof SALES_OPS)[number];

/** What changed, for the audit: the op and how many, never customers, amounts, numbers or lines. */
export type SalesEvent = { readonly type: "sales_invoices.changed"; readonly op: "draft" | "credit_note" | "issue" | "remove" | "settings"; readonly count: number };

export type SalesToolsOptions = {
	readonly workspace: Workspace;
	readonly store: SalesInvoiceStore;
	/** The company's data (invoices set_company): the seller, read only. */
	readonly company: Pick<InvoiceStore, "read">;
	/** The forfettario's profile: tells the regime when the company does not say it. */
	readonly taxes: Pick<TaxStore, "read">;
	readonly clients?: Pick<ClientStore, "read">;
	readonly quotes?: Pick<QuoteStore, "read" | "markInvoiced">;
	readonly timesheet?: Pick<TimesheetStore, "read" | "setBilled">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: SalesEvent) => Promise<void>;
	/** Tests: the clock and the PDF maker. */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

/** What the ops share. */
export type SalesEnv = Omit<SalesToolsOptions, "now" | "make" | "whoIs" | "record"> & {
	readonly now: () => Date;
	readonly make: (input: MakeInput) => Promise<MadeDocument>;
	readonly marker: (ctx: ToolContext) => Marker;
	readonly audit: (ctx: ToolContext, op: SalesEvent["op"], count: number) => Promise<void>;
	readonly book: () => SalesBook;
};

/** What FatturaPA still needs, to ask the person: never invented. */
export function askFor(missing: readonly string[], what = "la fattura"): string {
	return [`Per ${what} mi servono ancora questi dati. Chiedili a chi ti scrive, non inventarli, poi rifai la richiesta con le sue risposte:`, ...missing.map((m) => `• ${m}`)].join("\n");
}

/** The due date an invoice dated `day` has with its payment terms. */
export function dueOf(inv: Pick<SalesInvoice, "payment" | "type">, day: string): string | undefined {
	if (inv.payment === undefined || inv.type === CREDIT_NOTE_TYPE) return undefined;
	return dueDates(day, [inv.payment.days], { endOfMonth: inv.payment.endOfMonth })[0]?.date;
}

const DESCRIPTION = [
	"Le fatture elettroniche in uscita (FatturaPA): Annie prepares the XML file of an invoice or a credit note to a customer; she never transmits it to the SdI and never mails it by herself.",
	"What the person says → op: «fai la fattura del preventivo 2026-004» → draft with quote; «fattura a Rossi le ore non fatturate» → draft with customer and hours true (period, if said); «fattura a Rossi: consulenza 500 euro» → draft with customer and lines; «fai una nota di credito per la fattura 12» → credit_note with invoice (lines only for a partial one); «emettila», «sì, va bene» after a draft → issue with draft and confirm true, only after the person said yes to the draft as shown; «le fatture di quest'anno» → list; «fammi vedere la fattura 12» → show; «togli la bozza» → remove; «numera le fatture come 2026/1» or the bollo always on the customer → settings.",
	"draft: vat (22, 10, 5, 4, or 0 with natura) and natura for every line unless a line has its own; in the forfettario nothing (no VAT, N2.2 and the dicitura by themselves); ritenuta true only when the person asks (ordinario); cassa {kind rivalsa_inps or contributo_integrativo, type TC01…TC21 for a cassa, rate}; bollo_to_client when asked; payment_days, end_of_month, method, iban; the customer's vat, cf, address («Via Roma 1, 20121 Milano MI»), recipient_code, pec, country only as the person says them; order {id, cig, cup} for a public office; notes; replace: the draft it takes the place of.",
	"When the tool asks for data, ask the person and never fill it in yourself. Repeat numbers and amounts as given, never compute them yourself.",
].join(" ");

export function createSalesInvoiceTools(options: SalesToolsOptions): AnnieTool[] {
	const { store, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const env: SalesEnv = {
		workspace: options.workspace,
		store,
		company: options.company,
		taxes: options.taxes,
		...(options.clients === undefined ? {} : { clients: options.clients }),
		...(options.quotes === undefined ? {} : { quotes: options.quotes }),
		...(options.timesheet === undefined ? {} : { timesheet: options.timesheet }),
		timeZone,
		now,
		make: options.make ?? ((input: MakeInput) => makeDocumentFile(input)),
		marker: (ctx) => ({ by: who(ctx), at: now().toISOString() }),
		audit: async (ctx, op, count) => {
			// Its own step: an audit that failed is written on the rerun, after the change it records.
			await ctx.step(`audit-${op}`, async () => {
				await options.record?.({ type: "sales_invoices.changed", op, count });
				return true;
			});
		},
		book: () => {
			const book = store.read();
			if (book.broken) throw new SalesInvoiceError(SALES_BROKEN);
			return book;
		},
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const line = {
		type: "object",
		properties: {
			description: text(FIELD_LIMITS.descrizione, "as said"),
			quantity: { type: ["number", "string"], description: "default 1" },
			unit: text(FIELD_LIMITS.unitaMisura, "«ore», «pz»"),
			price: { type: ["number", "string"], description: "unit price, VAT excluded" },
			discount: { type: ["number", "string"], description: "percent" },
			vat: { type: ["number", "string"], description: "this line's rate, when it differs" },
			natura: text(5, "this line's nature at 0%"),
			reference: text(FIELD_LIMITS.riferimentoNormativo, "the law of a 0% line, as said"),
		},
		required: ["description", "price"],
		additionalProperties: false,
	};
	return [
		{
			name: "sales_invoices",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...SALES_OPS] },
					customer: text(200, "draft: the customer as said, partita IVA, or card id CL-0001"),
					quote: text(30, "draft: the accepted quote's number"),
					hours: { type: "boolean", description: "draft: bill the customer's hours not yet billed" },
					period: text(40, "draft with hours: «ottobre», «T3», «anno»; default every hour not billed"),
					lines: { type: "array", maxItems: SALES_LIMITS.lines, items: line, description: "draft, credit_note: the lines" },
					vat: { type: ["number", "string"], description: "draft: VAT rate of the lines (22, 10, 5, 4, 0)" },
					natura: text(5, "draft: nature of the 0% lines (N2.2, N4, N6.3…)"),
					reference: text(FIELD_LIMITS.riferimentoNormativo, "draft: the law of the 0% lines, as said"),
					ritenuta: { anyOf: [{ type: "boolean" }, { type: "string", enum: [...RITENUTA_CAUSALI] }], description: "draft: true (causale A) or the causale; only when asked" },
					cassa: {
						type: "object",
						properties: { kind: { type: "string", enum: ["rivalsa_inps", "contributo_integrativo"] }, type: text(4, "TC01…TC21, for a cassa"), rate: { type: ["number", "string"] } },
						required: ["kind"],
						additionalProperties: false,
					},
					bollo_to_client: { type: "boolean", description: "draft, settings: the bollo charged to the customer (a line) or paid by the owner" },
					split_payment: { type: "boolean", description: "draft: scissione dei pagamenti, for a public office" },
					payment_days: { type: "integer", minimum: 0, maximum: 365 },
					end_of_month: { type: "boolean" },
					method: text(20, "bonifico (default), contanti, assegno, carta, riba, rid, pagopa"),
					iban: text(40, "default the first IBAN saved with the company"),
					vat_number: text(40, "draft: the customer's partita IVA"),
					cf: text(20, "draft: the customer's codice fiscale"),
					address: text(200, "draft: the customer's address with CAP, comune, provincia"),
					recipient_code: text(7, "draft: codice destinatario (7, or 6 for a public office)"),
					pec: text(FIELD_LIMITS.pec, "draft: the customer's PEC"),
					country: text(2, "draft: a foreign customer's country (DE, FR…)"),
					order: { type: "object", properties: { id: text(FIELD_LIMITS.idDocumento, ""), cig: text(FIELD_LIMITS.cig, ""), cup: text(FIELD_LIMITS.cup, "") }, required: ["id"], additionalProperties: false },
					notes: text(SALES_LIMITS.causale, "draft, credit_note: the causale, as said"),
					replace: text(10, "draft: the draft id (BZ-0001) this one takes the place of"),
					invoice: text(20, "credit_note: the number of the invoice it corrects; show: a number"),
					draft: text(10, "issue, show, remove: the draft id (BZ-0001)"),
					confirm: { type: "boolean", description: "issue: true only after the person said yes to the draft as shown" },
					year: { type: "integer", minimum: 2000, maximum: 2100, description: "list: default this year" },
					compact: { type: "boolean", description: "list: the brief's line only" },
					numbering: { type: "string", enum: ["plain", "year"], description: "settings: «12» or «2026/12»" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!SALES_OPS.includes(args.op as Op)) return "Errore: non conosco questa operazione sulle fatture.";
				const op = args.op as Op;
				// Another agente's request is not the person's word: the year's counts and totals only.
				const agent = ctx.thread?.channel === AGENT_CHANNEL;
				if (agent && !salesAgentReads(args)) {
					return "Errore: a un altro agente non preparo, non emetto e non mostro fatture: posso dare solo quante sono e i totali dell'anno. Il resto lo chiede chi ti scrive, nella sua conversazione.";
				}
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "draft":
							return await draft(env, args, ctx, day);
						case "credit_note":
							return await creditNote(env, args, ctx, day);
						case "issue":
							return await issue(env, args, ctx, day);
						case "show":
							return show(args, day);
						case "list":
							return list(args, day, agent);
						case "remove":
							return await remove(args, ctx);
						case "settings":
							return await settings(args, ctx, day);
					}
				} catch (error) {
					if (error instanceof SalesInvoiceError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function show(args: Record<string, unknown>, day: string): string {
		const inv = findOne(env.book(), args);
		if (typeof inv === "string") return inv;
		const t = salesTotals(inv);
		return fenced(invoiceLines(inv, t, isIssued(inv) ? inv.due : dueOf(inv, day)).join("\n"));
	}

	function list(args: Record<string, unknown>, day: string, agent: boolean): string {
		const book = env.book();
		const year = typeof args.year === "number" && Number.isInteger(args.year) ? args.year : Number(day.slice(0, 4));
		const issued = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.year === year).map((inv) => ({ inv, t: salesTotals(inv) }));
		const drafts = book.invoices.filter((i) => !isIssued(i));
		if (agent) return agentListAnswer(year, issued, drafts.length);
		if (args.compact === true) {
			const limit = new Date(now().getTime() - STALE_DRAFT_DAYS * 86_400_000).toISOString();
			return briefLine(drafts.filter((d) => d.at < limit).length, STALE_DRAFT_DAYS);
		}
		return listAnswer(year, issued, drafts.map((inv) => ({ inv, t: salesTotals(inv) })));
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const book = env.book();
		const id = typeof args.draft === "string" ? args.draft.trim().toUpperCase() : undefined;
		const drafts = book.invoices.filter((i) => !isIssued(i));
		const target = id === undefined ? (drafts.length === 1 ? drafts[0] : undefined) : book.invoices.find((i) => i.id === id);
		if (target === undefined) {
			// A call run again after it removed: the draft is gone.
			if (book.calls.includes(ctx.callId)) {
				await env.audit(ctx, "remove", 1);
				return "Fatto, la bozza è tolta. Nessun numero è stato usato.";
			}
			return id === undefined ? (drafts.length === 0 ? "Non c'è nessuna bozza da togliere." : "Errore: ci sono più bozze, dimmi quale togliere.") : `Errore: non c'è la bozza ${id}.`;
		}
		if (isIssued(target)) return `Errore: la ${target.type === CREDIT_NOTE_TYPE ? "nota di credito" : "fattura"} n. ${target.number} è già emessa e non si può togliere: per annullarla si fa una nota di credito.`;
		store.update(ctx.callId, (state) => ({ ...state, invoices: state.invoices.filter((i) => i.id !== target.id) }));
		await env.audit(ctx, "remove", 1);
		return [`Fatto, ho tolto la bozza ${target.id}. Nessun numero è stato usato.`, fenced(`Bozza di ${target.type === CREDIT_NOTE_TYPE ? "nota di credito" : "fattura"} a ${target.buyer.name}`)].join("\n");
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const book = env.book();
		const year = Number(day.slice(0, 4));
		if (args.numbering !== undefined && args.numbering !== "plain" && args.numbering !== "year") return "Errore: il numero si scrive come «12» o come «2026/12».";
		if (args.bollo_to_client !== undefined && typeof args.bollo_to_client !== "boolean") return "Errore: il bollo è a carico del cliente o no.";
		const shown = (numbering: string | undefined, bollo: boolean | undefined) =>
			[`Numero delle fatture: ${invoiceNumber(year, 12, numbering === "year" ? "year" : "plain")} (per esempio).`, `Bollo virtuale: ${bollo === undefined ? "da chiedere la prima volta che serve" : bollo ? "a carico del cliente, come riga in fattura" : "a carico tuo, solo dichiarato"}.`].join("\n");
		if (args.numbering === undefined && args.bollo_to_client === undefined) return shown(book.settings?.numbering, book.settings?.bolloToClient);
		const changesNumbering = args.numbering !== undefined && args.numbering !== (book.settings?.numbering ?? "plain");
		if (changesNumbering && book.invoices.some((i) => isIssued(i) && i.year === year)) {
			return `Errore: nel ${year} ci sono già fatture emesse con l'altro modo di scrivere il numero: lo cambio solo dall'anno prossimo, prima della prima fattura, così la numerazione resta uniforme.`;
		}
		store.update(ctx.callId, (state) => ({
			...state,
			settings: {
				...(state.settings ?? {}),
				...env.marker(ctx),
				...(args.numbering === undefined ? {} : { numbering: args.numbering as "plain" | "year" }),
				...(args.bollo_to_client === undefined ? {} : { bolloToClient: args.bollo_to_client as boolean }),
			},
		}));
		await env.audit(ctx, "settings", 1);
		const saved = env.book().settings;
		return `Fatto, ho salvato.\n${shown(saved?.numbering, saved?.bolloToClient)}`;
	}
}

const SAID_NUMBER = /^(?:n\.?\s*)?(?:(\d{4})\s*[/-]\s*)?(\d{1,5})(?:\s*[/-]\s*(\d{4}))?$/i;

/** The issued invoices a number names: «12», «2026/12», «12/2026», «n. 12»; this year's first when no year is said. */
export function findIssued(invoices: readonly SalesInvoice[], said: string, type?: SalesInvoice["type"]): IssuedInvoice[] {
	const m = SAID_NUMBER.exec(said.trim());
	if (m === null) return [];
	const year = m[1] ?? m[3];
	const seq = Number(m[2]);
	return invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.seq === seq && (year === undefined || i.year === Number(year)) && (type === undefined || i.type === type)).sort((a, b) => b.year - a.year);
}

/** The draft or invoice `args` names (draft id, or invoice number); the only draft when nothing is named. */
function findOne(book: SalesBook, args: Record<string, unknown>): SalesInvoice | string {
	if (typeof args.draft === "string") {
		const id = args.draft.trim().toUpperCase();
		return book.invoices.find((i) => i.id === id) ?? `Errore: non c'è la bozza ${id}.`;
	}
	if (typeof args.invoice === "string") {
		const found = findIssued(book.invoices, args.invoice);
		if (found.length === 0) return "Errore: non trovo una fattura emessa con quel numero.";
		if (found.length > 1 && found[0]?.year !== found[1]?.year) return `Errore: c'è una fattura con quel numero in più anni (${found.map((f) => f.year).join(", ")}): dimmi l'anno.`;
		return found[0] as IssuedInvoice;
	}
	const drafts = book.invoices.filter((i) => !isIssued(i));
	if (drafts.length === 1) return drafts[0] as SalesInvoice;
	return drafts.length === 0 ? "Errore: dimmi quale fattura, con il numero." : "Errore: ci sono più bozze, dimmi quale.";
}
