import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";

/**
 * The board (ADR 0049): the tenant's schede, in four columns, each assignable to an agente.
 * One board per tenant, because a scheda moves between agenti. A scheda assigned to an agente is
 * worked in a console conversation of that agente with the person who handed it over; the
 * agente moves it to «Da rivedere» and a person moves it to «Fatto».
 */
export const CARD_STATUSES = ["da_fare", "in_corso", "da_rivedere", "fatto"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const STATUS_LABEL: Record<CardStatus, string> = { da_fare: "Da fare", in_corso: "In corso", da_rivedere: "Da rivedere", fatto: "Fatto" };

export const CARD_PRIORITIES = ["bassa", "normale", "alta"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

/** Who did something: a person of the console or an agente, by ID. */
export type CardActor = { readonly kind: "person" | "agent"; readonly id: string };

export type CardEvent = {
	readonly at: string;
	readonly by: CardActor;
	readonly kind: "created" | "status" | "assigned" | "comment" | "edited";
	readonly status?: CardStatus;
	/** The agente assigned; null: nobody. */
	readonly assignee?: string | null;
	readonly text?: string;
};

export type Card = {
	readonly id: string;
	/** Shown as #n: short to say in chat. */
	readonly n: number;
	readonly title: string;
	readonly description: string;
	readonly status: CardStatus;
	readonly priority: CardPriority;
	/** The agente it is assigned to. */
	readonly assignee?: string;
	/** The conversation of the assignee where it is worked, and the person it is with. */
	readonly work?: { readonly agent: string; readonly threadId: string; readonly personId: string };
	readonly createdBy: CardActor;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Newest last, the latest BOARD_LIMITS.events. */
	readonly events: readonly CardEvent[];
};

type BoardFile = { readonly next: number; readonly cards: readonly Card[] };

export const BOARD_LIMITS = {
	/** Schede not yet «Fatto». */
	open: 300,
	/** «Fatto» schede kept, the most recent. */
	done: 200,
	title: 120,
	description: 4000,
	comment: 2000,
	events: 100,
} as const;

export class BoardError extends Error {
	override readonly name = "BoardError";
}

export type CardChange = {
	readonly title?: string;
	readonly description?: string;
	readonly priority?: CardPriority;
	readonly status?: CardStatus;
	/** null: nobody. */
	readonly assignee?: string | null;
	readonly work?: Card["work"] | null;
	readonly comment?: string;
	/** Refused unless the scheda is still in this column: two starts at once start it once. */
	readonly from?: CardStatus;
};

export class BoardStore {
	private readonly file: string;

	constructor(tenantDir: string) {
		this.file = join(tenantDir, "board.json");
	}

	list(): Card[] {
		return [...readJsonFile<BoardFile>(this.file, { next: 1, cards: [] }).cards];
	}

	/** By ID, or by number («12», «#12»). */
	get(ref: string): Card | undefined {
		const n = /^#?(\d{1,6})$/.exec(ref.trim())?.[1];
		return this.list().find((c) => c.id === ref || (n !== undefined && c.n === Number(n)));
	}

	create(input: { title: string; description?: string; priority?: CardPriority; assignee?: string }, by: CardActor, now = new Date()): Card {
		const title = clean(input.title, BOARD_LIMITS.title, "il titolo");
		if (title === "") throw new BoardError("Serve un titolo");
		const description = clean(input.description ?? "", BOARD_LIMITS.description, "la descrizione", true);
		const at = now.toISOString();
		let made: Card | undefined;
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (board.cards.filter((c) => c.status !== "fatto").length >= BOARD_LIMITS.open) throw new BoardError(`Ci sono già ${BOARD_LIMITS.open} schede aperte: chiudine qualcuna`);
			made = {
				id: `c_${randomBytes(6).toString("hex")}`,
				n: board.next,
				title,
				description,
				status: "da_fare",
				priority: input.priority ?? "normale",
				...(input.assignee === undefined ? {} : { assignee: input.assignee }),
				createdBy: by,
				createdAt: at,
				updatedAt: at,
				events: [{ at, by, kind: "created", ...(input.assignee === undefined ? {} : { assignee: input.assignee }) }],
			};
			return { next: board.next + 1, cards: [...board.cards, made] };
		});
		return made as Card;
	}

	/** Apply a change and record it; an agente never moves a scheda to «Fatto». */
	update(id: string, change: CardChange, by: CardActor, now = new Date()): Card {
		if (by.kind === "agent" && change.status === "fatto") throw new BoardError("Solo una persona sposta una scheda in «Fatto», dopo averla rivista");
		const at = now.toISOString();
		let changed: Card | undefined;
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			const card = board.cards.find((c) => c.id === id);
			if (card === undefined) throw new BoardError("Scheda inesistente");
			if (change.from !== undefined && card.status !== change.from) throw new BoardError(`La scheda #${card.n} non è più in «${STATUS_LABEL[change.from]}»`);
			if (by.kind === "agent" && card.status === "fatto" && change.status !== undefined) throw new BoardError(`La scheda #${card.n} è chiusa: la riapre una persona`);
			const events: CardEvent[] = [];
			let next: Card = card;
			if (change.title !== undefined || change.description !== undefined || (change.priority !== undefined && change.priority !== card.priority)) {
				const title = change.title === undefined ? card.title : clean(change.title, BOARD_LIMITS.title, "il titolo");
				if (title === "") throw new BoardError("Serve un titolo");
				const description = change.description === undefined ? card.description : clean(change.description, BOARD_LIMITS.description, "la descrizione", true);
				next = { ...next, title, description, priority: change.priority ?? card.priority };
				events.push({ at, by, kind: "edited" });
			}
			if (change.assignee !== undefined && (change.assignee ?? undefined) !== card.assignee) {
				const { assignee: _old, work: _work, ...rest } = next;
				next = change.assignee === null ? rest : { ...rest, assignee: change.assignee };
				events.push({ at, by, kind: "assigned", assignee: change.assignee });
			}
			if (change.work !== undefined) {
				const { work: _work, ...rest } = next;
				next = change.work === null ? rest : { ...rest, work: change.work };
			}
			if (change.status !== undefined && change.status !== card.status) {
				next = { ...next, status: change.status };
				events.push({ at, by, kind: "status", status: change.status });
			}
			if (change.comment !== undefined) {
				const text = clean(change.comment, BOARD_LIMITS.comment, "il commento", true);
				if (text !== "") events.push({ at, by, kind: "comment", text });
			}
			if (events.length === 0 && next === card) {
				changed = card;
				return board;
			}
			changed = { ...next, updatedAt: at, events: [...card.events, ...events].slice(-BOARD_LIMITS.events) };
			const cards = board.cards.map((c) => (c.id === id ? (changed as Card) : c));
			return { ...board, cards: keepDone(cards) };
		});
		return changed as Card;
	}

	remove(id: string): void {
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (!board.cards.some((c) => c.id === id)) throw new BoardError("Scheda inesistente");
			return { ...board, cards: board.cards.filter((c) => c.id !== id) };
		});
	}

	/** An agente deleted (ADR 0046): its schede go back to nobody, «Da fare» if they were being worked. */
	unassignAgent(agent: string, now = new Date()): void {
		const at = now.toISOString();
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (!board.cards.some((c) => c.assignee === agent || c.work?.agent === agent)) return board;
			const by: CardActor = { kind: "agent", id: agent };
			return {
				...board,
				cards: board.cards.map((c) => {
					if (c.assignee !== agent && c.work?.agent !== agent) return c;
					const { assignee: _a, work: _w, ...rest } = c;
					const back = c.status === "in_corso" ? "da_fare" : c.status;
					const events: CardEvent[] = [{ at, by, kind: "assigned", assignee: null, text: "agente eliminato" }, ...(back === c.status ? [] : [{ at, by, kind: "status" as const, status: back }])];
					return { ...rest, status: back, updatedAt: at, events: [...c.events, ...events].slice(-BOARD_LIMITS.events) };
				}),
			};
		});
	}
}

/** The most recent «Fatto» schede stay, the older ones go. */
function keepDone(cards: readonly Card[]): Card[] {
	const done = cards.filter((c) => c.status === "fatto").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const dropped = new Set(done.slice(BOARD_LIMITS.done).map((c) => c.id));
	return cards.filter((c) => !dropped.has(c.id));
}

function clean(text: string, max: number, what: string, multiline = false): string {
	const t = multiline ? text.replace(/\r\n?/g, "\n").trim() : text.replace(/\s+/g, " ").trim();
	if (t.length > max) throw new BoardError(`Testo troppo lungo per ${what}: al massimo ${max} caratteri`);
	return t;
}
