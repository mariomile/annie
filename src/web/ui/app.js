// Annie — console web. Vanilla ES module, no dependencies. Text from people, mails and the
// model is only ever set with textContent: never innerHTML.

const $app = document.getElementById("app");

const $toasts = document.getElementById("toasts");

/**
 * el.replaceChildren with h()'s rules: null, false and undefined add nothing (not the text "null"),
 * and lists are flattened, so views can pass optional parts and sections as they are.
 */
function mount(el, ...children) {
	el.replaceChildren(...children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false));
}

/** h("div.card.pad", { onclick }, "text", child) — safe DOM builder. */
function h(spec, attrs, ...children) {
	const [tag, ...classes] = spec.split(".");
	const el = document.createElement(tag || "div");
	if (classes.length) el.className = classes.join(" ");
	if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
		children.unshift(attrs);
		attrs = undefined;
	}
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "class") el.className += ` ${v}`;
		else if (k === "value") el.value = v;
		else if (k === "checked") el.checked = Boolean(v);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const child of children.flat(Infinity)) {
		if (child === undefined || child === null || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return el;
}

const ICONS = {
	inizia: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
	install: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
	listen: ["M4 9v6h4l5 4V5L8 9H4Z", "M16.5 8.5a5 5 0 0 1 0 7", "M19 6a8.5 8.5 0 0 1 0 12"],
	stop: ["M7 7h10v10H7Z"],
	chat: ["M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12Z"],
	board: ["M4 5h4v14H4Z", "M10 5h4v9h-4Z", "M16 5h4v6h-4Z"],
	agenti: ["M8 4h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z", "M9.5 9.5h.01M14.5 9.5h.01", "M9 20h6", "M12 16v4"],
	segreteria: ["M3 13h5l1.5 2.5h5L16 13h5", "M5.5 5h13L21 13v6H3v-6Z"],
	approvazioni: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "m8.5 12.5 2.5 2.5 4.5-5"],
	task: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7.5V12l3 2"],
	file: ["M14 3H6v18h12V7Z", "M14 3v4h4"],
	memoria: ["M12 4a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.2V16a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-1.8A3 3 0 0 0 16 9V8a4 4 0 0 0-4-4Z", "M12 4v16"],
	automazioni: ["M13 3 5 14h6l-1 7 8-11h-6Z"],
	stanze: ["M8 10h.01M12 10h.01M16 10h.01", "M21 11a8 8 0 0 1-11.5 7.2L4 20l1.4-4.6A8 8 0 1 1 21 11Z"],
	skill: ["M5 4h10l4 4v12H5Z", "M9 12h6M9 16h4", "M14 4v4h4"],
	connettori: ["M9 3v5M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0Z", "M12 17v4"],
	impostazioni: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M15 5v4M9 15v4"],
	persone: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M2.5 21a6.5 6.5 0 0 1 13 0", "M16 3.6a4 4 0 0 1 0 6.8", "M18.5 14.5A6.5 6.5 0 0 1 21.5 21"],
	attivita: ["M3 12h4l3-8 4 16 3-8h4"],
	search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
	theme: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 3v18", "M12 7h4.5M12 11h6M12 15h5.5"],
	logout: ["M14 4h5v16h-5", "M9.5 8 5.5 12l4 4", "M5.5 12H15"],
	menu: ["M4 7h16M4 12h16M4 17h16"],
	plus: ["M12 5v14M5 12h14"],
	down: ["m6 9 6 6 6-6"],
	check: ["m5 12.5 4.5 4.5L19 7"],
	compose: ["M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6", "M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"],
	sidebar: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M9.5 4v16"],
	attach: ["m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"],
	send: ["M12 19V5", "m6 11 6-6 6 6"],
	more: ["M6 12h.01M12 12h.01M18 12h.01"],
	account: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0"],
	screen: ["M3 4h18v12H3Z", "M8 20h8", "M12 16v4"],
	browser: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M3 12h18", "M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z"],
	back: ["M19 12H5", "m11 6-6 6 6 6"],
	close: ["M6 6l12 12M18 6 6 18"],
};

/** Inline stroke icon from the fixed table above (no markup from outside). */
function icon(name) {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) svg.setAttribute(k, v);
	for (const d of ICONS[name] ?? []) {
		const path = document.createElementNS(NS, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

// ---------- agent faces ----------
// Every agente has a face drawn from its id: one family (a soft body, two eyes), told apart by
// colour, shape and one small detail. The face is also how an agente shows it is thinking.
const FACE_COLORS = ["#ff8a65", "#f6c344", "#9be15d", "#3ed6b0", "#5cb8ff", "#8f82ff", "#ff7ab6", "#e2c9a0"];
const FACE_SHAPES = {
	round: { body: ["circle", { cx: 24, cy: 26, r: 17 }], top: 9, eyes: 25 },
	square: { body: ["rect", { x: 7, y: 9, width: 34, height: 34, rx: 12 }], top: 9, eyes: 25 },
	egg: { body: ["path", { d: "M24 8c10 0 17 7.5 17 18S33.5 43 24 43 7 36.5 7 26 14 8 24 8Z" }], top: 8, eyes: 25 },
	wide: { body: ["rect", { x: 5, y: 13, width: 38, height: 29, rx: 14.5 }], top: 13, eyes: 27 },
};

function faceSeed(id) {
	let n = 2166136261;
	for (const c of String(id)) n = Math.imul(n ^ c.codePointAt(0), 16777619);
	// Mixed once more, so ids that differ only at the end still land far apart.
	n = Math.imul(n ^ (n >>> 16), 2246822507);
	n = Math.imul(n ^ (n >>> 13), 3266489909);
	return (n ^ (n >>> 16)) >>> 0;
}

/** The look of an agente: the same id always gives the same face. Annie, the first, stays in the console's own black and white (--face-mono). */
function faceLook(agent) {
	const id = agent?.id ?? agent?.instanceId ?? agent?.name ?? "annie";
	// One hash per trait, so that the traits do not move together.
	const pick = (trait, list) => list[faceSeed(`${id}:${trait}`) % list.length];
	const annie = id === "annie";
	return {
		color: annie ? "var(--face-mono)" : pick("color", FACE_COLORS),
		eye: annie ? "var(--face-mono-eye)" : "#111",
		shape: annie ? "round" : pick("shape", Object.keys(FACE_SHAPES)),
		eyes: annie ? "tall" : pick("eyes", ["dot", "tall", "wide"]),
		extra: annie ? "none" : pick("extra", ["none", "antenna", "cheeks", "brow"]),
		delay: faceSeed(id) % 5000,
	};
}

/** The colour as a CSS value, for what surrounds a face (the glow behind the empty chat). */
function faceColor(agent) {
	return faceLook(agent).color;
}

/** face(agent, 28) or face(agent, 72, "thinking"): an inline SVG, decorative (the name is always written next to it). */
function face(agent, size = 28, mood = "idle") {
	const NS = "http://www.w3.org/2000/svg";
	// paint: colours set through CSSOM (the page's CSP refuses style attributes), so Annie's CSS variable works too.
	const el = (tag, attrs = {}, paint = {}) => {
		const node = document.createElementNS(NS, tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
		for (const [k, v] of Object.entries(paint)) node.style.setProperty(k, v);
		return node;
	};
	const look = faceLook(agent);
	const shape = FACE_SHAPES[look.shape];
	const svg = el("svg", { viewBox: "0 0 48 48", width: size, height: size, "aria-hidden": "true", class: `face ${mood}` });
	svg.style.setProperty("--blink-delay", `${look.delay}ms`);
	const shade = "face-shade";
	const defs = el("defs");
	const grad = el("linearGradient", { id: shade, x1: 0, y1: 0, x2: 0, y2: 1 });
	grad.append(el("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": "0.38" }), el("stop", { offset: "0.55", "stop-color": "#fff", "stop-opacity": "0" }));
	defs.append(grad);
	const body = el("g", { class: "face-body" });
	if (look.extra === "antenna") body.append(el("path", { d: `M24 ${shape.top}V${shape.top - 5}`, "stroke-width": 2.4, "stroke-linecap": "round" }, { stroke: look.color }), el("circle", { cx: 24, cy: shape.top - 5.5, r: 2.6 }, { fill: look.color }));
	const [tag, attrs] = shape.body;
	body.append(el(tag, attrs, { fill: look.color }), el(tag, { ...attrs, fill: `url(#${shade})` }), el(tag, { ...attrs, fill: "none", stroke: "rgba(0,0,0,0.08)", "stroke-width": 1 }));
	const y = shape.eyes;
	if (look.extra === "cheeks") body.append(el("circle", { cx: 13.5, cy: y + 7, r: 2.8, fill: "#ff4f73", opacity: 0.5 }), el("circle", { cx: 34.5, cy: y + 7, r: 2.8, fill: "#ff4f73", opacity: 0.5 }));
	if (look.extra === "brow") body.append(el("path", { d: `M14 ${y - 7}q3-2 6 0M28 ${y - 7}q3-2 6 0`, stroke: "#141414", "stroke-width": 1.8, fill: "none", "stroke-linecap": "round", opacity: 0.7 }));
	const eyes = el("g", { class: "face-eyes" });
	for (const x of [17.5, 30.5]) {
		const eye = { fill: look.eye };
		if (look.eyes === "dot") eyes.append(el("circle", { cx: x, cy: y, r: 3.3 }, eye));
		else if (look.eyes === "tall") eyes.append(el("ellipse", { cx: x, cy: y, rx: 2.7, ry: 4.1 }, eye));
		else eyes.append(el("ellipse", { cx: x, cy: y, rx: 3.8, ry: 3 }, eye));
		eyes.append(el("circle", { cx: x + 1, cy: y - 1.4, r: 1, fill: "#fff", opacity: 0.9, class: "glint" }));
	}
	body.append(eyes);
	svg.append(defs, body);
	return svg;
}

/** What stands in for an answer on its way: the faces of who may answer, looking around. */
function thinking(agents) {
	const who = agents.length === 1 ? `${agents[0].name} sta pensando` : "Stanno pensando";
	return h("div.thinking", { role: "status", "aria-label": who }, h("span.faces", agents.slice(0, 3).map((a) => face(a, 26, "thinking"))), h("span.thinking-text", `${who}…`));
}

function toast(text, bad = false) {
	const t = h(`div.toast${bad ? ".bad" : ""}`, text);
	$toasts.append(t);
	// An error is usually longer and says what to do: it stays longer.
	setTimeout(() => t.remove(), bad ? 9000 : 4200);
}

class ApiError extends Error {
	constructor(status, message, data = {}) {
		super(message);
		this.status = status;
		this.data = data;
	}
}

async function api(path, { method = "GET", body, raw } = {}) {
	const res = await fetch(path, {
		method,
		headers: { "x-annie": "1", ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}) },
		body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
		credentials: "same-origin",
	});
	const data = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : {};
	if (res.status === 401 && !path.startsWith("/api/login")) {
		state.me = undefined;
		renderLogin();
		throw new ApiError(401, data.error ?? "Accesso richiesto");
	}
	if (!res.ok) throw new ApiError(res.status, data.error ?? `Errore ${res.status}`, data);
	return data;
}

/** «1,2», «84»: Italian, at most one decimal. */
const decimal = (n) => n.toLocaleString("it-IT", { maximumFractionDigits: n >= 10 ? 0 : 1 });

