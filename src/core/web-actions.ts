import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import { CookieJar, pageText, WebFetchRefused, type WebFetchOptions, webFetch } from "./web-fetch.ts";
import { FormRefused, formBody, pageForms, type WebForm } from "./web-forms.ts";

/**
 * A form Annie asked to send (web_submit), waiting for (or past) a person's decision. Sent at
 * most once: the status is "running" on disk before the request leaves, so a crash in between
 * leaves it "uncertain", never sent twice (ADR 0011).
 */
export type WebAction = {
	readonly id: string;
	/** The page the form is on. */
	readonly pageUrl: string;
	readonly form: number;
	/** Where the form goes and how, as seen when it was asked: checked again before sending. */
	readonly action: string;
	readonly method: "POST";
	readonly values: Readonly<Record<string, string>>;
	/** Why, in Annie's words: shown on the card. */
	readonly reason: string;
	readonly status: "pending" | "approved" | "rejected" | "expired" | "running" | "done" | "failed" | "uncertain";
	readonly thread?: { readonly channel: string; readonly threadId: string };
	/** The person whose private conversation asked for it ("channel:userId"): they may decide. */
	readonly requester?: string;
	readonly proposedAt: string;
	readonly decidedBy?: { readonly channel: string; readonly userId: string };
	readonly decidedAt?: string;
	readonly result?: { readonly status: number; readonly url: string; readonly title: string; readonly text: string } | { readonly error: string };
	/** Chats that have the card. */
	readonly notified?: readonly string[];
};

export class WebActionError extends Error {
	override readonly name = "WebActionError";
}

export const WEB_ACTION_LIMITS = { maxPending: 20, ttlMs: 24 * 3600_000, maxValues: 50, maxValueChars: 5_000, maxResultChars: 4_000 } as const;
/** Connector name in the egress policy: the owner turned web actions on for the instance. */
export const WEB_ACTIONS_CONNECTOR = "web-actions";

const DECIDING = new Map<string, Promise<unknown>>();

export class WebActionStore {
	constructor(private readonly dir: string) {}

	async propose(input: Pick<WebAction, "pageUrl" | "form" | "action" | "values" | "reason" | "thread" | "requester">, now = new Date()): Promise<WebAction> {
		if (Object.keys(input.values).length > WEB_ACTION_LIMITS.maxValues) throw new WebActionError(`al massimo ${WEB_ACTION_LIMITS.maxValues} campi`);
		if (Object.values(input.values).some((v) => v.length > WEB_ACTION_LIMITS.maxValueChars)) throw new WebActionError(`un valore supera ${WEB_ACTION_LIMITS.maxValueChars} caratteri`);
		const pending = (await this.list(now)).filter((a) => a.status === "pending");
		if (pending.length >= WEB_ACTION_LIMITS.maxPending) throw new WebActionError(`troppe azioni in attesa (${WEB_ACTION_LIMITS.maxPending})`);
		const action: WebAction = { ...input, method: "POST", id: randomBytes(6).toString("hex"), status: "pending", proposedAt: now.toISOString() };
		await this.save(action);
		return action;
	}

