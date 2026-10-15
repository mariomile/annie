import type { ChannelAdapter, InboundAction, InboundMessage } from "./channels/types.ts";
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
	/** Button taps on this channel (approval cards). Must be idempotent: taps can be redelivered. */
	onAction?: (action: InboundAction) => Promise<void>,
): () => void {
	if (onAction !== undefined) {
		if (adapter.onAction === undefined) throw new Error(`Channel ${adapter.name} has no buttons`);
		adapter.onAction(onAction);
	}
	adapter.onInbound(async (message) => {
		try {
			await runtime.submit(await withAttachments(runtime, message));
		} catch (error) {
			log(`${adapter.name}: message not submitted: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	return runtime.onReply((reply) => {
		if (reply.channel !== adapter.name || reply.tenantId !== instance.tenantId || reply.instanceId !== instance.instanceId) return;
		const base = { tenantId: reply.tenantId, instanceId: reply.instanceId, channel: reply.channel, threadId: reply.threadId, idempotencyKey: reply.deliveryId, possibleDuplicate: reply.possibleDuplicate };
		const sending = async (): Promise<void> => {
			if (reply.status === "file") {
				const data = await runtime.workspace(reply.tenantId, reply.instanceId).read(reply.path);
				const name = reply.path.split("/").at(-1) ?? reply.path;
				if (adapter.sendFile === undefined) return adapter.send({ ...base, text: `File pronto nel workspace: ${reply.path}${reply.caption ? `\n${reply.caption}` : ""}` });
				return adapter.sendFile({ ...base, name, data, path: reply.path, ...(reply.caption === undefined ? {} : { caption: reply.caption }) });
			}
			if (reply.status === "unanswered") log(`${adapter.name}: unanswered in thread ${reply.threadId}: ${reply.reason}`);
			const text = reply.status === "answered" ? reply.text : "Non sono riuscita a rispondere. Riprova tra poco.";
			return adapter.send({ ...base, text });
		};
		sending()
			.then(
				// Not confirmed: the reply stays in the outbox and goes out again on the next resume.
				() => runtime.markDelivered(reply),
				(error: unknown) => log(`${adapter.name}: send failed, kept in the outbox: ${error instanceof Error ? error.message : String(error)}`),
			)
			.catch((error: unknown) => log(`${adapter.name}: sent, but not confirmed in the outbox: ${error instanceof Error ? error.message : String(error)}`));
	});
}

/**
 * Store the files of an inbound message in the instance's workspace, under uploads/, and
 * tell the instance where they are. Only for allowed users: the core decides that on submit,
 * so files of a stranger are dropped here, before they touch the disk.
 */
async function withAttachments(runtime: AnnieRuntime, message: InboundMessage): Promise<InboundMessage> {
	if (message.attachments === undefined || message.attachments.length === 0) return message;
	const record = await runtime.registry.getInstance(message.tenantId, message.instanceId);
	const allowed = (record.allowedUsers[message.channel] ?? []).includes(message.userId);
	if (!allowed) return { ...message, attachments: [] };
	const workspace = runtime.workspace(message.tenantId, message.instanceId);
	const saved: string[] = [];
	for (const file of message.attachments) {
		const safe = file.name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
		const path = `uploads/${message.messageId?.replace(/[^\w-]/g, "_") ?? Date.now()}-${safe}`;
		await workspace.write(path, file.data);
		saved.push(path);
	}
	const note = saved.map((p) => `[File caricato nel workspace: ${p}]`).join("\n");
	const { attachments: _files, ...rest } = message;
	return { ...rest, text: message.text === "" ? note : `${message.text}\n\n${note}` };
}