const fmt = {
	time: (iso) => (iso ? new Date(iso).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"),
	day: (iso) => (iso ? new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "—"),
	bytes: (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${decimal(n / 1024)} KB` : `${decimal(n / 1048576)} MB`),
	usd: (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`,
};

/** Reads with one argument, writes with two; null removes the key. */
function store(key, value) {
	try {
		if (value === undefined) return localStorage.getItem(key) ?? undefined;
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		return undefined;
	}
}

// ---------- state ----------
const state = {
	me: undefined,
	instances: [],
	instance: undefined,
	usage: undefined,
	pendingApprovals: 0,
	/** Schede waiting for this person's review (ADR 0051). */
	boardReview: 0,
	unread: new Set(),
	/** The current instance's conversations, newest first, for the sidebar. */
	threads: [],
	/** Steps of «Primi passi» still to do, for the owner; 0 when done or put away. */
	setupLeft: 0,
	events: undefined,
	onEntry: undefined,
};

const PALETTE = [
	{ id: "inizia", label: "Primi passi", group: "Lavoro", owner: true, when: () => state.setupLeft > 0, count: () => state.setupLeft },
	{ id: "chat", label: "Chat", group: "Lavoro" },
	{ id: "agenti", label: "Agenti", group: "Lavoro", count: () => (state.instances.length > 1 ? state.instances.length : 0) },
	{ id: "stanze", label: "Stanze", group: "Lavoro", when: () => state.instances.filter((i) => i.canChat).length > 1 },
	{ id: "board", label: "Board", group: "Lavoro", count: () => state.boardReview },
	{ id: "segreteria", label: "Segreteria", group: "Lavoro", when: (i) => i?.hasSegreteria },
	{ id: "approvazioni", label: "Approvazioni", group: "Lavoro", count: () => state.pendingApprovals },
	{ id: "task", label: "Task e sentinelle", group: "Lavoro" },
	{ id: "automazioni", label: "Automazioni", group: "Lavoro" },
	{ id: "file", label: "File", group: "Lavoro" },
	{ id: "memoria", label: "Memoria", group: "Lavoro" },
	{ id: "skill", label: "Skill", group: "Lavoro" },
	{ id: "connettori", label: "Connettori", group: "Gestione", owner: true },
	{ id: "impostazioni", label: "Impostazioni", group: "Gestione", owner: true },
	{ id: "persone", label: "Persone", group: "Gestione", owner: true },
	{ id: "attivita", label: "Attività e spesa", group: "Gestione" },
];

function route() {
	const [view, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
	return { view: view || "chat", rest: rest.map(decodeURIComponent) };
}

function go(view, ...rest) {
	location.hash = `#/${[view, ...rest].map(encodeURIComponent).join("/")}`;
}

// ---------- app on the phone (PWA) ----------
/** The browser's install offer, kept for the «Installa» button; undefined where there is none (iOS, already installed). */
let installOffer;
window.addEventListener("beforeinstallprompt", (event) => {
	event.preventDefault();
	installOffer = event;
	// The browser offers it again: the app was removed, whatever this browser remembered.
	if (store("annie.app") === "installed") store("annie.app", "removed");
	if (state.me) renderRail();
});
window.addEventListener("appinstalled", () => {
	installOffer = undefined;
	store("annie.app", "installed");
	if (state.me) render();
});
// Only on https or on this machine: elsewhere browsers refuse it, and the console works the same.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
const offlineBar = () => {
	const bar = document.getElementById("offline");
	if (bar) bar.hidden = navigator.onLine;
};
window.addEventListener("online", offlineBar);
window.addEventListener("offline", offlineBar);
offlineBar();

/** Running as the installed app, or installed from this browser (Safari never says so: there it is only known inside the app). */
function installed() {
	return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true || store("annie.app") === "installed";
}

/** iPhone and iPad, which install only from Safari's Share menu (iPadOS says it is a Mac, but has touch). */
const appleTouch = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const phone = /iphone|ipod|android.*mobile/i.test(navigator.userAgent);

async function install() {
	if (!installOffer) return;
	installOffer.prompt();
	const { outcome } = await installOffer.userChoice;
	installOffer = undefined;
	if (outcome === "accepted") {
		store("annie.app", "installed");
		toast(phone ? "Annie è sulla schermata Home" : "Annie è installata come app");
	}
	render();
}

// ---------- boot ----------
async function boot() {
	applyTheme();
	if (location.pathname === "/login") {
		const token = location.hash.slice(1);
		history.replaceState(null, "", "/");
		if (token) {
			try {
				await api("/api/login", { method: "POST", body: { token } });
			} catch (error) {
				if (error.data?.twoFactor) return renderCode(token);
				return renderLogin(error.message);
			}
		}
	}
	await enter();
}

/** With a session: load who this is and the instances, then show the console. */
async function enter() {
	try {
		state.me = (await api("/api/me")).person;
		await refreshInstances();
	} catch (error) {
		// No network, or the server not answering (a restart, a cell waking up): say so and try again by itself.
		if (!(error instanceof ApiError) || error.status >= 500) unreachable();
		return;
	}
	if (location.hash.startsWith("#/google?")) await finishGoogle();
	if (location.hash.startsWith("#/connettore?")) await finishConnector();
	connectEvents();
	const landing = location.hash === "" || location.hash === "#/";
	window.addEventListener("hashchange", render);
	render();
	setInterval(refreshCounters, 30_000);
	// After the first paint: the steps never hold the console up.
	await refreshSetup();
	// An owner who has not tried Annie yet lands on the steps when opening the console without a page in mind.
	if (landing && (location.hash === "" || location.hash === "#/") && state.setup && !state.setup.tried && state.setupLeft > 0) history.replaceState(null, "", "#/inizia");
	render();
}

/** The server cannot be reached: a screen that retries by itself, and a button to retry now. */
function unreachable() {
	let timer;
	const retry = () => {
		clearTimeout(timer);
		window.removeEventListener("online", retry);
		mount($app, h("div.empty", h("b", "Riprovo…")));
		void enter();
	};
	mount(
		$app,
		h(
			"div.empty",
			h("b", navigator.onLine ? "Non riesco a raggiungere Annie" : "Sei offline"),
			navigator.onLine ? "Il server non risponde: riprovo da sola tra qualche secondo." : "Annie si riapre da sola appena torna la rete.",
			h("p", h("button.btn", { onclick: retry }, "Riprova")),
		),
	);
	window.addEventListener("online", retry, { once: true });
	timer = setTimeout(retry, 10_000);
}

async function refreshInstances() {
	state.instances = (await api("/api/instances")).instances;
	const saved = store("annie.instance");
	state.instance = state.instances.find((i) => i.id === saved) ?? state.instances[0];
	await refreshCounters();
}

/** How many «Primi passi» are left, for the owner of the current instance. */
async function refreshSetup() {
	state.setupLeft = 0;
	state.setup = undefined;
	if (state.me?.role !== "owner" || !state.instance || setupHidden(state.instance.id)) return;
	try {
		const { setup } = await api(`/api/instances/${state.instance.id}/setup`);
		state.setup = setup;
		state.setupLeft = setupLeft(setup);
	} catch {
		/* not shown */
	}
}

/** «Primi passi» put away, per instance, in this browser: read with one argument, set with two. */
function setupHidden(instanceId, hide) {
	let ids = [];
	try {
		ids = JSON.parse(store("annie.setup.hidden") ?? "[]");
	} catch {
		/* an older value: start again */
	}
	if (!Array.isArray(ids)) ids = [];
	if (hide === undefined) return ids.includes(instanceId);
	store("annie.setup.hidden", JSON.stringify(hide ? [...new Set([...ids, instanceId])] : ids.filter((id) => id !== instanceId)));
}

async function refreshCounters() {
	try {
		state.usage = (await api("/api/usage")).usage;
		let pending = 0;
		for (const inst of state.instances.filter((i) => i.isApprover)) {
			const { proposals } = await api(`/api/instances/${inst.id}/proposals`);
			pending += proposals.filter((p) => p.status === "pending").length;
			if (inst.hasSegreteria) pending += (await api(`/api/instances/${inst.id}/pratiche`)).pratiche.filter((p) => p.status === "draft_ready").length;
		}
		// Forms to send: a person sees and decides their own, an approver everyone's.
		for (const inst of state.instances) pending += (await api(`/api/instances/${inst.id}/web-actions`).catch(() => ({ actions: [] }))).actions.filter((a) => a.status === "pending").length;
		// Connector calls that change something: the person who asked, or an approver.
		for (const inst of state.instances) pending += (await api(`/api/instances/${inst.id}/connector-actions`).catch(() => ({ actions: [] }))).actions.filter((a) => a.status === "pending").length;
		// Writes to the person's own Google account: theirs alone.
		for (const inst of state.instances) pending += (await api(`/api/instances/${inst.id}/google-actions`).catch(() => ({ actions: [] }))).actions.filter((a) => a.status === "pending").length;
		state.pendingApprovals = pending;
		state.boardReview = await boardReviewCount();
		renderRail();
	} catch {
		/* shown on next render */
	}
}

/** Schede an agente finished that this person reviews: those worked with them, or with nobody for the owner. */
async function boardReviewCount() {
	try {
		const { cards } = await api("/api/board");
		return cards.filter((c) => c.status === "da_rivedere" && (c.work?.agent === c.assignee ? c.work.personId === state.me.id : state.me.role === "owner")).length;
	} catch {
		return 0;
	}
}

function connectEvents() {
	state.events?.close();
	const es = new EventSource("/api/events");
	es.addEventListener("entry", (e) => {
		const event = JSON.parse(e.data);
		// A reply can carry news for the counters (a tool proposed, a task created).
		void refreshCounters();
		if (state.onEntry?.(event)) return;
		state.unread.add(event.threadId);
		const { view, rest } = route();
		if (view !== "chat" || rest[0] !== event.threadId) toast("Nuova risposta di Annie");
		renderRail();
		void refreshThreads().then(renderRail);
	});
	es.addEventListener("room", (e) => {
		const event = JSON.parse(e.data);
		if (state.onRoom?.(event)) return;
		if (event.entry.from === "agent") toast("Nuova risposta in una stanza");
	});
	es.addEventListener("board", (e) => {
		const event = JSON.parse(e.data);
		void refreshCounters();
		if (route().view === "board" && !document.querySelector("dialog[open]")) return render();
		toast(`Scheda #${event.n} da rivedere: ${event.title}`);
	});
	state.events = es;
}

function applyTheme(next) {
	if (next) store("annie.theme", next);
	const theme = store("annie.theme");
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
}

// ---------- login ----------
function renderLogin(error) {
	closeMenu();
	state.events?.close();
	mount($app, 
		h(
			"div.login",
			h(
				"div.card",
				h("div.login-mark", h("img", { src: "/icon.svg", alt: "", width: "40", height: "40" })),
				h("h1", "Accedi ad Annie"),
				h("p", "Per entrare usa il link personale che ti ha dato chi gestisce Annie. Il link ti riconosce: non condividerlo."),
				error ? h("p.chip.bad", error) : null,
				pasteLink(),
				h("p.muted", "Hai perso il link? Chiedi all'owner di generarne uno nuovo: quello vecchio smetterà di funzionare."),
			),
		),
	);
}

/**
 * The personal link pasted by hand: the app on the iPhone Home screen has no address bar, and a link
 * tapped in a mail opens in Safari, which keeps its own session.
 */
function pasteLink() {
	const link = h("input", { type: "url", autocomplete: "off", placeholder: "https://…/login#…", class: "mono", "aria-label": "Il tuo link personale" });
	const submit = async (event) => {
		event.preventDefault();
		const token = link.value.trim().split("#")[1] ?? "";
		if (!/^[\w-]{20,}$/.test(token)) return renderLogin("Questo non sembra il tuo link personale: copialo per intero.");
		try {
			await api("/api/login", { method: "POST", body: { token } });
		} catch (error) {
			if (error.data?.twoFactor) return renderCode(token);
			return renderLogin(error.message);
		}
		history.replaceState(null, "", "/");
		await enter();
	};
	return h("form.stack", { onsubmit: submit }, h("label.field", h("span", "Hai il link ma sei nell'app? Incollalo qui"), link), h("button.btn", { type: "submit" }, "Entra"));
}

/** The six-digit field of the verifica in due passaggi. */
function codeInput() {
	return h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", placeholder: "123 456", class: "mono code-input", "aria-label": "Codice" });
}

/** Second step of the login, for people with two-factor on. The link token stays in memory only. */
function renderCode(token, error) {
	const code = codeInput();
	const submit = async (e) => {
		e.preventDefault();
		try {
			await api("/api/login", { method: "POST", body: { token, code: code.value } });
		} catch (err) {
			return renderCode(token, err.message);
		}
		await enter();
	};
	mount($app, 
		h(
			"div.login",
			h(
				"form.card",
				{ onsubmit: submit },
				h("div.login-mark", h("img", { src: "/icon.svg", alt: "", width: "40", height: "40" })),
				h("h1", "Codice di verifica"),
				h("p", "Apri l'app di autenticazione sul telefono e scrivi il codice di sei cifre di Annie."),
				error ? h("p.chip.bad", error) : null,
				h("div.field", code),
				h("button.btn.accent", { type: "submit" }, "Entra"),
			),
		),
	);
	code.focus();
}

// ---------- Google ----------
/** Back from Google's consent: the code is in the fragment, the session in our cookie. */
async function finishGoogle() {
	const params = new URLSearchParams(location.hash.slice("#/google?".length));
	history.replaceState(null, "", "/#/chat");
	if (params.get("error")) return toast(params.get("error") === "access_denied" ? "Collegamento a Google annullato" : "Google non ha completato il collegamento: riprova", true);
	try {
		const { account } = await api("/api/google/finish", { method: "POST", body: { state: params.get("state") ?? "", code: params.get("code") ?? "" } });
		toast(`Google collegato: ${account.email}`);
	} catch (error) {
		toast(error.message, true);
	}
}

async function connectGoogle() {
	try {
		location.assign((await api("/api/google/start", { method: "POST", body: {} })).url);
	} catch (error) {
		toast(error.message, true);
	}
}

/** The person's own Google account, in the account dialog. */
function googleSection() {
	const box = h("div.card.pad.stack");
	const draw = async () => {
		const { available, account, services, write } = await api("/api/google");
		if (!available) return box.remove();
		const what = services.length > 1 ? "la tua posta e il tuo calendario" : services[0] === "gmail" ? "la tua posta" : "il tuo calendario";
		if (account) {
			mount(box, 
				h("div.kicker", "Google"),
				h("p", h("span.chip.ok", "Collegato"), " ", account.email),
				h("p.muted", write && account.canWrite ? `Annie legge ${what} quando glielo chiedi dalla console, o nel brief del mattino. Può preparare mail ed eventi, che partono solo quando li approvi tu.` : `Annie legge ${what} quando glielo chiedi dalla console, o nel brief del mattino. Non invia mail e non cambia eventi.`),
				write && !account.canWrite ? h("p", "Per far preparare ad Annie mail ed eventi (che approvi tu), ricollega Google lasciando spuntati tutti i permessi.") : null,
				h(
					"div.actions",
					write && !account.canWrite ? h("button.btn.accent", { onclick: () => void connectGoogle() }, "Ricollega Google") : null,
					h(
						"button.btn.danger",
						{
							onclick: async () => {
								await api("/api/google", { method: "DELETE" }).catch((e) => toast(e.message, true));
								toast("Google scollegato");
								await draw();
							},
						},
						"Scollega",
					),
				),
			);
			return;
		}
		mount(box, 
			h("div.kicker", "Google"),
			h("p", write ? `Collega Google: Annie potrà leggere ${what} quando glielo chiedi dalla console, e preparare mail ed eventi che partono solo dopo la tua approvazione.` : `Collega Google: Annie potrà leggere ${what}, solo leggere, quando glielo chiedi dalla console.`),
			h("div.actions", h("button.btn.accent", { onclick: () => void connectGoogle() }, "Collega Google")),
		);
	};
	void draw().catch(() => box.remove());
	return box;
}

/** Owner: whether this instance may use people's Google accounts (its egress policy). */
function googleCard(inst, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/google`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Google consentito per questo agente" : "Google non più consentito per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Google"),
		h("p.muted", "Chi ha collegato il proprio Google (dal menu del suo account) può chiedere a questo agente di leggere la sua posta e il suo calendario, solo nelle sue conversazioni dalla console. Se il server lo permette, anche di preparare mail ed eventi: partono solo quando quella persona li approva."),
		h("label.row-gap", toggle, h("span", "Consenti Google a questo agente")),
	);
}

/** Owner: replies as voice notes, made by the server's speech service (ADR 0020). */
function speechCard(inst, host, allowed, understood) {
	const toggle = h("input", { type: "checkbox", checked: allowed, disabled: !allowed && !understood });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/speech`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} risponde a voce a chi manda un vocale` : "Risposte a voce spente per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Risposte a voce"),
		h("p.muted", `A chi le manda un vocale su Telegram o WhatsApp, Annie risponde con un vocale e con il testo. Ognuno può chiederle «rispondimi sempre a voce» o «niente vocali». La voce la fa ${host}: riceve solo il testo delle risposte da leggere, mai i vocali di chi le scrive.`),
		understood ? null : h("p.chip.warn", "Per rispondere ai vocali Annie deve prima capirli: accendi anche Messaggi vocali."),
		h("label.row-gap", toggle, h("span", "Rispondi a voce ai vocali")),
	);
}

/** Owner: pictures made on request for this instance, by the server's image service. */
function imagesCard(inst, host, maxPerDay, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/images`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} può creare immagini` : "Immagini spente per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Immagini"),
		h("p.muted", `Annie crea immagini quando gliele chiedono (un'illustrazione, un logo, un volantino) e ritocca le foto che le mandano. Le genera il servizio ${host}, che riceve la descrizione e, per un ritocco, la foto. L'immagine arriva in chat e resta tra i file. Al massimo ${maxPerDay} immagini al giorno per tutto l'account.`),
		h("label.row-gap", toggle, h("span", "Consenti le immagini a questo agente")),
	);
}

/**
 * Owner: the AI model this instance runs on (ADR 0032). Any provider Annie offers, with the
 * server's key or one the owner pastes here; a saved key never comes back to the page.
 */
function modelCard(inst, current, providers) {
	const KEY_STATE = { server: "Chiave del server", saved: "Chiave salvata", missing: "Serve una chiave" };
	const offered = providers.some((p) => p.id === current.provider);
	const provider = h(
		"select",
		// The local development model is not offered: the instance keeps it until the owner picks another.
		offered ? null : h("option", { value: current.provider, selected: "selected" }, "Modello di prova"),
		providers.map((p) => h("option", { value: p.id, selected: p.id === current.provider ? "selected" : undefined }, p.label)),
	);
	const filter = h("input", { type: "search", placeholder: "Cerca un modello", autocomplete: "off" });
	const model = h("select");
	const key = h("input", { type: "password", autocomplete: "off", class: "mono", "aria-describedby": `model-key-${inst.id}` });
	const hint = h("small", { id: `model-key-${inst.id}` });
	const keyRow = h("label.field", h("span", "Chiave API"), key, hint);
	const filterRow = h("label.field", h("span", "Cerca"), filter);
	const status = h("span.chip", { "aria-live": "polite" });
	const submit = h("button.btn.accent", "Usa questo modello");
	const forget = h("button.btn.ghost", "Togli la chiave");
	let models = [];
	let asked = 0;
	const chosen = () => providers.find((p) => p.id === provider.value);
	const fill = (wanted) => {
		const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const shown = models.filter((m) => m.id === wanted || words.every((w) => `${m.name} ${m.id}`.toLowerCase().includes(w)));
		// Two models with the same name (one is a dated version) are told apart by their id.
		const names = new Map();
		for (const m of models) names.set(m.name, (names.get(m.name) ?? 0) + 1);
		mount(model, shown.map((m) => h("option", { value: m.id, selected: m.id === wanted ? "selected" : undefined }, modelLabel(m, names.get(m.name) > 1))));
		submit.disabled = shown.length === 0;
	};
	// The models are asked for when a provider is picked: some have hundreds. Only the last answer counts.
	const showModels = async () => {
		const p = chosen();
		const ask = ++asked;
		submit.disabled = true;
		const state = p?.key ?? "server";
		status.textContent = p === undefined ? "Modello di prova" : KEY_STATE[state];
		status.className = `chip${p === undefined || state === "missing" ? " warn" : " ok"}`;
		key.disabled = state === "server";
		key.value = "";
		key.placeholder = state === "server" ? "La mette chi gestisce il server" : state === "saved" ? "Incollane una nuova per cambiarla" : `La tua chiave ${p.label}`;
		hint.textContent = state === "server" ? "Il server ha già la chiave di questo provider." : `Resta sul server con le altre chiavi dell'account e non torna più su questa pagina. In alternativa chi gestisce il server la mette in ${p?.keyEnv}.`;
		keyRow.hidden = p === undefined;
		forget.hidden = state !== "saved";
		filter.value = "";
		if (p === undefined) {
			models = [];
			filterRow.hidden = true;
			mount(model, h("option", { value: current.modelId }, current.modelId));
			return;
		}
		const answer = await api(`/api/models/${encodeURIComponent(p.id)}`);
		if (ask !== asked) return;
		models = [...answer.models].sort((a, b) => a.name.localeCompare(b.name));
		filterRow.hidden = models.length <= 20;
		fill(p.id === current.provider ? current.modelId : p.defaultModel);
	};
	provider.addEventListener("change", () => showModels().catch((error) => toast(error.message, true)));
	filter.addEventListener("input", () => fill(model.value));
	submit.addEventListener("click", async () => {
		try {
			const body = { provider: provider.value, modelId: model.value, ...(key.value.trim() ? { apiKey: key.value.trim() } : {}) };
			const { model: saved } = await api(`/api/instances/${inst.id}/model`, { method: "PUT", body });
			toast(`Annie ora usa ${models.find((m) => m.id === saved.modelId)?.name ?? saved.modelId}`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	});
	forget.addEventListener("click", () =>
		confirmDialog("Togliere la chiave?", `La chiave di ${chosen()?.label} viene cancellata dal server. Gli agenti che la usano vanno prima spostati su un altro modello.`, "Togli", async () => {
			await api(`/api/model-keys/${encodeURIComponent(provider.value)}`, { method: "DELETE" });
			toast("Chiave tolta");
			render();
		}),
	);
	const card = h(
		"div.card.pad",
		h("div.row-gap", h("h2", "Modello AI"), status),
		h("p.muted", "Il modello con cui Annie pensa e risponde: Claude, GPT, Gemini, Grok, Mistral, DeepSeek, Kimi, o uno dei tanti di OpenRouter. Cambiarlo non tocca chat, file e memoria: anche le chat vecchie continuano con il nuovo modello."),
		h("label.field", h("span", "Provider"), provider),
		filterRow,
		h("label.field", h("span", "Modello"), model),
		keyRow,
		h("div.actions", submit, forget),
	);
	showModels().catch((error) => toast(error.message, true));
	return card;
}

/** «Claude Sonnet 5.5 · foto · ragiona · entrata $3 · uscita $15 per M token»: what tells two models apart. */
function modelLabel(m, withId) {
	return `${withId ? `${m.name} (${m.id})` : m.name} · ${modelFacts(m)}`;
}

/** What a model does and costs: «foto · ragiona · entrata $3 · uscita $15 per M token». */
function modelFacts(m) {
	const usd = (n) => `$${n < 1 ? Number(n.toFixed(2)) : Math.round(n * 10) / 10}`;
	const price = m.inputUsd > 0 || m.outputUsd > 0 ? `entrata ${usd(m.inputUsd)} · uscita ${usd(m.outputUsd)} per M token` : "gratis";
	return [m.images ? "foto" : null, m.reasoning ? "ragiona" : null, price].filter(Boolean).join(" · ");
}

/** Owner: voice messages of this instance transcribed by the server's service. */
function voiceCard(inst, host, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/voice`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Vocali trascritti per questo agente" : "Vocali non più trascritti per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Messaggi vocali"),
		h("p.muted", `I vocali di Telegram e WhatsApp vengono trascritti da ${host} e arrivano ad Annie come testo. Solo quelli delle persone che possono scrivere; l'audio va solo a quel servizio.`),
		h("label.row-gap", toggle, h("span", "Trascrivi i vocali di questo agente")),
	);
}

/** Owner: web search for this instance, through the server's search service (ADR 0017). */
function searchCard(inst, host, allowed, hosts) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/search`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} può cercare sul web` : "Ricerca sul web spenta per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	const everything = hosts.includes("*");
	const openAll = async () => {
		if (!confirm("Annie potrà leggere, fotografare e usare con il browser tutti i siti pubblici, non solo quelli trovati cercando. Una pagina con istruzioni nascoste potrebbe spingerla a cercare qualcosa che non deve. Continuare?")) return;
		try {
			await api(`/api/instances/${inst.id}/web`, { method: "PUT", body: { hosts: ["*"] } });
			toast("Annie può aprire tutti i siti pubblici");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	return h(
		"div.card.pad",
		h("h2", "Ricerca sul web"),
		h("p.muted", `Annie cerca notizie, prezzi, orari e tutto quello che cambia, e se glielo chiedi prepara un report di ricerca con le fonti numerate. Le ricerche vanno a ${host}, solo le parole cercate. Le pagine trovate le apre solo dai siti consentiti qui sotto.`),
		h("label.row-gap", toggle, h("span", "Consenti la ricerca a questo agente")),
		allowed && !everything
			? h("p.muted", h("span", hosts.length === 0 ? "Per ora vede solo titoli ed estratti dei risultati. " : "Delle pagine trovate apre solo quelle dei siti consentiti. "), h("button.btn.small.ghost", { onclick: openAll }, "Fai aprire tutti i siti pubblici"))
			: null,
	);
}

/** Owner: the sites this instance may read and screenshot. */
function webCard(inst, hosts) {
	const list = h("textarea", { rows: 4, class: "mono", placeholder: "comune.roma.it\nagenziaentrate.gov.it\n* (tutti i siti pubblici)", value: hosts.join("\n") });
	const save = async () => {
		try {
			const { hosts: saved } = await api(`/api/instances/${inst.id}/web`, { method: "PUT", body: { hosts: list.value.split(/[\s,]+/) } });
			toast(saved.length === 0 ? "Navigazione web spenta per questo agente" : saved.includes("*") ? "Annie può leggere tutti i siti pubblici" : `Annie può leggere ${saved.length} siti`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	return h(
		"div.card.pad",
		h("h2", "Navigazione web"),
		h("p.muted", "I siti che Annie può leggere, fotografare e usare con il suo browser: apre le pagine, clicca, scrive nelle ricerche e nei filtri, ma non invia moduli (per quello servono le azioni sul web, con approvazione). Quello che scrive in una ricerca arriva al sito. Un dominio per riga, i sottodomini sono compresi. Meglio elencarli uno per uno: * vuol dire tutti i siti pubblici, anche quelli dove una pagina potrebbe spingere Annie a cercare qualcosa che non deve. Vuoto: nessuno."),
		h("label.field", h("span", "Siti consentiti"), list),
		h("button.btn", { onclick: save }, "Salva i siti"),
	);
}

/** Owner: forms on the allowed sites, sent only after a person approves each one (ADR 0011). */
function webActionsCard(inst, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed || undefined });
	toggle.onchange = async () => {
		try {
			await api(`/api/instances/${inst.id}/web-actions-allowed`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Annie può chiedere di inviare moduli" : "Azioni sul web spente");
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	};
	return h(
		"div.card.pad",
		h("h2", "Azioni sul web"),
		h("p.muted", "Annie può chiedere di inviare un modulo di un sito consentito (un contatto, una prenotazione). Ogni invio aspetta l'approvazione di chi l'ha chiesto o di un approvatore, che vede destinazione e valori esatti; niente parte da solo."),
		h("label.row-gap", toggle, h("span", "Consenti le azioni sul web con approvazione")),
	);
}

/** Which other agenti may write to this one (ADR 0042). Each tick saves at once. */
function agentsCard(inst, settings) {
	const others = state.instances.filter((i) => i.id !== inst.id && !i.hasSegreteria);
	const allowed = new Set(settings.egress.channels.includes("agente") ? (settings.allowedUsers.agente ?? []) : []);
	const boxes = others.map((o) => {
		const box = h("input", { type: "checkbox", checked: allowed.has(o.id) || undefined });
		box.onchange = async () => {
			try {
				const from = others.filter((x, i) => boxes[i].box.checked).map((x) => x.id);
				await api(`/api/instances/${inst.id}/agents`, { method: "PUT", body: { from } });
				toast(box.checked ? `${o.name} può scrivere a ${inst.name}` : `${o.name} non può più scrivere a ${inst.name}`);
			} catch (error) {
				box.checked = !box.checked;
				toast(error.message, true);
			}
		};
		return { box, row: h("label.row-gap", box, h("span", agentLabel(o))) };
	});
	return h(
		"div.card.pad",
		h("h2", "Agenti che possono scrivergli"),
		h("p.muted", `Un agente spuntato può chiedere aiuto a ${inst.name} mentre lavora: ${inst.name} risponde con i suoi strumenti e solo la memoria condivisa, e la risposta torna nella chat da cui era partita la domanda. Le conversazioni tra agenti non compaiono in chat; in Attività resta traccia di ogni messaggio. Per farli collaborare tutti insieme usa «Fate squadra» nella pagina Agenti.`),
		others.length === 0 ? h("p.muted", "Non ci sono altri agenti: creane uno dalla pagina Agenti.") : boxes.map((b) => b.row),
	);
}

/** The instance's computer (ADR 0013): a terminal with no network. */
function computerCard(inst, allowed, problem) {
	const toggle = h("input", { type: "checkbox", checked: allowed || undefined });
	toggle.onchange = async () => {
		try {
			await api(`/api/instances/${inst.id}/computer-allowed`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Annie può usare il suo computer" : "Computer spento");
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	};
	const reset = () =>
		confirmDialog("Azzerare il computer?", "Annie perde i file che ha nel suo computer (/work). Quelli copiati nel workspace restano.", "Azzera", async () => {
			await api(`/api/instances/${inst.id}/computer`, { method: "DELETE" });
			toast("Computer azzerato");
		});
	return h(
		"div.card.pad",
		h("h2", "Computer"),
		h("p.muted", "Annie esegue comandi in un computer suo, senza rete e senza segreti: elabora fogli e documenti, converte file, fa grafici. Usa copie dei file del workspace e rimette lì quelli che produce. Niente può uscire da quel computer, quindi i comandi non chiedono approvazione."),
		problem ? h("p.warn", `Il computer non è disponibile: ${problem}.`) : null,
		h("label.row-gap", toggle, h("span", "Consenti ad Annie di usare il suo computer")),
		h("div.actions", h("button.btn.ghost", { onclick: reset }, "Azzera i file del computer")),
	);
}

/** The agente's screen through Cua (ADR 0045): a desktop of its own where it clicks and types. */
function desktopCard(inst, allowed, desktop) {
	if (!desktop.available) return h("div.card.pad", h("h2", "Schermo"), h("p.muted", "Lo schermo non è attivo su questo server: chiedi a chi gestisce Annie di attivarlo."));
	const toggle = h("input", { type: "checkbox", checked: allowed || undefined });
	toggle.onchange = async () => {
		try {
			await api(`/api/instances/${inst.id}/desktop-allowed`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} può usare il suo schermo` : "Schermo spento");
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	};
	const reset = () =>
		confirmDialog("Riavviare lo schermo?", "Si chiude tutto quello che è aperto sullo schermo di questo agente. Il workspace non cambia.", "Riavvia", async () => {
			await api(`/api/instances/${inst.id}/desktop`, { method: "DELETE" });
			toast("Schermo riavviato");
		});
	const network =
		desktop.network === "internet"
			? "Arriva a internet, e il suo browser non segue l'elenco dei siti consentiti."
			: desktop.network === "none"
				? "Non ha internet: usa solo i suoi programmi."
				: "Gira altrove ed è lo stesso per tutti gli agenti che lo usano. Se arriva a internet, il suo browser non segue l'elenco dei siti consentiti.";
	const many = desktop.shared ? "" : " Se più agenti usano lo schermo insieme, quello usato meno di recente si chiude per fare posto.";
	return h(
		"div.card.pad",
		h("h2", "Schermo"),
		h("p.muted", `${inst.name} ha un computer tutto suo, con un browser, dove guarda lo schermo, clicca e scrive. ${network} Quello che fa sullo schermo non chiede approvazione: prima di inviare, pagare o accedere a un account si ferma e chiede in chat.${many}`),
		desktop.problem ? h("p.warn", "Lo schermo per ora non funziona: chi gestisce Annie deve sistemarlo.") : null,
		desktop.problem ? h("details", h("summary", "Dettagli per chi gestisce Annie"), h("p.mono", desktop.problem)) : null,
		h("label.row-gap", toggle, h("span", "Consenti lo schermo a questo agente")),
		desktop.shared ? null : h("div.actions", h("button.btn.ghost", { onclick: reset }, "Riavvia lo schermo")),
	);
}

/** Deleting an agente (ADR 0046): what goes is said plainly, and the owner types the name to confirm. */
function deleteCard(inst) {
	const open = () => {
		const typed = h("input", { type: "text", autocomplete: "off", "aria-label": "Nome dell'agente" });
		const ok = h("button.btn.danger", { disabled: true }, "Elimina per sempre");
		typed.addEventListener("input", () => (ok.disabled = typed.value !== inst.name));
		const dialog = h(
			"dialog",
			h("h2", `Eliminare ${inst.name}?`),
			h("p", `Se ne vanno le sue conversazioni, la sua memoria, i file del suo workspace, i task programmati e le sentinelle, le richieste in attesa e i connettori. Bot Telegram, numero WhatsApp e telefono si scollegano, e il computer e lo schermo, se li ha, si spengono e si svuotano. Gli altri agenti non ricevono più messaggi da lui, e le risposte che gli dovevano ancora vanno perse. Non si può annullare.`),
			h("label.field", h("span", `Per confermare scrivi «${inst.name}»`), typed),
			h("div.actions", ok, h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
		);
		ok.onclick = async () => {
			ok.disabled = true;
			try {
				await api(`/api/instances/${inst.id}`, { method: "DELETE", body: { confirm: typed.value } });
				dialog.close();
				if (store("annie.instance") === inst.id) store("annie.instance", null);
				toast(`Agente «${inst.name}» eliminato`);
				await refreshInstances();
				go("agenti");
			} catch (error) {
				ok.disabled = false;
				toast(error.message, true);
			}
		};
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		typed.focus();
	};
	return h(
		"div.card.pad",
		h("div.kicker", "Elimina agente"),
		h("p.muted", `Elimina ${inst.name} con tutto quello che sa e che ha: conversazioni, memoria, file e automazioni. Gli altri agenti restano come sono.`),
		h("div.actions", h("button.btn.danger", { onclick: open }, `Elimina ${inst.name}`)),
	);
}

// ---------- account (two-factor) ----------
function accountDialog() {
	const body = h("div");
	const dialog = h("dialog", h("h2", "Il tuo account"), googleSection(), body);
	const draw = async () => {
		const me = (await api("/api/me")).person;
		state.me = me;
		if (me.twoFactor) {
			const code = codeInput();
			mount(body, 
				h("p", h("span.chip.ok", "Verifica in due passaggi attiva"), " Per entrare servono il tuo link e il codice dell'app."),
				h("label.field", h("span", "Per disattivarla, scrivi un codice"), code),
				h(
					"div.actions",
					h(
						"button.btn.danger",
						{
							onclick: async () => {
								try {
									await api("/api/me/2fa/disable", { method: "POST", body: { code: code.value } });
									toast("Verifica in due passaggi disattivata");
									await draw();
								} catch (error) {
									toast(error.message, true);
								}
							},
						},
						"Disattiva",
					),
					h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi"),
				),
			);
			return;
		}
		mount(body, 
			h("p", "Con la verifica in due passaggi, per entrare servono il tuo link e un codice dall'app di autenticazione del telefono (Google Authenticator, 1Password, Authy…). Se qualcuno ti ruba il link, da solo non basta."),
			h(
				"div.actions",
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								const { secret, uri } = await api("/api/me/2fa/setup", { method: "POST", body: {} });
								const code = codeInput();
								mount(body, 
									h("p", "1. Nell'app di autenticazione aggiungi un account con questa chiave (o apri il link dal telefono):"),
									h("div.secret-key.mono", secret.match(/.{1,4}/g).join(" ")),
									h("p", h("a", { href: uri }, "Apri nell'app di autenticazione")),
									h("label.field", h("span", "2. Scrivi il codice che l'app mostra"), code),
									h(
										"div.actions",
										h(
											"button.btn.accent",
											{
												onclick: async () => {
													try {
														await api("/api/me/2fa/enable", { method: "POST", body: { code: code.value } });
														toast("Verifica in due passaggi attiva");
														await draw();
													} catch (error) {
														toast(error.message, true);
													}
												},
											},
											"Attiva",
										),
										h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
									),
								);
								code.focus();
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Attiva la verifica in due passaggi",
				),
				h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi"),
			),
		);
	};
	dialog.addEventListener("close", () => (dialog.remove(), renderRail()));
	document.body.append(dialog);
	dialog.showModal();
	void draw();
}

// ---------- shell ----------
/** Sections reached from the sidebar; the rest (management, account) sits in the account menu. */
const SIDEBAR = new Set(["inizia", "agenti", "stanze", "board", "segreteria", "approvazioni", "task", "automazioni", "file", "memoria", "skill"]);

function render() {
	if (!state.me) return renderLogin();
	const { view } = route();
	const item = PALETTE.find((p) => p.id === view) ?? PALETTE.find((p) => p.id === "chat");
	if (item.owner && state.me.role !== "owner") return go("chat");
	closeMenu();
	closeModelMenu();
	const main = h("main", { id: "main", class: item.id === "chat" || (item.id === "stanze" && route().rest[0]) ? "is-chat" : "is-page" });
	const shell = h(
		`div.shell${store("annie.rail") === "closed" ? ".collapsed" : ""}`,
		h(
			"header.topbar",
			h("button.icon-btn", { "aria-label": "Menu", onclick: () => shell.classList.toggle("open") }, icon("menu")),
			h("b", "Annie"),
			h("button.icon-btn", { "aria-label": "Nuova chat", title: "Nuova chat", onclick: () => go("chat") }, icon("compose")),
		),
		h("div.scrim", { onclick: () => shell.classList.remove("open") }),
		h("aside.rail", { id: "rail" }),
		// With the sidebar closed on a computer: the two things still needed, in the corner.
		h(
			"div.peek",
			h("button.icon-btn", { "aria-label": "Apri la barra laterale", title: "Apri la barra laterale", onclick: toggleRail }, icon("sidebar")),
			h("button.icon-btn", { "aria-label": "Nuova chat", title: "Nuova chat", onclick: () => go("chat") }, icon("compose")),
		),
		main,
	);
	mount($app, shell);
	renderRail();
	void refreshThreads().then(renderRail);
	state.onEntry = undefined;
	state.onRoom = undefined;
	const views = { inizia: viewStart, chat: viewChat, stanze: viewRooms, segreteria: viewSegreteria, approvazioni: viewApprovals, task: viewTasks, automazioni: viewAutomations, file: viewFiles, memoria: viewMemory, skill: viewSkills, agenti: viewAgents, board: viewBoard, connettori: viewConnectors, impostazioni: viewSettings, persone: viewPeople, attivita: viewActivity };
	(views[item.id] ?? viewChat)(main).catch((error) => {
		if (error instanceof ApiError && error.status === 401) return;
		mount(main, h("div.empty", h("b", "Qualcosa non va"), error.message));
	});
}

function toggleRail() {
	const shell = document.querySelector(".shell");
	if (!shell) return;
	shell.classList.toggle("collapsed");
	store("annie.rail", shell.classList.contains("collapsed") ? "closed" : "open");
}

/** The current instance's conversations, for the sidebar; none for someone who cannot chat there. */
async function refreshThreads() {
	const inst = state.instance;
	if (!inst?.canChat) {
		state.threads = [];
		return;
	}
	try {
		const { threads } = await api(`/api/instances/${inst.id}/threads`);
		if (state.instance === inst) state.threads = threads;
	} catch {
		/* the list stays as it was */
	}
}

/** Today, yesterday, this week, older: how the sidebar groups conversations. */
function threadGroup(at, now = new Date()) {
	const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((day(now) - day(new Date(at))) / 86_400_000);
	return days <= 0 ? "Oggi" : days === 1 ? "Ieri" : days < 7 ? "Ultimi 7 giorni" : days < 30 ? "Ultimi 30 giorni" : "Più vecchie";
}

function closeRailOnPhone() {
	document.querySelector(".shell")?.classList.remove("open");
}

function renderRail() {
	const rail = document.getElementById("rail");
	if (!rail) return;
	const { view, rest } = route();
	const items = PALETTE.filter((p) => SIDEBAR.has(p.id) && (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance)));
	const nav = h("nav.sections", { "aria-label": "Sezioni" });
	for (const item of items) {
		const count = item.count?.() ?? 0;
		nav.append(h("a", { href: `#/${item.id}`, "aria-current": view === item.id ? "page" : undefined, onclick: closeRailOnPhone }, icon(item.id), h("span.label", item.label), count > 0 ? h("span.count", String(count)) : null));
	}
	const past = h("nav.history", { "aria-label": "Conversazioni" });
	let group;
	for (const t of state.threads ?? []) {
		const g = threadGroup(t.updatedAt);
		if (g !== group) {
			group = g;
			past.append(h("div.group", g));
		}
		const current = view === "chat" && rest[0] === t.id;
		past.append(
			h(
				"a",
				{ href: `#/chat/${encodeURIComponent(t.id)}`, "aria-current": current ? "page" : undefined, title: t.title, onclick: closeRailOnPhone },
				h("span.label", t.title),
				state.unread.has(t.id) ? [h("span.dot", { "aria-hidden": "true" }), h("span.sr", "non letto")] : null,
			),
		);
	}
	mount(
		rail,
		h(
			"div.rail-top",
			h("a.brand", { href: "#/chat", onclick: closeRailOnPhone }, h("img", { src: "/icon.svg", alt: "", width: "22", height: "22" }), h("b", "Annie")),
			h("button.icon-btn.collapse", { "aria-label": "Chiudi la barra laterale", title: "Chiudi la barra laterale", onclick: toggleRail }, icon("sidebar")),
		),
		h(
			"div.rail-actions",
			h("a.rail-btn", { href: "#/chat", "aria-current": view === "chat" && !rest[0] ? "page" : undefined, onclick: closeRailOnPhone }, icon("compose"), h("span.label", "Nuova chat")),
			h("button.rail-btn", { onclick: openPalette, "aria-label": "Vai a una sezione" }, icon("search"), h("span.label", "Cerca"), h("kbd", navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
		),
		state.instances.length > 1
			? h(
					"nav.roster",
					{ "aria-label": "Agenti" },
					state.instances.map((i) =>
						h(
							"button.roster-item",
							{
								"aria-current": i.id === state.instance?.id ? "true" : undefined,
								title: i.tagline ? `${i.name}: ${i.tagline}` : i.name,
								onclick: () => {
									if (i.id === state.instance?.id) return go("chat");
									state.instance = i;
									store("annie.instance", i.id);
									state.threads = [];
									// A conversation of the other instance does not exist here.
									if (route().rest[0] && route().view === "chat") go("chat");
									void refreshSetup().then(render);
									render();
								},
							},
							face(i, 24),
							h("span.roster-text", h("span.name", agentLabel(i)), i.tagline ? h("span.line", i.tagline) : null),
						),
					),
				)
			: null,
		nav,
		h("div.rail-scroll", past.childElementCount ? past : null),
		h(
			"div.rail-foot",
			h(
				"button.who-id",
				{ onclick: openMenu, "aria-haspopup": "menu", "aria-expanded": document.querySelector(".menu") ? "true" : "false", title: "Account e gestione" },
				h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)),
				h("span.who-text", h("span.name", state.me.name), h("span.role", state.instance?.name ?? (state.me.role === "owner" ? "Owner" : "Membro"))),
				icon("more"),
			),
		),
	);
}

/** The account menu: spend, management sections, account, theme, exit. */
function openMenu() {
	if (closeMenu()) return;
	// The sidebar is drawn again on every reply: always the button that is on the page now.
	const anchor = () => document.querySelector("button.who-id");
	const owner = state.me.role === "owner";
	const u = state.usage;
	const share = u ? Math.min(1, u.todayUsd / u.hardUsd) : 0;
	const { view } = route();
	const entry = (iconName, label, action, current) =>
		h(
			"button",
			{
				role: "menuitem",
				"aria-current": current ? "page" : undefined,
				onclick: () => {
					closeMenu();
					closeRailOnPhone();
					action();
				},
			},
			icon(iconName),
			h("span", label),
		);
	const section = (id) => {
		const item = PALETTE.find((p) => p.id === id);
		return !item.owner || owner ? entry(id, item.label, () => go(id), view === id) : null;
	};
	const menu = h(
		"div.menu",
		h("div.menu-head", h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)), h("div", h("div.name", state.me.name), h("div.role", `${owner ? "Owner" : "Membro"}${state.me.twoFactor ? " · verifica attiva" : ""}`))),
		u
			? h(
					"div.spend",
					h("div.row", h("span", "Spesa di oggi"), h("b.mono", fmt.usd(u.todayUsd))),
					h("div.bar", h(`i${share >= 1 ? ".bad" : u.todayUsd >= u.softUsd ? ".warn" : ""}`, { "data-w": share })),
					h("div.row", h("span.muted", `soglia ${fmt.usd(u.softUsd)}`), h("span.muted", `tetto ${fmt.usd(u.hardUsd)}`)),
				)
			: null,
		h(
			"div",
			{ role: "menu", "aria-label": "Account e gestione" },
			h("hr", { role: "separator" }),
			section("connettori"),
			section("impostazioni"),
			section("persone"),
			section("attivita"),
			owner ? entry("plus", "Nuovo agente", () => agentForm()) : null,
			installOffer && !installed() ? entry("install", "Installa l'app", install) : null,
			h("hr", { role: "separator" }),
			entry("account", "Il tuo account", accountDialog),
			entry("theme", "Tema chiaro/scuro", cycleTheme),
			entry("logout", "Esci", async () => {
				await api("/api/logout", { method: "POST" }).catch(() => {});
				state.me = undefined;
				renderLogin();
			}),
		),
	);
	document.body.append(menu);
	const bar = menu.querySelector(".spend .bar i");
	if (bar) bar.style.width = `${Math.max(2, Number(bar.dataset.w) * 100)}%`;
	const r = anchor().getBoundingClientRect();
	menu.style.left = `${Math.max(8, r.left)}px`;
	menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
	anchor().setAttribute("aria-expanded", "true");
	menu.querySelector("button")?.focus();
	// The button toggles by itself: a press on it is not «away».
	const away = (e) => {
		if (!menu.contains(e.target) && !e.target.closest?.("button.who-id")) closeMenu();
	};
	const keys = (e) => {
		if (!menu.contains(document.activeElement)) return;
		if (e.key === "Escape") {
			e.preventDefault();
			closeMenu();
			anchor()?.focus();
		} else if (e.key === "Tab") closeMenu();
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const all = [...menu.querySelectorAll("button")];
			const i = all.indexOf(document.activeElement);
			all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
		}
	};
	document.addEventListener("pointerdown", away);
	document.addEventListener("keydown", keys);
	menu.cleanup = () => {
		document.removeEventListener("pointerdown", away);
		document.removeEventListener("keydown", keys);
		anchor()?.setAttribute("aria-expanded", "false");
	};
}

/** Closes the account menu; true when one was open. */
function closeMenu() {
	const menu = document.querySelector(".menu");
	if (!menu) return false;
	menu.cleanup?.();
	menu.remove();
	return true;
}

function cycleTheme() {
	const current = store("annie.theme") ?? "auto";
	const next = current === "auto" ? "dark" : current === "dark" ? "light" : "auto";
	applyTheme(next);
	toast(next === "auto" ? "Tema: come il sistema" : next === "dark" ? "Tema scuro" : "Tema chiaro");
}

function head(kicker, title, text, ...actions) {
	return h("div.head", h("div", h("div.kicker", kicker), title instanceof Node ? title : h("h1", title), text ? h("p", text) : null), actions.length ? h("div.row-gap", actions) : null);
}

function initials(name) {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

// ---------- command palette (⌘K) ----------
function openPalette() {
	if (!state.me || document.querySelector("dialog.palette")) return;
	const items = PALETTE.filter((p) => (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance))).map((p) => ({ ...p, icon: p.id, to: [p.id] }));
	// Conversations by title, once something is typed: this agente's chats, and the stanze (loaded now).
	const chats = state.threads.map((t) => ({ label: t.title, group: "Chat", icon: "chat", to: ["chat", t.id] }));
	let rooms = [];
	if (PALETTE.find((p) => p.id === "stanze")?.when()) {
		void api("/api/rooms")
			.then(({ rooms: list }) => {
				rooms = list.map((r) => ({ label: r.title, group: "Stanza", icon: "stanze", to: ["stanze", r.id] }));
				if (dialog.open) draw();
			})
			.catch(() => {});
	}
	const input = h("input", { type: "text", placeholder: "Vai a una sezione o a una conversazione…", "aria-label": "Cerca una sezione o una conversazione", autocomplete: "off" });
	const list = h("ul", { role: "listbox" });
	let active = 0;
	let shown = items;
	const dialog = h("dialog.palette", input, list);
	const pick = (item) => {
		dialog.close();
		dialog.remove();
		document.querySelector(".shell")?.classList.remove("open");
		go(...item.to);
	};
	const draw = () => {
		const q = input.value.trim().toLowerCase();
		const talks = q === "" ? [] : [...rooms, ...chats].filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
		shown = [...items.filter((i) => i.label.toLowerCase().includes(q)), ...talks];
		active = Math.min(active, Math.max(0, shown.length - 1));
		mount(list, 
			...shown.map((item, n) =>
				h(
					"li",
					{
						role: "option",
						"aria-selected": n === active ? "true" : "false",
						onclick: () => pick(item),
						onmousemove: () => {
							if (active === n) return;
							active = n;
							draw();
						},
					},
					icon(item.icon),
					h("span", item.label),
					h("span.muted", item.group),
				),
			),
			...(shown.length ? [] : [h("li.none", "Niente con questo nome")]),
		);
	};
	input.addEventListener("input", () => {
		active = 0;
		draw();
	});
	input.addEventListener("keydown", (e) => {
		if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length) {
			e.preventDefault();
			active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
			draw();
		} else if (e.key === "Enter" && shown[active]) {
			e.preventDefault();
			pick(shown[active]);
		}
	});
	dialog.addEventListener("close", () => dialog.remove());
	dialog.addEventListener("click", (e) => {
		if (e.target === dialog) dialog.close();
	});
	document.body.append(dialog);
	draw();
	dialog.showModal();
	input.focus();
}

window.addEventListener("keydown", (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		openPalette();
	}
});

function needInstance(main) {
	if (state.instance) return false;
	mount(main, h("div.empty", h("b", "Nessun agente"), "Non hai ancora accesso a nessun agente. Chiedi all'owner di aggiungerti."));
	return true;
}

// ---------- chat ----------
/** A workspace picture shown in the page (not downloaded). */
const pictureUrl = (inst, path) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(path)}&inline=1`;

const HINTS = ["Riassumi in punti il file che ti carico", "Cosa c'è in questa foto?", "Ricordami ogni lunedì alle 9 di controllare gli ordini", "Prepara un CSV con i clienti citati", "Quali strumenti hai a disposizione?"];

async function viewChat(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	if (!inst.canChat) {
		mount(main, h("section.conversation.empty-chat", h("div.welcome", h("h2", "Chat non disponibile"), h("p", state.me.role === "owner" ? "Aggiungi te stesso alle persone che possono scrivere a questo agente, in Impostazioni." : "Non sei tra le persone che possono scrivere a questo agente."))));
		return;
	}
	const threadId = route().rest[0];
	chatModelCache.clear();
	const conversation = h("section.conversation");
	mount(main, conversation);
	if (!threadId) return landing(inst, conversation);
	// One panel at a time next to the chat, also when one opens by itself.
	const browser = browserPanel(inst, threadId, () => screen.show(false));
	const screen = screenPanel(inst, threadId, () => browser.show(false));
	mount(main, h("div.chat-split", conversation, browser.el, screen.el), h("div.panel-toggles", screen.toggle, browser.toggle));
	state.unread.delete(threadId);
	renderRail();
	const { entries, model } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}`);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	let typing;
	const picture = (path) => pictureUrl(inst, path);
	// A file to download; also what a picture that does not show (deleted, not really a picture) becomes.
	const fileLink = (file) => h("a.file", { href: `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(file.path)}` }, h("span.ext", (file.path.split(".").pop() ?? "file").slice(0, 4)), h("span", h("b", file.path.split("/").pop()), file.caption ? h("div.muted", file.caption) : null));
	const show = (entry) => {
		const shown = entry.file && /\.(png|jpe?g|webp|gif)$/i.test(entry.file.path);
		const body = shown
			? h(
					"div.picture",
					h(
					"a.pic",
					{ href: picture(entry.file.path), target: "_blank", rel: "noopener" },
					h("img", { src: picture(entry.file.path), alt: entry.file.caption ?? entry.file.path.split("/").pop(), loading: "lazy", onerror: (event) => event.target.closest(".picture").replaceWith(fileLink(entry.file)) }),
					),
					entry.file.caption ? h("div.muted", entry.file.caption) : null,
				)
			: entry.file
			? fileLink(entry.file)
			: h("div.body", entry.text ?? "");
		const pictures = entry.images?.length
			? h(
					"div.pics",
					entry.images.map((path) => {
						const link = h("a", { href: picture(path), target: "_blank", rel: "noopener" });
						// A photo deleted from the workspace since: said, not a broken image.
						link.append(h("img", { src: picture(path), alt: path.split("/").pop(), loading: "lazy", onerror: () => link.replaceWith(h("span.gone", `${path.split("/").pop()} non c'è più`)) }));
						return link;
					}),
				)
			: null;
		const listen = entry.from === "annie" && entry.text ? listenButton(entry.text) : null;
		// Which model wrote the reply: the chat's own, or the instance's when that could not answer.
		const by = entry.model ? h("span.by", { title: `${entry.model.provider} · ${entry.model.modelId}` }, entry.model.name ?? entry.model.modelId) : null;
		const el = h(`div.msg.${entry.from}`, h("div.meta", entry.from === "annie" ? [face(inst, 20), h("b.who", inst.name)] : null, fmt.time(entry.at), by, listen), pictures, entry.text || entry.file || !pictures ? body : null);
		transcript.append(el);
		return el;
	};
	for (const e of entries) show(e);
	// Google writes this conversation asked for: decided here, above the box, without leaving the chat.
	const asks = h("div.asks", { hidden: true });
	const drawAsks = async () => {
		const { actions } = await api(`/api/instances/${inst.id}/google-actions`).catch(() => ({ actions: [] }));
		const waiting = actions.filter((a) => a.status === "pending" && a.thread?.threadId === threadId);
		const { actions: calls } = await api(`/api/instances/${inst.id}/connector-actions`).catch(() => ({ actions: [] }));
		const asked = calls.filter((a) => a.status === "pending" && a.thread?.threadId === threadId);
		asks.hidden = waiting.length + asked.length === 0;
		const again = () => void drawAsks().then(refreshCounters);
		mount(asks, ...waiting.map((a) => googleActionCard(inst, a, again, true)), ...asked.map((a) => connectorActionCard(inst, a, again, true)));
	};
	void drawAsks();
	const stopTyping = () => {
		typing?.remove();
		typing = undefined;
	};
	const startTyping = () => {
		stopTyping();
		typing = thinking([inst]);
		transcript.append(typing);
		transcript.scrollTop = transcript.scrollHeight;
	};
	if (entries.length && entries.at(-1).from === "person") startTyping();
	state.onEntry = (event) => {
		if (event.threadId !== threadId) return false;
		stopTyping();
		show(event.entry);
		if (event.entry.from === "annie") void drawAsks();
		browser.lively();
		screen.lively();
		transcript.scrollTop = transcript.scrollHeight;
		return true;
	};
	const box = chatBox(inst, threadId, conversation, async (text, images) => {
		browser.lively();
		screen.lively();
		const bubble = show({ from: "person", text, images, at: new Date().toISOString() });
		const listed = state.threads.find((t) => t.id === threadId);
		if (listed && listed.title === "Nuova chat") {
			listed.title = text ? text.replace(/\s+/g, " ").slice(0, 60) : "Foto";
			renderRail();
		}
		startTyping();
		try {
			await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", body: images.length ? { text, images } : { text } });
		} catch (error) {
			stopTyping();
			bubble.remove();
			throw error;
		}
		void refreshThreads().then(renderRail);
	}, modelPill(inst, model, async (picked) => {
		await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/model`, { method: "PUT", body: picked ? { provider: picked.provider, modelId: picked.modelId } : {} });
	}));
	conversation.append(transcript, h("div.dock", asks, box.el));
	transcript.scrollTop = transcript.scrollHeight;
	// A message written on the empty chat: sent as soon as its conversation opens.
	if (main.isConnected && store(`annie.autosend.${threadId}`) === "1") {
		store(`annie.autosend.${threadId}`, null);
		void box.submit();
	}
	box.input.focus();
}

/**
 * The conversation's browser, next to the chat (ADR 0044): the page the agente has open with
 * web_browse, refreshed after each of its actions, and an address bar to open a page for it.
 * It opens by itself the first time the agente starts browsing in this conversation.
 */
function browserPanel(inst, threadId, onShow) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/browser`;
	const seenKey = `annie.browser.${threadId}`;
	let version = -1;
	let wasOpen = false;
	const address = h("input.address", { type: "text", inputmode: "url", placeholder: "Indirizzo di un sito consentito", "aria-label": "Indirizzo", spellcheck: "false", autocomplete: "off" });
	const back = h("button.icon-btn", { type: "button", title: "Indietro", "aria-label": "Indietro", disabled: true }, icon("back"));
	const title = h("span.page-title", "Browser");
	// A picture gone between the question and the download (the page closed): the last one stays.
	const screen = h("img.screen", { alt: "", hidden: true, onerror: () => { version = -1; } });
	const emptyLead = h("p");
	const empty = h("div.browser-empty", emptyLead, h("p.muted", "Apri una pagina qui sopra e chiedigli di leggerla, oppure chiedigli di cercare qualcosa sul web."));
	const busyNote = h("span.busy-note", { hidden: true }, `${inst.name} sta usando il browser…`);
	const el = h(
		"aside.browser-panel",
		{ hidden: true, "aria-label": "Browser" },
		h("div.browser-head", icon("browser"), title, busyNote, h("button.icon-btn", { type: "button", title: "Chiudi", "aria-label": "Chiudi il browser", onclick: () => show(false) }, icon("close"))),
		h("form.browser-bar", { onsubmit: (event) => { event.preventDefault(); void go({ url: address.value }); } }, back, address),
		h("div.browser-view", screen, empty),
		h("p.browser-note", "Solo i siti che l'owner ha consentito. Il browser legge soltanto: un modulo si invia solo con un'approvazione."),
	);
	const toggle = h("button.browser-toggle", { type: "button", title: "Browser della conversazione", "aria-pressed": "false", onclick: () => show(el.hidden) }, icon("browser"), h("span", "Browser"));
	const show = (on) => {
		if (on === !el.hidden) return;
		el.hidden = !on;
		toggle.setAttribute("aria-pressed", String(on));
		toggle.classList.remove("news");
		store(seenKey, "1");
		if (on) {
			onShow();
			void refresh();
		}
	};
	const narrow = () => matchMedia("(max-width: 860px)").matches;
	const draw = (state, available = true) => {
		back.disabled = !state.open;
		busyNote.hidden = !state.busy;
		if (!state.open) {
			screen.hidden = true;
			empty.hidden = false;
			title.textContent = "Browser";
			emptyLead.textContent = !available
				? "Il browser non è disponibile su questo server: chiedi all'operatore di installare Chromium."
				: state.closed
				? `Il browser si è chiuso (${state.closed}). Scrivi un indirizzo per riaprirlo.`
				: `Qui vedi il browser che ${inst.name} usa in questa conversazione, mentre lavora.`;
			version = -1;
			return;
		}
		// Chromium's own page for one that did not load: said plainly, the chat has the reason.
		const failed = state.url.startsWith("chrome-error:");
		title.textContent = failed ? "La pagina non si è aperta" : state.title || new URL(state.url).host;
		if (document.activeElement !== address && !failed) address.value = state.url;
		if (state.version !== version && !el.hidden) {
			version = state.version;
			screen.src = `${base}.png?v=${state.version}`;
			screen.alt = `La pagina ${state.title || state.url}`;
			screen.hidden = false;
			empty.hidden = true;
		}
	};
	const refresh = async () => {
		const { browser, available } = await api(base).catch(() => ({ browser: undefined }));
		if (browser === undefined) return;
		// The agente opened a page: the panel shows it, once per conversation unless closed before.
		// On a phone it would cover the chat: a dot on the button says it instead.
		if (browser.open && !wasOpen && el.hidden && store(seenKey) !== "1") {
			if (narrow()) toggle.classList.add("news");
			else show(true);
		}
		wasOpen = browser.open;
		draw(browser, available);
	};
	const go = async (body) => {
		if (body.url !== undefined && !body.url.trim()) return;
		el.classList.add("loading");
		try {
			const { browser } = await api(base, { method: "POST", body });
			draw(browser);
			address.blur();
		} catch (error) {
			toast(error.message, true);
		} finally {
			el.classList.remove("loading");
		}
	};
	back.onclick = () => void go({ back: true });
	// While the chat is on screen: a light question, often while the panel is open or the conversation
	// is moving (a message sent or arrived in the last two minutes), rarely otherwise; a picture only after a change.
	let ticks = 0;
	let livelyUntil = 0;
	const timer = setInterval(() => {
		if (!el.isConnected) return clearInterval(timer);
		ticks += 1;
		if (document.visibilityState === "visible" && (!el.hidden || Date.now() < livelyUntil || ticks % 4 === 0)) void refresh();
	}, 2000);
	void refresh();
	return {
		el,
		toggle,
		show,
		lively: () => {
			livelyUntil = Date.now() + 120_000;
		},
	};
}

/**
 * The agente's screen, live next to the chat (ADR 0067): the last picture it took of its screen in
 * this conversation, with what it just did. Only to watch: the agente works, the person follows.
 * The button appears once the agente has used its screen here; the panel opens by itself the first
 * time, on a wide window.
 */
function screenPanel(inst, threadId, onShow) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/screen`;
	const seenKey = `annie.screen.${threadId}`;
	let version = -1;
	// A picture gone between the question and the download (the screen reset): asked again next time.
	const picture = h("img.screen", { alt: "", hidden: true, onerror: () => { version = -1; } });
	const what = h("p.browser-note");
	const when = h("span.busy-note");
	const el = h(
		"aside.browser-panel",
		{ hidden: true, "aria-label": "Schermo" },
		h("div.browser-head", icon("screen"), h("span.page-title", `Lo schermo di ${inst.name}`), when, h("button.icon-btn", { type: "button", title: "Chiudi", "aria-label": "Chiudi lo schermo", onclick: () => show(false) }, icon("close"))),
		h("div.browser-view", picture),
		what,
		h("p.browser-note", "Qui guardi soltanto. Prima di inviare, pagare o accedere a un account si ferma e te lo chiede in chat."),
	);
	const toggle = h("button.browser-toggle", { type: "button", hidden: true, title: "Lo schermo dell'agente", "aria-pressed": "false", onclick: () => show(el.hidden) }, icon("screen"), h("span", "Schermo"));
	const show = (on) => {
		if (on === !el.hidden) return;
		el.hidden = !on;
		toggle.setAttribute("aria-pressed", String(on));
		if (on) {
			toggle.classList.remove("news");
			store(seenKey, "1");
			onShow();
			void refresh();
		}
	};
	const refresh = async () => {
		const answer = await api(base).catch(() => undefined);
		if (answer === undefined) return;
		const { screen, on } = answer;
		off = !on && screen === null;
		// Nothing seen (yet, or any more: the screen reset, Annie restarted): no button, no panel.
		if (screen === null) {
			show(false);
			toggle.hidden = true;
			picture.hidden = true;
			version = -1;
			return;
		}
		if (toggle.hidden) {
			toggle.hidden = false;
			if (store(seenKey) !== "1") {
				if (matchMedia("(max-width: 860px)").matches) toggle.classList.add("news");
				else show(true);
			}
		}
		when.textContent = fmt.time(screen.at);
		what.textContent = screen.action ?? "Ha guardato lo schermo.";
		if (screen.version !== version && !el.hidden) {
			version = screen.version;
			picture.src = `${base}.png?v=${screen.version}`;
			picture.alt = `Lo schermo di ${inst.name}: ${what.textContent}`;
			picture.hidden = false;
		}
	};
	// Often while the panel is open or the conversation is moving, rarely otherwise; never for an
	// agente without the screen. A picture only after a change.
	let ticks = 0;
	let livelyUntil = 0;
	let off = false;
	const timer = setInterval(() => {
		if (!el.isConnected) return clearInterval(timer);
		ticks += 1;
		if (document.visibilityState === "visible" && !off && (!el.hidden || Date.now() < livelyUntil || ticks % 5 === 0)) void refresh();
	}, 2000);
	void refresh();
	return {
		el,
		toggle,
		show,
		lively: () => {
			livelyUntil = Date.now() + 120_000;
		},
	};
}

/** The empty chat: a greeting, the box in the middle and a few ideas. Sending opens a new conversation. */
function landing(inst, conversation) {
	conversation.classList.add("empty-chat");
	// A model picked before the first message: the conversation it opens is created with it.
	let picked;
	const box = chatBox(inst, `new.${inst.id}`, conversation, async (text, images) => {
		const { thread } = await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: picked ? { model: { provider: picked.provider, modelId: picked.modelId } } : {} });
		store(`annie.draft.${thread.id}`, text);
		if (images.length) store(`annie.pending.${thread.id}`, JSON.stringify(images));
		store(`annie.autosend.${thread.id}`, "1");
		go("chat", thread.id);
	}, modelPill(inst, undefined, async (model) => {
		picked = model;
	}));
	const hour = new Date().getHours();
	const hello = hour < 5 || hour >= 18 ? "Buonasera" : "Buongiorno";
	const first = state.me.name.split(/\s+/)[0];
	conversation.style.setProperty("--glow", faceColor(inst));
	conversation.append(
		h(
			"div.welcome",
			h("div.mark", face(inst, 76)),
			h("h2", first && first !== "Owner" ? `${hello}, ${first}.` : `${hello}.`),
			h("p", state.instances.length > 1 ? `${inst.name}${inst.tagline ? `: ${inst.tagline.replace(/[.!?…]+$/, "")}` : ""}. Di cosa hai bisogno?` : "Di cosa hai bisogno?"),
			box.el,
			h(
				"div.hints.ideas",
				HINTS.map((t) =>
					h(
						"button",
						{
							onclick: () => {
								box.input.value = t;
								box.input.dispatchEvent(new Event("input"));
								if (t.includes("foto")) box.input.placeholder = "Aggiungi la foto con la graffetta, trascinala qui o incollala";
								box.input.focus();
							},
						},
						t,
					),
				),
			),
			state.setupLeft > 0 ? h("p.aside", h("a", { href: "#/inizia" }, stepsLeftText(state.setupLeft))) : null,
			state.me.role !== "owner" && installOffer && !installed() ? h("p.aside", h("button.btn.small.ghost", { onclick: install }, icon("install"), "Installa Annie come app")) : null,
		),
	);
	box.input.focus();
}

/** What the chat model picker reads, asked once per chat view: the choices, and each provider's models. */
const chatModelCache = new Map();
const chatModelChoices = (inst) => cached(chatModelCache, inst.id, () => api(`/api/instances/${inst.id}/chat-models`));
const chatModelList = (inst, provider) => cached(chatModelCache, `${inst.id}/${provider}`, () => api(`/api/instances/${inst.id}/chat-models/${encodeURIComponent(provider)}`).then((r) => r.models));

function cached(map, key, load) {
	if (!map.has(key)) {
		const loading = load();
		loading.catch(() => map.delete(key));
		map.set(key, loading);
	}
	return map.get(key);
}

/**
 * The chat's model (ADR 0036), a pill in the message box as on Grok: the instance's, or a model of
 * a provider this person may use. `current` ({provider, modelId, name}) undefined: the instance's.
 * `save(model | undefined)` stores a choice; choices are saved one after the other, and when the
 * newest fails the pill shows the last one saved and the error is said.
 */
function modelPill(inst, current, save) {
	let chosen = current;
	let saved = current;
	let instanceModel;
	let picks = 0;
	let saving = Promise.resolve();
	const label = h("span.model-name", current?.name ?? "Modello");
	const pill = h("button.model-pill", { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Modello di questa chat" }, label, icon("down"));
	const draw = () => {
		const shown = chosen ?? instanceModel;
		label.textContent = shown?.name ?? "Modello";
		pill.classList.toggle("own", chosen !== undefined);
		pill.setAttribute("aria-label", `Modello di questa chat: ${label.textContent}${chosen ? "" : " (quello dell'agente)"}`);
	};
	const pick = (model) => {
		closeModelMenu();
		pill.focus();
		chosen = model;
		draw();
		const mine = ++picks;
		saving = saving.then(async () => {
			try {
				await save(model);
				saved = model;
				// An owner's pick may have allowed a provider: the list says so next time.
				chatModelCache.delete(inst.id);
			} catch (error) {
				if (mine !== picks) return;
				chosen = saved;
				draw();
				toast(error.message, true);
			}
		});
	};
	pill.addEventListener("click", () => {
		if (!closeModelMenu()) void openModelMenu(inst, pill, chosen, pick);
	});
	void chatModelChoices(inst)
		.then((choices) => {
			instanceModel = choices.instanceModel;
			draw();
		})
		.catch(() => {});
	draw();
	return pill;
}

/** The list of models under the pill: search, the instance's model, then each provider's. */
async function openModelMenu(inst, pill, chosen, pick) {
	const listId = `model-list-${Date.now()}`;
	const search = h("input", { type: "search", placeholder: "Cerca un modello", autocomplete: "off", "aria-label": "Cerca un modello", "aria-controls": listId });
	const list = h("div.model-list", { id: listId, role: "listbox", "aria-label": "Modelli" });
	const status = h("p.muted.model-empty", { role: "status" });
	const menu = h("div.model-menu", search, list, status);
	document.body.append(menu);
	pill.setAttribute("aria-expanded", "true");
	pill.setAttribute("aria-controls", listId);
	const place = () => {
		const r = pill.getBoundingClientRect();
		const view = window.visualViewport;
		const height = view?.height ?? window.innerHeight;
		const width = Math.min(320, window.innerWidth - 16);
		menu.style.width = `${width}px`;
		menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
		// Upwards from the box at the bottom of a chat; downwards when there is more room below.
		const above = r.top - 14;
		const below = height - r.bottom - 14;
		const up = above >= 280 || above >= below;
		menu.style.maxHeight = `${Math.min(420, up ? above : below)}px`;
		menu.style.bottom = up ? `${window.innerHeight - r.top + 6}px` : "";
		menu.style.top = up ? "" : `${r.bottom + 6}px`;
		menu.style.transformOrigin = up ? "bottom right" : "top right";
	};
	place();
	// On a phone the search waits for a tap: focusing it would open the keyboard over the list.
	const touch = window.matchMedia("(pointer: coarse)").matches;
	if (!touch) search.focus();
	const option = (text, note, selected, onPick) =>
		h("button.model-option", { type: "button", role: "option", "aria-selected": selected ? "true" : "false", onclick: onPick }, h("span", h("span.model-option-name", text), note ? h("small", note) : null), selected ? icon("check") : null);
	let catalogs = [];
	const fill = () => {
		const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const match = (m, p) => words.every((w) => `${m.name} ${m.id} ${p.label}`.toLowerCase().includes(w));
		const groups = catalogs.map(({ provider, models, error }, i) => {
			const shown = (models ?? []).filter((m) => match(m, provider));
			if (error === undefined && shown.length === 0) return null;
			const head = `model-group-${i}`;
			// Two models with the same name (one is a dated version) are told apart by their id.
			const names = new Map();
			for (const m of shown) names.set(m.name, (names.get(m.name) ?? 0) + 1);
			// The provider's suggested model first, then its catalog as it comes.
			const ordered = [...shown].sort((a, b) => (b.id === provider.defaultModel) - (a.id === provider.defaultModel));
			return h(
				"div",
				{ role: "group", "aria-labelledby": head },
				h("div.model-group", { id: head }, provider.label, provider.allowed ? null : h("small", " · sceglierlo lo permette all'agente")),
				error === undefined
					? ordered.map((m) => option(names.get(m.name) > 1 ? `${m.name} (${m.id})` : m.name, modelFacts(m), chosen?.provider === provider.id && chosen?.modelId === m.id, () => pick({ provider: provider.id, modelId: m.id, name: m.name })))
					: h("small.model-error", "Elenco non disponibile ora"),
			);
		});
		mount(list, words.length === 0 ? option("Modello dell'agente", "lo sceglie l'owner in Impostazioni", chosen === undefined, () => pick(undefined)) : null, groups);
		status.textContent = words.length > 0 && groups.every((g) => g === null) ? "Nessun modello trovato" : "";
		status.hidden = status.textContent === "";
	};
	search.addEventListener("input", fill);
	menu.addEventListener("keydown", (e) => {
		const all = [search, ...list.querySelectorAll("button")];
		const i = all.indexOf(document.activeElement);
		if (e.key === "Escape") {
			e.preventDefault();
			closeModelMenu();
			pill.focus();
		} else if (e.key === "Tab") closeModelMenu();
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
		} else if (e.key === "Home" || e.key === "End") {
			if (document.activeElement === search) return;
			e.preventDefault();
			all[e.key === "Home" ? 1 : all.length - 1]?.focus();
		} else if (e.key === "Enter" && document.activeElement === search && search.value.trim() !== "") {
			// Enter in the search takes the first model found; with nothing typed it does nothing.
			e.preventDefault();
			list.querySelector("button")?.click();
		}
	});
	const away = (e) => {
		if (!menu.contains(e.target) && !pill.contains(e.target)) closeModelMenu();
	};
	document.addEventListener("pointerdown", away);
	window.addEventListener("resize", place);
	window.visualViewport?.addEventListener("resize", place);
	menu.cleanup = () => {
		document.removeEventListener("pointerdown", away);
		window.removeEventListener("resize", place);
		window.visualViewport?.removeEventListener("resize", place);
		pill.setAttribute("aria-expanded", "false");
		pill.removeAttribute("aria-controls");
	};
	status.textContent = "Carico i modelli…";
	try {
		const { providers } = await chatModelChoices(inst);
		// One provider that does not answer leaves the others listed.
		const settled = await Promise.allSettled(providers.map((provider) => chatModelList(inst, provider.id)));
		catalogs = providers.map((provider, i) => (settled[i].status === "fulfilled" ? { provider, models: settled[i].value } : { provider, error: settled[i].reason }));
	} catch (error) {
		status.textContent = error.message;
		return;
	}
	if (!menu.isConnected) return;
	fill();
	if (touch) list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
}

/** Closes the model list; true when one was open. */
function closeModelMenu() {
	const menu = document.querySelector(".model-menu");
	if (!menu) return false;
	menu.cleanup?.();
	menu.remove();
	return true;
}

/**
 * The commands a message can start with, offered as soon as the box holds «/» (after the @names
 * of a stanza): Up and Down move, Enter or Tab picks, Esc closes. `load` gives them once, as
 * { name, note, prefix? }: `prefix` is a stanza's @name, written before the command when no name
 * is yet, so the skill reaches the agente that has it.
 */
function commandMenu(input, load, onChange) {
	const menu = h("div.command-menu", { role: "listbox", "aria-label": "Comandi", hidden: true });
	let commands;
	let shown = [];
	let at = 0;
	const typed = () => /^((?:@[\p{L}\p{N}_-]+[\s,:]*)*)\/([\w-]*)$/u.exec(input.value);
	const close = () => {
		menu.hidden = true;
		shown = [];
		input.removeAttribute("aria-activedescendant");
	};
	const pick = (c) => {
		const [, names = ""] = typed() ?? [];
		input.value = `${names === "" ? (c.prefix ?? "") : names}/${c.name} `;
		close();
		input.focus();
		onChange();
	};
	const draw = () => {
		mount(menu, shown.map((c, i) => h("button.model-option", { type: "button", role: "option", id: `command-${i}`, "aria-selected": i === at ? "true" : "false", onmousedown: (e) => e.preventDefault(), onclick: () => pick(c) }, h("span", h("span.model-option-name", `${c.prefix ?? ""}/${c.name}`), c.note ? h("small", c.note) : null))));
		input.setAttribute("aria-activedescendant", `command-${at}`);
		menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	};
	const update = async () => {
		const match = typed();
		if (match === null) return close();
		commands ??= await load().catch(() => []);
		const word = (match[2] ?? "").toLowerCase();
		// After «@vendite », only what that agente has (all of them after @tutti).
		const names = (match[1] ?? "").toLowerCase();
		const called = (c) => names === "" || c.prefix === undefined || /@(tutti|all)\b/.test(names) || names.includes(c.prefix.trim().toLowerCase());
		shown = commands.filter((c) => c.name.startsWith(word) && called(c)).slice(0, 8);
		// The box may have changed while the commands were loading.
		if (shown.length === 0 || typed() === null) return close();
		at = Math.min(at, shown.length - 1);
		menu.hidden = false;
		draw();
	};
	input.addEventListener("input", () => {
		at = 0;
		void update();
	});
	input.addEventListener("blur", close);
	// Before the box's own keys, so Enter picks a command instead of sending it.
	input.addEventListener(
		"keydown",
		(e) => {
			if (menu.hidden || e.isComposing) return;
			const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
			if (move !== undefined) at = (at + move + shown.length) % shown.length;
			else if (e.key === "Enter" || e.key === "Tab") pick(shown[at]);
			else if (e.key === "Escape") close();
			else return;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (move !== undefined) draw();
		},
		true,
	);
	return menu;
}

/** An agente's commands: its skills, /modello, and /attiva-skill when the person has drafts to turn on. */
async function agentCommands(instanceId, prefix) {
	const { skills, drafts } = await api(`/api/instances/${encodeURIComponent(instanceId)}/skills`);
	return [
		...skills.map((s) => ({ name: s.name, note: s.description, prefix })),
		...(drafts.length > 0 ? [{ name: "attiva-skill", note: `Attiva una tua bozza: ${drafts.map((d) => d.name).join(", ")}`, prefix }] : []),
		{ name: "modello", note: "Scegli il modello di questa chat", prefix },
	];
}

/**
 * The message box: text, photos waiting to go with it, files noted in it, a drop zone and a paste.
 * The draft and the photos are kept per key (a conversation, or "new") until onSend succeeds;
 * when onSend throws, they come back and the error is said.
 */
function chatBox(inst, key, dropZone, onSend, extra = null) {
	const picture = (path) => pictureUrl(inst, path);
	const draftKey = `annie.draft.${key}`;
	const input = h("textarea", { rows: 1, placeholder: inst.name.toLowerCase() === "annie" ? "Scrivi ad Annie…" : `Scrivi a ${inst.name}…`, title: "Invio per inviare, Maiusc+Invio per andare a capo", "aria-label": "Messaggio", value: store(draftKey) ?? "" });
	// Photos uploaded for the next message: shown above the box until it is sent, kept with the draft.
	const pendingKey = `annie.pending.${key}`;
	const pending = (() => {
		try {
			const saved = JSON.parse(store(pendingKey) ?? "[]");
			return Array.isArray(saved) ? saved.filter((p) => typeof p === "string").slice(0, 4) : [];
		} catch {
			return [];
		}
	})();
	let uploading = 0;
	let sending = false;
	const tray = h("div.tray", { hidden: true });
	const sendButton = h("button.send", { "aria-label": "Invia", title: "Invia", onclick: () => submit() }, icon("send"));
	const ready = () => {
		sendButton.disabled = uploading > 0 || sending || (!input.value.trim() && pending.length === 0);
	};
	const drawTray = () => {
		store(pendingKey, pending.length ? JSON.stringify(pending) : null);
		tray.hidden = pending.length === 0 && uploading === 0;
		ready();
		mount(tray, 
			...pending.map((p, i) =>
				h("span.chip", h("img", { src: picture(p), alt: p.split("/").pop() }), h("button", { "aria-label": `Togli ${p.split("/").pop()}`, onclick: () => { pending.splice(i, 1); drawTray(); } }, "×")),
			),
			...Array.from({ length: uploading }, () => h("span.chip.loading", { "aria-label": "Caricamento" })),
		);
	};
	const fit = () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(220, input.scrollHeight)}px`;
	};
	const submit = async () => {
		const text = input.value.trim();
		if (uploading > 0) return toast("Aspetta che le foto finiscano di caricarsi");
		if (sending || (!text && pending.length === 0)) return;
		sending = true;
		const images = pending.splice(0);
		input.value = "";
		fit();
		drawTray();
		store(draftKey, null);
		try {
			await onSend(text, images);
		} catch (error) {
			toast(error.message, true);
			input.value = text;
			store(draftKey, text);
			pending.unshift(...images);
			fit();
		} finally {
			sending = false;
			drawTray();
		}
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void submit();
		}
	});
	input.addEventListener("input", () => {
		store(draftKey, input.value);
		fit();
		ready();
	});
	const file = h("input", { type: "file", class: "sr", multiple: true, "aria-label": "Carica un file o una foto" });
	const PICTURES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
	// From the paperclip, a drop on the chat or a paste (a screenshot): photos go with the message, other files are noted in it.
	const add = async (files) => {
		const pictures = files.filter((f) => PICTURES.includes(f.type));
		if (pending.length + pictures.length > 4) toast("Al massimo 4 foto per messaggio", true);
		const allowed = new Set(pictures.slice(0, Math.max(0, 4 - pending.length)));
		for (const f of files) {
			const isPicture = PICTURES.includes(f.type);
			if (isPicture && !allowed.has(f)) continue;
			if (isPicture) uploading += 1;
			drawTray();
			try {
				const name = f.name || `incollata.${f.type.slice("image/".length).replace("jpeg", "jpg")}`;
				const { file: saved, note } = await api(`/api/instances/${inst.id}/files/raw?name=${encodeURIComponent(name)}`, { method: "PUT", raw: f });
				if (isPicture) pending.push(saved.path);
				else {
					// The server's words for the file (a document, a recording): the same on every channel.
					input.value = `${input.value ? `${input.value}\n` : ""}${note} `;
					store(draftKey, input.value);
					fit();
					toast(`Caricato ${saved.path}`);
				}
			} catch (error) {
				toast(error.message, true);
			} finally {
				if (isPicture) uploading -= 1;
				drawTray();
			}
		}
		input.focus();
	};
	file.addEventListener("change", () => {
		const files = [...(file.files ?? [])];
		file.value = "";
		void add(files);
	});
	input.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		e.preventDefault();
		void add(files);
	});
	dropZone.addEventListener("dragover", (e) => {
		if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
	});
	dropZone.addEventListener("drop", (e) => {
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		e.preventDefault();
		void add(files);
	});
	drawTray();
	requestAnimationFrame(fit);
	const commands = commandMenu(input, () => agentCommands(inst.id), () => {
		store(draftKey, input.value);
		fit();
		ready();
	});
	const el = h("div.box", commands, tray, h("div.composer", h("label.attach", { title: "Carica un file o una foto" }, icon("attach"), h("span.sr", "File"), file), input, extra, sendButton));
	return { el, input, submit };
}

