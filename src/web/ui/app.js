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
	segreteria: ["M3 13h5l1.5 2.5h5L16 13h5", "M5.5 5h13L21 13v6H3v-6Z"],
	approvazioni: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "m8.5 12.5 2.5 2.5 4.5-5"],
	task: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7.5V12l3 2"],
	file: ["M14 3H6v18h12V7Z", "M14 3v4h4"],
	memoria: ["M12 4a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.2V16a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-1.8A3 3 0 0 0 16 9V8a4 4 0 0 0-4-4Z", "M12 4v16"],
	connettori: ["M9 3v5M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0Z", "M12 17v4"],
	impostazioni: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M15 5v4M9 15v4"],
	persone: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M2.5 21a6.5 6.5 0 0 1 13 0", "M16 3.6a4 4 0 0 1 0 6.8", "M18.5 14.5A6.5 6.5 0 0 1 21.5 21"],
	attivita: ["M3 12h4l3-8 4 16 3-8h4"],
	search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
	theme: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 3v18", "M12 7h4.5M12 11h6M12 15h5.5"],
	logout: ["M14 4h5v16h-5", "M9.5 8 5.5 12l4 4", "M5.5 12H15"],
	menu: ["M4 7h16M4 12h16M4 17h16"],
	plus: ["M12 5v14M5 12h14"],
	compose: ["M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6", "M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"],
	sidebar: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M9.5 4v16"],
	attach: ["m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"],
	send: ["M12 19V5", "m6 11 6-6 6 6"],
	more: ["M6 12h.01M12 12h.01M18 12h.01"],
	account: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0"],
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

