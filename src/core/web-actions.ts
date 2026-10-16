import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import { CookieJar, checkedUrl, pageText, WebFetchRefused, type WebFetchOptions, webFetch } from "./web-fetch.ts";
import { FormRefused, formBody, formFingerprint, pageForms, type WebForm } from "./web-forms.ts";

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
	/** The submit button pressed (its number among the form's buttons). */
	readonly button: number;
	/** Everything that will be sent except hidden fields, as the approver reads it. */
	readonly shown: readonly (readonly [string, string])[];
	/** The form as it was when asked (formFingerprint): a changed form is not sent. */
	readonly fingerprint: string;
	/** Why, in Annie's words: shown on the card. */
	readonly reason: string;
	readonly status: "pending" | "approved" | "rejected" | "expired" | "running" | "done" | "failed" | "uncertain";
	readonly thread?: { readonly channel: string; readonly threadId: string };
	/** The person whose private conversation asked for it ("channel:userId"): they may decide. */
	readonly requester?: string;
	readonly proposedAt: string;
	readonly decidedBy?: { readonly channel: string; readonly userId: string };
	readonly decidedAt?: string;
	readonly result?: WebActionResult;
	/** Chats that have the card. */
	readonly notified?: readonly string[];
};

/** What the site answered; or why nothing left; or, once the form had gone out, that the outcome is not known. */
export type WebActionResult = { readonly status: number; readonly url: string; readonly title: string; readonly text: string } | { readonly error: string; readonly uncertain?: true };

export class WebActionError extends Error {
	override readonly name = "WebActionError";
}

/** The form may have reached the site: never "not sent", never sent again. */
export class WebActionUncertain extends Error {
	override readonly name = "WebActionUncertain";
}

export const WEB_ACTION_LIMITS = { maxPending: 20, ttlMs: 24 * 3600_000, maxValues: 50, maxValueChars: 5_000, maxResultChars: 4_000 } as const;
/** Connector name in the egress policy: the owner turned web actions on for the instance. */
export const WEB_ACTIONS_CONNECTOR = "web-actions";

const DECIDING = new Map<string, Promise<unknown>>();

export class WebActionStore {
	constructor(private readonly dir: string) {}

	/** `key` (the tool call's) makes a rerun return the same request instead of a second one. */
	async propose(input: Pick<WebAction, "pageUrl" | "form" | "action" | "values" | "button" | "shown" | "fingerprint" | "reason" | "thread" | "requester">, now = new Date(), key?: string): Promise<WebAction> {
		const id = key === undefined ? randomBytes(6).toString("hex") : createHash("sha256").update(key).digest("hex").slice(0, 12);
		if (key !== undefined) {
			const existing = await this.get(id, now);
			if (existing !== undefined) return existing;
		}
		if (Object.keys(input.values).length > WEB_ACTION_LIMITS.maxValues) throw new WebActionError(`al massimo ${WEB_ACTION_LIMITS.maxValues} campi`);
		if (Object.values(input.values).some((v) => v.length > WEB_ACTION_LIMITS.maxValueChars)) throw new WebActionError(`un valore supera ${WEB_ACTION_LIMITS.maxValueChars} caratteri`);
		const pending = (await this.list(now)).filter((a) => a.status === "pending");
		if (pending.length >= WEB_ACTION_LIMITS.maxPending) throw new WebActionError(`troppe azioni in attesa (${WEB_ACTION_LIMITS.maxPending})`);
		const action: WebAction = { ...input, method: "POST", id, status: "pending", proposedAt: now.toISOString() };
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
	decide(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, run: (action: WebAction) => Promise<WebActionResult>, now = new Date()): Promise<{ action: WebAction; changed: boolean }> {
		return this.serial(id, () => this.decideNow(id, decision, by, run, now));
	}

	/** One read-modify-write at a time per action, decisions and card bookkeeping alike. */
	private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
		const run = (DECIDING.get(id) ?? Promise.resolve()).then(work);
		const tail = run.catch(() => {});
		DECIDING.set(id, tail);
		void tail.then(() => {
			if (DECIDING.get(id) === tail) DECIDING.delete(id);
		});
		return run;
	}

	private async decideNow(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, run: (action: WebAction) => Promise<WebActionResult>, now: Date): Promise<{ action: WebAction; changed: boolean }> {
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
		const result: WebActionResult = await run(running).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), ...(error instanceof WebActionUncertain ? { uncertain: true as const } : {}) }));
		const action: WebAction = { ...running, status: "error" in result ? (result.uncertain ? "uncertain" : "failed") : "done", result };
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

	markNotified(id: string, chat: string): Promise<void> {
		return this.serial(id, async () => {
			const current = await this.get(id);
			if (current === undefined) return;
			await this.save({ ...current, notified: [...new Set([...(current.notified ?? []), chat])] });
		});
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
	if (page.url.startsWith("https:") && form.action.startsWith("http:")) throw new FormRefused(`il modulo ${index} manda i dati in chiaro (http): Annie non lo invia`);
	return { form, page: page.url };
}

/**
 * Send an approved action: the page again (fresh hidden fields and cookies), the same form,
 * the same destination, then one POST. Everything through the guarded fetch.
 */
export async function sendWebAction(action: WebAction, guard: Omit<WebFetchOptions, "cookies" | "send">): Promise<WebActionResult> {
	const cookies = new CookieJar();
	const { form } = await readForm(action.pageUrl, action.form, { ...guard, cookies });
	if (form.action !== action.action) throw new FormRefused(`il modulo ora va a ${form.action}, non più a ${action.action}: chiedi di nuovo`);
	if (formFingerprint(form) !== action.fingerprint) throw new FormRefused("il modulo è cambiato da quando è stato chiesto: chiedi di nuovo");
	const send = formBody(form, action.values, action.button);
	checkedUrl(form.action, guard);
	// From here the form may reach the site: any failure is an unknown outcome, not "not sent".
	let answer: Awaited<ReturnType<typeof webFetch>>;
	try {
		answer = await webFetch(form.action, { ...guard, cookies, send });
	} catch (error) {
		throw new WebActionUncertain(`il modulo è partito ma la risposta non è arrivata (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
	}
	const html = /^text\/html/i.test(answer.contentType);
	const { title, text } = html ? pageText(answer.body) : { title: "", text: /^(text\/|application\/(json|xml))/i.test(answer.contentType) ? answer.body : "" };
	return { status: answer.status, url: answer.url, title: title.slice(0, 200), text: text.slice(0, WEB_ACTION_LIMITS.maxResultChars) };
}
