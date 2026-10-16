import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage } from "../channels/types.ts";
import type { CrmAdapter, InboundMail, MailAdapter } from "../connectors/types.ts";
import { writeFileAtomic } from "../core/atomic-file.ts";
import type { AuditLog } from "../core/audit.ts";
import type { ModelClient } from "../core/completion.ts";
import type { ModelRoles } from "../core/model-routing.ts";
import { callbackData, type Pratica, PracticeStore, type TenantSegreteriaConfig } from "../core/practice.ts";
import { romeDayKey, TELEGRAM_HARD_CAP, type UsageLedger } from "../core/usage.ts";
import { type CallbackDeps, handleEditMessage, handleTelegramCallback, recoverAfterCrash } from "./callbacks.ts";
import type { ChecksConfig } from "./checks.ts";
import { maybeDelivered, type Notification, NotificationOutbox, type NotificationEntry } from "./notifications.ts";
import { forceQuote, type PipelineDeps, processInboundMail } from "./pipeline.ts";
import * as copy from "./telegram-copy.ts";

export type SegreteriaOptions = {
	readonly tenantId: string;
	readonly instanceId: string;
	/** The instance's own directory (pratiche, notifications, mail cursor). */
	readonly instanceDir: string;
	readonly mail: MailAdapter;
	readonly crm: CrmAdapter;
	/** Telegram adapter of this instance: cards out, taps and edit texts in. */
	readonly telegram: ChannelAdapter;
	readonly audit: AuditLog;
	readonly usage: UsageLedger;
	readonly roles: ModelRoles;
	readonly model?: { client: ModelClient; checks: ChecksConfig };
	/** Telegram user IDs of the sales people: the only ones who can act, and who get every card. */
	readonly salesUserIds: readonly string[];
	readonly tenantConfig?: TenantSegreteriaConfig;
	readonly pollIntervalMs?: number;
	/** After this many failed attempts a mail is skipped, with a notice. */
	readonly maxMailFailures?: number;
	readonly log?: (message: string) => void;
};

type CursorState = {
	cursor: string;
	/** Mails given up on after repeated failures. */
	skipped: string[];
	failures: Record<string, number>;
	/** Rome day of the last hard-cap notice, so it goes out once a day. */
	hardCapNoticeDay?: string;
};

/** How long after Modifica a text from the same person counts as the edit. */
const EDIT_WINDOW_MS = 30 * 60_000;

const ACTIONS: Record<string, "approve" | "edit" | "discard"> = { Approva: "approve", Modifica: "edit", Scarta: "discard" };

/**
 * The segreteria commerciale, running: polls the mailbox, turns each request into a pratica
 * with a draft, puts the card with Approva / Modifica / Scarta in front of the sales people
 * on Telegram, and sends the reply only after Approva. «Bozze, non invii autonomi.»
 *
 * All work (new mail, taps, edit texts) runs through one queue: a pratica is never changed
 * by two flows at once.
 */
export class SegreteriaService {
	readonly practices: PracticeStore;
	private readonly notifications: NotificationOutbox;
	private readonly cursorFile: string;
	private readonly sales: ReadonlySet<string>;
	private queue: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(private readonly options: SegreteriaOptions) {
		this.practices = new PracticeStore(options.instanceDir);
		this.notifications = new NotificationOutbox(join(options.instanceDir, "notifications"));
		this.cursorFile = join(options.instanceDir, "mail-cursor.json");
		this.sales = new Set(options.salesUserIds);
		options.telegram.onInbound((message) => this.serial(() => this.onText(message)));
		if (options.telegram.onAction === undefined) throw new Error(`Channel ${options.telegram.name} has no buttons; the segreteria needs them`);
		options.telegram.onAction((action) => this.serial(() => this.onTap(action)));
	}

	/** Resend cards a crash left undelivered, re-propose interrupted sends, then start polling. */
	async start(): Promise<void> {
		await this.serial(() => this.recover());
		this.stopped = false;
		const loop = async () => {
			if (this.stopped) return;
			try {
				await this.pollOnce();
			} catch (error) {
				this.log(`mail poll failed: ${errorText(error)}`);
			}
			if (!this.stopped) this.timer = setTimeout(loop, this.options.pollIntervalMs ?? 60_000);
		};
		void loop();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		await this.queue.catch(() => {});
	}

	/** One mailbox round. Exposed for tests. */
	pollOnce(): Promise<{ processed: number }> {
		return this.serial(() => this.poll());
	}

	/** Resend pending cards and re-propose sends interrupted by a crash. Exposed for tests. */
	recoverNow(): Promise<void> {
		return this.serial(() => this.recover());
	}