// ---------- segreteria ----------
const STATUS = {
	draft_ready: ["Da approvare", "accent"],
	awaiting_edit: ["In modifica", "warn"],
	approved: ["Invio in corso", "warn"],
	sent: ["Inviata", "ok"],
	discarded: ["Scartata", ""],
	failed: ["Problema", "bad"],
	classified_skip: ["Non commerciale / spam", ""],
	received: ["Ricevuta", ""],
	lead_upserted: ["Ricevuta", ""],
	logged: ["Registrata", ""],
};
/** What the draft asks the customer for (MissingField), as the owner reads it. */
const MISSING = {
	fullName: "nome",
	company: "azienda",
	email: "email",
	productOrService: "richiesta",
	quantity: "quantità",
	deliverySite: "luogo di consegna",
	vatNumber: "P.IVA",
	vatNumberInvalid: "P.IVA da ricontrollare",
	budget: "budget",
	deadline: "scadenza",
};

async function viewSegreteria(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const selected = route().rest[0];
	const waiting = (p) => p.status === "draft_ready" || p.status === "awaiting_edit" || p.status === "failed";
	// Waiting for a decision first, then the rest; newest first within each.
	const pratiche = (await api(`/api/instances/${inst.id}/pratiche`)).pratiche.sort((a, b) => Number(waiting(b)) - Number(waiting(a)));
	const open = pratiche.filter(waiting).length;
	const list = h("div.card.list");
	for (const p of pratiche) {
		const [label, tone] = STATUS[p.status] ?? [p.status, ""];
		list.append(
			h(
				"button",
				{ "aria-current": p.praticaId === selected ? "true" : undefined, onclick: () => go("segreteria", p.praticaId) },
				h("div.who-line", h("b", p.lead.fullName ?? p.lead.company ?? p.lead.email ?? "Sconosciuto"), h(`span.chip${tone ? `.${tone}` : ""}`, label)),
				h("div.subj", p.lead.rawSubject),
				h("div.mono.muted", `#${p.praticaId.slice(0, 8)} · ${fmt.time(p.lead.receivedAt)}`),
			),
		);
	}
	const detail = h("div");
	mount(main, 
		head(agentLabel(inst), h("h1", "Segreteria commerciale"), `${open} ${open === 1 ? "pratica aspetta" : "pratiche aspettano"} la tua decisione. Nessuna mail parte senza Approva.`),
		pratiche.length ? h("div.pratiche", list, detail) : h("div.card.empty", h("b", "Ancora nessuna richiesta"), "Le richieste di preventivo arrivate per email compariranno qui e su Telegram."),
	);
	const p = pratiche.find((x) => x.praticaId === selected) ?? pratiche[0];
	if (p) renderPratica(detail, inst, p);
}

