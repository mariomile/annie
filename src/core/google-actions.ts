import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type EventTime, GoogleUncertain } from "../connectors/google.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { AnnieRuntime } from "./runtime.ts";

/**
 * A write to a person's Google account that Annie asked for (ADR 0021): a mail sent or saved as
 * a draft, an event created, changed or deleted. It waits for the person whose account it is,
 * nobody else, and is done at most once: "running" is on disk before the request leaves, so a
 * crash in between leaves it "uncertain", never repeated (as web actions, ADR 0011).
 */
export type GoogleActionKind = "mail.send" | "mail.draft" | "calendar.create" | "calendar.update" | "calendar.delete";

export type MailDraft = {
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly body: string;
	/** Answering a message: the reply stays in its Gmail thread. */
	readonly inReplyTo?: { readonly id: string; readonly threadId: string; readonly messageId: string; readonly references: string };
};

/** For create, the event; for update, only what changes; for delete, the id. */
export type EventDraft = {
	readonly id?: string;
	readonly summary?: string;
	readonly start?: EventTime;
	readonly end?: EventTime;
	readonly location?: string;
	readonly description?: string;
	readonly attendees?: readonly string[];
};

export type GoogleAction = {
	readonly id: string;
	readonly kind: GoogleActionKind;
	/** The console person whose account it is: only they decide. */
	readonly personId: string;
	/** Their Google address, shown on the card. */
	readonly account: string;
	/** Why, in Annie's words. */
	readonly reason: string;
	readonly mail?: MailDraft;
	readonly event?: EventDraft;
	/** The event as it was when asked (update, delete): what the person is changing. */
	readonly current?: { readonly summary: string; readonly start: string; readonly end: string };
	/** Whether Google writes to the event's guests. */
	readonly notify?: boolean;
	readonly status: "pending" | "rejected" | "expired" | "running" | "done" | "failed" | "uncertain";
	readonly thread?: { readonly channel: string; readonly threadId: string };
	readonly proposedAt: string;
	readonly decidedAt?: string;
	readonly result?: GoogleActionResult;
};

/** What was done (and its link in Google, for events); or why not; or that it is not known. */
export type GoogleActionResult = { readonly done: string; readonly link?: string } | { readonly error: string; readonly uncertain?: true };

export class GoogleActionError extends Error {
	override readonly name = "GoogleActionError";
}

export const GOOGLE_ACTION_LIMITS = { maxPending: 20, ttlMs: 24 * 3600_000, maxRecipients: 20, maxSubject: 300, maxBody: 20_000, maxText: 2_000 } as const;

const DECIDING = new Map<string, Promise<unknown>>();

export class GoogleActionStore {
	constructor(readonly dir: string) {}

	/** `key` (the tool call's) makes a rerun return the same request instead of a second one. */
	async propose(input: Pick<GoogleAction, "kind" | "personId" | "account" | "reason" | "mail" | "event" | "current" | "notify" | "thread">, now = new Date(), key?: string): Promise<GoogleAction> {
		const id = key === undefined ? randomBytes(6).toString("hex") : createHash("sha256").update(`google:${key}`).digest("hex").slice(0, 12);
		if (key !== undefined) {
			const existing = await this.get(id, now);
			if (existing !== undefined) return existing;
		}
		const pending = (await this.list(now)).filter((a) => a.status === "pending");
		if (pending.length >= GOOGLE_ACTION_LIMITS.maxPending) throw new GoogleActionError(`troppe richieste in attesa (${GOOGLE_ACTION_LIMITS.maxPending}): falle decidere prima`);
		const action: GoogleAction = { ...input, id, status: "pending", proposedAt: now.toISOString() };
		await this.save(action);
		return action;
	}

