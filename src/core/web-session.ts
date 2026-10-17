import { randomBytes } from "node:crypto";
import { CookieJar, USER_AGENT, WebFetchRefused, webFetch } from "./web-fetch.ts";

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
	request(): { url(): string; method(): string; isNavigationRequest(): boolean };
	fulfill(response: { status: number; headers?: Record<string, string>; body?: Buffer }): Promise<void>;
	abort(reason?: string): Promise<void>;
};
export type Page = {
	goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	goBack(options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	screenshot(options: { fullPage: boolean; type: "png"; timeout?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
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

/** What a page may load in all, per screenshot or per page of a browser session. */
export type Budget = { requests: number; bytes: number };

/** What the routing refused or is still doing, told to Annie after each action. */
export type Traffic = { sends: Set<string>; hosts: Set<string>; files: Set<string>; overBudget: boolean; inflight: number };

/** Each list of refused things stays short: a page cannot grow it without end. */
const MAX_NOTED = 8;
/** Methods named as they are; any other token a page invents is just "altro". */
const METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function noted(set: Set<string>, value: string): void {
	if (set.size < MAX_NOTED) set.add(value.slice(0, 120));
}

/**
 * Chromium touches no network: every request a page makes is answered by the guarded fetch, one
 * redirect at a time, GET only, within a budget. WebSockets close. Anything else is refused and,
 * with `traffic`, noted (ADR 0009, ADR 0014).
 */
export async function guardContext(context: BrowserContext, guard: () => Guard, budget: Budget, traffic?: Traffic, cookies?: CookieJar): Promise<void> {
	await context.routeWebSocket(/.*/, (socket) => socket.close());
	await context.route("**/*", async (route) => {
		const request = route.request();
		const target = request.url();
		if (/^(data|blob|about):/.test(target)) return route.fulfill({ status: 204 });
		const host = hostOf(target);
		if (request.method() !== "GET") {
			// A send to a site that is not allowed (an analytics beacon) is only a blocked host.
			if (traffic !== undefined) {
				if (guard().hostAllowed(host.replace(/:\d+$/, ""))) noted(traffic.sends, `${METHODS.has(request.method()) ? request.method() : "altro"} ${host}`);
				else noted(traffic.hosts, host);
			}
			return route.abort("blockedbyclient");
		}
		if (--budget.requests < 0) {
			if (traffic !== undefined) traffic.overBudget = true;
			return route.abort("blockedbyclient");
		}
		if (traffic !== undefined) traffic.inflight++;
		try {
			const answer = await webFetch(target, { ...guard(), followRedirects: false, maxBytes: Math.min(5 * 1024 * 1024, Math.max(0, budget.bytes)), timeoutMs: 10_000, ...(cookies === undefined ? {} : { cookies }) });
			budget.bytes -= answer.bytes.length;
			const type = answer.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
			// A link to a file (a PDF, a spreadsheet): the browser does not download, Annie is told.
			if (traffic !== undefined && request.isNavigationRequest() && answer.status < 300 && type !== "" && !/^(text\/(html|plain)|application\/xhtml\+xml)$/.test(type)) {
				noted(traffic.files, `${type.slice(0, 60)} ${target.slice(0, 200)}`);
				// 204 to a navigation: the browser stays on the page it was on.
				return route.fulfill({ status: 204 });
			}
			const headers: Record<string, string> = answer.contentType ? { "content-type": answer.contentType } : {};
			if (answer.location !== undefined) headers.location = answer.location;
			return route.fulfill({ status: answer.status, headers, body: answer.bytes });
		} catch (error) {
			if (error instanceof WebFetchRefused && traffic !== undefined) {
				noted(traffic.hosts, host);
				// A link to a site that is not allowed: the page stays, and Annie is told.
				if (request.isNavigationRequest()) return route.fulfill({ status: 204 });
			}
			return route.abort("blockedbyclient");
		} finally {
			if (traffic !== undefined) traffic.inflight--;
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

/** The first line of an error, without what could pass for markup. */
export function plainError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message.split("\n")[0] ?? "").replace(/[^\w\s.:/()=-]/g, "").slice(0, 120);
}

/** Where to act: what the last view numbered. */
export type Element = { readonly ref: number; readonly kind: string; readonly label: string; readonly tag: string; readonly type: string; readonly href?: string; readonly value?: string };

export type View = {
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly elements: readonly Element[];
	/** Ours, fixed sentences: shown outside the fence. */
	readonly notes: readonly string[];
	/** Names and addresses the page chose: shown inside the fence. */
	readonly details: readonly string[];
	readonly screenshot?: Uint8Array;
};

export type ViewOptions = {
	readonly find?: string;
	readonly from?: number;
	readonly screenshot?: boolean;
	/** A person drove the page from the console's panel: the agente's last view no longer matches it. */
	readonly person?: true;
};

const PAGE_BUDGET: Budget = { requests: 400, bytes: 40 * 1024 * 1024 };
export const MAX_ELEMENTS = 80;
/** Text of one view, in characters; `from` reads on. */
const VIEW_TEXT = 8_000;
const ACTION_TIMEOUT_MS = 10_000;
/** Reading the page (text, elements, title, screenshot): a page that hangs it is closed. */
const READ_TIMEOUT_MS = 5_000;
/** After an action, how long to wait at most for the page's requests to end. */
const SETTLE_MS = 5_000;

/**
 * Before the page's own scripts: popups open in the same page, a form that would send stays
 * where it is (the browser only reads), and WebRTC, which our routing does not see, is gone.
 */
function initScript(flag: string): string {
	return `(() => {
	const flag = ${JSON.stringify(flag)};
	for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription"]) {
		try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
	}
	window.open = (url) => { if (url) location.href = String(url); return null; };
	document.addEventListener("click", (e) => {
		const a = e.target instanceof Element ? e.target.closest("a[target], form[target]") : null;
		if (a) a.removeAttribute("target");
	}, true);
	document.addEventListener("submit", (e) => {
		const form = e.target;
		if (!(form instanceof HTMLFormElement)) return;
		form.removeAttribute("target");
		const method = ((e.submitter && e.submitter.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
		if (method !== "get") { e.preventDefault(); e.stopImmediatePropagation(); window[flag] = (window[flag] || 0) + 1; }
	}, true);
})();`;
}

/**
 * Numbers the visible elements one can act on, under a fresh random attribute, fields and
 * buttons first, then the page's main part, then the rest; and reads the text. Every string is
 * cut here, in the page: nothing big crosses into Annie's process.
 */
function snapshotScript(attr: string, old: string | undefined, flag: string, options: ViewOptions): string {
	return `(() => {
	const attr = ${JSON.stringify(attr)};
	const old = ${JSON.stringify(old ?? "")};
	const flag = ${JSON.stringify(flag)};
	const find = ${JSON.stringify((options.find ?? "").toLowerCase().slice(0, 100))};
	const from = ${Math.max(0, Math.floor(options.from ?? 0))};
	const cut = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
	if (old) for (const e of document.querySelectorAll("[" + old + "]")) e.removeAttribute(old);
	const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [onclick]";
	const textOf = (id) => { const e = document.getElementById(id); return e ? cut(e.innerText, 80) : ""; };
	const labelOf = (e, tag, type, field) => {
		const by = e.getAttribute("aria-labelledby");
		const named = by ? by.split(/\\s+/).slice(0, 5).map(textOf).join(" ") : "";
		const own = e.labels && e.labels.length ? Array.from(e.labels).slice(0, 3).map((l) => cut(l.innerText, 80)).join(" ") : "";
		const img = e.querySelector ? e.querySelector("img[alt]") : null;
		const svg = e.querySelector ? e.querySelector("svg title") : null;
		const button = tag === "input" && /^(submit|button|reset)$/.test(type) ? e.value : "";
		return cut(e.getAttribute("aria-label") || named || own || (field ? "" : cut(e.innerText, 200)) || button || e.getAttribute("placeholder") || e.getAttribute("title") || (img && img.getAttribute("alt")) || (svg && svg.textContent) || e.getAttribute("name"), 80);
	};
	const found = [];
	const seen = new Set();
	let scanned = 0;
	for (const e of document.querySelectorAll(selector)) {
		if (++scanned > 3000) break;
		const box = e.getBoundingClientRect();
		if (box.width === 0 || box.height === 0 || e.disabled) continue;
		const style = getComputedStyle(e);
		if (style.visibility === "hidden" || style.display === "none") continue;
		const tag = e.tagName.toLowerCase();
		const type = cut(e.getAttribute("type"), 20).toLowerCase();
		const role = cut(e.getAttribute("role"), 20).toLowerCase();
		const field = tag === "input" || tag === "textarea" || tag === "select";
		const label = labelOf(e, tag, type, field);
		const href = tag === "a" ? cut(e.href, 300) : "";
		if (tag === "a") {
			if (seen.has(href + " " + label)) continue;
			seen.add(href + " " + label);
		}
		if (find && !(label + " " + href).toLowerCase().includes(find)) continue;
		const options = tag === "select" ? Array.from(e.options).slice(0, 15).map((o) => cut(o.text, 40) + (o.value !== o.text ? " = " + cut(o.value, 40) : "")).join(", ") + (e.options.length > 15 ? ", +" + (e.options.length - 15) + " altri" : "") : "";
		const value = field && type !== "password" && type !== "file" ? cut(tag === "select" && e.selectedOptions[0] ? e.selectedOptions[0].text : e.value, 80) : "";
		const checked = type === "checkbox" || type === "radio" ? !!e.checked : e.getAttribute("aria-checked") === "true";
		const priority = field || tag === "button" || role === "button" ? 0 : e.closest("main, article, [role=main]") ? 1 : 2;
		found.push({ e, index: scanned, priority, info: { tag, type, role, label, href, options, value, checked } });
	}
	const shown = found.slice().sort((a, b) => a.priority - b.priority || a.index - b.index).slice(0, ${MAX_ELEMENTS}).sort((a, b) => a.index - b.index);
	shown.forEach((f, i) => f.e.setAttribute(attr, String(i + 1)));
	const all = document.body ? String(document.body.innerText) : "";
	const blocked = Number(window[flag]) || 0;
	window[flag] = 0;
	return {
		elements: shown.map((f) => f.info),
		more: found.length - shown.length,
		scannedAll: scanned <= 3000,
		text: all.slice(from, from + ${VIEW_TEXT}),
		textLength: all.length,
		frames: Array.from(document.querySelectorAll("iframe[src]")).slice(0, 5).map((f) => cut(f.src, 200)),
		postForms: Array.from(document.forms).slice(0, 50).filter((f) => cut(f.getAttribute("method"), 10).toLowerCase() === "post").length,
		blockedForms: blocked,
	};
})()`;
}

type Raw = { elements?: unknown; more?: unknown; scannedAll?: unknown; text?: unknown; textLength?: unknown; frames?: unknown; postForms?: unknown; blockedForms?: unknown };

/** What the page script returned, checked: the page can patch the DOM and the builtins it uses. */
function cleanElements(raw: unknown): Element[] {
	if (!Array.isArray(raw)) return [];
	const text = (value: unknown, n: number) => (typeof value === "string" ? value.slice(0, n) : "");
	return raw.slice(0, MAX_ELEMENTS).flatMap((item: unknown, i) => {
		if (item === null || typeof item !== "object") return [];
		const e = item as Record<string, unknown>;
		const tag = text(e.tag, 20);
		const type = text(e.type, 20);
		const options = text(e.options, 1_500);
		const own = text(e.label, 80);
		const label = `${own}${options ? `${own ? " " : ""}(valori: ${options})` : ""}`;
		const href = text(e.href, 300);
		const value = text(e.value, 80);
		return [{ ref: i + 1, kind: kindOf(tag, type, text(e.role, 20), e.checked === true), label, tag, type, ...(href ? { href } : {}), ...(value ? { value } : {}) }];
	});
}

function kindOf(tag: string, type: string, role: string, checked: boolean): string {
	const mark = checked ? " (selezionata)" : "";
	if (tag === "a" || role === "link") return "link";
	if (tag === "select" || role === "combobox") return "scelta";
	if (tag === "textarea") return "campo di testo";
	if (tag === "input") {
		if (/^(submit|button|reset|image)$/.test(type)) return "pulsante";
		if (type === "checkbox") return `casella${mark}`;
		if (type === "radio") return `opzione${mark}`;
		if (type === "password") return "campo password";
		if (type === "file") return "caricamento file";
		return "campo di testo";
	}
	if (role === "checkbox" || role === "switch") return `casella${mark}`;
	if (role === "radio" || role === "option") return `opzione${mark}`;
	if (role === "tab") return "scheda";
	return "pulsante";
}

export class BrowseError extends Error {
	override readonly name = "BrowseError";
}

/** A page that stopped answering a read: its session is closed. */
class Hung extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Hung()), ms);
	});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type Session = {
	readonly key: string;
	readonly context: BrowserContext;
	readonly page: Page;
	readonly flag: string;
	readonly traffic: Traffic;
	readonly budget: Budget;
	/** Read fresh at every request: the owner's list as of the current action. */
	readonly guard: { current: Guard };
	attr: string | undefined;
	elements: Map<number, Element>;
	timer: NodeJS.Timeout | undefined;
	used: number;
	busy: boolean;
	queue: Promise<unknown>;
	/** Counts the actions done: what someone watching compares to know the page may have changed. */
	version: number;
	/** The last picture taken for someone watching, and at which version. */
	picture: { readonly version: number; readonly png: Uint8Array } | undefined;
	/** Where the page was after the last action, for someone watching without asking Chromium. */
	shown: { readonly url: string; readonly title: string };
	/** A person moved the page since the agente's last view: its numbers point elsewhere now. */
	movedByPerson: boolean;
};

/** A conversation's browser as someone watching it sees it (the console's browser panel). */
export type BrowserState = { readonly open: true; readonly url: string; readonly title: string; readonly version: number; readonly busy: boolean } | { readonly open: false; readonly closed?: string };

/**
 * Browsers that stay open for a conversation (ADR 0014): one per conversation, closed after a
 * while with no actions, a few at most on this server. They read and never send.
 */
export class BrowseSessions {
	private readonly sessions = new Map<string, Session>();
	private readonly starting = new Map<string, Promise<void>>();
	/** Why a conversation's browser is gone, so Annie can say it. */
	private readonly closed = new Map<string, string>();

	constructor(private readonly limits: { readonly max: number; readonly idleMs: number } = { max: 4, idleMs: 5 * 60_000 }) {}

	/** Opens `url` in the conversation's browser, starting one if needed. */
	async open(key: string, browser: Browser, url: string, guard: Guard, options: ViewOptions = {}): Promise<View> {
		if (!this.sessions.has(key)) {
			// Two calls at once for a new conversation start one browser, not two.
			let starting = this.starting.get(key);
			if (starting === undefined) {
				starting = this.start(key, browser, guard).finally(() => this.starting.delete(key));
				this.starting.set(key, starting);
			}
			await starting;
		}
		return this.act(key, guard, options, async (s) => {
			// Each page opened gets its own budget.
			Object.assign(s.budget, PAGE_BUDGET);
			await s.page.goto(url, { waitUntil: "load", timeout: 20_000 });
		});
	}

	/** The page as it is now, or the one before it. */
	view(key: string, guard: Guard, options: ViewOptions & { readonly back?: boolean } = {}): Promise<View> {
		return this.act(key, guard, options, async (s) => {
			if (options.back !== true) return;
			Object.assign(s.budget, PAGE_BUDGET);
			await s.page.goBack({ waitUntil: "load", timeout: 20_000 });
		});
	}

	click(key: string, ref: number, guard: Guard, options: ViewOptions = {}): Promise<View> {
		return this.act(key, guard, options, async (s) => {
			const { selector, live } = await this.target(s, ref);
			if (live.type === "file") throw new BrowseError("Annie non carica file sui siti");
			await s.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
		});
	}

	type(key: string, ref: number, text: string, submit: boolean, guard: Guard, options: ViewOptions = {}): Promise<View> {
		return this.act(key, guard, options, async (s) => {
			const { selector, live } = await this.target(s, ref);
			if (live.type === "password") throw new BrowseError("Annie non scrive password: non entra negli account");
			if (live.type === "file") throw new BrowseError("Annie non carica file sui siti");
			if (live.type === "checkbox" || live.type === "radio") throw new BrowseError(`l'elemento ${ref} è una casella: si seleziona con web_click`);
			if (live.tag === "select") {
				const choices = await within(s.page.evaluate<unknown>(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).slice(0, 200).map((o) => [String(o.value).slice(0, 80), String(o.text).replace(/\\s+/g, " ").trim().slice(0, 80)])`), READ_TIMEOUT_MS);
				const pairs = (Array.isArray(choices) ? choices : []).filter((c): c is [string, string] => Array.isArray(c) && typeof c[0] === "string" && typeof c[1] === "string");
				if (!pairs.some(([value, label]) => value === text || label === text)) throw new BrowseError(`«${text.slice(0, 40)}» non è tra i valori di questa scelta: ${pairs.slice(0, 15).map(([, label]) => label).join(", ")}`);
				await s.page.selectOption(selector, text, { timeout: ACTION_TIMEOUT_MS });
			} else if (live.tag === "input" || live.tag === "textarea") await s.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
			else throw new BrowseError(`l'elemento ${ref} non è un campo: si clicca con web_click`);
			if (submit) await s.page.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
		});
	}

	has(key: string): boolean {
		return this.sessions.has(key);
	}

	/** Where the conversation's browser is, as of its last action: no question to Chromium, so it is cheap to ask often. */
	state(key: string): BrowserState {
		const s = this.sessions.get(key);
		if (s === undefined) {
			const closed = this.closed.get(key);
			return closed === undefined ? { open: false } : { open: false, closed };
		}
		return { open: true, ...s.shown, version: s.version, busy: s.busy };
	}

	/**
	 * What is on screen, for someone watching: taken between actions, and taken again only after
	 * one. It changes nothing on the page, so the numbers of the agente's last view stay valid.
	 */
	picture(key: string): Promise<{ readonly png: Uint8Array; readonly version: number } | undefined> {
		const s = this.sessions.get(key);
		if (s === undefined) return Promise.resolve(undefined);
		// Never ahead of the agente: while it acts, the last picture is what there is.
		if (s.picture?.version === s.version || s.busy) return Promise.resolve(s.picture);
		const run = s.queue
			.catch(() => {})
			.then(async () => {
				if (this.sessions.get(key) !== s) return undefined;
				if (s.picture?.version === s.version) return s.picture;
				const version = s.version;
				// Busy, so the idle timer and the room for other conversations leave this session alone meanwhile.
				s.busy = true;
				const png = await within(s.page.screenshot({ fullPage: false, type: "png", timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 1_000)
					.catch(() => undefined)
					.finally(() => {
						s.busy = false;
					});
				if (png === undefined) return s.picture;
				s.picture = { version, png };
				return s.picture;
			});
		s.queue = run;
		return run;
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((s) => this.end(s, "chiusa")));
	}

	/** Close every conversation's browser of one scope (an agente deleted, ADR 0046), and forget them. */
	async closeScope(scope: string): Promise<void> {
		const prefix = `${scope}|`;
		await Promise.allSettled([...this.starting].filter(([key]) => key.startsWith(prefix)).map(([, starting]) => starting));
		await Promise.all([...this.sessions.values()].filter((s) => s.key.startsWith(prefix)).map((s) => this.end(s, "chiusa")));
		for (const key of [...this.closed.keys()]) if (key.startsWith(prefix)) this.closed.delete(key);
	}

	/** Closes this session, and only it: a newer one of the same conversation stays. */
	private async end(s: Session, reason: string): Promise<void> {
		if (this.sessions.get(s.key) === s) {
			this.sessions.delete(s.key);
			this.closed.set(s.key, reason);
			if (this.closed.size > 500) this.closed.delete(this.closed.keys().next().value as string);
		}
		clearTimeout(s.timer);
		await s.context.close().catch(() => {});
	}

	/** The element `ref` of the last view, checked on the page as it is now: one element, the same kind. */
	private async target(s: Session, ref: number): Promise<{ selector: string; live: { tag: string; type: string } }> {
		if (s.movedByPerson) throw new BrowseError("chi ti scrive ha aperto un'altra pagina nel browser: guardala di nuovo con web_browse senza url");
		const known = s.elements.get(ref);
		if (known === undefined || s.attr === undefined) throw new BrowseError(`nella pagina non c'è l'elemento ${ref}: usa i numeri dell'ultima vista`);
		const selector = `[${s.attr}="${ref}"]`;
		const live = await within(
			s.page.evaluate<unknown>(`(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); if (all.length !== 1) return null; return { tag: all[0].tagName.toLowerCase(), type: String(all[0].getAttribute("type") || "").toLowerCase().slice(0, 20) }; })()`),
			READ_TIMEOUT_MS,
		);
		const found = live !== null && typeof live === "object" ? (live as { tag?: unknown; type?: unknown }) : undefined;
		if (found === undefined || found.tag !== known.tag || found.type !== known.type) throw new BrowseError("la pagina è cambiata dall'ultima vista: guardala di nuovo con web_browse senza url");
		return { selector, live: { tag: known.tag, type: known.type } };
	}

	private async start(key: string, browser: Browser, guard: Guard): Promise<void> {
		// Room for one more: the idle session unused the longest closes. Busy ones are never cut.
		// The new session counts too; other conversations still starting already hold their place.
		const others = () => [...this.starting.keys()].filter((k) => k !== key).length;
		while (this.sessions.size + others() >= this.limits.max) {
			const oldest = [...this.sessions.values()].filter((s) => !s.busy).sort((a, b) => a.used - b.used)[0];
			if (oldest === undefined) throw new BrowseError("su questo server ci sono già troppi browser al lavoro: riprova tra poco");
			await this.end(oldest, "chiusa per fare posto a un'altra conversazione");
		}
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: USER_AGENT, acceptDownloads: false, serviceWorkers: "block" });
		const traffic: Traffic = { sends: new Set(), hosts: new Set(), files: new Set(), overBudget: false, inflight: 0 };
		const budget = { ...PAGE_BUDGET };
		const current = { current: guard };
		const flag = `__annie${randomBytes(6).toString("hex")}`;
		try {
			await guardContext(context, () => current.current, budget, traffic, new CookieJar());
			await context.addInitScript(initScript(flag));
			const page = await context.newPage();
			// Any other window (one the page opens anyway) is closed: everything happens in one page.
			context.on("page", (other) => {
				if (other !== page) void other.close().catch(() => {});
			});
			this.sessions.set(key, { key, context, page, flag, traffic, budget, guard: current, attr: undefined, elements: new Map(), timer: undefined, used: Date.now(), busy: false, queue: Promise.resolve(), version: 0, picture: undefined, shown: { url: "about:blank", title: "" }, movedByPerson: false });
			this.closed.delete(key);
		} catch (error) {
			await context.close().catch(() => {});
			throw error;
		}
	}

	/** One action at a time per session; then the page as it is after it. */
	private act(key: string, guard: Guard, options: ViewOptions, action: (s: Session) => Promise<unknown>): Promise<View> {
		const s = this.sessions.get(key);
		if (s === undefined) {
			const why = this.closed.get(key);
			return Promise.reject(new BrowseError(why === undefined ? "nessuna pagina aperta in questa conversazione: aprila con web_browse" : `la pagina di questa conversazione è stata ${why}: riaprila con web_browse`));
		}
		const run = s.queue
			.catch(() => {})
			.then(async () => {
				if (this.sessions.get(key) !== s) throw new BrowseError("la pagina di questa conversazione è stata chiusa: riaprila con web_browse");
				s.guard.current = guard;
				s.busy = true;
				// Idle counts from the end of the last action, never during one.
				clearTimeout(s.timer);
				try {
					let failure: string | undefined;
					try {
						await action(s);
					} catch (error) {
						if (error instanceof BrowseError || error instanceof Hung) throw error;
						failure = plainError(error);
						// A browser that went away (a restart of Chromium) leaves nothing to look at.
						if (/closed|disconnected|Target page/i.test(failure)) {
							await this.end(s, "chiusa perché il browser si è fermato");
							throw new BrowseError("il browser si è chiuso: riapri la pagina con web_browse");
						}
					}
					await this.settle(s);
					return await this.snapshot(s, failure, options);
				} catch (error) {
					if (!(error instanceof Hung)) throw error;
					await this.end(s, "chiusa perché non rispondeva");
					throw new BrowseError("la pagina non risponde ed è stata chiusa: riaprila con web_browse, o leggila con web_read");
				} finally {
					s.busy = false;
					s.version += 1;
					s.used = Date.now();
					if (this.sessions.get(key) === s) {
						s.timer = setTimeout(() => void this.end(s, "chiusa dopo qualche minuto senza azioni"), this.limits.idleMs);
						s.timer.unref();
					}
				}
			});
		s.queue = run;
		return run;
	}

	/** The page loaded, and its requests ended (content that arrives after the load). */
	private async settle(s: Session): Promise<void> {
		await s.page.waitForLoadState("load", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
		const until = Date.now() + SETTLE_MS;
		for (let quiet = 0; quiet < 3 && Date.now() < until; ) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			quiet = s.traffic.inflight === 0 ? quiet + 1 : 0;
		}
	}

	private async snapshot(s: Session, failure: string | undefined, options: ViewOptions): Promise<View> {
		const attr = `data-annie-${randomBytes(4).toString("hex")}`;
		const read = () => within(s.page.evaluate<Raw>(snapshotScript(attr, s.attr, s.flag, options)), READ_TIMEOUT_MS);
		// In the middle of a navigation the page has no document yet: once more, a moment later.
		const rawOrNot = await read().catch(async (error: unknown) => {
			if (error instanceof Hung) throw error;
			await new Promise((resolve) => setTimeout(resolve, 500));
			return read().catch((again: unknown) => {
				if (again instanceof Hung) throw again;
				return undefined;
			});
		});
		const raw: Raw | undefined = rawOrNot !== null && typeof rawOrNot === "object" ? rawOrNot : undefined;
		s.attr = attr;
		const elements = cleanElements(raw?.elements);
		s.elements = new Map(elements.map((e) => [e.ref, e]));
		const text = typeof raw?.text === "string" ? raw.text.slice(0, VIEW_TEXT) : "";
		const length = typeof raw?.textLength === "number" ? raw.textLength : text.length;
		const from = Math.max(0, Math.floor(options.from ?? 0));
		const more = typeof raw?.more === "number" ? raw.more : 0;
		const frames = Array.isArray(raw?.frames) ? raw.frames.filter((f): f is string => typeof f === "string").map((f) => f.slice(0, 200)).slice(0, 5) : [];
		const t = s.traffic;
		const notes: string[] = [];
		const details: string[] = [];
		if (raw === undefined) notes.push("La pagina sta ancora caricando: guardala di nuovo con web_browse senza url.");
		if (failure !== undefined) {
			notes.push("L'azione non è riuscita.");
			details.push(`Errore del browser: ${failure}`);
		}
		if (t.sends.size > 0 || Number(raw?.blockedForms) > 0) {
			notes.push("La pagina ha provato a inviare dati: bloccato, non è partito niente. Il browser legge soltanto; per inviare un modulo si apre la pagina con web_read e si usa web_submit, che chiede l'approvazione.");
			if (t.sends.size > 0) details.push(`Invii bloccati: ${[...t.sends].join(", ")}`);
		} else if (Number(raw?.postForms) > 0) notes.push("Questa pagina ha moduli che inviano dati: il browser non li invia. Per inviarne uno si apre la pagina con web_read e si usa web_submit, che chiede l'approvazione.");
		if (t.files.size > 0) {
			notes.push("Un link porta a un file, non a una pagina: il browser non lo apre. Se è un PDF o un documento, leggilo con web_read passando il suo indirizzo (in «File» qui sotto), o salvalo con web_download.");
			details.push(`File: ${[...t.files].join("; ")}`);
		}
		if (t.hosts.size > 0) details.push(`Bloccato quello che la pagina voleva caricare da siti non consentiti: ${[...t.hosts].join(", ")}`);
		if (t.overBudget) notes.push("La pagina ha caricato troppo: il resto è bloccato. Riaprirla con web_browse e l'url dà un nuovo margine.");
		if (more > 0 || raw?.scannedAll === false) details.push(`Altri ${more > 0 ? more : "molti"} elementi non elencati: web_browse con find e una parola li cerca.`);
		if (frames.length > 0) details.push(`Riquadri con altre pagine dentro (si aprono con web_browse): ${frames.join(", ")}`);
		if (length > from + text.length) details.push(`[testo da ${from} a ${from + text.length} di ${length} caratteri: web_browse con from=${from + text.length} per il resto]`);
		t.sends.clear();
		t.hosts.clear();
		t.files.clear();
		t.overBudget = false;
		const screenshot = options.screenshot === true ? await within(s.page.screenshot({ fullPage: false, type: "png", timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 1_000) : undefined;
		const title = await within(s.page.title(), READ_TIMEOUT_MS).catch((error: unknown) => {
			if (error instanceof Hung) throw error;
			return "";
		});
		const url = s.page.url().slice(0, 500);
		s.shown = { url, title: String(title).slice(0, 200) };
		// The agente reads this view; a person driving leaves its last one behind.
		s.movedByPerson = options.person === true;
		return { url, title: s.shown.title, text, elements, notes, details, ...(screenshot === undefined ? {} : { screenshot }) };
	}
}

/** A view as Annie reads it: what the page chose goes in the fence, our sentences outside. */
export function describeView(view: View, fence: (text: string) => string): string {
	const list = view.elements.map((e) => `[${e.ref}] ${e.kind}${e.label ? `: ${e.label}` : ""}${e.href ? ` → ${e.href}` : ""}${e.value ? ` (ora: «${e.value}»)` : ""}`).join("\n");
	const body = fence([`URL: ${view.url}${view.title ? `\nTitolo: ${view.title}` : ""}`, view.text, list ? `Elementi (web_click, web_type con il numero):\n${list}` : "", view.details.join("\n")].filter(Boolean).join("\n\n"));
	return [...view.notes, body].join("\n");
}

/** The browser of a conversation; there is none outside one. */
export function sessionKey(scope: string, thread: { readonly channel: string; readonly threadId: string }): string {
	return `${scope}|${thread.channel}:${thread.threadId}`;
}
