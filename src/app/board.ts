import type { ChannelAdapter } from "../channels/types.ts";
import type { BoardStore } from "../core/board.ts";
import { type BoardReview, BoardWork } from "../core/board-work.ts";
import type { AnnieRuntime } from "../core/runtime.ts";
import type { PeopleStore } from "../web/auth.ts";
import type { WebChannel } from "../web/channel.ts";

export type BoardWiring = {
	readonly runtime: AnnieRuntime;
	readonly tenant: string;
	readonly store: BoardStore;
	readonly people: PeopleStore;
	/** The main agente: the owner hears of schede to review in their chat with it. */
	readonly main: string;
	/** The agente's name, or undefined when it is not one a scheda can go to (missing, a segreteria). */
	readonly agentName: (agent: string) => Promise<string | undefined>;
	/** Whether the person may talk to the agente from the console. */
	readonly canChat: (agent: string, personId: string) => Promise<boolean>;
	readonly webChannel: (agent: string) => WebChannel | undefined;
	/** The main agente's Telegram and WhatsApp, where its approvers are. */
	readonly ownerChats: () => readonly (ChannelAdapter | undefined)[];
	readonly log: (message: string) => void;
};

/**
 * The board of a tenant at work (ADR 0050, 0051, 0061): schede handed to agenti are worked in
 * a console conversation, an agente working alone is told to go on after each answer, and a
 * scheda to review reaches the owner's chat with the main agente too.
 */
export function startBoard(w: BoardWiring): BoardWork {
	const { runtime, tenant, people, log } = w;
	const consoleOf = (agent: string) => {
		const channel = w.webChannel(agent);
		if (channel === undefined) throw new Error(`agente ${agent} has no console`);
		return channel;
	};
	const work = new BoardWork({
		store: w.store,
		agentName: w.agentName,
		canChat: w.canChat,
		isOwner: async (personId) => (await people.get(personId))?.role === "owner",
		owners: async () => (await people.list()).filter((p) => p.role === "owner").map((p) => p.id),
		personName: async (personId) => (await people.get(personId))?.name,
		openThread: async (agent, personId, title, reuse) => {
			const channel = consoleOf(agent);
			if (reuse !== undefined && (await channel.thread(reuse)) !== undefined) return reuse;
			return (await channel.createThread(personId, title)).id;
		},
		post: async (agent, threadId, personId, text) => {
			await consoleOf(agent).post(threadId, personId, text);
		},
	});
	// «Esegui da solo» (ADR 0061): each reply in the conversation of a scheda may be followed by «go on».
	runtime.onReply((reply) => {
		// Only answers to what was written in the conversation: not files or messages sent mid-turn.
		if (reply.tenantId !== tenant || reply.channel !== "web" || reply.status === "file" || reply.submissionId === "message") return;
		void work.afterReply(reply.instanceId, reply.threadId, reply.deliveryId, reply.status === "unanswered" ? reply.reason : undefined).catch((error: unknown) => log(`annie: board after reply in ${reply.threadId}: ${error instanceof Error ? error.message : String(error)}`));
	});
	// A scheda to review (ADR 0051): when it is the owner's, a line in the owner's chat with the main agente too.
	const noticeReview = async ({ card, people: to }: BoardReview): Promise<void> => {
		if (!(await Promise.all(to.map(async (id) => (await people.get(id))?.role === "owner"))).some(Boolean)) return;
		const record = await runtime.registry.getInstance(tenant, w.main);
		const agent = card.assignee === undefined ? undefined : (await runtime.registry.getInstance(tenant, card.assignee).catch(() => undefined))?.name;
		// The agente's words on this move, not an older round's.
		const moved = card.events.findLastIndex((e) => e.kind === "status" && e.status === "da_rivedere");
		const summary = card.events.slice(moved).find((e) => e.kind === "comment" && e.by.kind === "agent" && e.by.id === card.assignee)?.text;
		const text = `Scheda #${card.n} da rivedere: ${card.title}${agent === undefined ? "" : `\n${agent} l'ha finita`}${summary === undefined ? "." : `: ${summary.length > 300 ? `${summary.slice(0, 300)}[...]` : summary}`}\n\nApprovala o rimandala indietro dalla Board della console.`;
		for (const adapter of w.ownerChats()) {
			if (adapter === undefined) continue;
			for (const chat of record.approvers?.[adapter.name] ?? []) {
				await adapter
					.send({ tenantId: tenant, instanceId: w.main, channel: adapter.name, threadId: chat, idempotencyKey: `board-review:${card.id}:${card.updatedAt}:${chat}`, text })
					.catch((error: unknown) => log(`annie: notice for scheda #${card.n} to ${adapter.name} ${chat} not sent: ${error instanceof Error ? error.message : String(error)}`));
			}
		}
	};
	work.events.on("review", (review: BoardReview) => {
		void noticeReview(review).catch((error: unknown) => log(`annie: notice for scheda #${review.card.n} not sent: ${error instanceof Error ? error.message : String(error)}`));
	});
	return work;
}
