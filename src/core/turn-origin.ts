/**
 * Where a turn comes from (ADR 0088): a person's own message (`person`), a notice from the
 * instance's own work (`notice`: an action's outcome, a recurring invoice ready), something that
 * fires by itself (`scheduled`: a task programmato, a sentinella, an automazione, the board), or
 * another agente (`agent`: agent_message, a stanza where an agente called it). Given at admission,
 * stored with the turn's input in the durable engine (a rerun or a recovery keeps it), and read by
 * the tools as `ctx.origin`.
 *
 * What cannot be undone after a «sì» (`confirm: true`: issuing an invoice, a bank confirmation,
 * a merge…) goes on only in a person's turn: a page, a mail, a schedule or another agente never
 * stand for the person's yes. A turn whose origin is not known counts as not a person's.
 */
import type { ToolContext } from "./engine.ts";

export const TURN_ORIGINS = ["person", "notice", "scheduled", "agent"] as const;
export type TurnOrigin = (typeof TURN_ORIGINS)[number];

export const isTurnOrigin = (v: unknown): v is TurnOrigin => typeof v === "string" && (TURN_ORIGINS as readonly string[]).includes(v);

/** Where the turn came from, in words, for the refusal. */
const FROM: Readonly<Record<TurnOrigin, string>> = {
	person: "",
	notice: "questo turno nasce da un avviso del mio lavoro",
	scheduled: "questo turno nasce da un'attività programmata",
	agent: "questo turno nasce dalla richiesta di un altro agente",
};

/**
 * undefined when the turn is a person's: the confirmed step may go on. Otherwise the refusal to
 * give the model; `what` is the step in the first person («emetto la fattura»). The preview (no
 * confirm) still works.
 */
export function requirePersonFor(ctx: Pick<ToolContext, "origin">, what: string): string | undefined {
	if (ctx.origin === "person") return undefined;
	const why = ctx.origin === undefined ? "non so da dove viene questo turno" : FROM[ctx.origin];
	return `Errore: ${what.charAt(0).toUpperCase()}${what.slice(1)} solo dopo un messaggio della persona, e ${why}. Questo lo confermo solo dopo un messaggio della persona: chiedile se va bene, e ripeti con la conferma solo dopo il suo sì, in un suo messaggio.`;
}