	async get(id: string, now = new Date()): Promise<WebAction | undefined> {
		if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
		let action: WebAction;
		try {
			action = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as WebAction;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return expired(action, now) ? { ...action, status: "expired" } : action;
	}

	async list(now = new Date()): Promise<WebAction[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const all = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => this.get(n.slice(0, -5), now)));
		return all.filter((a): a is WebAction => a !== undefined).sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
	}

	/**
	 * Decide a pending action; one decision at a time per action, the first one wins. Approving
	 * marks it running and sends it with `run`, then stores the result.
	 */
	decide(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, run: (action: WebAction) => Promise<NonNullable<WebAction["result"]>>, now = new Date()): Promise<{ action: WebAction; changed: boolean }> {
		const work = (DECIDING.get(id) ?? Promise.resolve()).then(() => this.decideNow(id, decision, by, run, now));
		const tail = work.catch(() => {});
		DECIDING.set(id, tail);
		void tail.then(() => {
			if (DECIDING.get(id) === tail) DECIDING.delete(id);
		});
		return work;
	}

	private async decideNow(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, run: (action: WebAction) => Promise<NonNullable<WebAction["result"]>>, now: Date): Promise<{ action: WebAction; changed: boolean }> {
		const current = await this.get(id, now);
		if (current === undefined) throw new WebActionError(`nessuna azione ${id}`);
		if (current.status !== "pending") return { action: current, changed: false };
		const decided = { decidedBy: by, decidedAt: now.toISOString() };
		if (decision === "rejected") {
			const action: WebAction = { ...current, ...decided, status: "rejected" };
			await this.save(action);
			return { action, changed: true };
		}
		const running: WebAction = { ...current, ...decided, status: "running" };
		await this.save(running);
		const result = await run(running).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
		const action: WebAction = { ...running, status: "error" in result ? "failed" : "done", result };
		await this.save(action);
		return { action, changed: true };
	}

	/** At start: an action left running by a dead process may or may not have been sent. */
	async settleInterrupted(): Promise<WebAction[]> {
		const settled: WebAction[] = [];
		for (const action of await this.list()) {
			if (action.status !== "running") continue;
			const next: WebAction = { ...action, status: "uncertain" };
			await this.save(next);
			settled.push(next);
		}
		return settled;
	}

	async markNotified(id: string, chat: string): Promise<void> {
		const current = await this.get(id);
		if (current === undefined) return;
		await this.save({ ...current, notified: [...new Set([...(current.notified ?? []), chat])] });
	}

	private save(action: WebAction): Promise<void> {
		// "expired" is computed on read, never stored over a pending action.
		const stored = action.status === "expired" ? { ...action, status: "pending" as const } : action;
		return writeFileAtomic(join(this.dir, `${action.id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
	}
}

function expired(action: WebAction, now: Date): boolean {
	return action.status === "pending" && now.getTime() - Date.parse(action.proposedAt) > WEB_ACTION_LIMITS.ttlMs;
}

/** The form `index` of the page, read through the guarded fetch with this visit's cookies. */
export async function readForm(pageUrl: string, index: number, guard: WebFetchOptions): Promise<{ form: WebForm; page: string }> {
	const page = await webFetch(pageUrl, guard);
	if (page.status >= 400) throw new WebFetchRefused(`la pagina risponde ${page.status}`);
	if (!/^text\/html/i.test(page.contentType)) throw new WebFetchRefused("la pagina non è HTML, non ha moduli");
	const form = pageForms(page.body, page.url)[index];
	if (form === undefined) throw new FormRefused(`la pagina non ha il modulo ${index}`);
	if (form.method !== "POST") throw new FormRefused(`il modulo ${index} è di ricerca (GET): leggi direttamente ${form.action} con i parametri nell'indirizzo`);
	if (form.enctype === "other") throw new FormRefused(`il modulo ${index} usa un formato che Annie non invia`);
	return { form, page: page.url };
}

/**
 * Send an approved action: the page again (fresh hidden fields and cookies), the same form,
 * the same destination, then one POST. Everything through the guarded fetch.
 */
export async function sendWebAction(action: WebAction, guard: Omit<WebFetchOptions, "cookies" | "send">): Promise<NonNullable<WebAction["result"]>> {
	const cookies = new CookieJar();
	const { form } = await readForm(action.pageUrl, action.form, { ...guard, cookies });
	if (form.action !== action.action) throw new FormRefused(`il modulo ora va a ${form.action}, non più a ${action.action}: chiedi di nuovo`);
	const answer = await webFetch(form.action, { ...guard, cookies, send: formBody(form, action.values) });
	const html = /^text\/html/i.test(answer.contentType);
	const { title, text } = html ? pageText(answer.body) : { title: "", text: /^(text\/|application\/(json|xml))/i.test(answer.contentType) ? answer.body : "" };
	return { status: answer.status, url: answer.url, title: title.slice(0, 200), text: text.slice(0, WEB_ACTION_LIMITS.maxResultChars) };
}