	async get(id: string, now = new Date()): Promise<GoogleAction | undefined> {
		if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
		let action: GoogleAction;
		try {
			action = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as GoogleAction;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return action.status === "pending" && now.getTime() - Date.parse(action.proposedAt) > GOOGLE_ACTION_LIMITS.ttlMs ? { ...action, status: "expired" } : action;
	}

	async list(now = new Date()): Promise<GoogleAction[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const all = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => this.get(n.slice(0, -5), now)));
		return all.filter((a): a is GoogleAction => a !== undefined).sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
	}

	/** The first decision wins; approving marks it running, does it with `run`, stores the result. */
	decide(id: string, decision: "approved" | "rejected", personId: string, run: (action: GoogleAction) => Promise<GoogleActionResult>, now = new Date()): Promise<{ action: GoogleAction; changed: boolean }> {
		const work = async () => {
			const current = await this.get(id, now);
			if (current === undefined || current.personId !== personId) throw new GoogleActionError(`nessuna richiesta ${id}`);
			if (current.status !== "pending") return { action: current, changed: false };
			if (decision === "rejected") {
				const action: GoogleAction = { ...current, status: "rejected", decidedAt: now.toISOString() };
				await this.save(action);
				return { action, changed: true };
			}
			const running: GoogleAction = { ...current, status: "running", decidedAt: now.toISOString() };
			await this.save(running);
			const result = await run(running).catch((error: unknown): GoogleActionResult => ({ error: error instanceof Error ? error.message : String(error), ...(error instanceof GoogleUncertain ? { uncertain: true as const } : {}) }));
			const action: GoogleAction = { ...running, status: "error" in result ? (result.uncertain ? "uncertain" : "failed") : "done", result };
			await this.save(action);
			return { action, changed: true };
		};
		const key = `${this.dir}/${id}`;
		const running = (DECIDING.get(key) ?? Promise.resolve()).then(work);
		const tail = running.catch(() => {});
		DECIDING.set(key, tail);
		void tail.then(() => {
			if (DECIDING.get(key) === tail) DECIDING.delete(key);
		});
		return running;
	}

	/** At start: a write left running by a dead process may or may not have reached Google. */
	async settleInterrupted(): Promise<GoogleAction[]> {
		const settled: GoogleAction[] = [];
		for (const action of await this.list()) {
			if (action.status !== "running") continue;
			const next: GoogleAction = { ...action, status: "uncertain", result: { error: "Annie si è riavviata mentre lo faceva", uncertain: true } };
			await this.save(next);
			settled.push(next);
		}
		return settled;
	}

	private save(action: GoogleAction): Promise<void> {
		const stored = action.status === "expired" ? { ...action, status: "pending" as const } : action;
		return writeFileAtomic(join(this.dir, `${action.id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
	}
}

/** An address as Google takes it in a header: one mailbox, nothing that could add another or a header. */
export function validAddress(address: string): boolean {
	return address.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address);
}

/** One header value: no line breaks, words outside ASCII in RFC 2047's base64 form. */
function headerValue(value: string): string {
	if (/[\r\n]/.test(value)) throw new GoogleActionError("un'intestazione della mail non può andare a capo");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** The mail as Gmail takes it (RFC 2822, base64url): plain text, UTF-8. The sender is the account itself. */
export function mimeMessage(mail: MailDraft): string {
	const lines = [
		`To: ${mail.to.join(", ")}`,
		...(mail.cc.length === 0 ? [] : [`Cc: ${mail.cc.join(", ")}`]),
		`Subject: ${headerValue(mail.subject)}`,
		...(mail.inReplyTo === undefined || mail.inReplyTo.messageId === "" ? [] : [`In-Reply-To: ${headerValue(mail.inReplyTo.messageId)}`, `References: ${headerValue(`${mail.inReplyTo.references} ${mail.inReplyTo.messageId}`.trim())}`]),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
	];
	if ([...mail.to, ...mail.cc].some((a) => !validAddress(a))) throw new GoogleActionError("indirizzo non valido");
	const body = Buffer.from(mail.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
	return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

/** A start or end as the model gives it: a day, or a moment with or without its offset (then in `timeZone`). */
export function eventTime(value: string, timeZone: string): EventTime | undefined {
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.isNaN(Date.parse(value)) ? undefined : { date: value };
	const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
	if (m === null || Number.isNaN(Date.parse(`${m[1]}${m[2] ?? ":00"}${m[3] ?? "Z"}`))) return undefined;
	const local = `${m[1]}${m[2] ?? ":00"}`;
	return m[3] === undefined ? { dateTime: local, timeZone } : { dateTime: `${local}${m[3]}` };
}

/** Comparable instant (a zoneless time read as UTC: start and end share the zone, so the order holds). */
export function instant(time: EventTime): number {
	if ("date" in time) return Date.parse(`${time.date}T00:00:00Z`);
	return Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(time.dateTime) ? time.dateTime : `${time.dateTime}Z`);
}

/** What the person reads on the card and in the audit-free report: the action in one line. */
export function googleActionTitle(action: Pick<GoogleAction, "kind" | "mail" | "event" | "current">): string {
	switch (action.kind) {
		case "mail.send":
			return `Inviare una mail a ${action.mail?.to.join(", ")}`;
		case "mail.draft":
			return `Salvare una bozza per ${action.mail?.to.join(", ")}`;
		case "calendar.create":
			return `Creare l'evento «${action.event?.summary ?? ""}»`;
		case "calendar.update":
			return `Modificare l'evento «${action.current?.summary ?? action.event?.id ?? ""}»`;
		case "calendar.delete":
			return `Cancellare l'evento «${action.current?.summary ?? action.event?.id ?? ""}»`;
	}
}

/**
 * Decide a Google action: only the person whose account it is, from the console. Approving does
 * it once with `run`; the outcome goes back to the conversation for Annie to report.
 */
export async function decideGoogleAction(
	runtime: AnnieRuntime,
	tenant: string,
	instance: string,
	id: string,
	decision: "approved" | "rejected",
	personId: string,
	run: (action: GoogleAction) => Promise<GoogleActionResult>,
): Promise<GoogleAction> {
	const audit = runtime.audit(tenant);
	const { action, changed } = await runtime.googleActions(tenant, instance).decide(id, decision, personId, async (running) => {
		await audit.append({ type: "google_action.approved", instanceId: instance, actionId: id, kind: running.kind, recipients: (running.mail?.to.length ?? 0) + (running.mail?.cc.length ?? 0) + (running.event?.attendees?.length ?? 0), personId });
		return run(running);
	});
	if (!changed) return action;
	await audit.append({ type: `google_action.${action.status}`, instanceId: instance, actionId: id, kind: action.kind, personId });
	if (action.thread === undefined) return action;
	if (action.status === "rejected") {
		await runtime.sendMessage(tenant, instance, { ...action.thread, text: `Richiesta ${action.id} rifiutata: ${lowerFirst(googleActionTitle(action))}, non l'ho fatto.`, key: `google-action:${action.id}` });
		return action;
	}
	await runtime.submitNotice(tenant, instance, { ...action.thread, messageId: `google-action:${action.id}`, text: googleActionReport(action), event: { source: "google_action", actionId: action.id } });
	return action;
}

const DONE: Record<GoogleActionKind, string> = {
	"mail.send": "mail inviata",
	"mail.draft": "bozza salvata in Gmail (non inviata)",
	"calendar.create": "evento creato",
	"calendar.update": "evento modificato",
	"calendar.delete": "evento cancellato",
};

/** What Annie is told after the decision. Only our own words and Google's link: nothing to fence. */
export function googleActionReport(action: GoogleAction): string {
	const what = lowerFirst(googleActionTitle(action));
	const result = action.result;
	if (result !== undefined && "error" in result && result.uncertain)
		return `[Esito della richiesta ${action.id}] Approvata, ma non si sa se Google l'ha fatto (${result.error}). Dillo alla persona e suggeriscile di controllare in Gmail o nel calendario prima di chiederlo di nuovo; non rifarlo da sola.`;
	if (result === undefined || "error" in result) return `[Esito della richiesta ${action.id}] Approvata, ma non è riuscita: ${what}. Motivo: ${result?.error ?? "sconosciuto"}. Dillo alla persona con parole tue.`;
	return `[Esito della richiesta ${action.id}] Approvata dalla persona e fatta: ${DONE[action.kind]}${result.link === undefined ? "" : ` (${result.link})`}. Diglielo in breve.`;
}

function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}
