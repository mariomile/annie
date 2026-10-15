import type { ChannelAdapter } from "./channels/types.ts";
import type { AnnieRuntime } from "./core/index.ts";

/**
 * Connects a channel adapter, bound to one instance, to the core: inbound messages become
 * submissions; replies of that instance on that channel go back out through it, and only
 * through it, and are confirmed to the core's outbox once the channel accepts them.
 * The only module that knows both sides.
 */
export function connectChannel(
	runtime: AnnieRuntime,
	adapter: ChannelAdapter,
	instance: { readonly tenantId: string; readonly instanceId: string },
	log: (message: string) => void = console.error,
): () => void {
	adapter.onInbound(async (message) => {
		try {
			await runtime.submit(message);
		} catch (error) {
			log(`${adapter.name}: message not submitted: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	return runtime.onReply((reply) => {
		if (reply.channel !== adapter.name || reply.tenantId !== instance.tenantId || reply.instanceId !== instance.instanceId) return;
		const text = reply.status === "answered" ? reply.text : "Non sono riuscita a rispondere. Riprova tra poco.";
		if (reply.status === "unanswered") log(`${adapter.name}: unanswered in thread ${reply.threadId}: ${reply.reason}`);
		adapter
			.send({ tenantId: reply.tenantId, instanceId: reply.instanceId, channel: reply.channel, threadId: reply.threadId, text, idempotencyKey: reply.deliveryId, possibleDuplicate: reply.possibleDuplicate })
			.then(
				// Not confirmed: the reply stays in the outbox and goes out again on the next resume.
				() => runtime.markDelivered(reply),
				(error: unknown) => log(`${adapter.name}: send failed, kept in the outbox: ${error instanceof Error ? error.message : String(error)}`),
			)
			.catch((error: unknown) => log(`${adapter.name}: sent, but not confirmed in the outbox: ${error instanceof Error ? error.message : String(error)}`));
	});
}
