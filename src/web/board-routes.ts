import { BOARD_LIMITS, BoardError, type BoardStore, CARD_PRIORITIES, CARD_STATUSES, type CardChange, type CardPriority, type CardStatus } from "../core/board.ts";
import type { BoardWork } from "../core/board-work.ts";
import type { AnnieRuntime } from "../core/runtime.ts";
import type { Person, PeopleStore } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";

export type BoardRoutesDeps = {
	readonly runtime: AnnieRuntime;
	readonly tenantId: string;
	readonly people: PeopleStore;
	readonly board: { readonly store: BoardStore; readonly work: BoardWork } | undefined;
	/** Segreterie take no schede. */
	readonly segreterie: ReadonlyMap<string, unknown> | undefined;
};

/**
 * The board in the console (ADR 0050). The owner sees every scheda; a member those they created
 * or work on, and those of the agenti they can talk to.
 */
export function boardRoutes(route: AddRoute, { runtime, tenantId, people, board, segreterie }: BoardRoutesDeps): void {
	const boardOf = () => {
		if (board === undefined) throw new HttpError(501, "La board non è disponibile su questo server");
		return board;
	};
	const boardAgents = async () => (await runtime.registry.listInstances(tenantId)).filter((r) => !(segreterie?.has(r.id) ?? false));
	/** The scheda, if this person sees it. */
	const visibleCard = async (ref: string, p: Person) => {
		const { store, work } = boardOf();
		const card = store.get(ref);
		if (card === undefined || !(await work.visibleTo(card, p.id))) throw new HttpError(404, "Scheda inesistente");
		return card;
	};
	const boardError = (error: unknown): never => {
		if (error instanceof BoardError) throw new HttpError(400, error.message);
		throw error;
	};
	const cardBody = (body: Record<string, unknown>) => {
		if (body.priority !== undefined && !(CARD_PRIORITIES as readonly unknown[]).includes(body.priority)) throw new HttpError(400, `Priorità: ${CARD_PRIORITIES.join(", ")}`);
		if (body.status !== undefined && !(CARD_STATUSES as readonly unknown[]).includes(body.status)) throw new HttpError(400, `Colonna: ${CARD_STATUSES.join(", ")}`);
		const priority = body.priority as CardPriority | undefined;
		const status = body.status as CardStatus | undefined;
		const assignee = body.assignee === null || body.assignee === "" ? null : typeof body.assignee === "string" ? body.assignee : undefined;
		return { priority, status, assignee };
	};
	route("GET", "/api/board", "person", async ({ person }) => {
		const { store, work } = boardOf();
		const p = person as Person;
		const agents = await boardAgents();
		const all = store.list();
		const seen = await Promise.all(all.map((c) => work.visibleTo(c, p.id)));
		const cards = all.filter((_, i) => seen[i]);
		const names = new Map((await people.list()).map((x) => [x.id, x.name]));
		const involved = new Set(cards.flatMap((c) => [c.createdBy, ...c.events.map((e) => e.by)].filter((a) => a.kind === "person").map((a) => a.id)));
		return {
			cards,
			agents: agents.map((r) => ({ id: r.id, name: r.name, ...(r.persona?.emoji === undefined ? {} : { emoji: r.persona.emoji }), canAssign: r.egress.channels.includes("web") && (r.allowedUsers.web ?? []).includes(p.id) })),
			people: Object.fromEntries([...involved].map((id) => [id, names.get(id) ?? "una persona"])),
			auto: { replies: BOARD_LIMITS.autoRounds, hours: BOARD_LIMITS.autoMs / 3_600_000 },
		};
	});
	route("POST", "/api/board", "person", async ({ person, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const body = (await readJson(req)) as Record<string, unknown>;
		const { priority, assignee } = cardBody(body);
		const card = await work
			.create({ title: typeof body.title === "string" ? body.title : "", ...(typeof body.description === "string" ? { description: body.description } : {}), ...(priority === undefined ? {} : { priority }), ...(assignee ? { assignee } : {}), ...(body.auto === true ? { auto: true } : {}), ...(typeof body.parent === "string" && body.parent !== "" ? { parent: (await visibleCard(body.parent, p)).id } : {}) }, { kind: "person", id: p.id }, p.id)
			.catch(boardError);
		await runtime.audit(tenantId).append({ type: "board.card_created", cardId: card.id, personId: p.id, ...(card.assignee === undefined ? {} : { assignee: card.assignee }), ...(card.parent === undefined ? {} : { parent: card.parent }) });
		return { card };
	});
	route("PUT", "/api/board/:id", "person", async ({ person, params, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const card = await visibleCard(params[0] as string, p);
		const body = (await readJson(req)) as Record<string, unknown>;
		const { priority, status, assignee } = cardBody(body);
		const change: CardChange = {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(priority === undefined ? {} : { priority }),
			...(status === undefined ? {} : { status }),
			...(assignee === undefined ? {} : { assignee }),
			...(typeof body.comment === "string" ? { comment: body.comment } : {}),
			// «Esegui da solo» on (counting from now) or off.
			...(typeof body.auto === "boolean" ? { auto: body.auto ? { rounds: 0, since: new Date().toISOString() } : null } : {}),
		};
		const changed = await work.change(card.id, change, { kind: "person", id: p.id }, p.id).catch(boardError);
		await runtime.audit(tenantId).append({ type: "board.card_changed", cardId: card.id, personId: p.id, fields: Object.keys(change).join(","), ...(status === undefined ? {} : { status }) });
		return { card: changed };
	});
	// Avvia: the work on a scheda waiting in «Da fare» starts, with whoever presses it.
	route("POST", "/api/board/:id/start", "person", async ({ person, params, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const card = await visibleCard(params[0] as string, p);
		const body = (await readJson(req)) as { auto?: unknown };
		const started = await work.startWaiting(card.id, p.id, { kind: "person", id: p.id }, body.auto === true).catch(boardError);
		await runtime.audit(tenantId).append({ type: "board.card_started", cardId: card.id, personId: p.id, assignee: started.assignee ?? "", auto: started.auto !== undefined });
		return { card: started };
	});
	route("DELETE", "/api/board/:id", "person", async ({ person, params }) => {
		const { store } = boardOf();
		const p = person as Person;
		const card = await visibleCard(params[0] as string, p);
		if (p.role !== "owner" && !(card.createdBy.kind === "person" && card.createdBy.id === p.id)) throw new HttpError(403, "Solo chi l'ha creata o l'owner la elimina");
		try {
			store.remove(card.id);
		} catch (error) {
			boardError(error);
		}
		await runtime.audit(tenantId).append({ type: "board.card_deleted", cardId: card.id, personId: p.id });
		return { ok: true };
	});
}