const fmt = {
	time: (iso) => (iso ? new Date(iso).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"),
	day: (iso) => (iso ? new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "—"),
	bytes: (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`),
	usd: (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`,
};

function store(key, value) {
	try {
		if (value === undefined) return localStorage.getItem(key) ?? undefined;
		localStorage.setItem(key, value);
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
	{ id: "segreteria", label: "Segreteria", group: "Lavoro", when: (i) => i?.hasSegreteria },
	{ id: "approvazioni", label: "Approvazioni", group: "Lavoro", count: () => state.pendingApprovals },
	{ id: "task", label: "Task e sentinelle", group: "Lavoro" },
	{ id: "file", label: "File", group: "Lavoro" },
	{ id: "memoria", label: "Memoria", group: "Lavoro" },
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
		renderRail();
	} catch {
		/* shown on next render */
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
		if (route().view !== "chat") toast("Nuova risposta di Annie");
		renderRail();
		void refreshThreads().then(renderRail);
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
			toast(toggle.checked ? "Google consentito per questa istanza" : "Google non più consentito per questa istanza");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h3", "Google"),
		h("p.muted", "Chi ha collegato il proprio Google (dal menu del suo account) può chiedere a questa istanza di leggere la sua posta e il suo calendario, solo nelle sue conversazioni dalla console. Se il server lo permette, anche di preparare mail ed eventi: partono solo quando quella persona li approva."),
		h("label.row-gap", toggle, h("span", "Consenti Google a questa istanza")),
	);
}

/** Owner: replies as voice notes, made by the server's speech service (ADR 0020). */
function speechCard(inst, host, allowed, understood) {
	const toggle = h("input", { type: "checkbox", checked: allowed, disabled: !allowed && !understood });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/speech`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Annie risponde a voce a chi le manda un vocale" : "Risposte a voce spente per questa istanza");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h3", "Risposte a voce"),
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
			toast(toggle.checked ? "Annie può creare immagini" : "Immagini spente per questa istanza");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h3", "Immagini"),
		h("p.muted", `Annie crea immagini quando gliele chiedono (un'illustrazione, un logo, un volantino) e ritocca le foto che le mandano. Le genera il servizio ${host}, che riceve la descrizione e, per un ritocco, la foto. L'immagine arriva in chat e resta tra i file. Al massimo ${maxPerDay} immagini al giorno per tutto l'account.`),
		h("label.row-gap", toggle, h("span", "Consenti le immagini a questa istanza")),
	);
}

/** Owner: voice messages of this instance transcribed by the server's service. */
function voiceCard(inst, host, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/voice`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Vocali trascritti per questa istanza" : "Vocali non più trascritti per questa istanza");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h3", "Messaggi vocali"),
		h("p.muted", `I vocali di Telegram e WhatsApp vengono trascritti da ${host} e arrivano ad Annie come testo. Solo quelli delle persone che possono scrivere; l'audio va solo a quel servizio.`),
		h("label.row-gap", toggle, h("span", "Trascrivi i vocali di questa istanza")),
	);
}

/** Owner: web search for this instance, through the server's search service (ADR 0017). */
function searchCard(inst, host, allowed, hosts) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/search`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Annie può cercare sul web" : "Ricerca sul web spenta per questa istanza");
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
		h("h3", "Ricerca sul web"),
		h("p.muted", `Annie cerca notizie, prezzi, orari e tutto quello che cambia, e se glielo chiedi prepara un report di ricerca con le fonti numerate. Le ricerche vanno a ${host}, solo le parole cercate. Le pagine trovate le apre solo dai siti consentiti qui sotto.`),
		h("label.row-gap", toggle, h("span", "Consenti la ricerca a questa istanza")),
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
			toast(saved.length === 0 ? "Navigazione web spenta per questa istanza" : saved.includes("*") ? "Annie può leggere tutti i siti pubblici" : `Annie può leggere ${saved.length} siti`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	return h(
		"div.card.pad",
		h("h3", "Navigazione web"),
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
		h("h3", "Azioni sul web"),
		h("p.muted", "Annie può chiedere di inviare un modulo di un sito consentito (un contatto, una prenotazione). Ogni invio aspetta l'approvazione di chi l'ha chiesto o di un approvatore, che vede destinazione e valori esatti; niente parte da solo."),
		h("label.row-gap", toggle, h("span", "Consenti le azioni sul web con approvazione")),
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
		h("h3", "Computer"),
		h("p.muted", "Annie esegue comandi in un computer suo, senza rete e senza segreti: elabora fogli e documenti, converte file, fa grafici. Usa copie dei file del workspace e rimette lì quelli che produce. Niente può uscire da quel computer, quindi i comandi non chiedono approvazione."),
		problem ? h("p.warn", `Il computer non è disponibile: ${problem}.`) : null,
		h("label.row-gap", toggle, h("span", "Consenti ad Annie di usare il suo computer")),
		h("div.actions", h("button.btn.ghost", { onclick: reset }, "Azzera i file del computer")),
	);
}

// ---------- account (two-factor) ----------
function accountDialog() {
	const body = h("div");
	const dialog = h("dialog", h("h3", "Il tuo account"), googleSection(), body);
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
const SIDEBAR = new Set(["inizia", "segreteria", "approvazioni", "task", "file", "memoria"]);

function render() {
	if (!state.me) return renderLogin();
	const { view } = route();
	const item = PALETTE.find((p) => p.id === view) ?? PALETTE.find((p) => p.id === "chat");
	if (item.owner && state.me.role !== "owner") return go("chat");
	closeMenu();
	const main = h("main", { id: "main", class: item.id === "chat" ? "is-chat" : "is-page" });
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
	const views = { inizia: viewStart, chat: viewChat, segreteria: viewSegreteria, approvazioni: viewApprovals, task: viewTasks, file: viewFiles, memoria: viewMemory, connettori: viewConnectors, impostazioni: viewSettings, persone: viewPeople, attivita: viewActivity };
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
				state.unread.has(t.id) ? h("span.dot", { "aria-label": "non letto" }) : null,
			),
		);
	}
	const unreadElsewhere = [...state.unread].some((id) => !(state.threads ?? []).some((t) => t.id === id));
	mount(
		rail,
		h(
			"div.rail-top",
			h("a.brand", { href: "#/chat", onclick: closeRailOnPhone }, h("img", { src: "/icon.svg", alt: "", width: "22", height: "22" }), h("b", "Annie")),
			h("button.icon-btn.collapse", { "aria-label": "Chiudi la barra laterale", title: "Chiudi la barra laterale", onclick: toggleRail }, icon("sidebar")),
		),
		h(
			"div.rail-actions",
			h("a.rail-btn", { href: "#/chat", "aria-current": view === "chat" && !rest[0] ? "page" : undefined, onclick: closeRailOnPhone }, icon("compose"), h("span.label", "Nuova chat"), unreadElsewhere ? h("span.dot", { "aria-label": "risposte non lette" }) : null),
			h("button.rail-btn", { onclick: openPalette, "aria-label": "Vai a una sezione" }, icon("search"), h("span.label", "Cerca"), h("kbd", navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
		),
		state.instances.length > 1
			? h(
					"div.instance-pick",
					h("label.sr", { for: "instance" }, "Istanza"),
					h(
						"select",
						{
							id: "instance",
							onchange: (e) => {
								state.instance = state.instances.find((i) => i.id === e.target.value);
								store("annie.instance", state.instance.id);
								state.threads = [];
								void refreshSetup().then(render);
								render();
							},
						},
						state.instances.map((i) => h("option", { value: i.id, selected: i.id === state.instance?.id ? "selected" : undefined }, i.name)),
					),
				)
			: null,
		nav,
		h("div.rail-scroll", past.childElementCount ? past : null),
		h(
			"div.rail-foot",
			h(
				"button.who-id",
				{ onclick: (e) => openMenu(e.currentTarget), "aria-haspopup": "menu", title: "Account e gestione" },
				h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)),
				h("span.who-text", h("span.name", state.me.name), h("span.role", state.instance?.name ?? (state.me.role === "owner" ? "Owner" : "Membro"))),
				icon("more"),
			),
		),
	);
}

/** The account menu: spend, management sections, account, theme, exit. */
function openMenu(anchorEl) {
	if (closeMenu()) return;
	const owner = state.me.role === "owner";
	const u = state.usage;
	const share = u ? Math.min(1, u.todayUsd / u.hardUsd) : 0;
	const { view } = route();
	const entry = (iconName, label, onclick, current) => h("button", { role: "menuitem", onclick: () => (closeMenu(), closeRailOnPhone(), onclick()), "aria-current": current ? "page" : undefined }, icon(iconName), h("span", label));
	const section = (id) => {
		const item = PALETTE.find((p) => p.id === id);
		return (!item.owner || owner) ? entry(id, item.label, () => go(id), view === id) : null;
	};
	const menu = h(
		"div.menu",
		{ role: "menu", "aria-label": "Account e gestione" },
		h("div.menu-head", h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)), h("div", h("div.name", state.me.name), h("div.role", `${owner ? "Owner" : "Membro"}${state.me.twoFactor ? " · verifica attiva" : ""}`))),
		u
			? h(
					"div.spend",
					h("div.row", h("span", "Spesa di oggi"), h("b.mono", fmt.usd(u.todayUsd))),
					h("div.bar", h(`i${share >= 1 ? ".bad" : u.todayUsd >= u.softUsd ? ".warn" : ""}`, { "data-w": share })),
					h("div.row", h("span.muted", `soglia ${fmt.usd(u.softUsd)}`), h("span.muted", `tetto ${fmt.usd(u.hardUsd)}`)),
				)
			: null,
		h("hr"),
		section("connettori"),
		section("impostazioni"),
		section("persone"),
		section("attivita"),
		owner ? entry("plus", "Nuova istanza", instanceForm) : null,
		installOffer && !installed() ? entry("install", "Installa l'app", install) : null,
		h("hr"),
		entry("account", "Il tuo account", accountDialog),
		entry("theme", "Tema chiaro/scuro", cycleTheme),
		entry("logout", "Esci", async () => {
			await api("/api/logout", { method: "POST" }).catch(() => {});
			state.me = undefined;
			renderLogin();
		}),
	);
	document.body.append(menu);
	const bar = menu.querySelector(".spend .bar i");
	if (bar) bar.style.width = `${Math.max(2, Number(bar.dataset.w) * 100)}%`;
	const r = anchorEl.getBoundingClientRect();
	menu.style.left = `${Math.max(8, r.left)}px`;
	menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
	menu.querySelector("button")?.focus();
	const away = (e) => {
		if (!menu.contains(e.target) && !anchorEl.contains(e.target)) closeMenu();
	};
	const keys = (e) => {
		if (e.key === "Escape") {
			closeMenu();
			anchorEl.focus();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const all = [...menu.querySelectorAll("button")];
			const i = all.indexOf(document.activeElement);
			all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
		}
	};
	setTimeout(() => document.addEventListener("pointerdown", away), 0);
	document.addEventListener("keydown", keys);
	menu.cleanup = () => {
		document.removeEventListener("pointerdown", away);
		document.removeEventListener("keydown", keys);
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
	const items = PALETTE.filter((p) => (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance)));
	const input = h("input", { type: "text", placeholder: "Vai a una sezione…", "aria-label": "Cerca una sezione", autocomplete: "off" });
	const list = h("ul", { role: "listbox" });
	let active = 0;
	let shown = items;
	const dialog = h("dialog.palette", input, list);
	const pick = (item) => {
		dialog.close();
		dialog.remove();
		document.querySelector(".shell")?.classList.remove("open");
		go(item.id);
	};
	const draw = () => {
		const q = input.value.trim().toLowerCase();
		shown = items.filter((i) => i.label.toLowerCase().includes(q));
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
					icon(item.id),
					h("span", item.label),
					h("span.muted", item.group),
				),
			),
			...(shown.length ? [] : [h("li.none", "Nessuna sezione")]),
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
	mount(main, h("div.empty", h("b", "Nessuna istanza"), "Non hai ancora accesso a nessuna istanza. Chiedi all'owner di aggiungerti."));
	return true;
}

// ---------- chat ----------
const HINTS = ["Riassumi in punti il file che ti carico", "Cosa c'è in questa foto?", "Ricordami ogni lunedì alle 9 di controllare gli ordini", "Prepara un CSV con i clienti citati", "Quali strumenti hai a disposizione?"];

async function viewChat(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	if (!inst.canChat) {
		mount(main, h("div.welcome", h("h2", "Chat non disponibile"), h("p", state.me.role === "owner" ? "Aggiungi te stesso alle persone che possono scrivere a questa istanza, in Impostazioni." : "Non sei tra le persone che possono scrivere a questa istanza.")));
		return;
	}
	const threadId = route().rest[0];
	const conversation = h("section.conversation");
	mount(main, conversation);
	if (!threadId) return landing(inst, conversation);
	state.unread.delete(threadId);
	renderRail();
	const { entries } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}`);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	let typing;
	const picture = (path) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(path)}&inline=1`;
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
		const el = h(`div.msg.${entry.from}`, h("div.meta", fmt.time(entry.at), listen), pictures, entry.text || entry.file || !pictures ? body : null);
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
		typing = h("div.typing", { "aria-label": "Annie sta scrivendo" }, h("i"), h("i"), h("i"));
		transcript.append(typing);
		transcript.scrollTop = transcript.scrollHeight;
	};
	if (entries.length && entries.at(-1).from === "person") startTyping();
	state.onEntry = (event) => {
		if (event.threadId !== threadId) return false;
		stopTyping();
		show(event.entry);
		if (event.entry.from === "annie") void drawAsks();
		transcript.scrollTop = transcript.scrollHeight;
		return true;
	};
	const box = chatBox(inst, threadId, conversation, async (text, images) => {
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
	});
	if (store(`annie.photo.${threadId}`) === "1") {
		store(`annie.photo.${threadId}`, "");
		box.input.placeholder = "Aggiungi la foto con la graffetta, trascinala qui o incollala";
	}
	conversation.append(transcript, h("div.dock", asks, box.el));
	transcript.scrollTop = transcript.scrollHeight;
	// A message written on the empty chat: sent as soon as its conversation opens.
	if (store(`annie.autosend.${threadId}`) === "1") {
		store(`annie.autosend.${threadId}`, "");
		void box.submit();
	}
	box.input.focus();
}

/** The empty chat: a greeting, the box in the middle and a few ideas. Sending opens a new conversation. */
function landing(inst, conversation) {
	conversation.classList.add("empty-chat");
	const box = chatBox(inst, "new", conversation, async (text, images) => {
		const { thread } = await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: {} });
		store(`annie.draft.${thread.id}`, text);
		store(`annie.pending.${thread.id}`, JSON.stringify(images));
		store(`annie.autosend.${thread.id}`, "1");
		go("chat", thread.id);
	});
	const hour = new Date().getHours();
	const hello = hour < 5 || hour >= 18 ? "Buonasera" : "Buongiorno";
	const first = state.me.name.split(/\s+/)[0];
	conversation.append(
		h(
			"div.welcome",
			h("img.mark", { src: "/icon.svg", alt: "", width: "40", height: "40" }),
			h("h2", first && first !== "Owner" ? `${hello}, ${first}.` : `${hello}.`),
			h("p", "Di cosa hai bisogno?"),
			box.el,
			h(
				"div.hints",
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

/**
 * The message box: text, photos waiting to go with it, files noted in it, a drop zone and a paste.
 * The draft and the photos are kept per key (a conversation, or "new") until onSend succeeds;
 * when onSend throws, they come back and the error is said.
 */
function chatBox(inst, key, dropZone, onSend) {
	const picture = (path) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(path)}&inline=1`;
	const draftKey = `annie.draft.${key}`;
	const input = h("textarea", { rows: 1, placeholder: "Scrivi ad Annie…", title: "Invio per inviare, Maiusc+Invio per andare a capo", "aria-label": "Messaggio", value: store(draftKey) ?? "" });
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
		store(pendingKey, JSON.stringify(pending));
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
		store(draftKey, "");
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
				const { file: saved, document: docLabel } = await api(`/api/instances/${inst.id}/files/raw?name=${encodeURIComponent(name)}`, { method: "PUT", raw: f });
				if (isPicture) pending.push(saved.path);
				else {
					const note = docLabel ? `[Documento ${docLabel} nel workspace: ${saved.path}. Leggilo con file_read]` : `[File caricato nel workspace: ${saved.path}]`;
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
	const el = h("div.box", tray, h("div.composer", h("label.attach", { title: "Carica un file o una foto" }, icon("attach"), h("span.sr", "File"), file), input, sendButton));
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
		head(inst.name, h("h1", "Segreteria commerciale"), `${open} ${open === 1 ? "pratica aspetta" : "pratiche aspettano"} la tua decisione. Nessuna mail parte senza Approva.`),
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
		["Dati mancanti", p.missingFields.length ? p.missingFields.join(", ") : "nessuno"],
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
					? h("p.muted", "Solo gli approvatori di questa istanza possono decidere.")
					: null,
			editing,
		),
	);
}