function renderPratica(detail, inst, p) {
	const lead = p.lead;
	const [label, tone] = STATUS[p.status] ?? [p.status, ""];
	const act = async (action, extra = {}) => {
		try {
			const { result } = await api(`/api/instances/${inst.id}/pratiche/${p.praticaId}/action`, { method: "POST", body: { action, draftVersion: p.draftVersion, requestId: crypto.randomUUID(), ...extra } });
			if (result.kind === "ignored") toast(result.reason === "stale_version" ? "La bozza è cambiata nel frattempo: ricarico." : "Azione già eseguita o non più valida.", true);
			else toast(action === "approve" ? (result.sent ? "Mail inviata" : "Fatto") : action === "discard" ? "Pratica scartata" : "Bozza aggiornata");
		} catch (error) {
			toast(error.message, true);
		}
		render();
	};
	const editing = h("div.stack", { hidden: true });
	const editText = h("textarea", { rows: 4, placeholder: "Come vuoi cambiare la bozza? (oppure incolla il testo intero)" });
	editing.append(h("label.field", h("span", "Modifica"), editText), h("div.row-gap", h("button.btn", { onclick: () => editText.value.trim() && act("edit", { text: editText.value }) }, "Aggiorna bozza"), h("button.btn.ghost", { onclick: () => (editing.hidden = true) }, "Annulla")));
	const canAct = inst.isApprover && (p.status === "draft_ready" || p.status === "failed" || p.status === "awaiting_edit" || (p.status === "classified_skip" && p.classification === "spam"));
	const rows = [
		["Nome", [lead.title, lead.fullName].filter(Boolean).join(" ") || "—"],
		["Azienda", lead.company ?? "—"],
		["Email", lead.email ?? "—"],
		["Telefono", lead.phone ?? "—"],
		["Richiesta", lead.productOrService ?? "—"],
		["Quantità", lead.quantity ?? "—"],
		["Tempi", lead.urgency ?? "—"],
		["Dati mancanti", p.missingFields.length ? p.missingFields.map((f) => MISSING[f] ?? f).join(", ") : "nessuno"],
	];
	if (lead.notes) rows.push(["Note", lead.notes]);
	mount(detail, 
		h(
			"div.stack",
			h(
				"div.card.pad",
				h("div.row-gap", h(`span.chip${tone ? `.${tone}` : ""}`, label), h("span.mono.muted", `Pratica #${p.praticaId.slice(0, 8)} · bozza v${p.draftVersion}`)),
				h("h2", lead.rawSubject),
				h("dl.lead", rows.map(([k, v]) => [h("dt", k), h("dd", v)])),
			),
			p.draftBody ? h("div.letter", h("div.subject", `Oggetto: ${p.draftSubject}`), p.draftBody) : h("div.card.empty", h("b", "Nessuna bozza"), p.classification === "spam" ? "Probabilmente spam. Approva per trattarla come richiesta: verrà preparata una bozza da approvare." : "Questa mail non richiede una risposta."),
			canAct
				? h(
						"div.actions",
						h(
							"button.btn.accent",
							{
								onclick: () => {
									if (p.status === "classified_skip") return act("approve");
									confirmDialog(`Inviare la mail a ${lead.email}?`, "La bozza mostrata parte così com'è, nello stesso thread della richiesta.", "Invia la mail", () => act("approve"));
								},
							},
							p.status === "classified_skip" ? "È una richiesta vera" : "Approva e invia",
						),
						p.draftBody ? h("button.btn.ghost", { onclick: () => ((editing.hidden = false), editText.focus()) }, "Modifica") : null,
						h("button.btn.danger", { onclick: () => act("discard") }, "Scarta"),
					)
				: !inst.isApprover
					? h("p.muted", "Solo gli approvatori di questo agente possono decidere.")
					: null,
			editing,
		),
	);
}

