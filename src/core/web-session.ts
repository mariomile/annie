import { randomBytes } from "node:crypto";
import { USER_AGENT, WebFetchRefused, webFetch } from "./web-fetch.ts";

/** What the browser needs from Chromium (Playwright's Browser satisfies it). */
export type Browser = {
	newContext(options: { viewport: { width: number; height: number }; userAgent: string; acceptDownloads: boolean; serviceWorkers: "block" }): Promise<BrowserContext>;
	close(): Promise<void>;
	on(event: "disconnected", listener: () => void): unknown;
};
export type BrowserContext = {
	route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
	routeWebSocket(url: RegExp, handler: (socket: { close(): Promise<void> }) => Promise<void> | void): Promise<void>;
	addInitScript(script: string): Promise<void>;
	on(event: "page", listener: (page: Page) => void): unknown;
	newPage(): Promise<Page>;
	close(): Promise<void>;
};
type Route = {
	request(): { url(): string; method(): string };
	fulfill(response: { status: number; headers?: Record<string, string>; body?: Buffer }): Promise<void>;
	abort(reason?: string): Promise<void>;
};
export type Page = {
	goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	screenshot(options: { fullPage: boolean; type: "png"; clip?: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
	title(): Promise<string>;
	url(): string;
	evaluate<T>(expression: string): Promise<T>;
	click(selector: string, options: { timeout: number }): Promise<void>;
	fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
	selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
	press(selector: string, key: string, options: { timeout: number }): Promise<void>;
	waitForLoadState(state: "load", options: { timeout: number }): Promise<void>;
	close(): Promise<void>;
};

/** The guard of every request a page makes: the owner's sites, never an internal address. */
export type Guard = { readonly hostAllowed: (host: string) => boolean; readonly addressAllowed: (address: string) => boolean };

/** What a page may load in all, per screenshot or per browser session. */
export type Budget = { requests: number; bytes: number };

/** What the routing refused, told to Annie after each action. */
export type Blocked = { sends: Set<string>; hosts: Set<string>; overBudget: boolean };

/**
 * Chromium touches no network: every request a page makes is answered by the guarded fetch, one
 * redirect at a time, GET only, within a budget. WebSockets close. Anything else is refused and
 * noted in `blocked` (ADR 0009, ADR 0014).
 */
export async function guardContext(context: BrowserContext, guard: () => Guard, budget: Budget, blocked?: Blocked): Promise<void> {
	await context.routeWebSocket(/.*/, (socket) => socket.close());
	await context.route("**/*", async (route) => {
		const request = route.request();
		const target = request.url();
		if (/^(data|blob|about):/.test(target)) return route.fulfill({ status: 204 });
		const host = hostOf(target);
		if (request.method() !== "GET") {
			blocked?.sends.add(`${request.method()} ${host}`);
			return route.abort("blockedbyclient");
		}
		if (--budget.requests < 0) {
			if (blocked !== undefined) blocked.overBudget = true;
			return route.abort("blockedbyclient");
		}
		try {
			const answer = await webFetch(target, { ...guard(), followRedirects: false, maxBytes: Math.min(5 * 1024 * 1024, Math.max(0, budget.bytes)), timeoutMs: 10_000 });
			budget.bytes -= answer.bytes.length;
			const headers: Record<string, string> = answer.contentType ? { "content-type": answer.contentType } : {};
			if (answer.location !== undefined) headers.location = answer.location;
			return route.fulfill({ status: answer.status, headers, body: answer.bytes });
		} catch (error) {
			if (error instanceof WebFetchRefused) blocked?.hosts.add(host);
			return route.abort("blockedbyclient");
		}
	});
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "?";
	}
}

/** Where to act: what the last view numbered. */
export type Element = { readonly ref: number; readonly kind: string; readonly label: string; readonly href?: string; readonly value?: string; readonly tag: string; readonly type: string };

export type View = { readonly url: string; readonly title: string; readonly text: string; readonly elements: readonly Element[]; readonly notes: readonly string[] };

const SESSION_BUDGET: Budget = { requests: 600, bytes: 60 * 1024 * 1024 };
const MAX_TEXT = 8_000;
const MAX_ELEMENTS = 80;
const ACTION_TIMEOUT_MS = 10_000;

/** Popups open in the same page: a new window is never out of sight. */
const SAME_PAGE = `(() => {
	window.open = (url) => { if (url) location.href = String(url); return null; };
	document.addEventListener("click", (e) => { const a = e.target instanceof Element ? e.target.closest("a[target], form[target]") : null; if (a) a.removeAttribute("target"); }, true);
	document.addEventListener("submit", (e) => { if (e.target instanceof HTMLFormElement) e.target.removeAttribute("target"); }, true);
})();`;

/** Numbers the visible elements one can act on, under a random attribute, and describes them. */
function elementsScript(attr: string): string {
	return `(() => {
	const attr = ${JSON.stringify(attr)};
	for (const e of document.querySelectorAll("[" + attr + "]")) e.removeAttribute(attr);
	const out = [];
	const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [onclick]';
	for (const e of document.querySelectorAll(selector)) {
		if (out.length >= ${MAX_ELEMENTS}) break;
		const box = e.getBoundingClientRect();
		const style = getComputedStyle(e);
		if (box.width === 0 || box.height === 0 || style.visibility === "hidden" || style.display === "none" || e.disabled) continue;
		const ref = out.length + 1;
		e.setAttribute(attr, String(ref));
		const tag = e.tagName.toLowerCase();
		const type = (e.getAttribute("type") || "").toLowerCase();
		const field = tag === "input" || tag === "textarea" || tag === "select";
		const text = (e.getAttribute("aria-label") || (field ? "" : e.innerText) || (tag === "input" && /^(submit|button|reset)$/.test(type) ? e.value : "") || e.getAttribute("placeholder") || e.getAttribute("title") || e.getAttribute("name") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
		const label = field && e.id ? (document.querySelector('label[for="' + CSS.escape(e.id) + '"]')?.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 80) : "";
		out.push({ ref, tag, type, label: label || text, href: tag === "a" ? e.href : undefined, value: field && type !== "password" && type !== "file" ? String(e.value ?? "").slice(0, 80) : undefined, options: tag === "select" ? Array.from(e.options).slice(0, 15).map((o) => o.value).join(", ") : undefined, checked: type === "checkbox" || type === "radio" ? e.checked : undefined });
	}
	return out;
})()`;
}

function kindOf(e: { tag: string; type: string; checked?: boolean }): string {
	if (e.tag === "a") return "link";
	if (e.tag === "select") return "scelta";
	if (e.tag === "textarea") return "campo di testo";
	if (e.tag === "input") {
		if (/^(submit|button|reset|image)$/.test(e.type)) return "pulsante";
		if (e.type === "checkbox" || e.type === "radio") return e.checked ? "casella (selezionata)" : "casella";
		if (e.type === "password") return "campo password";
		if (e.type === "file") return "caricamento file";
		return "campo di testo";
	}
	return "pulsante";
}

export class BrowseError extends Error {
	override readonly name = "BrowseError";
}

type Session = {
	readonly key: string;
	readonly context: BrowserContext;
	readonly page: Page;
	readonly attr: string;
	readonly blocked: Blocked;
	guard: Guard;
	elements: Map<number, Element>;
	timer: NodeJS.Timeout | undefined;
	used: number;
	queue: Promise<unknown>;
};

/**
 * Browsers that stay open for a conversation (ADR 0014): one per conversation, closed after a
 * while with no actions, a few at most on this server. They read and never send.
 */
export class BrowseSessions {
	private readonly sessions = new Map<string, Session>();
	private readonly starting = new Map<string, Promise<void>>();

	constructor(private readonly limits: { readonly max: number; readonly idleMs: number } = { max: 4, idleMs: 5 * 60_000 }) {}

	/** Opens `url` in the conversation's browser, starting one if needed. */
	async open(key: string, browser: Browser, url: string, guard: Guard): Promise<View> {
		if (!this.sessions.has(key)) {
			// Two calls at once for a new conversation start one browser, not two.
			let starting = this.starting.get(key);
			if (starting === undefined) {
				starting = this.start(key, browser, guard).finally(() => this.starting.delete(key));
				this.starting.set(key, starting);
			}
			await starting;
		}
		return this.act(key, guard, (s) => s.page.goto(url, { waitUntil: "load", timeout: 20_000 }));
	}

	/** The page as it is now. */
	view(key: string, guard: Guard): Promise<View> {
		return this.act(key, guard, async () => {});
	}

	click(key: string, ref: number, guard: Guard): Promise<View> {
		return this.act(key, guard, async (s) => {
			const element = this.element(s, ref);
			if (element.type === "file") throw new BrowseError("Annie non carica file sui siti");
			await s.page.click(`[${s.attr}="${ref}"]`, { timeout: ACTION_TIMEOUT_MS });
		});
	}

	type(key: string, ref: number, text: string, submit: boolean, guard: Guard): Promise<View> {
		return this.act(key, guard, async (s) => {
			const element = this.element(s, ref);
			const selector = `[${s.attr}="${ref}"]`;
			if (element.type === "password") throw new BrowseError("Annie non scrive password: non entra negli account");
			if (element.type === "file") throw new BrowseError("Annie non carica file sui siti");
			if (element.tag === "select") await s.page.selectOption(selector, text, { timeout: ACTION_TIMEOUT_MS });
			else if (element.tag === "input" || element.tag === "textarea") await s.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
			else throw new BrowseError(`l'elemento ${ref} non è un campo: si clicca con web_click`);
			if (submit) await s.page.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
		});
	}

	async screenshot(key: string): Promise<Uint8Array> {
		const s = this.sessions.get(key);
		if (s === undefined) throw new BrowseError("nessuna pagina aperta in questa conversazione: aprila con web_browse");
		return s.page.screenshot({ fullPage: false, type: "png" });
	}

	has(key: string): boolean {
		return this.sessions.has(key);
	}

	async close(key: string): Promise<void> {
		const s = this.sessions.get(key);
		if (s === undefined) return;
		this.sessions.delete(key);
		clearTimeout(s.timer);
		await s.context.close().catch(() => {});
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((key) => this.close(key)));
	}

	private element(s: Session, ref: number): Element {
		const element = s.elements.get(ref);
		if (element === undefined) throw new BrowseError(`nella pagina non c'è l'elemento ${ref}: usa i numeri dell'ultima vista`);
		return element;
	}

	private async start(key: string, browser: Browser, guard: Guard): Promise<void> {
		// Room for one more: the session unused the longest closes.
		while (this.sessions.size >= this.limits.max) {
			const oldest = [...this.sessions.values()].sort((a, b) => a.used - b.used)[0];
			if (oldest === undefined) break;
			await this.close(oldest.key);
		}
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: USER_AGENT, acceptDownloads: false, serviceWorkers: "block" });
		const blocked: Blocked = { sends: new Set(), hosts: new Set(), overBudget: false };
		const session: Session = { key, context, page: undefined as unknown as Page, attr: `data-annie-${randomBytes(4).toString("hex")}`, blocked, guard, elements: new Map(), timer: undefined, used: Date.now(), queue: Promise.resolve() };
		try {
			await guardContext(context, () => session.guard, { ...SESSION_BUDGET }, blocked);
			await context.addInitScript(SAME_PAGE);
			const page = await context.newPage();
			// Any other window (one the page opens anyway) is closed: everything happens in one page.
			context.on("page", (other) => {
				if (other !== page) void other.close().catch(() => {});
			});
			(session as { page: Page }).page = page;
		} catch (error) {
			await context.close().catch(() => {});
			throw error;
		}
		this.sessions.set(key, session);
	}

	/** One action at a time per session; then the page as it is after it. */
	private act(key: string, guard: Guard, action: (s: Session) => Promise<unknown>): Promise<View> {
		const s = this.sessions.get(key);
		if (s === undefined) return Promise.reject(new BrowseError("nessuna pagina aperta in questa conversazione: aprila con web_browse"));
		const run = s.queue.catch(() => {}).then(async () => {
			s.guard = guard;
			// Idle counts from the end of the last action, never during one.
			clearTimeout(s.timer);
			try {
				let failure: string | undefined;
				try {
					await action(s);
				} catch (error) {
					if (error instanceof BrowseError) throw error;
					failure = error instanceof Error ? error.message.split("\n")[0]?.replace(/[^\w\s.:/()=-]/g, "").slice(0, 120) : String(error);
					// A browser that went away (a restart of Chromium) leaves nothing to look at.
					if (/closed|disconnected|Target page/i.test(failure ?? "")) {
						await this.close(key);
						throw new BrowseError("il browser si è chiuso: riapri la pagina con web_browse");
					}
				}
				await s.page.waitForLoadState("load", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
				// Pages that change after a click do it a moment later.
				await new Promise((resolve) => setTimeout(resolve, 300));
				return await this.snapshot(s, failure);
			} finally {
				s.used = Date.now();
				if (this.sessions.get(key) === s) {
					s.timer = setTimeout(() => void this.close(key), this.limits.idleMs);
					s.timer.unref();
				}
			}
		});
		s.queue = run;
		return run;
	}

	private async snapshot(s: Session, failure: string | undefined): Promise<View> {
		const raw = await s.page.evaluate<(Element & { options?: string; checked?: boolean })[]>(elementsScript(s.attr)).catch(() => []);
		const elements = raw.map((e) => ({ ...e, kind: kindOf(e), ...(e.options ? { label: `${e.label}${e.label ? " " : ""}(valori: ${e.options})` } : {}) }));
		s.elements = new Map(elements.map((e) => [e.ref, e]));
		const text = String((await s.page.evaluate<string>("document.body ? document.body.innerText : ''").catch(() => "")) ?? "");
		const notes: string[] = [];
		if (failure !== undefined) notes.push(`L'azione non è riuscita (${failure}).`);
		if (s.blocked.sends.size > 0) notes.push(`La pagina ha provato a inviare dati (${[...s.blocked.sends].join(", ")}): bloccato, non è partito niente. Il browser legge soltanto; per inviare un modulo si usa web_submit, con l'approvazione.`);
		if (s.blocked.hosts.size > 0) notes.push(`Bloccato quello che la pagina voleva caricare da siti non consentiti: ${[...s.blocked.hosts].slice(0, 8).join(", ")}.`);
		if (s.blocked.overBudget) notes.push("La pagina ha caricato troppo: il resto è bloccato. Chiudi e riapri con web_browse se serve.");
		s.blocked.sends.clear();
		s.blocked.hosts.clear();
		return {
			url: s.page.url(),
			title: (await s.page.title().catch(() => "")).slice(0, 200),
			text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[… tagliato, ${text.length} caratteri in tutto]` : text,
			elements,
			notes,
		};
	}
}

/** A view as Annie reads it: page content goes in the fence, our notes outside. */
export function describeView(view: View, fence: (text: string) => string): string {
	const list = view.elements
		.map((e) => `[${e.ref}] ${e.kind}${e.label ? `: ${e.label}` : ""}${e.href ? ` → ${e.href.slice(0, 200)}` : ""}${e.value ? ` (ora: «${e.value}»)` : ""}`)
		.join("\n");
	const body = fence(`URL: ${view.url}${view.title ? `\nTitolo: ${view.title}` : ""}\n\n${view.text}${list ? `\n\nElementi (web_click, web_type con il numero):\n${list}` : ""}`);
	return [...view.notes, body].join("\n");
}

/** The session of a conversation, or of a single call where there is no conversation. */
export function sessionKey(scope: string, thread: { channel: string; threadId: string } | undefined, callId: string): string {
	return `${scope}|${thread === undefined ? `call:${callId}` : `${thread.channel}:${thread.threadId}`}`;
}