function confirmDialog(title, text, okLabel, onOk) {
	const dialog = h(
		"dialog",
		h("h3", title),
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
			h("header", h("div", h("div.kicker", `Proposta ${p.id} · ${fmt.time(p.proposedAt)}`), h("h3", "Tool ", h("span.mono", `custom_${p.name}`))), p.status === "pending" ? h("span.chip.accent", "In attesa") : null),
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
			h("header", h("div", h("div.kicker", `Richiesta ${a.id} · ${fmt.time(a.proposedAt)}`), h("h3", "Invio di un modulo a ", h("span.mono", new URL(a.action).host))), a.status === "pending" ? h("span.chip.accent", "In attesa") : null),
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
					h("header", h("div", h("div.kicker", s.name), h("h3", `${waiting.length} ${waiting.length === 1 ? "bozza aspetta" : "bozze aspettano"} Approva`)), h("span.chip.accent", "Segreteria")),
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
		head(inst.name, h("h1", "Approvazioni"), "Tutto ciò che aspetta una tua decisione: le mail e gli eventi che Annie prepara sul tuo Google, le azioni sui servizi collegati (Notion, Linear, GitHub…) che cambiano qualcosa, le bozze della segreteria, i moduli che Annie chiede di inviare e i tool che scrive da sola, spenti finché un approvatore non li legge e li approva."),
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
		h("header", h("div", h("div.kicker", `${a.connectorName} · richiesta ${a.id} · ${fmt.time(a.proposedAt)}`), h("h3", a.reason)), a.status === "pending" ? h(a.destructive ? "span.chip.bad" : "span.chip.accent", a.destructive ? "Può cancellare o sovrascrivere" : "In attesa") : null),
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
		h("header", h("div", h("div.kicker", `${kind} · ${fmt.time(a.proposedAt)}`), h("h3", googleTitle(a))), a.status === "pending" ? h("span.chip.accent", "Da approvare") : null),
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
 * owner can take it from here (the model is the operator's, and some browsers cannot install).
 */
function setupSteps(setup) {
	const can = setup.can ?? {};
	return [
		{ id: "model", own: false, done: setup.model, title: "Collega un modello AI", text: setup.model ? "Annie usa un modello AI vero." : "Ora risponde il modello di prova, che ripete quello che scrivi. Lo collega chi gestisce il server di Annie (su Annie Cloud, l'assistenza): chiediglielo." },
		{ id: "instructions", own: true, done: setup.instructions, title: "Dille chi è e cosa fa", text: "Due righe su di te o sulla tua azienda, il tono e cosa deve fare. Puoi partire da un esempio: vengono aggiunte a quello che Annie sa già fare, e le cambi quando vuoi in Impostazioni." },
		{ id: "tried", own: true, done: setup.tried, title: "Scrivile qualcosa", text: `Una domanda, una foto, un file da riassumere: vedi subito come risponde.${setup.model ? "" : " Con il modello di prova la risposta ripete quello che scrivi."}` },
		{ id: "channel", own: true, done: setup.channel, title: "Usala dal telefono", text: `Collega Telegram o WhatsApp e mettiti tra chi può scriverle: le scrivi, le mandi ${can.transcription ? "vocali e " : ""}foto${can.transcription && can.speech ? ", ti risponde anche a voce" : ""}, e ti avvisa lei.`, go: ["impostazioni", "telegram"] },
		{ id: "web", own: true, done: setup.web, title: "Lasciala cercare sul web", text: can.search ? "Accendi la ricerca e scegli i siti che può aprire: notizie, prezzi, orari aggiornati, report di ricerca con le fonti." : "Scegli i siti che può aprire: notizie, prezzi, orari aggiornati.", go: ["impostazioni", can.search ? "ricerca" : "siti"] },
		...(can.images ? [{ id: "images", own: true, done: setup.images, title: "Fatti creare un'immagine", text: "Accendi le immagini: un logo, un volantino, una foto ritoccata, chiesti a parole in chat.", go: ["impostazioni", "immagini"] }] : []),
		{ id: "connectors", own: true, done: setup.connectors, title: "Collega i tuoi strumenti", text: "Notion, Linear, Jira, Stripe, GitHub e altri in un clic: entri con il tuo account e Annie può cercare, leggere e aggiornare lì dentro.", go: ["connettori"] },
		{ id: "people", own: true, done: setup.people, title: "Invita il tuo team", text: "Aggiungi le persone in Persone, poi in Impostazioni scegli chi può scrivere a questa istanza. Ognuno ha le sue chat e la sua memoria; tu decidi chi approva le azioni delicate.", go: ["persone"] },
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
			inst.name,
			h("h1", "Primi passi"),
			`${done} di ${steps.length} fatti. Ogni passo rende Annie più utile; li puoi fare in qualsiasi ordine.`,
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
		head(inst.name, h("h1", "Task e sentinelle"), "Istruzioni che Annie esegue da sola, una volta o a ripetizione, e pagine che controlla per te. Il risultato arriva nella chat scelta."),
		inst.canChat && briefState ? briefCard(inst, briefState) : null,
		h(
			"div.grid-2",
			h("div.card", schedules.length ? table : h("div.empty", h("b", "Nessun task"), "Creane uno qui accanto, oppure chiedilo ad Annie in chat.")),
			h(
				"div.card.pad",
				h("h3", "Nuovo task"),
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
				h("h3", "Nuova sentinella"),
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
				? "Hai collegato Google, ma questa istanza non lo può usare: l'owner lo attiva in Impostazioni."
				: "Calendario di oggi, mail non lette che chiedono una risposta, e quello che Annie ricorda di te. Solo lettura.";
	return h(
		"div.card.pad.brief",
		h("div.row-gap", h("h3", "Brief del mattino"), brief ? h("span.chip.ok", "Attivo") : null),
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
		head(inst.name, h("h1", "File"), `Il workspace di ${inst.name}: i file che crea e quelli che le date (legge anche PDF, Word, Excel e PowerPoint). ${files.length} file, ${fmt.bytes(total)}.`, h("label.btn.accent", "Carica un file", upload)),
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
	const list = (memories, editable, empty) =>
		memories.length
			? h(
					"table.ledger",
					h(
						"tbody",
						memories.map((m) =>
							h(
								"tr",
								h("td", m.text, h("div.mono.muted", `${m.source === "annie" ? "ricordata da Annie" : "aggiunta a mano"} · ${fmt.time(m.createdAt)}`)),
								h("td", editable ? h("button.btn.small.danger", { onclick: () => forget(m) }, "Dimentica") : null),
							),
						),
					),
				)
			: h("div.empty", h("b", "Niente"), empty);
	const add = (isShared) => {
		const text = h("textarea", { rows: 2, maxlength: 500, placeholder: isShared ? "Es. L'ufficio è chiuso dal 10 al 25 agosto" : "Es. Preferisco risposte brevi, in punti" });
		const save = async () => {
			try {
				await api(`/api/instances/${inst.id}/memory`, { method: "POST", body: { text: text.value, shared: isShared } });
				toast("Annie se lo ricorderà");
				render();
			} catch (error) {
				toast(error.message, true);
			}
		};
		return h("div.pad", h("label.field", h("span", isShared ? "Aggiungi una cosa che vale per tutti" : "Aggiungi una cosa su di te"), text), h("button.btn", { onclick: save }, "Ricorda"));
	};
	mount(main, 
		head(inst.name, h("h1", "Memoria"), "Quello che Annie ricorda di te tra una conversazione e l'altra, e le cose che valgono per tutti. Lo vede solo chi ne è il soggetto; quelle condivise le vede chiunque scriva ad Annie."),
		h(
			"div.grid-2",
			h("div.card", h("div.pad", h("h3", "Su di te")), list(mine, true, "Annie non ricorda ancora niente di te. Puoi dirle «ricordati che…» in chat, o aggiungerlo qui."), add(false)),
			h("div.card", h("div.pad", h("h3", "Condivise")), list(shared, canEditShared, "Nessuna memoria condivisa."), canEditShared ? add(true) : h("p.muted.pad", "Solo l'owner aggiunge o toglie memorie condivise.")),
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
		return h("div.card.pad", h("h3", e.name), h("span.chip", AUTH_LABEL[e.auth]), h("p.muted", e.description), h("div.go", button));
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
		h("h3", replace ? `Nuovo token per ${e.name}` : `Collega ${e.name}`),
		h("p.muted", e.tokenHelp ?? ""),
		h("label.field", h("span", "Token"), token, h("small", "Resta sul server di Annie e non si vede più. Si usa solo per questa istanza.")),
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
			h("div.row-gap", h("h3", c.name), chip),
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
		head(inst.name, h("h1", "Connettori"), "Collegano Annie agli strumenti che usate già. Ognuno raggiunge solo il suo servizio, e solo se consentito.", h("button.btn.accent", { onclick: () => connectorForm(inst) }, "+ Connettore")),
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
		h("h3", existing ? `Modifica ${existing.name}` : "Nuovo connettore"),
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

// ---------- nuova istanza ----------
function instanceForm() {
	const name = h("input", { type: "text", placeholder: "Vendite", maxlength: "80" });
	const id = h("input", { type: "text", placeholder: "vendite", class: "mono", maxlength: "63" });
	const instructions = h("textarea", { rows: 5, maxlength: "2000", placeholder: "Per chi lavora e cosa deve fare. Vengono aggiunte a quello che Annie sa già fare; lascia vuoto per partire dalle istruzioni predefinite." });
	let touched = false;
	id.addEventListener("input", () => (touched = true));
	name.addEventListener("input", () => {
		if (!touched) id.value = name.value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
	});
	const create = async () => {
		try {
			const { instance } = await api("/api/instances", { method: "POST", body: { id: id.value.trim(), name: name.value.trim(), instructions: instructions.value } });
			dialog.close();
			await refreshInstances();
			state.instance = state.instances.find((i) => i.id === instance.id) ?? state.instance;
			store("annie.instance", state.instance.id);
			toast(`Istanza ${instance.name} creata`);
			await refreshSetup();
			go(state.setupLeft > 0 ? "inizia" : "chat");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog",
		h("h3", "Nuova istanza"),
		h("p.muted", "Un'altra Annie con istruzioni, file, task e connettori suoi. Usa lo stesso modello dell'istanza principale; all'inizio solo tu puoi scriverle, poi decidi chi in Impostazioni."),
		h("label.field", h("span", "Nome"), name),
		h("label.field", h("span", "ID"), id, h("small", "Minuscole, cifre, - e _. Non si cambia più.")),
		h("label.field", h("span", "Chi la usa e per cosa"), instructions),
		h("div.actions", h("button.btn.accent", { onclick: create }, "Crea istanza"), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	name.focus();
}

// ---------- impostazioni ----------
async function viewSettings(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ settings }, { people }, tg, wa, google, voice, search, tel, computer, speech, images] = await Promise.all([
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
	]);
	const name = h("input", { type: "text", value: settings.name });
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
			await api(`/api/instances/${inst.id}/settings`, { method: "PUT", body: { name: name.value, instructions: instructions.value, webPeople: rows.filter((r) => r.c.checked).map((r) => r.p.id), webApprovers: rows.filter((r) => r.a.checked).map((r) => r.p.id) } });
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
			inst.name,
			h("h1", "Impostazioni"),
			"Chi può usare questa istanza dal web, chi approva le sue azioni, e come si comporta.",
			h("button.btn.ghost", { onclick: () => (setupHidden(inst.id, false), go("inizia")) }, "Primi passi"),
			h("button.btn.accent", { onclick: save }, "Salva"),
		),
		h(
			"div.grid-2",
			h(
				"div.stack",
				h("div.card.pad", h("label.field", h("span", "Nome"), name), h("label.field", h("span", "Istruzioni"), instructions, h("small", "Il carattere e le regole di Annie per questa istanza."))),
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
				computer.available ? computerCard(inst, (settings.egress.connectors ?? []).includes("computer"), computer.problem) : null,
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
		confirmDialog("Scollegare il bot?", "Annie smette di rispondere su Telegram per questa istanza. Il token viene cancellato.", "Scollega", async () => {
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
		confirmDialog("Scollegare WhatsApp?", "Annie smette di rispondere su WhatsApp per questa istanza. Token e app secret vengono cancellati.", "Scollega", async () => {
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
		confirmDialog("Scollegare il telefono?", "Annie smette di rispondere alle chiamate per questa istanza: il numero resta su Twilio ma rifiuta le chiamate. Le credenziali e le risposte in attesa vengono cancellate.", "Scollega", async () => {
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
			h("h3", title),
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
				h("h3", "Aggiungi una persona"),
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
				h("p.muted", "Poi, in Impostazioni, scegli a quali istanze può scrivere e se approva."),
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