function confirmDialog(title, text, okLabel, onOk) {
	const dialog = h(
		"dialog",
		h("h2", title),
		h("p", text),
		h(
			"div.actions",
			h(
				"button.btn.accent",
				{
					onclick: () => {
						dialog.close();
						onOk();
					},
				},
				okLabel,
			),
			h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
		),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}

// ---------- approvazioni ----------
async function viewApprovals(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { proposals } = await api(`/api/instances/${inst.id}/proposals`);
	const pending = proposals.filter((p) => p.status === "pending");
	const decided = proposals.filter((p) => p.status !== "pending").reverse();
	const card = (p) => {
		const el = h(
			"article.card.pad.dossier",
			h("header", h("div", h("div.kicker", `Proposta ${p.id} · ${fmt.time(p.proposedAt)}`), h("h2", "Tool ", h("span.mono", `custom_${p.name}`))), p.status === "pending" ? h("span.chip.accent", "In attesa") : null),
			h("p", p.description),
			h("p", h("b", "Può raggiungere: "), p.hosts.length ? h("span.mono", p.hosts.join(", ")) : h("span", "nessun host (niente rete)")),
			h("details", { open: p.status === "pending" ? true : undefined }, h("summary", "Codice"), h("pre.code", p.code)),
			h("details", h("summary", "Argomenti (JSON Schema)"), h("pre.code", JSON.stringify(p.parameters, null, 2))),
			p.status !== "pending" ? h(`div.stamp.${p.status === "approved" ? "ok" : "bad"}`, p.status === "approved" ? "Approvato" : "Rifiutato") : null,
			p.decidedAt ? h("p.mono.muted", `Deciso il ${fmt.time(p.decidedAt)}`) : null,
		);
		if (p.status === "pending" && inst.isApprover) {
			const decide = async (decision) => {
				try {
					await api(`/api/instances/${inst.id}/proposals/${p.id}/decision`, { method: "POST", body: { decision } });
					el.querySelector(".chip.accent")?.remove();
					el.querySelector(".actions")?.remove();
					el.append(h(`div.stamp.${decision === "approved" ? "ok" : "bad"}`, decision === "approved" ? "Approvato" : "Rifiutato"));
					setTimeout(() => void refreshCounters().then(render), 900);
				} catch (error) {
					toast(error.message, true);
				}
			};
			el.append(h("div.actions", h("button.btn.accent", { onclick: () => decide("approved") }, "Approva"), h("button.btn.danger", { onclick: () => decide("rejected") }, "Rifiuta"), h("span.muted", "Approvato, gira isolato e raggiunge solo gli host dichiarati.")));
		}
		return el;
	};
	const { actions } = await api(`/api/instances/${inst.id}/web-actions`);
	const ACTION_STAMP = { done: ["ok", "Inviato"], failed: ["bad", "Non inviato"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In invio"] };
	const actionCard = (a) => {
		const el = h(
			"article.card.pad.dossier",
			h("header", h("div", h("div.kicker", `Richiesta ${a.id} · ${fmt.time(a.proposedAt)}`), h("h2", "Invio di un modulo a ", h("span.mono", new URL(a.action).host))), a.status === "pending" ? h("span.chip.accent", "In attesa") : null),
			h("p", a.reason),
			h("p", h("b", "Pagina: "), h("span.mono", a.pageUrl)),
			h("p", h("b", "Invio a: "), h("span.mono", a.action)),
			h("p.muted", "Cosa parte (tranne i campi nascosti del sito, come i token di sicurezza):"),
			h("table.ledger", h("tbody", a.shown.map(([k, v]) => h("tr", h("td.mono", k), h("td", h("pre.code", v)))))),
			a.result ? h("details", h("summary", "Risposta del sito"), h("pre.code", a.result.error ?? `${a.result.status} ${a.result.url}\n${a.result.title}\n\n${a.result.text}`)) : null,
			a.status !== "pending" && ACTION_STAMP[a.status] ? h(`div.stamp.${ACTION_STAMP[a.status][0]}`, ACTION_STAMP[a.status][1]) : null,
		);
		if (a.status === "pending") {
			const decide = async (decision) => {
				try {
					const { action } = await api(`/api/instances/${inst.id}/web-actions/${a.id}/decision`, { method: "POST", body: { decision } });
					toast(action.status === "done" ? "Modulo inviato" : action.status === "rejected" ? "Richiesta rifiutata" : action.status === "failed" ? "Il modulo non è partito: vedi la risposta" : action.status === "uncertain" ? "Esito incerto: controlla sul sito" : `Richiesta ${action.status}`, action.status === "failed" || action.status === "uncertain");
					setTimeout(() => void refreshCounters().then(render), 600);
				} catch (error) {
					toast(error.message, true);
				}
			};
			el.append(h("div.actions", h("button.btn.accent", { onclick: () => decide("approved") }, "Invia"), h("button.btn.danger", { onclick: () => decide("rejected") }, "Rifiuta"), h("span.muted", "Il modulo parte una volta sola, con questi valori. Se nel frattempo il sito lo cambia, non parte.")));
		}
		return el;
	};
	const pendingActions = actions.filter((a) => a.status === "pending");
	const decidedActions = actions.filter((a) => a.status !== "pending").reverse();
	const { actions: connectorActions } = await api(`/api/instances/${inst.id}/connector-actions`).catch(() => ({ actions: [] }));
	const afterConnector = () => setTimeout(() => void refreshCounters().then(render), 600);
	const pendingConnector = connectorActions.filter((a) => a.status === "pending").map((a) => connectorActionCard(inst, a, afterConnector));
	const decidedConnector = connectorActions.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => connectorActionCard(inst, a, afterConnector));
	const { actions: googleActions } = await api(`/api/instances/${inst.id}/google-actions`).catch(() => ({ actions: [] }));
	const afterGoogle = () => setTimeout(() => void refreshCounters().then(render), 600);
	const pendingGoogle = googleActions.filter((a) => a.status === "pending").map((a) => googleActionCard(inst, a, afterGoogle));
	const decidedGoogle = googleActions.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => googleActionCard(inst, a, afterGoogle));
	// Everything waiting for this person, in one place: drafts of every segreteria they approve too.
	const drafts = [];
	for (const s of state.instances.filter((i) => i.hasSegreteria && i.isApprover)) {
		const waiting = (await api(`/api/instances/${s.id}/pratiche`)).pratiche.filter((p) => p.status === "draft_ready");
		if (waiting.length)
			drafts.push(
				h(
					"article.card.pad.dossier",
					h("header", h("div", h("div.kicker", s.name), h("h2", `${waiting.length} ${waiting.length === 1 ? "bozza aspetta" : "bozze aspettano"} Approva`)), h("span.chip.accent", "Segreteria")),
					h("ul", waiting.slice(0, 5).map((p) => h("li", `${p.lead.fullName ?? p.lead.company ?? p.lead.email ?? "Sconosciuto"} · ${p.lead.rawSubject}`))),
					h(
						"div.actions",
						h(
							"button.btn",
							{
								onclick: () => {
									state.instance = s;
									store("annie.instance", s.id);
									go("segreteria", waiting[0].praticaId);
								},
							},
							"Apri la segreteria",
						),
					),
				),
			);
	}
	mount(main, 
		head(agentLabel(inst), h("h1", "Approvazioni"), "Tutto ciò che aspetta una tua decisione: le mail e gli eventi che Annie prepara sul tuo Google, le azioni sui servizi collegati (Notion, Linear, GitHub…) che cambiano qualcosa, le bozze della segreteria, i moduli che Annie chiede di inviare e i tool che scrive da sola, spenti finché un approvatore non li legge e li approva."),
		h(
			"div.stack",
			drafts,
			pendingGoogle,
			pendingConnector,
			pendingActions.map(actionCard),
			pending.map(card),
			drafts.length || pendingGoogle.length || pendingConnector.length || pendingActions.length || pending.length ? null : h("div.card.empty", h("b", "Niente da approvare"), "Le mail e gli eventi che Annie prepara per te compaiono qui e in chat; le azioni sui servizi collegati, le bozze della segreteria, i moduli da inviare e i tool che Annie propone qui e su Telegram o WhatsApp."),
			decidedGoogle.length || decidedConnector.length || decidedActions.length || decided.length ? [h("div.kicker", "Decisi"), decidedGoogle, decidedConnector, decidedActions.slice(0, 20).map(actionCard), decided.map(card)] : null,
		),
	);
}

// ---------- Connettori: azioni che cambiano qualcosa ----------
const CONNECTOR_STAMP = { done: ["ok", "Fatto"], failed: ["bad", "Non riuscito"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In corso"] };

/** A call to a connected service waiting for a person: why, what, with which values, whole; approve runs it once. */
function connectorActionCard(inst, a, after, compact = false) {
	const el = h(
		"article.card.pad.dossier",
		h("header", h("div", h("div.kicker", `${a.connectorName} · richiesta ${a.id} · ${fmt.time(a.proposedAt)}`), h("h2", a.reason)), a.status === "pending" ? h(a.destructive ? "span.chip.bad" : "span.chip.accent", a.destructive ? "Può cancellare o sovrascrivere" : "In attesa") : null),
		h("p", h("b", "Azione: "), a.toolTitle, " ", h("span.mono.muted", a.tool)),
		a.shown.length ? h("table.ledger", h("tbody", a.shown.map(([k, v]) => h("tr", h("td.mono", k), h("td", h("pre.code", v)))))) : h("p.muted", "Nessun dato."),
		a.result ? h("details", h("summary", "Dettagli"), h("pre.code", a.result.error ?? a.result.text)) : null,
		a.status !== "pending" && CONNECTOR_STAMP[a.status] ? h(`div.stamp.${CONNECTOR_STAMP[a.status][0]}`, CONNECTOR_STAMP[a.status][1]) : null,
	);
	if (a.status === "pending") {
		const decide = async (decision) => {
			try {
				const { action } = await api(`/api/instances/${inst.id}/connector-actions/${a.id}/decision`, { method: "POST", body: { decision } });
				toast(action.status === "done" ? `Fatto su ${a.connectorName}` : action.status === "rejected" ? "Richiesta rifiutata" : action.status === "failed" ? "Non è stata fatta: vedi i dettagli" : action.status === "uncertain" ? `Esito incerto: controlla su ${a.connectorName}` : action.status === "expired" ? "La richiesta era scaduta" : `Richiesta ${action.status}`, action.status !== "done" && action.status !== "rejected");
				after();
			} catch (error) {
				toast(error.message, true);
			}
		};
		el.append(h("div.actions", h("button.btn.accent", { onclick: () => decide("approved") }, "Approva"), h("button.btn.danger", { onclick: () => decide("rejected") }, "Rifiuta"), compact ? null : h("span.muted", `Se la approvi, Annie la fa una volta sola, con questi valori, su ${a.connectorName}.`)));
	}
	return el;
}

// ---------- Google: scrivere con approvazione ----------
const GOOGLE_KIND = {
	"mail.send": ["Mail", "Invia la mail", "Mail inviata"],
	"mail.draft": ["Bozza in Gmail", "Salva la bozza", "Bozza salvata in Gmail"],
	"calendar.create": ["Nuovo evento", "Crea l'evento", "Evento creato"],
	"calendar.update": ["Modifica di un evento", "Modifica l'evento", "Evento modificato"],
	"calendar.delete": ["Evento da cancellare", "Cancella l'evento", "Evento cancellato"],
};
const GOOGLE_STAMP = { done: ["ok", "Fatto"], failed: ["bad", "Non riuscito"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In corso"] };

/** The day before (YYYY-MM-DD): Google ends an all-day event on the day after the last one. */
function dayBefore(date) {
	return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** An event time as Google takes it, for reading: "gio 16 ott, 10:00" as in the calendar, or the day. */
function eventWhen(t, end = false) {
	if (!t) return "";
	let text = typeof t === "string" ? t : (t.date ?? t.dateTime ?? "");
	const allDay = /^\d{4}-\d{2}-\d{2}$/.test(text);
	if (allDay && end) text = dayBefore(text);
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(text);
	if (!m) return text;
	const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
	return m[4] ? `${day}, ${m[4]}:${m[5]}` : day;
}

/** Start → end, the end's day left out when it is the same; all day said once. */
function eventSpan(start, end) {
	const a = eventWhen(start);
	const b = eventWhen(end, true);
	const allDay = !a.includes(":");
	if (allDay) return a === b ? `${a}, tutto il giorno` : `da ${a} a ${b}, tutto il giorno`;
	const [dayA] = a.split(", ");
	return b.startsWith(`${dayA}, `) ? `${a} → ${b.slice(dayA.length + 2)}` : `${a} → ${b}`;
}

function googleTitle(a) {
	const to = a.mail?.to.join(", ");
	return {
		"mail.send": a.mail?.inReplyTo ? `Rispondere a ${to}` : `Inviare una mail a ${to}`,
		"mail.draft": `Salvare una bozza per ${to}`,
		"calendar.create": `Creare «${a.event?.summary ?? ""}»`,
		"calendar.update": `Modificare «${a.current?.summary ?? ""}»`,
		"calendar.delete": `Cancellare «${a.current?.summary ?? ""}»`,
	}[a.kind] ?? "Richiesta";
}

/**
 * A write to the person's Google account, as they decide it: everything that will happen, word
 * for word. `compact` in the chat, above the box.
 */
function googleActionCard(inst, a, after, compact = false) {
	const [kind, verb, doneWord] = GOOGLE_KIND[a.kind] ?? ["Richiesta", "Approva", "Fatto"];
	const attached = a.mail?.attachments?.length ?? 0;
	const kicker = [kind, attached === 1 ? "1 allegato" : attached ? `${attached} allegati` : null, fmt.time(a.proposedAt)].filter(Boolean).join(" · ");
	const rows = [];
	const row = (label, value) => value && rows.push(h("tr", h("td", label), h("td", value)));
	if (a.mail) {
		row("Da", a.account);
		const answered = a.mail.inReplyTo;
		if (answered) row("In risposta a", `${answered.from} · «${answered.subject}»${answered.date ? ` · ${answered.date}` : ""}`);
		row("A", a.mail.to.join(", "));
		if (answered?.replyToDiffers) row("Attenzione", "chi ha scritto chiede di rispondere a un altro indirizzo: controlla il destinatario");
		row("Cc", a.mail.cc.join(", "));
		row("Oggetto", a.mail.subject);
		const files = a.mail.attachments ?? [];
		// Whole paths: what leaves the workspace, as the server checked it (ADR 0056).
		row(files.length === 1 ? "Allegato" : "Allegati", files.length ? files.map((f) => h("div", `${f.path} (${fmt.bytes(f.size)})`)) : null);
	} else {
		const e = a.event ?? {};
		const c = a.current;
		row("Calendario", a.account);
		if (c) row(a.kind === "calendar.delete" ? "Evento" : "Evento attuale", `${c.summary} · ${eventSpan(c.start, c.end)}`);
		if (c?.occurrence) row("Ricorrente", "cambia solo questa occorrenza");
		if (c?.series) row("Ricorrente", "cambia tutta la serie");
		if (a.kind === "calendar.create") row("Titolo", e.summary);
		else row("Nuovo titolo", e.summary);
		if (e.start) row(a.kind === "calendar.update" ? "Nuovo orario" : "Quando", eventSpan(e.start, e.end));
		row("Luogo", e.location);
		row("Descrizione", e.description);
		const before = c?.attendees ?? [];
		if (e.attendees) {
			const added = e.attendees.filter((x) => !before.includes(x));
			const removed = before.filter((x) => !e.attendees.includes(x));
			if (a.kind === "calendar.create") row("Invitati", e.attendees.join(", "));
			else {
				row("Invitati aggiunti", added.join(", "));
				row("Invitati tolti", removed.join(", "));
			}
		} else if (before.length) row("Invitati", before.join(", "));
		if (before.length || e.attendees?.length) row("Avvisi", a.notify ? "Google scrive agli invitati" : "gli invitati non vengono avvisati");
	}
	const expires = new Date(Date.parse(a.proposedAt) + 24 * 3600_000).toISOString();
	const el = h(
		`article.card.pad.dossier.google-ask${compact ? ".compact" : ""}`,
		h("header", h("div", h("div.kicker", kicker), h("h2", googleTitle(a))), a.status === "pending" ? h("span.chip.accent", "Da approvare") : null),
		a.reason ? h("p.muted", a.reason) : null,
		h("table.ledger.fields", h("tbody", rows)),
		a.mail ? (compact && a.mail.body.length > 600 ? h("details", h("summary", "Testo della mail"), h("pre.letter", a.mail.body)) : h("pre.letter", a.mail.body)) : null,
		a.result?.error ? h("p.muted", a.result.error) : null,
		a.result?.link?.startsWith("https://www.google.com/calendar/") ? h("p", h("a", { href: a.result.link, target: "_blank", rel: "noopener" }, "Apri in Google Calendar")) : null,
		a.status !== "pending" && GOOGLE_STAMP[a.status] ? h(`div.stamp.${GOOGLE_STAMP[a.status][0]}`, GOOGLE_STAMP[a.status][1]) : null,
	);
	if (a.status === "pending") {
		const buttons = [];
		const decide = async (decision) => {
			for (const b of buttons) b.disabled = true;
			try {
				const { action } = await api(`/api/instances/${inst.id}/google-actions/${a.id}/decision`, { method: "POST", body: { decision } });
				const words = { done: doneWord, rejected: "Richiesta rifiutata", failed: "Non è riuscito: vedi il motivo", uncertain: "Esito incerto: controlla in Google", expired: "Richiesta scaduta", running: "In corso" };
				toast(words[action.status] ?? "Richiesta decisa", action.status === "failed" || action.status === "uncertain");
				after();
			} catch (error) {
				for (const b of buttons) b.disabled = false;
				toast(error.message, true);
			}
		};
		buttons.push(h(`button.btn${a.kind === "calendar.delete" ? ".danger" : ".accent"}`, { onclick: () => decide("approved") }, verb), h("button.btn.ghost", { onclick: () => decide("rejected") }, "Rifiuta"));
		el.append(h("div.actions", ...buttons, h("span.muted", `Una volta sola, esattamente così. Scade ${fmt.time(expires)}.`)));
	}
	return el;
}

// ---------- ascolta ----------
/**
 * A reply read aloud by a voice installed on this device: only local voices, so the text never
 * leaves it (some browsers' voices are online services). No local voice in the page's language:
 * no button. Read sentence by sentence, since some browsers stop a long utterance midway.
 */
const listening = { button: undefined, voice: undefined };

function localVoice() {
	if (!("speechSynthesis" in window)) return undefined;
	listening.voice ??= window.speechSynthesis.getVoices().find((v) => v.localService && v.lang?.toLowerCase().startsWith("it"));
	return listening.voice;
}
// Chrome lists its voices only after a while: buttons drawn before that appear on the next render.
if ("speechSynthesis" in window) window.speechSynthesis.addEventListener?.("voiceschanged", () => (listening.voice = undefined));
window.addEventListener("hashchange", () => stopReading());

function stopReading() {
	if (!("speechSynthesis" in window)) return;
	window.speechSynthesis.cancel();
	listening.button?.replaceChildren(icon("listen"));
	listening.button?.setAttribute("aria-label", "Ascolta");
	listening.button?.setAttribute("aria-pressed", "false");
	listening.button = undefined;
}

/** What is said: the same rules as the voice notes on Telegram and WhatsApp (src/channels/speech.ts). */
function speakable(text) {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, "$1")
		.replace(/\bhttps?:\/\/\S+/g, "link")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
		.replace(/\|/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

function listenButton(text) {
	if (!localVoice()) return null;
	const button = h("button.listen", { type: "button", "aria-label": "Ascolta", "aria-pressed": "false", title: "Ascolta" }, icon("listen"));
	button.addEventListener("click", () => {
		const again = listening.button === button;
		stopReading();
		if (again) return;
		const voice = localVoice();
		const sentences = (speakable(text).match(/[^.!?\n]+[.!?]*[»"')\]]*\s*/g) ?? []).filter((x) => /[\p{L}\p{N}]/u.test(x));
		if (!voice || sentences.length === 0) return;
		listening.button = button;
		button.replaceChildren(icon("stop"));
		button.setAttribute("aria-label", "Ferma");
		button.setAttribute("aria-pressed", "true");
		sentences.forEach((sentence, i) => {
			const utterance = new SpeechSynthesisUtterance(sentence.trim());
			utterance.voice = voice;
			utterance.lang = voice.lang;
			if (i === sentences.length - 1) utterance.onend = () => listening.button === button && stopReading();
			utterance.onerror = () => listening.button === button && stopReading();
			window.speechSynthesis.speak(utterance);
		});
	});
	return button;
}

// ---------- primi passi ----------
const TEMPLATES = [
	["Assistente personale", "Assistente personale di chi ti scrive. Rispondi in italiano, breve e diretta. Prima di fare qualcosa che manda messaggi o spende soldi, chiedi conferma."],
	["Negozio o studio", "Assistente di [nome dell'attività], a [città]. Aiuti il titolare con clienti, ordini e appuntamenti. Tono cordiale e professionale. Non promettere prezzi o date senza conferma."],
	["Team di lavoro", "Assistente del team di [azienda]. Prepari riassunti, documenti e promemoria, e cerchi informazioni aggiornate citando le fonti. Rispondi in italiano, in punti quando serve."],
];
const PLACEHOLDER = /\[[^\]\n]{1,60}\]/;

/** Install is possible here: the browser offered it, or Safari's Share menu on iPhone and iPad. */
const canInstall = () => installOffer !== undefined || appleTouch;

/**
 * The steps of «Primi passi», from what the server checked and what this browser knows. `own`: the
 * owner can take it from here (some browsers cannot install).
 */
function setupSteps(setup) {
	const can = setup.can ?? {};
	return [
		{ id: "model", own: true, done: setup.model, title: "Scegli il modello AI", text: setup.model ? "Annie usa un modello AI vero: puoi cambiarlo quando vuoi." : "Ora risponde il modello di prova, che ripete quello che scrivi. Scegli Claude, GPT, Gemini, Grok o un altro, e incolla la tua chiave.", go: ["impostazioni", "modello"] },
		{ id: "instructions", own: true, done: setup.instructions, title: "Dille chi è e cosa fa", text: "Due righe su di te o sulla tua azienda, il tono e cosa deve fare. Puoi partire da un esempio: vengono aggiunte a quello che Annie sa già fare, e le cambi quando vuoi in Impostazioni." },
		{ id: "tried", own: true, done: setup.tried, title: "Scrivile qualcosa", text: `Una domanda, una foto, un file da riassumere: vedi subito come risponde.${setup.model ? "" : " Con il modello di prova la risposta ripete quello che scrivi."}` },
		{ id: "channel", own: true, done: setup.channel, title: "Usala dal telefono", text: `Collega Telegram o WhatsApp e mettiti tra chi può scriverle: le scrivi, le mandi ${can.transcription ? "vocali e " : ""}foto${can.transcription && can.speech ? ", ti risponde anche a voce" : ""}, e ti avvisa lei.`, go: ["impostazioni", "telegram"] },
		{ id: "web", own: true, done: setup.web, title: "Lasciala cercare sul web", text: can.search ? "Accendi la ricerca e scegli i siti che può aprire: notizie, prezzi, orari aggiornati, report di ricerca con le fonti." : "Scegli i siti che può aprire: notizie, prezzi, orari aggiornati.", go: ["impostazioni", can.search ? "ricerca" : "siti"] },
		...(can.images ? [{ id: "images", own: true, done: setup.images, title: "Fatti creare un'immagine", text: "Accendi le immagini: un logo, un volantino, una foto ritoccata, chiesti a parole in chat.", go: ["impostazioni", "immagini"] }] : []),
		{ id: "connectors", own: true, done: setup.connectors, title: "Collega i tuoi strumenti", text: "Notion, Linear, Jira, Stripe, GitHub e altri in un clic: entri con il tuo account e Annie può cercare, leggere e aggiornare lì dentro.", go: ["connettori"] },
		{ id: "people", own: true, done: setup.people, title: "Invita il tuo team", text: "Aggiungi le persone in Persone, poi in Impostazioni scegli chi può scrivere a questo agente. Ognuno ha le sue chat e la sua memoria; tu decidi chi approva le azioni delicate.", go: ["persone"] },
		{ id: "app", own: canInstall(), done: installed(), title: "Installa la console come app", text: "Annie sulla schermata Home o sul desktop, a schermo intero, come un'app." },
	];
}

/** Steps left that the owner can take from the console: what the counters show. */
function setupLeft(setup) {
	return setupSteps(setup).filter((s) => !s.done && s.own).length;
}

function stepsLeftText(n) {
	return n === 1 ? "Primi passi: ne manca 1" : `Primi passi: ne mancano ${n}`;
}

async function viewStart(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { setup } = await api(`/api/instances/${inst.id}/setup`);
	if (inst !== state.instance) return;
	state.setup = setup;
	const steps = setupSteps(setup);
	state.setupLeft = setupHidden(inst.id) ? 0 : setupLeft(setup);
	renderRail();
	const instructions = h("textarea", { rows: 4, maxlength: "2000", placeholder: "Es. Assistente di Studio Rossi a Roma: aiuti con clienti e appuntamenti, in italiano, tono cordiale." });
	const save = h("button.btn.accent", "Salva");
	save.addEventListener("click", async () => {
		const text = instructions.value.trim();
		if (text === "") return toast("Scrivi due righe su di te o sulla tua azienda", true);
		const gap = PLACEHOLDER.exec(text);
		if (gap) {
			instructions.focus();
			instructions.setSelectionRange(gap.index, gap.index + gap[0].length);
			return toast("Sostituisci le parti tra parentesi quadre con i tuoi dati", true);
		}
		save.disabled = true;
		try {
			await api(`/api/instances/${inst.id}/settings`, { method: "PUT", body: { about: text } });
			toast("Istruzioni salvate");
			render();
		} catch (error) {
			save.disabled = false;
			toast(error.message, true);
		}
	});
	const fill = (text) => {
		instructions.value = text;
		instructions.focus();
		// The first part to replace is selected, so typing replaces it.
		const gap = PLACEHOLDER.exec(text);
		if (gap) instructions.setSelectionRange(gap.index, gap.index + gap[0].length);
	};
	const extra = {
		instructions: () => h("div.stack", h("div.hints", TEMPLATES.map(([label, text]) => h("button", { type: "button", onclick: () => fill(text) }, label))), instructions, h("div.row-gap", save)),
		tried: () =>
			h(
				"button.btn.small",
				{
					onclick: async () => {
						try {
							const { thread } = await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: {} });
							store(`annie.draft.${thread.id}`, "Cosa sai fare per me?");
							go("chat", thread.id);
						} catch (error) {
							toast(error.message, true);
						}
					},
				},
				"Prova: «Cosa sai fare per me?»",
			),
		app: () =>
			installOffer
				? h("button.btn.accent", { onclick: install }, icon("install"), "Installa")
				: h(
						"p.muted",
						appleTouch
							? "Su iPhone e iPad: apri questa pagina in Safari, tocca Condividi e poi «Aggiungi alla schermata Home». Nell'app entri di nuovo con il tuo link: incollalo nella schermata di accesso."
							: window.isSecureContext
								? "Dal menu del browser scegli «Installa app» o «Aggiungi a schermata Home». Alcuni browser, come Firefox sul computer, non lo permettono."
								: "Si installa solo dall'indirizzo https della console: chiedilo a chi gestisce Annie.",
					),
	};
	const done = steps.filter((s) => s.done).length;
	mount(
		main,
		head(
			agentLabel(inst),
			h("h1", "Primi passi"),
			`${done} di ${steps.length} fatti. Ogni passo rende ${inst.name} più utile; li puoi fare in qualsiasi ordine.`,
			h(
				"button.btn.small.ghost",
				{
					onclick: () => {
						setupHidden(inst.id, true);
						state.setupLeft = 0;
						toast("Li ritrovi in Impostazioni, in alto");
						go("chat");
					},
				},
				"Nascondi",
			),
		),
		h(
			"ol.steps",
			steps.map((step) =>
				h(
					`li.card.pad${step.done ? ".done" : ""}`,
					h("div.row-gap", step.done ? h("span.chip.ok", "fatto") : h("span.chip", "da fare"), h("b", step.title)),
					h("p.muted", step.text),
					!step.done && extra[step.id] ? extra[step.id]() : null,
					!step.done && step.go ? h("button.btn.small", { onclick: () => go(...step.go) }, "Vai") : null,
				),
			),
		),
	);
}

// ---------- task ----------
async function viewTasks(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ schedules }, { watches }, threads, briefState] = await Promise.all([
		api(`/api/instances/${inst.id}/schedules`),
		api(`/api/instances/${inst.id}/watches`),
		inst.canChat ? api(`/api/instances/${inst.id}/threads`).then((r) => r.threads) : Promise.resolve([]),
		api(`/api/instances/${inst.id}/brief`).catch(() => undefined),
	]);
	const table = h(
		"table.ledger",
		h("thead", h("tr", h("th", "Istruzione"), h("th", "Quando"), h("th", "Prossima"), h("th", ""))),
		h(
			"tbody",
			schedules.map((s) =>
				h(
					"tr",
					h("td", s.kind === "brief" ? "Brief del mattino" : s.instruction, h("div.mono.muted", `${s.id} · ${s.channel}${s.createdBy.kind === "instance" ? " · creato da Annie" : ""}`)),
					h("td.mono", "at" in s.when ? `una volta` : `${s.when.cron} (${s.when.timeZone})`),
					h("td.mono", s.nextRunAt ? fmt.time(s.nextRunAt) : "finito"),
					h(
						"td",
						h(
							"button.btn.small.danger",
							{
								onclick: async () => {
									await api(`/api/instances/${inst.id}/schedules/${s.id}`, { method: "DELETE" });
									toast("Task eliminato");
									render();
								},
							},
							"Elimina",
						),
					),
				),
			),
		),
	);
	let mode = "cron";
	const instruction = h("textarea", { rows: 2, placeholder: "Es. Riassumi le email di ieri e dimmi cosa richiede una risposta" });
	const at = h("input", { type: "datetime-local" });
	const cron = h("input", { type: "text", value: "0 9 * * 1-5", class: "mono" });
	const thread = h("select", threads.map((t) => h("option", { value: t.id }, t.title)));
	const whenBox = h("div");
	const presets = h(
		"div.hints",
		[
			["Giorni feriali 9:00", "0 9 * * 1-5"],
			["Ogni lunedì 8:30", "30 8 * * 1"],
			["Ogni giorno 18:00", "0 18 * * *"],
			["Primo del mese", "0 9 1 * *"],
		].map(([label, value]) => h("button", { type: "button", onclick: () => (cron.value = value) }, label)),
	);
	const drawWhen = () => mount(whenBox, mode === "cron" ? h("label.field", h("span", "Ripetizione (cron, fuso Europe/Rome)"), cron, presets, h("small", "minuto ora giorno mese giorno-settimana")) : h("label.field", h("span", "Data e ora"), at));
	const seg = h(
		"div.seg",
		[
			["cron", "Si ripete"],
			["once", "Una volta"],
		].map(([value, label]) =>
			h(
				"button",
				{
					type: "button",
					"aria-pressed": value === mode ? "true" : "false",
					onclick: (e) => {
						mode = value;
						for (const b of seg.children) b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false");
						drawWhen();
					},
				},
				label,
			),
		),
	);
	drawWhen();
	const create = async () => {
		try {
			const body = { instruction: instruction.value, threadId: thread.value, ...(mode === "cron" ? { cron: cron.value } : { at: at.value ? new Date(at.value).toISOString() : "" }) };
			await api(`/api/instances/${inst.id}/schedules`, { method: "POST", body });
			toast("Task programmato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	mount(main, 
		head(agentLabel(inst), h("h1", "Task e sentinelle"), `Istruzioni che ${inst.name} esegue da solo, una volta o a ripetizione, e pagine che controlla per te. Il risultato arriva nella chat scelta.`),
		inst.canChat && briefState ? briefCard(inst, briefState) : null,
		h(
			"div.grid-2",
			h("div.card", schedules.length ? table : h("div.empty", h("b", "Nessun task"), `Creane uno qui accanto, oppure chiedilo a ${inst.name} in chat.`)),
			h(
				"div.card.pad",
				h("h2", "Nuovo task"),
				threads.length
					? [h("label.field", h("span", "Cosa deve fare"), instruction), h("div.field", h("span", "Quando"), seg), whenBox, h("label.field", h("span", "Risultato nella chat"), thread), h("button.btn.accent", { onclick: create }, "Programma")]
					: h("p.muted", "Apri prima una conversazione in Chat: il risultato dei task arriva lì."),
			),
		),
		...watchSection(inst, watches, threads),
	);
}

/** Sentinelle: pages Annie checks by itself, writing to a chat when they change or a price crosses a threshold. */
function watchSection(inst, watches, threads) {
	const num = (n) => Number(n).toLocaleString("it-IT", { maximumFractionDigits: 2 });
	const condition = (w) => {
		const after = w.what ? ` dopo «${w.what}»` : "";
		if (w.below != null && w.above != null) return `Prezzo${after} sotto ${num(w.below)} o sopra ${num(w.above)}`;
		if (w.below != null) return `Prezzo${after} sotto ${num(w.below)}`;
		if (w.above != null) return `Prezzo${after} sopra ${num(w.above)}`;
		return w.what ? `Cambiamenti vicino a «${w.what}»` : "Qualsiasi cambiamento della pagina";
	};
	const status = (w) => {
		if (w.disabledReason) return h("span.chip.bad", "ferma");
		if (w.failures > 0) return h("span.chip.warn", `errore ${w.failures}×`);
		return h("span.chip.ok", "attiva");
	};
	const host = (url) => {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	};
	const act = (label, path, method, done, cls = "") =>
		h(
			`button.btn.small${cls}`,
			{
				onclick: async () => {
					try {
						await api(`/api/instances/${inst.id}/watches/${path}`, { method });
						toast(done);
						render();
					} catch (error) {
						toast(error.message, true);
					}
				},
			},
			label,
		);
	const table = h(
		"table.ledger",
		h("thead", h("tr", h("th", "Pagina"), h("th", "Avvisa per"), h("th", "Ultimo controllo"), h("th", ""))),
		h(
			"tbody",
			watches.map((w) =>
				h(
					"tr",
					h("td", h("a", { href: w.url, target: "_blank", rel: "noopener noreferrer" }, host(w.url)), h("div.mono.muted", `${w.id} · ogni ${w.everyMinutes} min${w.createdBy.kind === "instance" ? " · creata da Annie" : ""}`)),
					h(
						"td",
						condition(w),
						w.last?.side === "missing" ? h("div.muted", "prezzo non visibile ora") : w.last?.price != null ? h("div.mono.muted", `ora ${num(w.last.price)}`) : null,
					),
					h(
						"td",
						h("div.mono", w.lastCheckAt ? fmt.time(w.lastCheckAt) : "in arrivo"),
						status(w),
						w.disabledReason ? h("div.muted", `Ferma: ${w.disabledReason}`) : w.lastError ? h("div.muted", `Ultimo errore: ${w.lastError}`) : null,
					),
					h("td", h("div.row-gap", w.disabledReason || w.failures > 0 ? act("Riattiva", `${w.id}/resume`, "POST", "Sentinella riattivata") : null, act("Elimina", w.id, "DELETE", "Sentinella eliminata", ".danger"))),
				),
			),
		),
	);
	const url = h("input", { type: "url", placeholder: "https://negozio.it/prodotto" });
	const what = h("input", { type: "text", placeholder: "Es. Prezzo, Disponibilità, il nome del prodotto", maxlength: 200 });
	const below = h("input", { type: "text", inputmode: "decimal", placeholder: "Es. 49,90" });
	const above = h("input", { type: "text", inputmode: "decimal", placeholder: "Es. 120" });
	const every = h(
		"select",
		[
			[30, "Ogni 30 minuti"],
			[60, "Ogni ora"],
			[180, "Ogni 3 ore"],
			[720, "Ogni 12 ore"],
			[1440, "Ogni giorno"],
		].map(([value, label]) => h("option", { value, ...(value === 60 ? { selected: true } : {}) }, label)),
	);
	const thread = h("select", threads.map((t) => h("option", { value: t.id }, t.title)));
	const create = async () => {
		try {
			const { watch } = await api(`/api/instances/${inst.id}/watches`, { method: "POST", body: { url: url.value, what: what.value, below: below.value, above: above.value, everyMinutes: Number(every.value), threadId: thread.value } });
			const now = watch.last?.price != null ? ` Prezzo adesso: ${num(watch.last.price)}.` : "";
			toast(watch.below != null || watch.above != null ? `Sentinella attiva: ti scrivo quando il prezzo passa la soglia.${now}` : "Sentinella attiva: ti scrivo quando cambia.");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	return [
		h("h2.subhead", "Sentinelle"),
		h(
			"div.grid-2",
			h("div.card", watches.length ? table : h("div.empty", h("b", "Nessuna sentinella"), "Annie controlla una pagina da sola e ti scrive quando cambia o quando un prezzo scende. Creane una qui accanto, oppure chiedi in chat: «avvisami quando questo scende sotto 50 €».")),
			h(
				"div.card.pad",
				h("h2", "Nuova sentinella"),
				threads.length
					? [
							h("label.field", h("span", "Pagina da controllare"), url),
							h("label.field", h("span", "Cosa guardare"), what, h("small", "La frase subito prima di quello che ti interessa. Senza frase Annie guarda tutta la pagina.")),
							h("div.grid-2", h("label.field", h("span", "Avvisami se il prezzo è sotto"), below), h("label.field", h("span", "o sopra"), above)),
							h("label.field", h("span", "Quanto spesso"), every),
							h("label.field", h("span", "Avvisi nella chat"), thread),
							h("button.btn.accent", { onclick: create }, "Attiva"),
						]
					: h("p.muted", "Apri prima una conversazione in Chat: gli avvisi arrivano lì."),
			),
		),
	];
}

/** The person's brief del mattino: on, off, and at what time. */
function briefCard(inst, { brief, google }) {
	const time = h("input", { type: "time", value: brief?.time ?? "07:30", class: "mono" });
	const weekdays = h("input", { type: "checkbox", checked: brief ? brief.weekdaysOnly !== false : true });
	const save = async () => {
		try {
			await api(`/api/instances/${inst.id}/brief`, { method: "PUT", body: { time: time.value, weekdaysOnly: weekdays.checked } });
			toast(brief ? "Brief aggiornato" : `Brief attivo: ogni mattina alle ${time.value}`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const off = async () => {
		await api(`/api/instances/${inst.id}/brief`, { method: "DELETE" }).catch((e) => toast(e.message, true));
		toast("Brief disattivato");
		render();
	};
	const hint = !google.available
		? "Google non è configurato su questo server: il brief userà solo quello che Annie ricorda di te."
		: !google.connected
			? "Collega Google dal menu del tuo account per avere calendario e mail nel brief."
			: !google.allowed
				? "Hai collegato Google, ma questo agente non lo può usare: l'owner lo attiva in Impostazioni."
				: "Calendario di oggi, mail non lette che chiedono una risposta, e quello che Annie ricorda di te. Solo lettura.";
	return h(
		"div.card.pad.brief",
		h("div.row-gap", h("h2", "Brief del mattino"), brief ? h("span.chip.ok", "Attivo") : null),
		h("p.muted", hint),
		h(
			"div.row-gap",
			h("label.field.inline", h("span", "Ora"), time),
			h("label.row-gap", weekdays, h("span", "Solo giorni feriali")),
			h("button.btn.accent", { onclick: save }, brief ? "Aggiorna" : "Attiva"),
			brief ? h("button.btn.ghost", { onclick: () => go("chat", brief.threadId) }, "Apri la chat del brief") : null,
			brief ? h("button.btn.danger", { onclick: off }, "Disattiva") : null,
		),
	);
}

// ---------- file ----------
async function viewFiles(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { files } = await api(`/api/instances/${inst.id}/files`);
	const upload = h("input", { type: "file", class: "sr" });
	upload.addEventListener("change", async () => {
		const f = upload.files?.[0];
		if (!f) return;
		try {
			await api(`/api/instances/${inst.id}/files/raw?name=${encodeURIComponent(f.name)}`, { method: "PUT", raw: f });
			toast(`Caricato ${f.name}`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	});
	const total = files.reduce((n, f) => n + f.size, 0);
	mount(main, 
		head(agentLabel(inst), h("h1", "File"), `Il workspace di ${inst.name}: i file che crea e quelli che riceve (legge anche PDF, Word, Excel e PowerPoint). ${files.length} file, ${fmt.bytes(total)}.`, h("label.btn.accent", "Carica un file", upload)),
		h(
			"div.card",
			files.length
				? h(
						"table.ledger",
						h("thead", h("tr", h("th", "File"), h("th", "Dimensione"), h("th", "Modificato"), h("th", ""))),
						h(
							"tbody",
							files.map((f) =>
								h(
									"tr",
									h("td", h("a.mono", { href: `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(f.path)}` }, f.path)),
									h("td.num", fmt.bytes(f.size)),
									h("td.mono", fmt.time(f.modifiedAt)),
									h(
										"td",
										state.me.role === "owner"
											? h(
													"button.btn.small.danger",
													{
														onclick: () =>
															confirmDialog(`Eliminare ${f.path}?`, "Il file sparisce dal workspace di Annie.", "Elimina", async () => {
																await api(`/api/instances/${inst.id}/files?path=${encodeURIComponent(f.path)}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
																render();
															}),
													},
													"Elimina",
												)
											: null,
									),
								),
							),
						),
					)
				: h("div.empty", h("b", "Nessun file"), "Caricane uno, o chiedi ad Annie di preparare un report."),
		),
	);
}

// ---------- memoria ----------
async function viewMemory(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { mine, shared, canEditShared } = await api(`/api/instances/${inst.id}/memory`);
	const forget = (m) =>
		confirmDialog("Dimenticare questa memoria?", m.text, "Dimentica", async () => {
			await api(`/api/instances/${inst.id}/memory/${m.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			render();
		});
	const rows = (memories, editable) =>
		memories.map((m) =>
			h(
				"tr",
				h("td", m.text, h("div.mono.muted", `${m.source === "annie" ? `ricordata da ${inst.name}` : "aggiunta a mano"} · ${fmt.time(m.createdAt)}`)),
				h("td", editable ? h("button.btn.small.danger", { onclick: () => forget(m) }, "Dimentica") : null),
			),
		);
	/** The essential memories, sent with every message; the archivio (ADR 0062) folded, with a filter, since it holds up to 1000. */
	const list = (memories, editable, empty) => {
		const essential = memories.filter((m) => !m.archived);
		const archived = memories.filter((m) => m.archived).reverse();
		const archive = () => {
			const body = h("tbody", rows(archived, editable));
			const filter = h("input", { type: "search", placeholder: "Cerca nell'archivio" });
			filter.addEventListener("input", () => {
				const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
				mount(body, rows(archived.filter((m) => words.every((w) => m.text.toLowerCase().includes(w))), editable));
			});
			return h("details.pad", h("summary", `In archivio · ${archived.length}`), h("p.muted", `${inst.name} non le riceve con ogni messaggio: le cerca quando servono.`), archived.length > 8 ? filter : null, h("table.ledger", body));
		};
		return [
			essential.length ? h("table.ledger", h("tbody", rows(essential, editable))) : h("div.empty", h("b", "Niente"), empty),
			archived.length ? archive() : null,
		];
	};
	const add = (isShared) => {
		const text = h("textarea", { rows: 2, maxlength: 500, placeholder: isShared ? "Es. L'ufficio è chiuso dal 10 al 25 agosto" : "Es. Preferisco risposte brevi, in punti" });
		const archived = h("input", { type: "checkbox" });
		const save = async () => {
			try {
				await api(`/api/instances/${inst.id}/memory`, { method: "POST", body: { text: text.value, shared: isShared, archived: archived.checked } });
				toast(archived.checked ? `In archivio: ${inst.name} lo cerca quando serve` : `${inst.name} se lo ricorderà`);
				render();
			} catch (error) {
				toast(error.message, true);
			}
		};
		return h(
			"div.pad",
			h("label.field", h("span", isShared ? "Aggiungi una cosa che vale per tutti" : "Aggiungi una cosa su di te"), text),
			h("label.row-gap", archived, h("span", "In archivio: un dettaglio che serve ogni tanto, non in ogni conversazione")),
			h("div.actions", h("button.btn", { onclick: save }, "Ricorda")),
		);
	};
	mount(main, 
		head(agentLabel(inst), h("h1", "Memoria"), `Quello che ${inst.name} ricorda di te tra una conversazione e l'altra, e le cose che valgono per tutti. Lo vede solo chi ne è il soggetto; quelle condivise le vede chiunque scriva a ${inst.name}.`),
		h(
			"div.grid-2",
			h("div.card", h("div.pad", h("h2", "Su di te")), list(mine, true, `${inst.name} non ricorda ancora niente di te. Puoi scrivere «ricordati che…» in chat, o aggiungerlo qui.`), add(false)),
			h("div.card", h("div.pad", h("h2", "Condivise")), list(shared, canEditShared, "Nessuna memoria condivisa."), canEditShared ? add(true) : h("p.muted.pad", "Solo l'owner aggiunge o toglie memorie condivise.")),
		),
	);
}

// ---------- stanze (ADR 0063) ----------
async function viewRooms(main) {
	const roomId = route().rest[0];
	if (roomId) return viewRoom(main, roomId);
	const { rooms } = await api("/api/rooms");
	const chatty = state.instances.filter((i) => i.canChat);
	const form = h("div.card.pad.stack", { hidden: true });
	const create = () => {
		const title = h("input", { type: "text", maxlength: 80, placeholder: "Es. Bando regionale" });
		const boxes = chatty.map((i) => ({ id: i.id, box: h("input", { type: "checkbox" }), label: `${i.emoji ? `${i.emoji} ` : ""}${i.name}` }));
		const save = async () => {
			const agents = boxes.filter((b) => b.box.checked).map((b) => b.id);
			if (agents.length < 2) return toast("Scegli almeno due agenti", true);
			try {
				const { room } = await api("/api/rooms", { method: "POST", body: { title: title.value, agents } });
				go("stanze", room.id);
			} catch (error) {
				toast(error.message, true);
			}
		};
		mount(
			form,
			h("h2", "Nuova stanza"),
			h("label.field", h("span", "Nome"), title, h("small", "Se lo lasci vuoto, la stanza prende i nomi degli agenti.")),
			h("div.field", h("span", "Agenti (da 2 a 5)"), boxes.map((b) => h("label.row-gap", b.box, h("span", b.label)))),
			h("div.actions", h("button.btn.accent", { onclick: save }, "Crea"), h("button.btn.ghost", { onclick: () => (form.hidden = true) }, "Annulla")),
		);
		form.hidden = false;
		title.focus();
	};
	const names = (r) => r.agents.map((a) => `${a.emoji ? `${a.emoji} ` : ""}${a.name}`).join(", ");
	mount(
		main,
		head("Lavoro", h("h1", "Stanze"), "Una conversazione con più agenti insieme. Scrivi @nome per chiamarne uno, @tutti per tutti; senza nome risponde l'ultimo che ha parlato. Un agente può chiamare in causa un altro. Le stanze sono solo tue.", chatty.length > 1 ? h("button.btn.accent", { onclick: create }, icon("plus"), "Nuova stanza") : null),
		h(
			"div.stack",
			form,
			h(
				"div.card",
				rooms.length
					? h("table.ledger", h("tbody", rooms.map((r) => h("tr", h("td", h("a", { href: `#/stanze/${encodeURIComponent(r.id)}` }, h("b", r.title)), h("div.muted", names(r)), r.last ? h("div.room-last", h("b", `${r.last.who}: `), r.last.text) : null), h("td.mono.muted", fmt.time(r.updatedAt))))))
					: h("div.empty", h("b", "Nessuna stanza"), "Per esempio il ricercatore trova un bando, l'agente delle vendite prepara l'offerta e il contabile fa i conti, tutti nella stessa conversazione."),
			),
		),
	);
}

async function viewRoom(main, roomId) {
	const { room, entries } = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
	const agentOf = (id) => room.agents.find((a) => a.instanceId === id);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	const fileLink = (instanceId, file) => h("a.file", { href: `/api/instances/${encodeURIComponent(instanceId)}/files/raw?path=${encodeURIComponent(file.path)}` }, h("span.ext", (file.path.split(".").pop() ?? "file").slice(0, 4)), h("span", h("b", file.path.split("/").pop()), file.caption ? h("div.muted", file.caption) : null));
	const typing = thinking(room.agents.filter((a) => a.present));
	const show = (entry) => {
		if (entry.from === "note") return transcript.append(h("div.room-note", entry.text));
		if (entry.from === "person") return transcript.append(h("div.msg.person", h("div.meta", fmt.time(entry.at)), h("div.body", entry.text)));
		const agent = agentOf(entry.instanceId);
		const by = entry.model ? h("span.by", { title: `${entry.model.provider} · ${entry.model.modelId}` }, entry.model.name ?? entry.model.modelId) : null;
		transcript.append(h("div.msg.annie", h("div.meta", face(agent ?? { id: entry.instanceId }, 20), h("b.who", `${agent?.emoji ? `${agent.emoji} ` : ""}${agent?.name ?? entry.instanceId}`), h("span", fmt.time(entry.at)), by), entry.file ? fileLink(entry.instanceId, entry.file) : h("div.body", entry.text ?? "")));
	};
	for (const e of entries) show(e);
	state.onRoom = (event) => {
		if (event.roomId !== roomId) return false;
		if (event.entry.from === "person") return true;
		// An answer ends the wait; one that calls another agente starts the next on the server.
		typing.remove();
		show(event.entry);
		transcript.scrollTop = transcript.scrollHeight;
		return true;
	};
	const present = room.agents.filter((a) => a.present);
	// What was being written stays, like in a chat, until it is sent.
	const draftKey = `annie.draft.room.${roomId}`;
	const input = h("textarea", { rows: 1, placeholder: `Scrivi alla stanza, @${present[0]?.handle ?? "nome"} per chiamare un agente…`, "aria-label": "Messaggio", value: store(draftKey) ?? "" });
	const send = h("button.send", { "aria-label": "Invia", disabled: true }, icon("send"));
	const fit = () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
		send.disabled = !input.value.trim();
		store(draftKey, input.value.trim() ? input.value : null);
	};
	const submit = async () => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		fit();
		show({ from: "person", text, at: new Date().toISOString() });
		transcript.scrollTop = transcript.scrollHeight;
		try {
			await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", body: { text } });
			// The dots stay until an agente answers.
			transcript.append(typing);
			transcript.scrollTop = transcript.scrollHeight;
		} catch (error) {
			input.value = text;
			fit();
			toast(error.message, true);
		}
	};
	input.addEventListener("input", fit);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void submit();
		}
	});
	send.addEventListener("click", () => void submit());
	// One tap to call an agente: its @name at the start of the message.
	const call = (a) => {
		const handle = `@${a.handle} `;
		if (!input.value.includes(handle.trim())) input.value = `${handle}${input.value}`;
		input.focus();
		fit();
	};
	const chips = h("div.room-agents", room.agents.map((a) => h(`button.chip${a.present ? "" : ".gone"}`, { onclick: () => call(a), disabled: !a.present, title: a.present ? `Chiama ${a.name}` : `${a.name} non è più disponibile` }, face(a, 18), `${a.emoji ? `${a.emoji} ` : ""}${a.name}`)), h("button.chip", { onclick: () => ((input.value = `@tutti ${input.value}`), input.focus(), fit()) }, "@tutti"));
	const remove = () =>
		confirmDialog(`Cancellare la stanza «${room.title}»?`, "La conversazione sparisce per te. Gli agenti non ne terranno traccia nelle loro chat.", "Cancella", async () => {
			try {
				await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
				go("stanze");
			} catch (error) {
				toast(error.message, true);
			}
		});
	const header = h("div.room-head", h("a.icon-btn", { href: "#/stanze", "aria-label": "Tutte le stanze" }, icon("back")), h("b", room.title), h("button.btn.small.ghost", { onclick: remove }, "Cancella"));
	if (entries.length === 0) transcript.append(h("div.room-note", `Nella stanza: ${room.agents.map((a) => a.name).join(", ")}. Scrivi @nome per chiamarne uno, @tutti per tutti.`));
	// Each agente's skills, with its @name: picked from here, a skill reaches the agente that has it.
	const commands = commandMenu(
		input,
		async () => {
			const lists = await Promise.all(present.map((a) => agentCommands(a.instanceId, `@${a.handle} `).then((list) => list.map((c) => ({ ...c, note: `${a.name} · ${c.note}` })))));
			return lists.flat();
		},
		fit,
	);
	mount(main, h("section.conversation", header, transcript, h("div.dock", chips, h("div.box", commands, h("div.composer", input, send)))));
	fit();
	transcript.scrollTop = transcript.scrollHeight;
	input.focus();
}

// ---------- automazioni (ADR 0060) ----------
const CHANNEL_NAME = { web: "console", telegram: "Telegram", whatsapp: "WhatsApp" };

async function viewAutomations(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const listBox = h("div.card");
	const panel = h("div.card.pad.stack", { hidden: true });
	const remove = (a) =>
		confirmDialog(`Cancellare «${a.name}»?`, "L'indirizzo smette di funzionare: il servizio che lo chiama riceverà un errore.", "Cancella", async () => {
			await api(`/api/instances/${inst.id}/automations/${a.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			refresh();
		});
	const where = (a) => {
		if (a.channel !== "web") return `risponde su ${CHANNEL_NAME[a.channel] ?? a.channel}`;
		const t = state.threads.find((x) => x.id === a.threadId);
		return t ? h("a", { href: `#/chat/${encodeURIComponent(t.id)}` }, `risponde in «${t.title}»`) : "risponde nella sua chat";
	};
	const runs = (a) => (a.runs ? `${a.runs === 1 ? "1 chiamata" : `${a.runs} chiamate`}, l'ultima ${fmt.time(a.lastRunAt)}` : "mai chiamata");
	async function refresh() {
		const { automations } = await api(`/api/instances/${inst.id}/automations`);
		mount(
			listBox,
			automations.length
				? h(
						"table.ledger",
						h(
							"tbody",
							automations.map((a) =>
								h(
									"tr",
									h("td", h("b", a.name), h("div", a.instruction), h("div.mono.muted", [where(a), runs(a), a.mine ? null : a.person ? `di ${CHANNEL_NAME[a.person.channel] ?? a.person.channel} ${a.person.userId}` : null].filter(Boolean).flatMap((x, i) => (i ? [" · ", x] : [x])))),
									h("td", a.canEdit ? h("button.btn.small.danger", { onclick: () => remove(a) }, "Cancella") : null),
								),
							),
						),
					)
				: h("div.empty", h("b", "Nessuna automazione"), `Un'automazione è un indirizzo segreto: quando un modulo, un negozio online o Stripe lo chiama, ${inst.name} lavora con i dati ricevuti e ti scrive.`),
		);
	}
	/** The address and the token, once: only a hash of the token is kept. */
	const showOnce = (a, token) => {
		const url = `${location.origin}${a.path}`;
		mount(
			panel,
			h("h2", `«${a.name}» è pronta`),
			h("p", h("b", "Copia ora il token: non si vedrà più."), " Chi lo ha fa lavorare ", inst.name, " per te, con i tuoi strumenti. Per cambiarlo cancella l'automazione e creane un'altra."),
			h("label.field", h("span", "Indirizzo (POST)"), copyBox(url, "Indirizzo")),
			h("label.field", h("span", "Token"), copyBox(token, "Token"), h("small", "Nell'intestazione Authorization: Bearer, o X-Annie-Token. Se il servizio non permette intestazioni, in fondo all'indirizzo: ?token=…")),
			h("details", h("summary", "Prova dal terminale"), copyBox(`curl -X POST ${url} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"prova": true}'`, "Comando")),
			h("div.actions", h("button.btn", { onclick: () => (panel.hidden = true) }, "Fatto, l'ho copiato")),
		);
	};
	const create = () => {
		if (!inst.canChat) return toast(`Per creare un'automazione devi poter scrivere a ${inst.name}`, true);
		const name = h("input", { type: "text", maxlength: 80, placeholder: "Es. Ordini dal sito" });
		const instruction = h("textarea", { rows: 3, maxlength: 2000, placeholder: "Es. Riassumi l'ordine e dimmi se c'è da spedire oggi" });
		const chat = h("select", h("option", { value: "" }, "Una chat nuova, con il nome dell'automazione"), state.threads.map((t) => h("option", { value: t.id }, t.title)));
		const save = async () => {
			if (!name.value.trim() || !instruction.value.trim()) return toast("Servono un nome e cosa deve fare", true);
			try {
				const threadId = chat.value || (await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: { title: `Automazione: ${name.value.trim()}` } })).thread.id;
				const { automation, token } = await api(`/api/instances/${inst.id}/automations`, { method: "POST", body: { name: name.value, instruction: instruction.value, threadId } });
				showOnce(automation, token);
				await refreshThreads();
				refresh();
			} catch (error) {
				toast(error.message, true);
			}
		};
		mount(
			panel,
			h("h2", "Nuova automazione"),
			h("label.field", h("span", "Nome"), name),
			h("label.field", h("span", "Cosa deve fare"), instruction, h("small", `${inst.name} riceve questa istruzione con i dati della chiamata (un modulo, un ordine, un pagamento), trattati come dati e non come ordini.`)),
			h("label.field", h("span", "Dove ti risponde"), chat),
			h("div.actions", h("button.btn.accent", { onclick: save }, "Crea"), h("button.btn.ghost", { onclick: () => (panel.hidden = true) }, "Annulla")),
		);
		panel.hidden = false;
		name.focus();
	};
	await refresh();
	mount(
		main,
		head(agentLabel(inst), h("h1", "Automazioni"), `Indirizzi segreti che fanno lavorare ${inst.name} quando un altro servizio li chiama: un modulo compilato, un ordine dal sito, un pagamento su Stripe, uno Zap. Al più 30 chiamate l'ora per automazione. Ognuno vede le sue, l'owner tutte.`, h("button.btn.accent", { onclick: create }, icon("plus"), "Nuova automazione")),
		h("div.stack", panel, listBox),
	);
}

// ---------- skill (ADR 0059) ----------
/** «Chiusura del mese» → «chiusura-del-mese», as the server names it; only a preview of the command. */
const skillSlug = (name) =>
	name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

async function viewSkills(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { skills, drafts } = await api(`/api/instances/${inst.id}/skills`);
	const editor = h("div.card.pad.stack", { hidden: true });
	const save = async (body, done) => {
		try {
			const { skill, replaced } = await api(`/api/instances/${inst.id}/skills`, { method: "PUT", body });
			toast(replaced ? `Skill /${skill.name} aggiornata` : `Skill /${skill.name} salvata`);
			done?.();
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	/** The form for a new skill or one to change; a SKILL.md pasted or uploaded fills it. */
	const edit = (skill) => {
		const name = h("input", { type: "text", maxlength: 32, value: skill?.name ?? "", placeholder: "Es. Chiusura del mese", readonly: Boolean(skill) });
		const command = h("small");
		const showCommand = () => (command.textContent = name.value.trim() ? `Si lancia con /${skillSlug(name.value)}` : "Il nome diventa il comando, da console, Telegram e WhatsApp.");
		name.addEventListener("input", showCommand);
		showCommand();
		const description = h("textarea", { rows: 2, maxlength: 1024, placeholder: "Quando usarla, in una riga. Es. Quando chiedo di chiudere il mese" }, skill?.description ?? "");
		const body = h("textarea", { rows: 10, maxlength: 20000, placeholder: "I passi, in Markdown.\n1. Guarda le fatture scadute\n2. Poi le spese del mese\n3. Scrivimi il riepilogo" }, skill?.body ?? "");
		const pasted = h("textarea", { rows: 6, placeholder: "---\nname: chiusura-del-mese\ndescription: Quando chiedo di chiudere il mese\n---\n\n1. …" });
		const file = h("input", { type: "file", accept: ".md,text/markdown,text/plain", hidden: true });
		file.addEventListener("change", async () => {
			const f = file.files?.[0];
			if (f) pasted.value = await f.text();
		});
		const close = () => (editor.hidden = true);
		mount(
			editor,
			h("h2", skill ? `Modifica /${skill.name}` : "Nuova skill"),
			h("label.field", h("span", "Nome"), name, command),
			h("label.field", h("span", "Quando usarla"), description, h("small", `${inst.name} vede questa riga in ogni conversazione e apre i passi quando un compito corrisponde.`)),
			h("label.field", h("span", "Passi"), body),
			h("div.actions", h("button.btn.accent", { onclick: () => save({ name: skill?.name ?? name.value, description: description.value, body: body.value }, close) }, "Salva"), h("button.btn.ghost", { onclick: close }, "Annulla")),
			skill
				? null
				: h(
						"details",
						h("summary", "Oppure importa un SKILL.md"),
						h("label.field", h("span", "Incolla il file, o caricalo"), pasted),
						h("div.actions", h("button.btn", { onclick: () => (pasted.value.trim() ? save({ skillMd: pasted.value }, close) : toast("Incolla prima un SKILL.md", true)) }, "Importa"), h("label.btn.ghost", "Carica un file", file)),
					),
		);
		editor.hidden = false;
		editor.scrollIntoView({ behavior: "smooth", block: "start" });
		(skill ? description : name).focus();
	};
	const exportMd = (s) => {
		const link = h("a", { href: URL.createObjectURL(new Blob([s.skillMd], { type: "text/markdown" })), download: "SKILL.md" });
		link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	};
	const remove = (s, draft) =>
		confirmDialog(draft ? `Scartare la bozza «${s.name}»?` : `Cancellare /${s.name}?`, draft ? "La bozza sparisce: non era ancora attiva." : `${inst.name} non la userà più, e il comando smette di funzionare.`, draft ? "Scarta" : "Cancella", async () => {
			await api(`/api/instances/${inst.id}/skills/${encodeURIComponent(s.name)}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			render();
		});
	const by = (s) => (s.mine ? "tua" : s.createdBy ? `di ${s.createdBy.replace(/^web:/, "console ")}` : null);
	const row = (s, draft) =>
		h(
			"tr",
			h("td", h("b.mono", `/${s.name}`), h("div", s.description), h("div.mono.muted", [by(s), `aggiornata ${fmt.time(s.updatedAt)}`].filter(Boolean).join(" · "))),
			h(
				"td",
				h(
					"div.row-gap",
					draft ? h("button.btn.small.accent", { onclick: () => save({ name: s.name, description: s.description, body: s.body }) }, "Attiva") : null,
					s.canEdit && !draft ? h("button.btn.small.ghost", { onclick: () => edit(s) }, "Modifica") : null,
					draft ? null : h("button.btn.small.ghost", { onclick: () => exportMd(s) }, "SKILL.md"),
					s.canEdit ? h("button.btn.small.danger", { onclick: () => remove(s, draft) }, draft ? "Scarta" : "Cancella") : null,
				),
			),
		);
	mount(
		main,
		head(agentLabel(inst), h("h1", "Skill"), `Procedure con un nome che ${inst.name} apre quando servono. Il nome è il comando: /chiusura-del-mese ottobre la lancia da qui, da Telegram e da WhatsApp. Le vede chi scrive a ${inst.name}; ognuno cambia le sue, l'owner tutte.`, h("button.btn.accent", { onclick: () => edit() }, icon("plus"), "Nuova skill")),
		h(
			"div.stack",
			editor,
			drafts.length
				? h("div.card", h("div.pad", h("h2", "Le tue bozze"), h("p.muted", `Le ha scritte ${inst.name} in chat. Non sono attive finché non le attivi tu, qui o scrivendo /attiva-skill.`)), h("table.ledger", h("tbody", drafts.map((d) => row(d, true)))))
				: null,
			h(
				"div.card",
				skills.length
					? h("table.ledger", h("tbody", skills.map((s) => row(s, false))))
					: h("div.empty", h("b", "Nessuna skill"), `Spiega a ${inst.name} come fai una cosa e chiedile di salvarla come skill, oppure creala qui.`),
			),
		),
	);
}

// ---------- connettori ----------
/** Back from a service's sign-in (ADR 0024): like Google's, the code is in the fragment. */
async function finishConnector() {
	const params = new URLSearchParams(location.hash.slice("#/connettore?".length));
	history.replaceState(null, "", "/#/connettori");
	const error = params.get("error");
	try {
		const done = await api("/api/connectors/oauth/finish", { method: "POST", body: { state: params.get("state") ?? "", ...(error ? { error } : { code: params.get("code") ?? "" }) } });
		// The connector's own instance, whatever was selected when the sign-in started.
		const inst = state.instances.find((i) => i.id === done.instanceId);
		if (inst) {
			state.instance = inst;
			store("annie.instance", inst.id);
		}
		if (done.cancelled) return toast(error === "access_denied" ? "Accesso annullato: il connettore resta da collegare" : "Il servizio non ha completato l'accesso: riprova con «Collega»", true);
		const st = done.status;
		toast(st?.connected ? `Collegato: Annie ha ${st.tools.length} nuovi strumenti` : `Accesso riuscito, ma il servizio non risponde${st?.error ? `: ${st.error}` : ""}`, !st?.connected);
	} catch (e) {
		toast(e.message, true);
	}
}

/** Opens the service's sign-in page, or says the connector works already. */
async function signInConnector(path, name) {
	const result = await api(path, { method: "POST", body: {} });
	if (result.url) {
		// Only a web page: a service never sends the console to another kind of address.
		if (!/^https?:\/\//.test(result.url)) throw new Error(`${name}: pagina di accesso non valida`);
		return location.assign(result.url);
	}
	toast(result.status?.connected ? `${name} collegato: ${result.status.tools.length} strumenti` : `${name} aggiunto${result.status?.error ? `, ma non collegato: ${result.status.error}` : ""}`, !result.status?.connected);
	render();
}

const AUTH_LABEL = { oauth: "Accedi con il tuo account", token: "Serve un token", none: "Pubblico, senza account" };
const CATALOG_GROUPS = [
	["lavoro", "Lavoro"],
	["pagamenti", "Pagamenti"],
	["conoscenza", "Documentazione"],
	["sviluppo", "Per sviluppatori"],
];

/** Whether the services can send the owner back here: https, or this computer. */
function returnWorks(redirectUrl) {
	if (!redirectUrl) return false;
	const u = new URL(redirectUrl);
	return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** The well-known servers not added yet, each one click away, by group. */
function catalogGallery(inst, catalog, oauth, redirectUrl, added) {
	const left = catalog.filter((e) => !added.has(e.id) && (e.auth !== "oauth" || oauth));
	if (left.length === 0) return null;
	const add = async (e, button) => {
		if (e.auth === "token") return tokenDialog(inst, e, false);
		button.disabled = true;
		try {
			await signInConnector(`/api/instances/${inst.id}/connectors/catalog/${e.id}`, e.name);
		} catch (error) {
			toast(error.message, true);
			button.disabled = false;
		}
	};
	const card = (e) => {
		const button = h("button.btn.small.accent", { onclick: () => void add(e, button) }, e.auth === "oauth" ? "Accedi e aggiungi" : "Aggiungi");
		return h("div.card.pad", h("h2", e.name), h("span.chip", AUTH_LABEL[e.auth]), h("p.muted", e.description), h("div.go", button));
	};
	return h(
		"section.catalog",
		h("h2", "Aggiungi in un clic"),
		h("p.muted", "Servizi noti con un collegamento ufficiale per gli assistenti. Premi «Accedi e aggiungi»: entri con il tuo account sulla pagina del servizio e torni qui. L'accesso resta sul server di Annie, mai nel browser."),
		oauth && !returnWorks(redirectUrl) ? h("p.chip.warn", "Questo server non ha un indirizzo https (ANNIE_PUBLIC_URL): molti servizi rifiutano di rimandarti qui dopo l'accesso.") : null,
		CATALOG_GROUPS.map(([group, label]) => {
			const items = left.filter((e) => e.category === group);
			return items.length ? h("div.stack", h("div.kicker", label), h("div.gallery", items.map(card))) : null;
		}),
	);
}

/** A token for a one-click connector: to add it, or to change the one it has. */
function tokenDialog(inst, e, replace) {
	const token = h("input", { type: "password", placeholder: "Incolla qui il token", autocomplete: "off" });
	const save = async () => {
		try {
			const { status } = await api(`/api/instances/${inst.id}/connectors/catalog/${e.id}`, { method: "POST", body: { token: token.value, ...(replace ? { replace: true } : {}) } });
			dialog.close();
			toast(status?.connected ? `${e.name} collegato: ${status.tools.length} strumenti` : `${e.name} salvato, ma non collegato${status?.error ? `: ${status.error}` : ""}`, !status?.connected);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	token.addEventListener("keydown", (ev) => ev.key === "Enter" && void save());
	const dialog = h(
		"dialog",
		h("h2", replace ? `Nuovo token per ${e.name}` : `Collega ${e.name}`),
		h("p.muted", e.tokenHelp ?? ""),
		h("label.field", h("span", "Token"), token, h("small", "Resta sul server di Annie e non si vede più. Si usa solo per questo agente.")),
		h("div.actions", h("button.btn.accent", { onclick: () => void save() }, "Salva e collega"), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	token.focus();
}

async function viewConnectors(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ connectors }, { catalog, oauth, redirectUrl }] = await Promise.all([api(`/api/instances/${inst.id}/connectors`), api("/api/connector-catalog")]);
	const cards = connectors.map((c) => {
		const st = c.status;
		const oauthConnector = c.transport.type === "http" && c.transport.auth === "oauth";
		const tokenEntry = catalog.find((e) => e.id === c.id && e.auth === "token" && c.transport.type === "http" && Object.keys(c.transport.headerSecrets ?? {}).length > 0);
		const chip = !c.enabled
			? h("span.chip", "Spento")
			: !c.allowed
				? h("span.chip.warn", "Non consentito")
				: st?.connected
					? h("span.chip.ok", `${st.tools.length} strumenti`)
					: st?.signIn
						? h("span.chip.warn", "Da collegare")
						: h("span.chip.bad", "Non collegato");
		return h(
			"div.card.pad.stack",
			h("div.row-gap", h("h2", c.name), chip),
			h("div.mono.muted", c.transport.type === "http" ? c.transport.url : `${c.transport.command} ${(c.transport.args ?? []).join(" ")}`),
			st?.error ? h("p.chip.bad", st.error) : null,
			st?.tools?.length ? h("p.mono", st.tools.join("  ")) : null,
			!st?.connected
				? null
				: c.approval === "none"
					? h("p.muted", "Approvazione spenta: Annie usa tutti gli strumenti senza chiedere.")
					: !st.approval?.length
						? h("p.muted", "Tutti gli strumenti leggono soltanto: Annie li usa senza chiedere.")
						: st.approval.length === st.tools.length
							? h("p.muted", "Tutti gli strumenti chiedono l'approvazione prima di agire.")
							: h("p.muted", `Chiedono l'approvazione prima di agire: ${st.approval.map((t) => t.replace(`${c.id}__`, "")).join(", ")}.`),
			st?.left ? h("p.muted", `Il servizio ha altri ${st.left} strumenti: Annie usa i primi ${st.tools.length}, per non confondere il modello.`) : null,
			h(
				"div.row-gap",
				oauthConnector && oauth && !st?.connected && c.enabled && c.allowed
					? h("button.btn.small.accent", { onclick: () => void signInConnector(`/api/instances/${inst.id}/connectors/${c.id}/sign-in`, c.name).catch((error) => toast(error.message, true)) }, "Collega")
					: null,
				tokenEntry ? h(`button.btn.small${st?.badToken ? ".accent" : ".ghost"}`, { onclick: () => tokenDialog(inst, tokenEntry, true) }, "Cambia token") : null,
				h("button.btn.small.ghost", { onclick: () => connectorForm(inst, c) }, "Modifica"),
				h(
					"button.btn.small.danger",
					{
						onclick: () =>
							confirmDialog(
								`Rimuovere ${c.name}?`,
								oauthConnector ? "Annie perde i suoi strumenti e il suo accesso al servizio viene cancellato." : tokenEntry ? "Annie perde i suoi strumenti e il token viene cancellato." : "Annie perde i suoi strumenti. I valori segreti restano salvati sul server.",
								"Rimuovi",
								async () => {
									await api(`/api/instances/${inst.id}/connectors/${c.id}`, { method: "DELETE" });
									render();
								},
							),
					},
					"Rimuovi",
				),
			),
		);
	});
	mount(main, 
		head(agentLabel(inst), h("h1", "Connettori"), `Collegano ${inst.name} agli strumenti che usate già. Ognuno raggiunge solo il suo servizio, e solo se consentito.`, h("button.btn.accent", { onclick: () => connectorForm(inst) }, "+ Connettore")),
		connectors.length ? h("div.grid-2", cards) : h("div.card.empty", h("b", "Nessun connettore"), "Scegline uno qui sotto, oppure aggiungi un altro server MCP (HTTP o locale) con il pulsante + Connettore."),
		catalogGallery(inst, catalog, oauth, redirectUrl, new Set(connectors.map((c) => c.id))),
	);
}

function connectorForm(inst, existing) {
	const t = existing?.transport;
	const id = h("input", { type: "text", value: existing?.id ?? "", placeholder: "crm", class: "mono", disabled: existing ? true : undefined });
	const name = h("input", { type: "text", value: existing?.name ?? "", placeholder: "CRM aziendale" });
	const type = h("select", h("option", { value: "http" }, "HTTP (Streamable HTTP)"), h("option", { value: "stdio", selected: t?.type === "stdio" ? "selected" : undefined }, "Locale (stdio)"));
	const url = h("input", { type: "url", value: t?.type === "http" ? t.url : "", placeholder: "https://mcp.example.com/mcp" });
	const command = h("input", { type: "text", value: t?.type === "stdio" ? [t.command, ...(t.args ?? [])].join(" ") : "", placeholder: "npx -y @modelcontextprotocol/server-filesystem /dati", class: "mono" });
	const secretName = h("input", { type: "text", placeholder: t?.type === "stdio" ? "API_KEY" : "authorization", class: "mono" });
	const secretValue = h("input", { type: "password", placeholder: "Valore (salvato nel secret store, mai mostrato)" });
	const allowed = h("input", { type: "checkbox", checked: existing ? existing.allowed : true });
	const enabled = h("input", { type: "checkbox", checked: existing ? existing.enabled : true });
	const askBox = h("input", { type: "checkbox", checked: existing?.approval !== "none" });
	const oauthBox = h("input", { type: "checkbox", checked: t?.type === "http" && t.auth === "oauth" });
	const box = h("div");
	const draw = () =>
		mount(
			box,
			type.value === "http"
				? h("div.stack", h("label.field", h("span", "URL"), url), h("label.row-gap", oauthBox, h("span", "Accesso con l'account del servizio (OAuth)")))
				: h("label.field", h("span", "Comando"), command, h("small", "Gira sul server di Annie: solo comandi di cui ti fidi.")),
		);
	type.addEventListener("change", draw);
	draw();
	const dialog = h(
		"dialog",
		h("h2", existing ? `Modifica ${existing.name}` : "Nuovo connettore"),
		h("label.field", h("span", "ID"), id, h("small", "lettere minuscole, cifre, trattini")),
		h("label.field", h("span", "Nome"), name),
		h("label.field", h("span", "Tipo"), type),
		box,
		h("div.field", h("span", type.value === "stdio" ? "Variabile segreta (opzionale)" : "Header segreto (opzionale)"), h("div.row-gap", secretName, secretValue)),
		h("label.row-gap", allowed, h("span", "Consenti nella egress policy")),
		h("label.row-gap", enabled, h("span", "Acceso")),
		h("label.row-gap", askBox, h("span", "Chiedi l'approvazione prima delle azioni che cambiano qualcosa")),
		h("small.muted", "Consigliato. Per creare, modificare o cancellare, Annie chiede il via libera a chi ha fatto la richiesta o a un approvatore; gli strumenti che il servizio indica come di sola lettura li usa da sola. Se il servizio non lo indica, chiede per tutti. Spegnilo solo per un servizio di cui ti fidi del tutto."),
		h(
			"div.actions",
			h(
				"button.btn.accent",
				{
					onclick: async () => {
						const cid = id.value.trim();
						try {
							const secrets = {};
							if (secretName.value.trim() && secretValue.value) {
								const key = `connector.${cid}.${secretName.value.trim().replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
								await api(`/api/instances/${inst.id}/secrets/${encodeURIComponent(key)}`, { method: "PUT", body: { value: secretValue.value } });
								secrets[secretName.value.trim()] = key;
							}
							const prev = existing?.transport ?? {};
							const transport =
								type.value === "http"
									? { type: "http", url: url.value.trim(), headerSecrets: { ...(prev.type === "http" ? prev.headerSecrets : {}), ...secrets }, ...(oauthBox.checked ? { auth: "oauth" } : {}) }
									: (() => {
											const [cmd, ...args] = command.value.trim().split(/\s+/);
											return { type: "stdio", command: cmd, args, envSecrets: { ...(prev.type === "stdio" ? prev.envSecrets : {}), ...secrets } };
										})();
							const { status } = await api(`/api/instances/${inst.id}/connectors/${encodeURIComponent(cid)}`, { method: "PUT", body: { name: name.value.trim() || cid, transport, enabled: enabled.checked, allowed: allowed.checked, ...(askBox.checked ? {} : { approval: "none" }) } });
							dialog.close();
							if (type.value === "http" && oauthBox.checked && status?.signIn && allowed.checked && enabled.checked) return await signInConnector(`/api/instances/${inst.id}/connectors/${encodeURIComponent(cid)}/sign-in`, name.value.trim() || cid);
							toast(status?.connected ? `Collegato: ${status.tools.length} tool` : `Salvato${status?.error ? `, ma non collegato: ${status.error}` : ""}`, !status?.connected);
							render();
						} catch (error) {
							toast(error.message, true);
						}
					},
				},
				"Salva e collega",
			),
			h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
		),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}

// ---------- agenti (ADR 0041) ----------
const TONES = [
	["naturale", "Naturale"],
	["formale", "Formale, dà del Lei"],
	["amichevole", "Amichevole"],
	["conciso", "Conciso"],
	["scherzoso", "Spiritoso"],
];

/** Starting points for a new agente: they only fill the form. */
const AGENT_TEMPLATES = [
	{ label: "Da zero", name: "", emoji: "", tagline: "", tone: "naturale", about: "" },
	{ label: "Assistente", name: "Assistente", emoji: "🙂", tagline: "Agenda, promemoria, mail e cose da fare", tone: "amichevole", about: "Aiuta una persona a organizzare la giornata: impegni, promemoria, liste, risposte alle mail." },
	{ label: "Ricercatore", name: "Ricercatore", emoji: "🔎", tagline: "Cerca, confronta e cita le fonti", tone: "conciso", about: "Fa ricerche sul web e nei file, confronta opzioni e fornitori, scrive report brevi con le fonti." },
	{ label: "Scrittore", name: "Scrittore", emoji: "✍️", tagline: "Testi, post e mail con la nostra voce", tone: "naturale", about: "Scrive e rivede testi: post, articoli, newsletter, mail. Chiede sempre a chi sono rivolti e che tono usare." },
	{ label: "Analista", name: "Analista", emoji: "📊", tagline: "Numeri, tabelle e grafici", tone: "conciso", about: "Risponde a domande su tabelle CSV ed Excel, fa i conti con i tool e prepara grafici e report." },
	{ label: "Assistenza clienti", name: "Assistenza", emoji: "💬", tagline: "Risponde ai clienti con garbo", tone: "formale", about: "Risponde alle domande dei clienti su prodotti, ordini e tempi, e passa a una persona quello che non sa." },
];

/** «🔎 Ricercatore», or the name alone. */
function agentLabel(agent) {
	return agent.emoji ? `${agent.emoji} ${agent.name}` : agent.name;
}

function slug(text) {
	return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

function agentForm() {
	const name = h("input", { type: "text", placeholder: "Ricercatore", maxlength: "80", "aria-label": "Nome" });
	const emoji = h("input.emoji-input", { type: "text", placeholder: "🙂", maxlength: "16", "aria-label": "Emoji" });
	const id = h("input", { type: "text", placeholder: "ricercatore", class: "mono", maxlength: "63" });
	const tagline = h("input", { type: "text", maxlength: "120", placeholder: "Cerca, confronta e cita le fonti" });
	const tone = h("select", TONES.map(([value, label]) => h("option", { value }, label)));
	const instructions = h("textarea", { rows: 4, maxlength: "2000", placeholder: "Per chi lavora e cosa deve fare. Si aggiunge a quello che sa già fare; lascia vuoto per partire dalle istruzioni predefinite." });
	let touched = false;
	id.addEventListener("input", () => (touched = true));
	name.addEventListener("input", () => {
		if (!touched) id.value = slug(name.value);
	});
	const chips = h(
		"div.templates",
		{ role: "group", "aria-label": "Parti da" },
		AGENT_TEMPLATES.map((t, i) =>
			h(
				"button.pick",
				{
					type: "button",
					"aria-pressed": i === 0 ? "true" : "false",
					onclick: (e) => {
						for (const b of chips.querySelectorAll("button")) b.setAttribute("aria-pressed", "false");
						e.currentTarget.setAttribute("aria-pressed", "true");
						name.value = t.name;
						emoji.value = t.emoji;
						tagline.value = t.tagline;
						tone.value = t.tone;
						instructions.value = t.about;
						if (!touched) id.value = slug(t.name);
						name.focus();
					},
				},
				t.emoji ? `${t.emoji} ${t.label}` : t.label,
			),
		),
	);
	const create = async () => {
		try {
			const { instance } = await api("/api/instances", { method: "POST", body: { id: id.value.trim(), name: name.value.trim(), instructions: instructions.value, persona: { emoji: emoji.value, tagline: tagline.value, tone: tone.value } } });
			dialog.close();
			await refreshInstances();
			state.instance = state.instances.find((i) => i.id === instance.id) ?? state.instance;
			store("annie.instance", state.instance.id);
			toast(`Agente ${agentLabel(instance)} creato`);
			await refreshSetup();
			go("chat");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog.agent-form",
		h("h2", "Nuovo agente"),
		h("p.muted", "Un agente con personalità, memoria, file, task e connettori suoi. Parte con il modello dell'agente principale; all'inizio solo tu puoi scrivergli, poi decidi chi in Impostazioni."),
		h("div.field", h("span", "Parti da"), chips),
		h("div.field", h("span", "Nome"), h("div.name-row", emoji, name)),
		h("label.field", h("span", "Cosa fa, in una riga"), tagline),
		h("label.field", h("span", "Tono"), tone),
		h("label.field", h("span", "Chi lo usa e per cosa"), instructions),
		h("details.advanced", h("summary", "Avanzate"), h("label.field", h("span", "ID"), id, h("small", "Lo usa l'indirizzo dell'agente: minuscole, cifre, - e _. Non si cambia più."))),
		h("div.actions", h("button.btn.accent", { onclick: create }, "Crea agente"), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	name.focus();
}

/** Ready-made squadre (ADR 0068): a few agenti that ask each other, with a room for all of them. */
async function teamsForm() {
	let listed;
	try {
		listed = await api("/api/teams");
	} catch (error) {
		return toast(error.message, true);
	}
	const { teams, available } = listed;
	if (!available) return toast("Questa installazione non crea agenti dalla console", true);
	// One squadra at a time: every button waits while one is made.
	const busy = (on) => {
		for (const b of dialog.querySelectorAll(".team button")) b.disabled = on;
	};
	const make = async (team) => {
		busy(true);
		try {
			const { agents, room, note } = await api("/api/teams", { method: "POST", body: { team: team.key } });
			dialog.close();
			await refreshInstances();
			toast(note ?? `Squadra ${team.name} pronta: ${agents.map((a) => a.name).join(", ")}`, note !== undefined);
			if (room) go("stanze", room);
			else go("agenti");
			render();
		} catch (error) {
			busy(false);
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog.teams-form",
		h("h2", "Squadre pronte"),
		h("p.muted", "Tre agenti con un compito ciascuno, che si chiedono aiuto tra loro, e una stanza dove li chiami tutti. Chi coordina divide il lavoro; sulla board può farne sotto-schede per gli altri. Dopo sono agenti come gli altri: li cambi o li elimini uno per uno."),
		h(
			"div.teams",
			teams.map((team) => {
				const button = h("button.btn.small.accent", { type: "button", onclick: () => void make(team) }, "Crea la squadra");
				return h(
					"section.team",
					h("b", `${team.emoji} ${team.name}`),
					h("p.muted.small", team.summary),
					h("ul", team.members.map((m, i) => h("li", h("span", `${m.emoji} ${m.name}`), h("small.muted", i === 0 ? `coordina · ${m.tagline}` : m.tagline)))),
					button,
				);
			}),
		),
		h("div.actions", h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}

// ---------- board (ADR 0050) ----------
const BOARD_COLUMNS = [
	["da_fare", "Da fare"],
	["in_corso", "In corso"],
	["da_rivedere", "Da rivedere"],
	["fatto", "Fatto"],
];
const REPEATS = [
	["", "No, una volta sola"],
	["giorno", "Ogni giorno"],
	["feriali", "Dal lunedì al venerdì"],
	["settimana", "Ogni settimana"],
	["mese", "Ogni mese"],
];
/** «lunedì 20 ott, 09:00»: when a scheda that comes back is made next. */
function whenNext(iso) {
	return new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const WEEKDAYS = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
const PRIORITIES = [
	["bassa", "Bassa"],
	["normale", "Normale"],
	["alta", "Alta"],
];

async function viewBoard(main) {
	const data = await api("/api/board");
	const agentOf = (id) => data.agents.find((a) => a.id === id);
	const who = (actor) => (actor.kind === "agent" ? (agentOf(actor.id)?.name ?? "un agente") : actor.id === state.me.id ? "Tu" : (data.people[actor.id] ?? "una persona"));
	const face = (id) => {
		const a = agentOf(id);
		return a ? face(a, 20) : null;
	};
	const save = async (card, body, done) => {
		try {
			await api(`/api/board/${card.id}`, { method: "PUT", body });
			if (done) toast(done);
			render();
			return true;
		} catch (error) {
			toast(error.message, true);
			return false;
		}
	};
	// Sotto-schede (ADR 0066): one level, shown under the scheda they are part of.
	const parentOf = (c) => (c.parent ? data.cards.find((x) => x.id === c.parent) : undefined);
	const childrenOf = (c) => data.cards.filter((x) => x.parent === c.id).sort((a, b) => a.n - b.n);
	const aloneLabel = `Lavora da solo fino alla fine, senza aspettare le tue risposte (al massimo ${data.auto.replies} risposte o ${data.auto.hours} ore, poi va in «Da rivedere»)`;
	// Dragged to another column (ADR 0051): the same moves as the buttons of the scheda.
	const moveTo = async (c, status) => {
		if (status === c.status) return;
		if (status === "in_corso" && c.status === "da_fare") {
			if (!c.assignee || !agentOf(c.assignee)?.canAssign) return toast("Affidala prima a un agente a cui puoi scrivere", true);
			try {
				await api(`/api/board/${c.id}/start`, { method: "POST" });
				toast(`${agentOf(c.assignee).name} ci sta lavorando`);
				render();
			} catch (error) {
				toast(error.message, true);
			}
			return;
		}
		// Sent back from review: with what to change, written in the scheda.
		if (status === "in_corso" && c.status === "da_rivedere") return cardDialog(c, true);
		await save(c, { status }, `Scheda #${c.n} in «${BOARD_COLUMNS.find(([v]) => v === status)[1]}»`);
	};
	const tile = (c) =>
		h(
			// A div, not a button: Firefox does not drag buttons.
			`div.board-card${c.priority === "alta" ? ".alta" : ""}`,
			{
				role: "button",
				tabindex: "0",
				draggable: "true",
				onclick: () => cardDialog(c),
				onkeydown: (e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					cardDialog(c);
				},
				ondragstart: (e) => {
					e.dataTransfer.setData("text/x-scheda", c.id);
					e.dataTransfer.effectAllowed = "move";
					e.currentTarget.classList.add("dragging");
				},
				ondragend: (e) => e.currentTarget.classList.remove("dragging"),
			},
			h("span.board-title", h("span.muted.mono", `#${c.n} `), c.title),
			c.parent && parentOf(c) ? h("span.muted.small", `parte di #${parentOf(c).n}`) : null,
			h(
				"span.board-meta",
				c.assignee ? [face(c.assignee), h("span", agentOf(c.assignee)?.name ?? "agente eliminato")] : h("span.muted", "Non assegnata"),
				c.priority === "normale" ? null : h("span.tag", `priorità ${c.priority}`),
				c.auto && c.status === "in_corso" ? h("span.tag", { title: `Lavora da solo: risposta ${c.auto.rounds} di ${data.auto.replies}` }, "da solo") : null,
			),
		);
	const columns = h(
		"div.board",
		BOARD_COLUMNS.map(([status, label]) => {
			const cards = data.cards.filter((c) => c.status === status).sort((a, b) => (status === "fatto" ? b.updatedAt.localeCompare(a.updatedAt) : (b.priority === "alta") - (a.priority === "alta") || a.n - b.n));
			const col = h(
				`section.board-col.${status}`,
				{
					"aria-label": label,
					ondragover: (e) => {
						if (!e.dataTransfer.types.includes("text/x-scheda")) return;
						e.preventDefault();
						col.classList.add("drop");
					},
					ondragleave: (e) => {
						if (!col.contains(e.relatedTarget)) col.classList.remove("drop");
					},
					ondrop: (e) => {
						e.preventDefault();
						col.classList.remove("drop");
						const card = data.cards.find((x) => x.id === e.dataTransfer.getData("text/x-scheda"));
						if (card) void moveTo(card, status);
					},
				},
				h("h2", label, h("span.muted", String(cards.length))),
				cards.length ? cards.map(tile) : h("p.muted.small", status === "da_rivedere" ? "Qui arrivano le schede finite dagli agenti, da approvare." : "Nessuna scheda"),
			);
			return col;
		}),
	);

	// One scheda: what it asks, who has it, what happened, and the moves a person makes.
	const cardDialog = (c, sendBack = false) => {
		const mine = c.work?.personId === state.me.id;
		const assignable = data.agents.filter((a) => a.canAssign || a.id === c.assignee);
		const assignee = h("select", { "aria-label": "Assegnata a" }, h("option", { value: "" }, "Nessuno"), assignable.map((a) => h("option", { value: a.id, selected: a.id === c.assignee ? "selected" : undefined }, a.emoji ? `${a.emoji} ${a.name}` : a.name)));
		// «In corso» comes from Avvia, which hands the scheda to the agente; not from a list.
		const status = h(
			"select",
			{ "aria-label": "Colonna" },
			BOARD_COLUMNS.filter(([v]) => v !== "in_corso" || c.status !== "da_fare").map(([v, l]) => h("option", { value: v, selected: v === c.status ? "selected" : undefined }, l)),
		);
		const comment = h("textarea", { rows: 2, placeholder: c.status === "da_rivedere" ? "Cosa va cambiato, se la rimandi indietro" : mine && c.status === "in_corso" ? "Arriva anche all'agente, nella conversazione" : "Un commento" });
		const events = c.events.filter((e) => e.kind !== "edited").slice(-30);
		const line = (e) =>
			h(
				"li",
				h("span.muted.small", `${fmt.time(e.at)} · ${who(e.by)}`),
				h(
					"div",
					e.kind === "created"
						? "ha creato la scheda"
						: e.kind === "status"
							? `l'ha spostata in «${BOARD_COLUMNS.find(([v]) => v === e.status)?.[1] ?? e.status}»`
							: e.kind === "assigned"
								? e.assignee
									? `l'ha assegnata a ${agentOf(e.assignee)?.name ?? "un agente"}`
									: `ha tolto l'assegnazione${e.text ? ` (${e.text})` : ""}`
								: e.text,
				),
			);
		const dialog = h("dialog.board-dialog");
		const act = (body, done) => async () => {
			if (await save(c, body, done)) dialog.close();
		};
		const withComment = (body) => (comment.value.trim() ? { ...body, comment: comment.value } : body);
		const openThread = async () => {
			dialog.close();
			// An agente created after this page was loaded is not in the list yet.
			store("annie.instance", c.work.agent);
			await refreshInstances();
			if (state.instance?.id !== c.work.agent) {
				if (state.instance) store("annie.instance", state.instance.id);
				return toast("Non puoi più scrivere a questo agente", true);
			}
			state.threads = [];
			void refreshSetup();
			go("chat", c.work.threadId);
		};
		const moves = [];
		// «Esegui da solo» (ADR 0061): the agente goes on without waiting for answers, then to review.
		const alone = h("input", { type: "checkbox", checked: c.auto !== undefined });
		const aloneRow = h("label.board-alone", alone, h("span", aloneLabel));
		if (c.status === "da_rivedere") {
			moves.push(h("button.btn.accent", { onclick: act(withComment({ status: "fatto" }), `Scheda #${c.n} approvata`) }, icon("check"), "Approva"));
			moves.push(
				h(
					"button.btn",
					{
						onclick: () => {
							if (!comment.value.trim()) {
								comment.focus();
								return toast("Scrivi cosa va cambiato", true);
							}
							void act({ status: "in_corso", comment: comment.value }, mine ? `Scheda #${c.n} rimandata a ${agentOf(c.assignee)?.name ?? "l'agente"}` : `Scheda #${c.n} rimandata in «Da fare»: premi Avvia per lavorarci con l'agente`)();
						},
					},
					"Rimanda indietro",
				),
			);
		}
		if (c.status === "da_fare" && c.assignee && agentOf(c.assignee)?.canAssign)
			moves.push(
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								await api(`/api/board/${c.id}/start`, { method: "POST", body: { auto: alone.checked } });
								dialog.close();
								toast(`${agentOf(c.assignee).name} ci sta lavorando`);
								render();
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Avvia",
				),
			);
		if (mine && c.work.agent === c.assignee && c.status !== "da_fare") moves.push(h("button.btn.ghost", { onclick: openThread }, "Apri la conversazione"));
		const startable = c.status === "da_fare" && c.assignee && agentOf(c.assignee)?.canAssign;
		const working = mine && c.work.agent === c.assignee && c.status === "in_corso";
		if (working)
			alone.addEventListener("change", async () => {
				if (!(await save(c, { auto: alone.checked }, alone.checked ? `${agentOf(c.assignee)?.name ?? "L'agente"} va avanti da solo` : "Ora l'agente aspetta le tue risposte"))) alone.checked = !alone.checked;
			});
		const canDelete = state.me.role === "owner" || (c.createdBy.kind === "person" && c.createdBy.id === state.me.id);
		const parent = parentOf(c);
		const children = childrenOf(c);
		// Without what is not there: append would write «null».
		const parts = [
			h("div.kicker", `Scheda #${c.n} · creata da ${c.createdBy.kind === "person" && c.createdBy.id === state.me.id ? "te" : who(c.createdBy)} il ${fmt.day(c.createdAt)}`),
			h("h2", c.title),
			c.description ? h("p.board-desc", c.description) : null,
			parent ? h("p.small", "Fa parte di ", h("a", { href: "#", onclick: (e) => (e.preventDefault(), dialog.close(), cardDialog(parent)) }, `#${parent.n} ${parent.title}`)) : null,
			children.length
				? h(
						"div.board-children",
						h("span.muted.small", `Sotto-schede: ${children.filter((x) => x.status === "fatto").length} di ${children.length} fatte`),
						h(
							"ul",
							children.map((x) =>
								h(
									"li",
									h("a", { href: "#", onclick: (e) => (e.preventDefault(), dialog.close(), cardDialog(x)) }, `#${x.n} ${x.title}`),
									h("span.muted.small", ` · ${BOARD_COLUMNS.find(([v]) => v === x.status)[1]}${x.assignee ? ` · ${agentOf(x.assignee)?.name ?? "agente eliminato"}` : ""}`),
								),
							),
						),
					)
				: null,
			h("div.board-fields", h("label.field", h("span", "Assegnata a"), assignee), h("label.field", h("span", "Colonna"), status)),
			moves.length ? h("div.actions", moves) : null,
			startable || working ? aloneRow : null,
			working && c.auto ? h("p.muted.small", `Risposte senza di te: ${c.auto.rounds} di ${data.auto.replies}.`) : null,
			events.length ? h("ul.board-events", events.map(line)) : null,
			h("label.field", h("span", "Commento"), comment),
			h(
				"div.actions",
				h(
					"button.btn",
					{
						onclick: () => {
							const body = withComment({});
							if (assignee.value !== (c.assignee ?? "")) body.assignee = assignee.value;
							if (status.value !== c.status) body.status = status.value;
							if (Object.keys(body).length === 0) return dialog.close();
							void act(body, "Scheda aggiornata")();
						},
					},
					"Salva",
				),
				h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi"),
				canDelete
					? h(
							"button.btn.ghost.danger",
							{
								onclick: async () => {
									if (!confirm(`Eliminare la scheda #${c.n}?`)) return;
									try {
										await api(`/api/board/${c.id}`, { method: "DELETE" });
										dialog.close();
										toast("Scheda eliminata");
										render();
									} catch (error) {
										toast(error.message, true);
									}
								},
							},
							"Elimina",
						)
					: null,
			),
		];
		dialog.append(...parts.filter((x) => x !== null));
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		if (sendBack) {
			comment.focus();
			toast("Scrivi cosa va cambiato e premi Rimanda indietro");
		}
	};

	const newCard = () => {
		const title = h("input", { type: "text", maxlength: 120, placeholder: "Es. Prepara il preventivo per Rossi" });
		const description = h("textarea", { rows: 4, placeholder: "Cosa fare e quando è finito: l'agente vede solo questo" });
		const assignee = h("select", h("option", { value: "" }, "Nessuno, per ora"), data.agents.filter((a) => a.canAssign).map((a) => h("option", { value: a.id }, a.emoji ? `${a.emoji} ${a.name}` : a.name)));
		const priority = h("select", PRIORITIES.map(([v, l]) => h("option", { value: v, selected: v === "normale" ? "selected" : undefined }, l)));
		const parents = data.cards.filter((x) => !x.parent && x.status !== "fatto").sort((a, b) => a.n - b.n);
		const parent = h("select", h("option", { value: "" }, "Nessuna"), parents.map((x) => h("option", { value: x.id }, `#${x.n} ${x.title}`)));
		const alone = h("input", { type: "checkbox" });
		const aloneRow = h("label.board-alone", { hidden: true }, alone, h("span", aloneLabel));
		// «Si ripete» (ADR 0069): only for a scheda handed to an agente.
		const every = h("select", REPEATS.map(([v, l]) => h("option", { value: v }, l)));
		const time = h("input", { type: "time", value: "09:00", step: "300", "aria-label": "Ora" });
		const weekday = h("select", { "aria-label": "Giorno" }, WEEKDAYS.map((d, i) => h("option", { value: String(i + 1) }, d)));
		const monthday = h("select", { "aria-label": "Giorno del mese" }, Array.from({ length: 28 }, (_, i) => h("option", { value: String(i + 1) }, `il ${i + 1}`)));
		const repeatWhen = h("div.board-repeat-when", { hidden: true }, weekday, monthday, h("span", "alle"), time);
		const repeatRow = h("div.field", { hidden: true }, h("span", "Si ripete"), h("div.board-repeat", every, repeatWhen));
		const drawRepeat = () => {
			repeatWhen.hidden = !every.value;
			weekday.hidden = every.value !== "settimana";
			monthday.hidden = every.value !== "mese";
			ok.textContent = every.value ? "Programma" : "Crea";
			if (parentRow) parentRow.hidden = Boolean(every.value);
		};
		every.addEventListener("change", drawRepeat);
		assignee.addEventListener("change", () => {
			aloneRow.hidden = !assignee.value;
			repeatRow.hidden = !assignee.value;
			if (!assignee.value) every.value = "";
			drawRepeat();
		});
		const ok = h("button.btn.accent", "Crea");
		const parentRow = parents.length ? h("label.field", h("span", "Fa parte di"), parent) : null;
		const dialog = h(
			"dialog.board-dialog",
			h("h2", "Nuova scheda"),
			h("label.field", h("span", "Titolo"), title),
			h("label.field", h("span", "Descrizione"), description),
			h("div.board-fields", h("label.field", h("span", "Affida a"), assignee), h("label.field", h("span", "Priorità"), priority)),
			repeatRow,
			parentRow,
			h("p.muted.small", "Se la affidi a un agente, ci lavora subito in una conversazione con te e la sposta in «Da rivedere» quando ha finito. Se si ripete, ogni volta nasce una scheda nuova che parte con te, come se premessi Avvia."),
			aloneRow,
			h("div.actions", ok, h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
		);
		ok.onclick = async () => {
			ok.disabled = true;
			try {
				if (every.value) {
					const repeat = { every: every.value, time: time.value, ...(every.value === "settimana" ? { day: Number(weekday.value) } : every.value === "mese" ? { day: Number(monthday.value) } : {}) };
					const { routine } = await api("/api/board", { method: "POST", body: { title: title.value, description: description.value, priority: priority.value, assignee: assignee.value, auto: alone.checked, repeat } });
					dialog.close();
					toast(`Si ripete ${routine.whenText}: la prima volta ${whenNext(routine.next)}`);
					render();
					return;
				}
				const { card } = await api("/api/board", { method: "POST", body: { title: title.value, description: description.value, priority: priority.value, ...(assignee.value ? { assignee: assignee.value, auto: alone.checked } : {}), ...(parent.value ? { parent: parent.value } : {}) } });
				dialog.close();
				toast(card.status === "in_corso" ? `Scheda #${card.n} affidata a ${agentOf(card.assignee)?.name}` : `Scheda #${card.n} creata`);
				render();
			} catch (error) {
				ok.disabled = false;
				toast(error.message, true);
			}
		};
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		title.focus();
	};

	// Schede that come back (ADR 0069): who set them sees them above the columns, and pauses or removes them.
	const routineRow = (r) => {
		const agent = agentOf(r.assignee);
		const toggle = async () => {
			try {
				await api(`/api/board/routines/${r.id}`, { method: "PUT", body: { paused: !r.paused } });
				toast(r.paused ? "Riparte alla prossima volta" : "In pausa: non nascono schede finché non la riprendi");
				render();
			} catch (error) {
				toast(error.message, true);
			}
		};
		const remove = () =>
			confirmDialog("Non ripeterla più?", `«${r.title}» non crea più schede. Quelle già create restano sulla board.`, "Togli", () =>
				api(`/api/board/routines/${r.id}`, { method: "DELETE" })
					.then(() => {
						toast("Non si ripete più");
						render();
					})
					.catch((error) => toast(error.message, true)),
			);
		const last = r.last ? data.cards.find((c) => c.id === r.last) : undefined;
		return h(
			`li.board-routine${r.paused ? ".paused" : ""}`,
			face(r.assignee),
			h(
				"div",
				h("b", r.title),
				h(
					"p.muted.small",
					[agent ? agent.name : "agente non disponibile", r.whenText, r.personId === state.me.id ? null : `impostata da ${data.people[r.personId] ?? "una persona"}`, r.paused ? "in pausa" : `la prossima ${whenNext(r.next)}`, r.auto ? "da solo" : null, last ? `ultima #${last.n}` : null].filter(Boolean).join(" · "),
				),
				r.problem ? h("p.small.board-routine-problem", `L'ultima volta non è partita: ${r.problem}.`) : null,
			),
			h("div.row-gap", h("button.btn.small.ghost", { onclick: toggle }, r.paused ? "Riprendi" : "Pausa"), h("button.btn.small.ghost", { onclick: remove }, "Togli")),
		);
	};
	const routines = data.routines?.length ? h("details.board-routines", { open: store("annie.board.routines") !== "0" ? "" : undefined, ontoggle: (e) => store("annie.board.routines", e.currentTarget.open ? "1" : "0") }, h("summary", `Si ripetono (${data.routines.length})`), h("ul", data.routines.map(routineRow))) : null;
	mount(
		main,
		head("Annie", h("h1", "Board"), "Le cose da fare, affidate agli agenti. L'agente ci lavora in una conversazione con chi gliel'ha affidata e la sposta in «Da rivedere»; poi una persona la chiude, o la rimanda indietro con un commento. Puoi anche chiedere in chat: «mettilo in board per Ricercatore», e avviarla da qui.", h("button.btn.accent", { onclick: newCard }, icon("plus"), "Nuova scheda")),
		routines,
		columns,
	);
	// The agenti move schede while the page is open: it follows them, unless a scheda is open.
	const look = (d) => JSON.stringify([d.cards.map((c) => [c.id, c.updatedAt]), (d.routines ?? []).map((r) => [r.id, r.next, r.problem, r.paused, r.last])]);
	const shown = look(data);
	const timer = setInterval(async () => {
		if (!main.isConnected) return clearInterval(timer);
		if (document.querySelector("dialog[open]") || document.hidden) return;
		try {
			const next = await api("/api/board");
			if (main.isConnected && look(next) !== shown) render();
		} catch {
			/* next round */
		}
	}, 10_000);
}

/** Every agente with its face, what it does and what runs by itself. */
async function viewAgents(main) {
	const owner = state.me.role === "owner";
	const { agents } = await api("/api/agents");
	const switchTo = (agent, view) => {
		state.instance = state.instances.find((i) => i.id === agent.id) ?? state.instance;
		store("annie.instance", state.instance.id);
		state.threads = [];
		void refreshSetup().then(render);
		go(view);
	};
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
	const writesTo = (a) => agents.filter((x) => x.acceptsFrom?.includes(a.id)).map((x) => x.name);
	// «Fate squadra»: every agente may ask every other one; the per-agente card in Impostazioni stays the fine control.
	const team = agents.filter((a) => !state.instances.find((i) => i.id === a.id)?.hasSegreteria);
	const together = team.length > 1 && team.every((a) => team.every((x) => x.id === a.id || a.acceptsFrom?.includes(x.id)));
	const setTeam = async (on) => {
		try {
			for (const a of team) await api(`/api/instances/${a.id}/agents`, { method: "PUT", body: { from: on ? team.filter((x) => x.id !== a.id).map((x) => x.id) : [] } });
			toast(on ? "Ora gli agenti possono chiedersi aiuto tra loro" : "Gli agenti non si scrivono più tra loro");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const teamButton = owner && team.length > 1 ? h("button.btn.ghost", { title: "Ogni agente può chiedere aiuto agli altri mentre lavora", onclick: () => setTeam(!together) }, together ? "Separa gli agenti" : "Fate squadra") : null;
	const card = (a) =>
		h(
			`article.card.agent${a.id === state.instance?.id ? ".current" : ""}`,
			h("div.agent-face", face(a, 52)),
			h(
				"div.agent-body",
				h("h2", a.name, a.id === state.instance?.id ? h("span.tag", "aperto") : null),
				a.tagline ? h("p", a.tagline) : null,
				h("p.muted.small", [a.model?.name, TONES.find(([v]) => v === a.tone)?.[1], a.channels.filter((c) => c !== "web" && c !== "agente").join(", ")].filter(Boolean).join(" · ")),
				h("p.muted.small", [plural(a.schedules, "task", "task"), plural(a.watches, "sentinella", "sentinelle"), plural(a.memories, "ricordo", "ricordi")].join(" · ")),
				a.acceptsFrom?.length ? h("p.muted.small", `Gli scrivono: ${a.acceptsFrom.map((id) => agents.find((x) => x.id === id)?.name ?? id).join(", ")}`) : null,
				owner && writesTo(a).length ? h("p.muted.small", `Può scrivere a: ${writesTo(a).join(", ")}`) : null,
			),
			h(
				"div.agent-actions",
				a.canChat ? h("button.btn.small.accent", { onclick: () => switchTo(a, "chat") }, "Chatta") : null,
				owner ? h("button.btn.small.ghost", { onclick: () => switchTo(a, "impostazioni") }, "Personalità e impostazioni") : null,
			),
		);
	mount(
		main,
		head("Annie", h("h1", "Agenti"), "Ognuno ha la sua personalità, la sua memoria, i suoi task, file e connettori. Ognuno può avere il suo bot su Telegram e WhatsApp.", owner ? h("div.row-gap", teamButton, h("button.btn.ghost", { title: "Più agenti già pronti a lavorare insieme", onclick: () => teamsForm() }, "Squadre pronte"), h("button.btn.accent", { onclick: () => agentForm() }, icon("plus"), "Nuovo agente")) : null),
		agents.length === 0 ? h("div.empty", h("b", "Nessun agente"), owner ? "Crea il primo con Nuovo agente." : "Chiedi all'owner di aggiungerti a un agente.") : h("div.agents", agents.map(card)),
	);
}

// ---------- impostazioni ----------
async function viewSettings(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ settings }, { people }, tg, wa, google, voice, search, tel, computer, speech, images, models, desktop] = await Promise.all([
		api(`/api/instances/${inst.id}/settings`),
		api("/api/people"),
		api(`/api/instances/${inst.id}/telegram`).catch(() => undefined),
		api(`/api/instances/${inst.id}/whatsapp`).catch(() => undefined),
		api("/api/google").catch(() => ({ available: false })),
		api("/api/voice").catch(() => ({ available: false })),
		api("/api/search").catch(() => ({ available: false })),
		api(`/api/instances/${inst.id}/phone`).catch(() => undefined),
		api("/api/computer").catch(() => ({ available: false })),
		api("/api/speech").catch(() => ({ available: false })),
		api("/api/images").catch(() => ({ available: false })),
		api(`/api/instances/${inst.id}/model`).catch(() => undefined),
		api("/api/desktop").catch(() => ({ available: false })),
	]);
	const name = h("input", { type: "text", value: settings.name, maxlength: "80", "aria-label": "Nome" });
	const emoji = h("input.emoji-input", { type: "text", value: settings.persona.emoji ?? "", placeholder: "🙂", maxlength: "16", "aria-label": "Emoji" });
	const tagline = h("input", { type: "text", value: settings.persona.tagline ?? "", maxlength: "120", placeholder: "Cosa fa, in una riga" });
	const tone = h("select", TONES.map(([value, label]) => h("option", { value, selected: value === (settings.persona.tone ?? "naturale") ? "selected" : undefined }, label)));
	const instructions = h("textarea", { rows: 9, value: settings.instructions });
	const chat = new Set(settings.allowedUsers.web ?? []);
	const approve = new Set(settings.approvers.web ?? []);
	const rows = people.map((p) => {
		const c = h("input", { type: "checkbox", checked: chat.has(p.id), "aria-label": `${p.name} può scrivere` });
		const a = h("input", { type: "checkbox", checked: approve.has(p.id), "aria-label": `${p.name} approva` });
		return { p, c, a, row: h("tr", h("td", p.name, h("div.mono.muted", p.id)), h("td", c), h("td", a)) };
	});
	const save = async () => {
		try {
			await api(`/api/instances/${inst.id}/settings`, { method: "PUT", body: { name: name.value, instructions: instructions.value, persona: { emoji: emoji.value, tagline: tagline.value, tone: tone.value }, webPeople: rows.filter((r) => r.c.checked).map((r) => r.p.id), webApprovers: rows.filter((r) => r.a.checked).map((r) => r.p.id) } });
			toast("Impostazioni salvate");
			await refreshInstances();
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const e = settings.egress;
	mount(main, 
		head(
			agentLabel(inst),
			h("h1", "Impostazioni"),
			"La personalità di questo agente, chi può usarlo dal web, chi approva le sue azioni.",
			h("button.btn.ghost", { onclick: () => (setupHidden(inst.id, false), go("inizia")) }, "Primi passi"),
			h("button.btn.accent", { onclick: save }, "Salva"),
		),
		h(
			"div.grid-2",
			h(
				"div.stack",
				anchor(
					"personalita",
					h(
						"div.card.pad",
						h("div.kicker", "Personalità"),
						h("div.field", h("span", "Nome"), h("div.name-row", emoji, name)),
						h("label.field", h("span", "Cosa fa, in una riga"), tagline),
						h("label.field", h("span", "Tono"), tone),
						h("label.field", h("span", "Istruzioni"), instructions, h("small", "Cosa sa fare e le sue regole. Nome, ruolo e tono gli arrivano dopo queste.")),
					),
				),
				models === undefined ? null : anchor("modello", modelCard(inst, models.model, models.providers)),
				tg === undefined ? null : anchor("telegram", telegramCard(inst, tg.telegram)),
				wa === undefined ? null : whatsappCard(inst, wa.whatsapp),
				tel === undefined ? null : phoneCard(inst, tel.phone),
				google.available ? googleCard(inst, (settings.egress.connectors ?? []).includes("google")) : null,
				voice.available ? voiceCard(inst, voice.host, (settings.egress.connectors ?? []).includes("voice")) : null,
				speech.available ? anchor("voce", speechCard(inst, speech.host, (settings.egress.connectors ?? []).includes("speech"), voice.available && (settings.egress.connectors ?? []).includes("voice"))) : null,
				search.available ? anchor("ricerca", searchCard(inst, search.host, (settings.egress.connectors ?? []).includes("web_search"), settings.egress.web ?? [])) : null,
				images.available ? anchor("immagini", imagesCard(inst, images.host, images.maxPerDay, (settings.egress.connectors ?? []).includes("image_generation"))) : null,
				anchor("siti", webCard(inst, settings.egress.web ?? [])),
				webActionsCard(inst, (settings.egress.connectors ?? []).includes("web-actions")),
				anchor("agenti", agentsCard(inst, settings)),
				computer.available ? computerCard(inst, (settings.egress.connectors ?? []).includes("computer"), computer.problem) : null,
				anchor("schermo", desktopCard(inst, (settings.egress.connectors ?? []).includes("schermo"), desktop)),
			),
			h(
				"div.stack",
				h("div.card", h("table.ledger", h("thead", h("tr", h("th", "Persona"), h("th", "Scrive"), h("th", "Approva"))), h("tbody", rows.map((r) => r.row)))),
				h(
					"div.card.pad",
					h("div.kicker", "Egress policy"),
					h("dl.lead", h("dt", "Modello"), h("dd.mono", `${settings.model.provider}/${settings.model.modelId}`), h("dt", "Canali"), h("dd.mono", e.channels.join(", ") || "nessuno"), h("dt", "Connettori"), h("dd.mono", (e.connectors ?? []).join(", ") || "nessuno")),
					h("p.muted", "Tutto ciò che non è in elenco è negato. I connettori si consentono dalla loro pagina."),
				),
				settings.deletable ? anchor("elimina", deleteCard(inst)) : null,
			),
		),
	);
}

/** A card that «Primi passi» can point at: #/impostazioni/<id> scrolls to it and makes it flash. */
function anchor(id, card) {
	card.id = `card-${id}`;
	if (route().rest[0] === id)
		requestAnimationFrame(() => {
			card.scrollIntoView({ behavior: "smooth", block: "start" });
			card.classList.add("flash");
		});
	return card;
}

/** The instance's Telegram bot: the token goes in once and never comes back. */
function telegramCard(inst, t) {
	const token = h("input", { type: "password", autocomplete: "off", placeholder: t.connected ? "Nuovo token (facoltativo)" : "123456789:AA…", class: "mono" });
	const list = (ids) => ids.join(", ");
	const allowed = h("input", { type: "text", class: "mono", value: list(t.allowedUsers), placeholder: "123456789, 987654321" });
	const approvers = h("input", { type: "text", class: "mono", value: list(t.approvers), placeholder: "123456789" });
	const ids = (input) => input.value.split(/[\s,]+/).filter(Boolean);
	const save = async () => {
		try {
			await api(`/api/instances/${inst.id}/telegram`, { method: "PUT", body: { ...(token.value.trim() ? { token: token.value.trim() } : {}), allowedUsers: ids(allowed), approvers: ids(approvers) } });
			toast(t.connected ? "Telegram aggiornato" : "Bot collegato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const disconnect = () =>
		confirmDialog("Scollegare il bot?", `${inst.name} smette di rispondere su Telegram. Il token viene cancellato.`, "Scollega", async () => {
			await api(`/api/instances/${inst.id}/telegram`, { method: "DELETE" });
			toast("Bot scollegato");
			render();
		});
	return h(
		"div.card.pad",
		h("div.row-gap", h("div.kicker", "Telegram"), t.connected ? h("span.chip.ok", t.username ? `@${t.username}` : "Collegato") : h("span.chip", "Non collegato")),
		t.connected ? null : h("p.muted", "Crea un bot con @BotFather su Telegram e incolla qui il suo token. Ogni persona ammessa apre il bot e preme Start."),
		h("label.field", h("span", t.connected ? "Token" : "Token del bot"), token),
		h("label.field", h("span", "Chi può scrivere"), allowed, h("small", "ID numerici di Telegram, separati da virgole. Chi non è in elenco non riceve risposta. Per sapere il tuo ID scrivi a @userinfobot su Telegram.")),
		h("label.field", h("span", "Chi approva"), approvers, h("small", "Ricevono su Telegram le schede dei tool da approvare.")),
		h("div.actions", h("button.btn.accent", { onclick: save }, t.connected ? "Salva" : "Collega"), t.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
	);
}

/** A value to copy into another service's dashboard. */
function copyBox(value, what) {
	const input = h("input", { type: "text", class: "mono", readonly: true, value });
	return h("div.link-box", input, h("button.btn.ghost", { onclick: async () => (await navigator.clipboard.writeText(value).catch(() => input.select()), toast(`${what} copiato`)) }, "Copia"));
}

/** The instance's WhatsApp number (Meta Cloud API): token and app secret go in once and never come back. */
function whatsappCard(inst, w) {
	const secret = (placeholder) => h("input", { type: "password", autocomplete: "off", class: "mono", placeholder });
	const accessToken = secret(w.connected ? "Nuovo token (facoltativo)" : "EAAG…");
	const appSecret = secret(w.connected ? "Nuovo app secret (facoltativo)" : "32 caratteri esadecimali");
	const phoneNumberId = h("input", { type: "text", class: "mono", placeholder: w.connected ? "Invariato" : "123456789012345" });
	const list = (numbers) => numbers.join(", ");
	const allowed = h("input", { type: "text", class: "mono", value: list(w.allowedUsers), placeholder: "393331234567, 393479876543" });
	const approvers = h("input", { type: "text", class: "mono", value: list(w.approvers), placeholder: "393331234567" });
	const templateName = h("input", { type: "text", class: "mono", value: w.template?.name ?? "", placeholder: "annie_aggiornamento" });
	const templateLanguage = h("input", { type: "text", class: "mono", value: w.template?.language ?? "", placeholder: "it" });
	const numbers = (input) => input.value.split(/[\s,]+/).map((n) => n.replace(/^\+/, "")).filter(Boolean);
	const save = async () => {
		try {
			const given = { accessToken: accessToken.value.trim(), phoneNumberId: phoneNumberId.value.trim(), appSecret: appSecret.value.trim() };
			// The template only when it changed: otherwise saving the people list does not need Meta.
			const changed = w.connected && (templateName.value.trim() !== (w.template?.name ?? "") || templateLanguage.value.trim() !== (w.template?.language ?? ""));
			const template = changed ? { templateName: templateName.value.trim(), templateLanguage: templateLanguage.value.trim() } : {};
			const body = { ...Object.fromEntries(Object.entries(given).filter(([, v]) => v)), ...template, allowedUsers: numbers(allowed), approvers: numbers(approvers) };
			await api(`/api/instances/${inst.id}/whatsapp`, { method: "PUT", body });
			toast(w.connected ? "WhatsApp aggiornato" : "Numero collegato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const disconnect = () =>
		confirmDialog("Scollegare WhatsApp?", `${inst.name} smette di rispondere su WhatsApp. Token e app secret vengono cancellati.`, "Scollega", async () => {
			await api(`/api/instances/${inst.id}/whatsapp`, { method: "DELETE" });
			toast("WhatsApp scollegato");
			render();
		});
	return h(
		"div.card.pad",
		h("div.row-gap", h("div.kicker", "WhatsApp"), w.connected ? h("span.chip.ok", w.number ?? "Collegato") : h("span.chip", "Non collegato")),
		w.connected ? null : h("p.muted", "Serve un numero WhatsApp Business sulla piattaforma di Meta. Da developers.facebook.com prendi il token di accesso permanente, l'ID del numero e l'app secret (guida in docs/chiavi.md)."),
		w.webhookUrl === null ? h("p.muted", "Questo server non ha un indirizzo https pubblico: WhatsApp non può mandargli i messaggi.") : null,
		h("label.field", h("span", "Token di accesso"), accessToken),
		h("label.field", h("span", "ID del numero"), phoneNumberId),
		h("label.field", h("span", "App secret"), appSecret, h("small", "Serve a controllare che i messaggi arrivino davvero da Meta.")),
		w.connected && w.webhookUrl !== null
			? h(
					"div.stack",
					h("div.kicker", "Da incollare nell'app Meta (WhatsApp → Configurazione → Webhook)"),
					copyBox(w.webhookUrl, "Indirizzo"),
					copyBox(w.verifyToken ?? "", "Token di verifica"),
					h("small.muted", "Poi iscriviti al campo «messages»."),
				)
			: null,
		h("label.field", h("span", "Chi può scrivere"), allowed, h("small", "Numeri con prefisso internazionale, separati da virgole. Chi non è in elenco non riceve risposta.")),
		h("label.field", h("span", "Chi approva"), approvers, h("small", "Ricevono su WhatsApp le schede dei tool da approvare.")),
		w.connected
			? h(
					"div.stack",
					h("div.kicker", "Oltre le 24 ore"),
					h("p.muted", "WhatsApp lascia scrivere liberamente solo entro 24 ore dall'ultimo messaggio della persona. Dopo, Annie tiene da parte i messaggi e li consegna appena la persona scrive. Con un template approvato da Meta (una variabile {{1}} nel testo) la avvisa subito, con un estratto."),
					h("div.grid-2", h("label.field", h("span", "Nome del template"), templateName), h("label.field", h("span", "Lingua"), templateLanguage)),
				)
			: null,
		h("div.actions", h("button.btn.accent", { onclick: save }, w.connected ? "Salva" : "Collega"), w.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
	);
}

/** The instance's phone number (Twilio, ADR 0012): Annie answers calls, one turn at a time. */
function phoneCard(inst, p) {
	const accountSid = h("input", { type: "text", class: "mono", autocomplete: "off", placeholder: p.connected ? (p.accountSid ?? "Invariato") : "AC…" });
	const authToken = h("input", { type: "password", class: "mono", autocomplete: "off", placeholder: p.connected ? "Nuovo auth token (facoltativo)" : "32 caratteri esadecimali" });
	const number = h("input", { type: "text", class: "mono", placeholder: p.connected ? (p.number ?? "Invariato") : "+390612345678" });
	const pin = h("input", { type: "password", inputmode: "numeric", autocomplete: "off", class: "mono", placeholder: p.connected ? "Nuovo codice (facoltativo)" : "Da 4 a 8 cifre" });
	const allowed = h("input", { type: "text", class: "mono", value: p.allowedUsers.join(", "), placeholder: "+393331234567, +393479876543" });
	// No "+" added here: 3331234567 would become a French number. The server asks for the prefix.
	const numbers = (input) => input.value.split(/[\s,]+/).filter(Boolean);
	const save = async () => {
		try {
			const given = { accountSid: accountSid.value.trim(), authToken: authToken.value.trim(), number: number.value.trim(), pin: pin.value.trim() };
			await api(`/api/instances/${inst.id}/phone`, { method: "PUT", body: { ...Object.fromEntries(Object.entries(given).filter(([, v]) => v)), allowedUsers: numbers(allowed) } });
			toast(p.connected ? "Telefono aggiornato" : "Numero collegato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const disconnect = () =>
		confirmDialog("Scollegare il telefono?", `${inst.name} smette di rispondere alle chiamate: il numero resta su Twilio ma rifiuta le chiamate. Le credenziali e le risposte in attesa vengono cancellate.`, "Scollega", async () => {
			await api(`/api/instances/${inst.id}/phone`, { method: "DELETE" });
			toast("Telefono scollegato");
			render();
		});
	return h(
		"div.card.pad",
		h("div.row-gap", h("div.kicker", "Telefono"), p.connected ? h("span.chip.ok", p.number ?? "Collegato") : h("span.chip", "Non collegato")),
		p.connected ? null : h("p.muted", "Annie risponde alle chiamate su un numero Twilio, a voce, un turno alla volta. Da console.twilio.com prendi Account SID, auth token e il numero (guida in docs/chiavi.md): l'indirizzo delle chiamate lo imposta Annie."),
		p.https ? null : h("p.muted", "Questo server non ha un indirizzo https pubblico: Twilio non può chiamarlo."),
		h("label.field", h("span", "Account SID"), accountSid),
		h("label.field", h("span", "Auth token"), authToken, h("small", "Serve anche a controllare che le chiamate arrivino davvero da Twilio.")),
		h("label.field", h("span", "Numero"), number),
		h("label.field", h("span", "Codice"), pin, h("small", "Chi chiama lo digita all'inizio di ogni chiamata: il numero di chi chiama da solo si può falsificare. Dallo solo alle persone in elenco.")),
		h("label.field", h("span", "Chi può chiamare"), allowed, h("small", "Numeri con + e prefisso internazionale, separati da virgole. Le chiamate da altri numeri vengono rifiutate.")),
		h("div.actions", h("button.btn.accent", { onclick: save, disabled: !p.https && !p.connected }, p.connected ? "Salva" : "Collega"), p.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
	);
}

// ---------- persone ----------
async function viewPeople(main) {
	const { people } = await api("/api/people");
	const showLink = (title, link) => {
		const full = `${location.origin}${link}`;
		const input = h("input", { type: "text", value: full, readonly: true });
		const dialog = h(
			"dialog",
			h("h2", title),
			h("p", "Dallo alla persona in privato: è la sua chiave. Non verrà più mostrato."),
			h("div.link-box", input, h("button.btn", { onclick: async () => (await navigator.clipboard.writeText(full).catch(() => input.select()), toast("Link copiato")) }, "Copia")),
			h("div.actions", h("button.btn.ghost", { onclick: () => dialog.close() }, "Fatto")),
		);
		dialog.addEventListener("close", () => (dialog.remove(), render()));
		document.body.append(dialog);
		dialog.showModal();
		input.select();
	};
	const newName = h("input", { type: "text", placeholder: "Nome e cognome" });
	const role = h("select", h("option", { value: "member" }, "Membro"), h("option", { value: "owner" }, "Owner"));
	mount(main, 
		head("Annie", h("h1", "Persone"), "Chi può entrare nella console. Ognuno ha un link personale; rigenerarlo chiude le sue sessioni."),
		h(
			"div.grid-2",
			h(
				"div.card",
				h(
					"table.ledger",
					h("thead", h("tr", h("th", "Persona"), h("th", "Ruolo"), h("th", "Dal"), h("th", ""))),
					h(
						"tbody",
						people.map((p) =>
							h(
								"tr",
								h("td", p.name, h("div.mono.muted", p.id)),
								h("td", h("div.row-gap", h(`span.chip${p.role === "owner" ? ".accent" : ""}`, p.role === "owner" ? "owner" : "membro"), p.twoFactor ? h("span.chip.ok", "Verifica in 2 passaggi") : null)),
								h("td.mono", fmt.day(p.createdAt)),
								h(
									"td.row-gap",
									h(
										"button.btn.small.ghost",
										{
											onclick: () =>
												confirmDialog(`Nuovo link per ${p.name}?`, "Il link attuale e le sue sessioni smettono di funzionare.", "Genera", async () => {
													const { link } = await api(`/api/people/${p.id}/link`, { method: "POST" });
													showLink(`Nuovo link per ${p.name}`, link);
												}),
										},
										"Nuovo link",
									),
									p.twoFactor && p.id !== state.me.id
										? h(
												"button.btn.small.ghost",
												{
													onclick: () =>
														confirmDialog(`Togliere la verifica in due passaggi a ${p.name}?`, "Per chi ha perso il telefono: potrà entrare con il solo link e riattivarla.", "Togli", async () => {
															await api(`/api/people/${p.id}/2fa/reset`, { method: "POST" });
															render();
														}),
												},
												"Togli verifica",
											)
										: null,
									p.id !== state.me.id
										? h(
												"button.btn.small.danger",
												{
													onclick: () =>
														confirmDialog(`Rimuovere ${p.name}?`, "Non potrà più entrare.", "Rimuovi", async () => {
															await api(`/api/people/${p.id}`, { method: "DELETE" });
															render();
														}),
												},
												"Rimuovi",
											)
										: null,
								),
							),
						),
					),
				),
			),
			h(
				"div.card.pad",
				h("h2", "Aggiungi una persona"),
				h("label.field", h("span", "Nome"), newName),
				h("label.field", h("span", "Ruolo"), role, h("small", "L'owner gestisce connettori, impostazioni e persone.")),
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								const { person, link } = await api("/api/people", { method: "POST", body: { name: newName.value, role: role.value } });
								showLink(`Link di ${person.name}`, link);
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Crea e mostra il link",
				),
				h("p.muted", "Poi, in Impostazioni, scegli a quali agenti può scrivere e se approva."),
			),
		),
	);
}

// ---------- attività ----------
async function viewActivity(main) {
	const { usage } = await api("/api/usage");
	const owner = state.me.role === "owner";
	const audit = owner ? (await api("/api/audit?limit=200")).events : [];
	const share = Math.min(1, usage.todayUsd / usage.hardUsd);
	const label = (e) => {
		const { at: _at, ts: _ts, type: _type, tenantId: _tenant, ...rest } = e;
		return Object.entries(rest)
			.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
			.join("  ");
	};
	mount(main, 
		head("Annie", h("h1", "Attività e spesa"), "Quanto ha speso oggi il tenant in modelli, e cosa è successo."),
		h(
			"div.stack",
			h(
				"div.card.pad",
				h("div.kicker", "Oggi"),
				h("div.row-gap", h("span", h("b", fmt.usd(usage.todayUsd))), h("span.muted", `soglia di avviso ${fmt.usd(usage.softUsd)} · tetto ${fmt.usd(usage.hardUsd)}`)),
				h("div.spend", h("div.bar", h(`i${share >= 1 ? ".bad" : usage.todayUsd >= usage.softUsd ? ".warn" : ""}`, { "data-w": share }))),
				h("p.muted", "Oltre il tetto Annie smette di chiamare il modello fino a domani; l'invio di bozze già approvate continua."),
			),
			owner
				? h(
						"div.card",
						audit.length
							? h(
									"table.ledger",
									h("thead", h("tr", h("th", "Quando"), h("th", "Evento"), h("th", "Dettagli"))),
									h("tbody", audit.map((e) => h("tr", h("td.mono", fmt.time(e.ts ?? e.at)), h("td", h("span.chip", e.type)), h("td.mono.muted", label(e))))),
								)
							: h("div.empty", h("b", "Nessun evento")),
					)
				: h("div.card.empty", "L'audit completo è visibile all'owner."),
		),
	);
	const bar = main.querySelector(".spend .bar i");
	if (bar) requestAnimationFrame(() => (bar.style.width = `${Math.max(2, Number(bar.dataset.w) * 100)}%`));
}

void boot();