	private async poll(): Promise<{ processed: number }> {
		// Cards Telegram refused earlier (rate limit, network): try them again every round.
		for (const entry of await this.notifications.list()) await this.deliver(entry);
		const state = await this.readCursor();
		const { messages, nextCursor } = await this.options.mail.listNewRequests(this.options.tenantId, state.cursor, {
			isKnown: async (id) => state.skipped.includes(id) || (await this.practices.findByMailMessageId(id)) !== undefined,
		});
		let processed = 0;
		for (const mail of messages) {
			if (state.skipped.includes(mail.messageId)) continue;
			try {
				const result = await processInboundMail(this.pipelineDeps(), mail);
				if (result.action !== "noop_duplicate") processed++;
				else await this.ensureCard(result.pratica);
				delete state.failures[mail.messageId];
			} catch (error) {
				if (errorText(error) === "hard_cap") {
					await this.hardCapNotice(state);
					// Keep the cursor: these mails are read again once the cap resets.
					await this.writeCursor(state);
					return { processed };
				}
				await this.mailFailed(state, mail, error);
				if (!state.skipped.includes(mail.messageId)) {
					await this.writeCursor(state);
					return { processed };
				}
			}
		}
		await this.writeCursor({ ...state, cursor: nextCursor });
		return { processed };
	}

	private async mailFailed(state: CursorState, mail: InboundMail, error: unknown): Promise<void> {
		const failures = (state.failures[mail.messageId] ?? 0) + 1;
		state.failures[mail.messageId] = failures;
		this.log(`mail ${mail.messageId} failed (${failures}): ${errorText(error)}`);
		await this.options.audit.append({ type: "mail.failed", instanceId: this.options.instanceId, mailMessageId: mail.messageId, failures, error: errorText(error) });
		if (failures < (this.options.maxMailFailures ?? 3)) return;
		state.skipped.push(mail.messageId);
		delete state.failures[mail.messageId];
		await this.notify({
			text: `Mail non elaborata

Non riesco a elaborare la mail «${mail.subject}» da ${mail.from} (ricevuta ${copy.formatReceivedAt(mail.receivedAt)}). Ho smesso di riprovare: controllala a mano nella casella.`,
			buttons: [],
			praticaId: "mail",
			draftVersion: 0,
		});
	}

	/**
	 * A mail read again is one whose round never finished. If the process died after saving
	 * its pratica and before writing the card, the sales people never got it: send it now.
	 */
	private async ensureCard(pratica: Pratica): Promise<void> {
		const waitsForTap = pratica.status === "draft_ready" || (pratica.status === "classified_skip" && pratica.classification === "spam");
		if (!waitsForTap || (await this.notifications.hasCard(pratica.praticaId, pratica.draftVersion))) return;
		await this.options.audit.append({ type: "card.recovered", instanceId: this.options.instanceId, praticaId: pratica.praticaId, draftVersion: pratica.draftVersion });
		await this.notify({
			text: pratica.status === "draft_ready" ? `${copy.newRequestNotice(pratica)}\n\n${copy.leadCardAndDraft(pratica)}` : copy.spamNotice(pratica),
			buttons: [...copy.BUTTONS],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
	}

	private async hardCapNotice(state: CursorState): Promise<void> {
		const day = romeDayKey();
		if (state.hardCapNoticeDay === day) return;
		state.hardCapNoticeDay = day;
		await this.notify({ text: TELEGRAM_HARD_CAP, buttons: [], praticaId: "hard-cap", draftVersion: 0 });
	}

	private async onTap(action: InboundAction): Promise<void> {
		await handleTelegramCallback(this.callbackDeps(), { userId: action.userId, callbackData: action.data, actionId: action.actionId });
	}

	private async onText(message: InboundMessage): Promise<void> {
		if (!this.sales.has(message.userId)) {
			// Silent to strangers (A8), visible to the owner.
			await this.options.audit.append({ type: "user.denied", instanceId: this.options.instanceId, channel: message.channel, userId: message.userId, action: "text" });
			return;
		}
		// The text is the edit of the pratica this person tapped Modifica on, if it is recent.
		const since = Date.now() - EDIT_WINDOW_MS;
		const editing = (await this.practices.list())
			.filter((p) => p.status === "awaiting_edit" && p.editingBy === message.userId && Date.parse(p.editingSince ?? "") >= since)
			.sort((a, b) => (b.editingSince ?? "").localeCompare(a.editingSince ?? ""))[0];
		if (editing === undefined) {
			await this.options.telegram.send({
				tenantId: this.options.tenantId,
				instanceId: this.options.instanceId,
				channel: this.options.telegram.name,
				threadId: message.threadId,
				text: "Segreteria attiva. Le nuove richieste di preventivo arrivano qui da sole, con la bozza e i pulsanti Approva, Modifica e Scarta. Per cambiare una bozza tocca Modifica, poi scrivi qui.",
				idempotencyKey: `help:${message.messageId ?? Date.now()}`,
			});
			return;
		}
		await handleEditMessage(this.callbackDeps(), { userId: message.userId, praticaId: editing.praticaId, text: message.text });
	}

	private async recover(): Promise<void> {
		for (const entry of await this.notifications.list()) await this.deliver(entry);
		for (const pratica of await this.practices.list()) {
			if (pratica.status === "approved" && !pratica.sentMessageId) await recoverAfterCrash(this.callbackDeps(), pratica.praticaId);
		}
	}

	/** Write the card to the outbox, then send it to every sales person. */
	private async notify(notification: Notification): Promise<void> {
		if (this.sales.size === 0) {
			this.log(`no sales person allowed on Telegram, message dropped: ${notification.text.split("\n")[0]}`);
			return;
		}
		const entry = await this.notifications.add(notification, [...this.sales]);
		await this.deliver(entry);
	}

	private async deliver(initial: NotificationEntry): Promise<void> {
		let entry = initial;
		for (const chat of initial.pending) {
			const duplicate = maybeDelivered(entry, chat);
			entry = (await this.notifications.attempt(entry, chat)).entry;
			const text = duplicate ? `${copy.duplicateNotifyLine()}\n\n${entry.text}` : entry.text;
			try {
				await this.options.telegram.send({
					tenantId: this.options.tenantId,
					instanceId: this.options.instanceId,
					channel: this.options.telegram.name,
					// Private chat with the sales person: the chat ID is the user ID.
					threadId: chat,
					text,
					idempotencyKey: `card:${entry.id}:${chat}`,
					buttons: entry.buttons.map((label) => {
						const action = ACTIONS[label];
						if (action === undefined) throw new Error(`Unknown button "${label}"`);
						return { label, data: callbackData(entry.praticaId, entry.draftVersion, action) };
					}),
				});
				entry = await this.notifications.delivered(entry, chat);
			} catch (error) {
				// Refused by Telegram: the card did not arrive. Otherwise (network) it may have. Retried next round.
				if (error instanceof ChannelRefused) entry = await this.notifications.refused(entry, chat);
				this.log(`card to ${chat} not sent, retried next round: ${errorText(error)}`);
			}
		}
	}

	private pipelineDeps(): PipelineDeps {
		const o = this.options;
		return {
			tenantId: o.tenantId,
			instanceId: o.instanceId,
			practices: this.practices,
			mail: o.mail,
			crm: o.crm,
			audit: o.audit,
			usage: o.usage,
			roles: o.roles,
			...(o.model === undefined ? {} : { model: o.model }),
			...(o.tenantConfig === undefined ? {} : { tenantConfig: o.tenantConfig }),
			notify: (n) => this.notify(n),
		};
	}

	private callbackDeps(): CallbackDeps {
		const o = this.options;
		return {
			tenantId: o.tenantId,
			instanceId: o.instanceId,
			practices: this.practices,
			mail: o.mail,
			crm: o.crm,
			audit: o.audit,
			allowedUserIds: this.sales,
			notify: (n) => this.notify(n),
			forceExtract: async (pratica) => {
				await forceQuote(this.pipelineDeps(), pratica);
			},
		};
	}

	private async readCursor(): Promise<CursorState> {
		try {
			const state = JSON.parse(await readFile(this.cursorFile, "utf8")) as Partial<CursorState>;
			return { cursor: state.cursor ?? "", skipped: state.skipped ?? [], failures: state.failures ?? {}, ...(state.hardCapNoticeDay === undefined ? {} : { hardCapNoticeDay: state.hardCapNoticeDay }) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cursor: "", skipped: [], failures: {} };
			throw error;
		}
	}

	private writeCursor(state: CursorState): Promise<void> {
		// Keep the skip list bounded: old IDs fall behind the cursor anyway.
		return writeFileAtomic(this.cursorFile, `${JSON.stringify({ ...state, skipped: state.skipped.slice(-500) })}\n`);
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		// Errors go to the caller (the poll loop, the Telegram adapter), which logs them.
		const run = this.queue.then(work);
		this.queue = run.catch(() => {});
		return run;
	}

	private log(message: string): void {
		(this.options.log ?? console.error)(`segreteria: ${message}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
