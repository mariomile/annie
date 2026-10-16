// Annie — console web. Vanilla ES module, no dependencies. Text from people, mails and the
// model is only ever set with textContent: never innerHTML.

const $app = document.getElementById("app");
const $toasts = document.getElementById("toasts");

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
	setTimeout(() => t.remove(), 4200);
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
	events: undefined,
	onEntry: undefined,
};

const PALETTE = [
	{ id: "chat", label: "Chat", group: "Lavoro" },
	{ id: "segreteria", label: "Segreteria", group: "Lavoro", when: (i) => i?.hasSegreteria },
	{ id: "approvazioni", label: "Approvazioni", group: "Lavoro", count: () => state.pendingApprovals },
	{ id: "task", label: "Task programmati", group: "Lavoro" },
	{ id: "file", label: "File", group: "Lavoro" },
	{ id: "memoria", label: "Memoria", group: "Lavoro" },
	{ id: "connettori", label: "Connettori", group: "Gestione", owner: true },
	{ id: "impostazioni", label: "Impostazioni", group: "Gestione", owner: true },
	{ id: "persone", label: "Persone", group: "Gestione", owner: true },
	{ id: "attivita", label: "Attività e spesa", group: "Gestione" },
];

function route() {
	const [view = "chat", ...rest] = location.hash.replace(/^#\/?/, "").split("/");
	return { view, rest: rest.map(decodeURIComponent) };
}

function go(view, ...rest) {
	location.hash = `#/${[view, ...rest].map(encodeURIComponent).join("/")}`;
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
	} catch {
		return;
	}
	await refreshInstances();
	if (location.hash.startsWith("#/google?")) await finishGoogle();
	connectEvents();
	window.addEventListener("hashchange", render);
	render();
	setInterval(refreshCounters, 30_000);
}

async function refreshInstances() {
	state.instances = (await api("/api/instances")).instances;
	const saved = store("annie.instance");
	state.instance = state.instances.find((i) => i.id === saved) ?? state.instances[0];
	await refreshCounters();
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
	$app.replaceChildren(
		h(
			"div.login",
			h(
				"div.card",
				h("div.login-mark", h("img", { src: "/icon.svg", alt: "", width: "40", height: "40" })),
				h("h1", "Accedi ad Annie"),
				h("p", "Per entrare usa il link personale che ti ha dato chi gestisce Annie. Il link ti riconosce: non condividerlo."),
				error ? h("p.chip.bad", error) : null,
				h("p.muted", "Hai perso il link? Chiedi all'owner di generarne uno nuovo: quello vecchio smetterà di funzionare."),
			),
		),
	);
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
	$app.replaceChildren(
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

/** The person's own Google account, in the account dialog. */
function googleSection() {
	const box = h("div.card.pad.stack");
	const draw = async () => {
		const { available, account, services } = await api("/api/google");
		if (!available) return box.remove();
		const what = services.length > 1 ? "la tua posta e il tuo calendario" : services[0] === "gmail" ? "la tua posta" : "il tuo calendario";
		if (account) {
			box.replaceChildren(
				h("div.kicker", "Google"),
				h("p", h("span.chip.ok", "Collegato"), " ", account.email),
				h("p.muted", `Annie legge ${what} quando glielo chiedi dalla console, o nel brief del mattino. Non invia mail e non cambia eventi.`),
				h(
					"div.actions",
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
		box.replaceChildren(
			h("div.kicker", "Google"),
			h("p", `Collega Google: Annie potrà leggere ${what}, solo leggere, quando glielo chiedi dalla console.`),
			h(
				"div.actions",
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								location.assign((await api("/api/google/start", { method: "POST", body: {} })).url);
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Collega Google",
				),
			),
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
		h("p.muted", "Chi ha collegato il proprio Google (dal menu del suo account) può chiedere a questa istanza di leggere la sua posta e il suo calendario, solo nelle sue conversazioni dalla console."),
		h("label.row-gap", toggle, h("span", "Consenti Google a questa istanza")),
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
		h("p.muted", "I siti che Annie può leggere e fotografare (web_read, web_screenshot). Solo lettura: non compila moduli e non invia niente. Un dominio per riga, i sottodomini sono compresi; * vuol dire tutti i siti pubblici. Vuoto: nessuno."),
		h("label.field", h("span", "Siti consentiti"), list),
		h("button.btn", { onclick: save }, "Salva i siti"),
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
			body.replaceChildren(
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
		body.replaceChildren(
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
								body.replaceChildren(
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
function render() {
	if (!state.me) return renderLogin();
	const { view } = route();
	const item = PALETTE.find((p) => p.id === view) ?? PALETTE[0];
	if (item.owner && state.me.role !== "owner") return go("chat");
	const main = h("main", { id: "main" });
	const shell = h(
		"div.shell",
		h("header.topbar", h("button.icon-btn", { "aria-label": "Menu", onclick: () => shell.classList.toggle("open") }, icon("menu")), h("b", h("img", { src: "/icon.svg", alt: "", width: "20", height: "20" }), "Annie"), h("button.icon-btn", { "aria-label": "Cerca", onclick: openPalette }, icon("search"))),
		h("aside.rail", { id: "rail" }),
		main,
	);
	$app.replaceChildren(shell);
	renderRail();
	state.onEntry = undefined;
	const views = { chat: viewChat, segreteria: viewSegreteria, approvazioni: viewApprovals, task: viewTasks, file: viewFiles, memoria: viewMemory, connettori: viewConnectors, impostazioni: viewSettings, persone: viewPeople, attivita: viewActivity };
	(views[item.id] ?? viewChat)(main).catch((error) => {
		if (error instanceof ApiError && error.status === 401) return;
		main.replaceChildren(h("div.empty", h("b", "Qualcosa non va"), error.message));
	});
}

function renderRail() {
	const rail = document.getElementById("rail");
	if (!rail) return;
	const { view } = route();
	const items = PALETTE.filter((p) => (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance)));
	const nav = h("nav.sections", { "aria-label": "Sezioni" });
	let group;
	for (const item of items) {
		if (item.group !== group) {
			group = item.group;
			nav.append(h("div.group", group));
		}
		const count = item.id === "chat" ? state.unread.size : (item.count?.() ?? 0);
		nav.append(h("a", { href: `#/${item.id}`, "aria-current": view === item.id ? "page" : undefined, onclick: () => document.querySelector(".shell")?.classList.remove("open") }, icon(item.id), h("span.label", item.label), count > 0 ? h("span.count", String(count)) : null));
	}
	const u = state.usage;
	const share = u ? Math.min(1, u.todayUsd / u.hardUsd) : 0;
	rail.replaceChildren(
		h("div.brand", h("img", { src: "/icon.svg", alt: "", width: "22", height: "22" }), h("b", "Annie")),
		h("button.search", { onclick: openPalette, "aria-label": "Vai a una sezione" }, icon("search"), h("span", "Vai a…"), h("kbd", navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
		state.instances.length > 1
			? h(
					"div.instance-pick",
					h("label", { for: "instance" }, "Istanza"),
					h(
						"select",
						{
							id: "instance",
							onchange: (e) => {
								state.instance = state.instances.find((i) => i.id === e.target.value);
								store("annie.instance", state.instance.id);
								render();
							},
						},
						state.instances.map((i) => h("option", { value: i.id, selected: i.id === state.instance?.id ? "selected" : undefined }, i.name)),
					),
				)
			: h("div.instance-pick", h("label", "Istanza"), h("div.mono", state.instance?.name ?? "nessuna")),
		state.me.role === "owner" ? h("button.add-instance", { onclick: instanceForm }, icon("plus"), h("span", "Nuova istanza")) : null,
		nav,
		h(
			"div.rail-foot",
			u
				? h(
						"div.spend",
						h("div.row", h("span", "Spesa di oggi"), h("b.mono", fmt.usd(u.todayUsd))),
						h("div.bar", h(`i${share >= 1 ? ".bad" : u.todayUsd >= u.softUsd ? ".warn" : ""}`, { "data-w": share })),
						h("div.row", h("span.muted", `soglia ${fmt.usd(u.softUsd)}`), h("span.muted", `tetto ${fmt.usd(u.hardUsd)}`)),
					)
				: null,
			h(
				"div.who",
				h("button.who-id", { onclick: accountDialog, title: "Il tuo account" }, h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)), h("div", h("div.name", state.me.name), h("div.role", `${state.me.role === "owner" ? "Owner" : "Membro"}${state.me.twoFactor ? " · verifica attiva" : ""}`))),
				h(
					"div.row-gap",
					h("button.icon-btn", { title: "Tema chiaro/scuro", "aria-label": "Cambia tema", onclick: cycleTheme }, icon("theme")),
					h(
						"button.icon-btn",
						{
							title: "Esci",
							"aria-label": "Esci",
							onclick: async () => {
								await api("/api/logout", { method: "POST" }).catch(() => {});
								state.me = undefined;
								renderLogin();
							},
						},
						icon("logout"),
					),
				),
			),
		),
	);
	const bar = rail.querySelector(".spend .bar i");
	if (bar) requestAnimationFrame(() => (bar.style.width = `${Math.max(2, Number(bar.dataset.w) * 100)}%`));
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
		list.replaceChildren(
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
	main.replaceChildren(h("div.empty", h("b", "Nessuna istanza"), "Non hai ancora accesso a nessuna istanza. Chiedi all'owner di aggiungerti."));
	return true;
}

// ---------- chat ----------
async function viewChat(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	if (!inst.canChat) {
		main.replaceChildren(head(inst.name, "Chat", null), h("div.card.empty", h("b", "Chat non disponibile"), state.me.role === "owner" ? "Aggiungi te stesso alle persone che possono scrivere a questa istanza, in Impostazioni." : "Non sei tra le persone che possono scrivere a questa istanza."));
		return;
	}
	const threadId = route().rest[0];
	const { threads } = await api(`/api/instances/${inst.id}/threads`);
	const list = h("ul");
	for (const t of threads) {
		list.append(
			h(
				"li",
				h(
					"a",
					{ href: `#/chat/${encodeURIComponent(t.id)}`, "aria-current": t.id === threadId ? "true" : undefined },
					h("span.t", t.title),
					h("span.d", h("span", fmt.time(t.updatedAt)), state.unread.has(t.id) ? h("span.dot", { "aria-label": "non letto" }) : null),
				),
			),
		);
	}
	const newThread = async (first) => {
		const { thread } = await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: {} });
		if (first) store(`annie.draft.${thread.id}`, first);
		go("chat", thread.id);
	};
	const side = h("section.card.threads", h("header", h("b", "Conversazioni"), h("button.btn.small.ghost", { onclick: () => newThread(), "aria-label": "Nuova conversazione" }, icon("plus"), "Nuova")), threads.length ? list : h("p.muted", h("span", "")));
	const conversation = h("section.card.conversation");
	main.replaceChildren(head(inst.name, h("h1", "Chat"), null), h("div.chat", side, conversation));
	if (!threadId) {
		conversation.append(
			h(
				"div.welcome",
				h("h2", "Di cosa hai bisogno?"),
				h("p", "Annie risponde, prepara file, programma promemoria e usa i connettori della tua azienda. Le azioni delicate passano sempre da un'approvazione."),
				h(
					"div.hints",
					["Riassumi in punti il file che ti carico", "Ricordami ogni lunedì alle 9 di controllare gli ordini", "Prepara un CSV con i clienti citati", "Quali strumenti hai a disposizione?"].map((t) => h("button", { onclick: () => newThread(t) }, t)),
				),
			),
		);
		return;
	}
	state.unread.delete(threadId);
	renderRail();
	const { entries } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}`);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	let typing;
	const show = (entry) => {
		const body = entry.file
			? h("a.file", { href: `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(entry.file.path)}` }, h("span.ext", (entry.file.path.split(".").pop() ?? "file").slice(0, 4)), h("span", h("b", entry.file.path.split("/").pop()), entry.file.caption ? h("div.muted", entry.file.caption) : null))
			: h("div.body", entry.text ?? "");
		transcript.append(h(`div.msg.${entry.from}`, h("div.meta", fmt.time(entry.at)), body));
	};
	for (const e of entries) show(e);
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
		transcript.scrollTop = transcript.scrollHeight;
		return true;
	};
	const input = h("textarea", { rows: 1, placeholder: "Scrivi ad Annie…", title: "Invio per inviare, Maiusc+Invio per andare a capo", "aria-label": "Messaggio", value: store(`annie.draft.${threadId}`) ?? "" });
	const send = async () => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		input.style.height = "auto";
		store(`annie.draft.${threadId}`, "");
		show({ from: "person", text, at: new Date().toISOString() });
		const current = list.querySelector('[aria-current="true"] .t');
		if (current && current.textContent === "Nuova chat") current.textContent = text.replace(/\s+/g, " ").slice(0, 60);
		startTyping();
		try {
			await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", body: { text } });
		} catch (error) {
			stopTyping();
			toast(error.message, true);
			input.value = text;
		}
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		}
	});
	input.addEventListener("input", () => {
		store(`annie.draft.${threadId}`, input.value);
		input.style.height = "auto";
		input.style.height = `${Math.min(220, input.scrollHeight)}px`;
	});
	const file = h("input", { type: "file", class: "sr", "aria-label": "Carica un file" });
	file.addEventListener("change", async () => {
		const f = file.files?.[0];
		if (!f) return;
		try {
			const { file: saved } = await api(`/api/instances/${inst.id}/files/raw?name=${encodeURIComponent(f.name)}`, { method: "PUT", raw: f });
			input.value = `${input.value ? `${input.value}\n` : ""}[File caricato nel workspace: ${saved.path}] `;
			input.focus();
			toast(`Caricato ${saved.path}`);
		} catch (error) {
			toast(error.message, true);
		}
		file.value = "";
	});
	conversation.append(
		transcript,
		h("div.composer", h("label.btn.ghost.attach", { title: "Carica un file" }, "File", file), input, h("button.btn.accent", { onclick: send }, "Invia")),
	);
	transcript.scrollTop = transcript.scrollHeight;
	input.focus();
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
	main.replaceChildren(
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
	detail.replaceChildren(
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
	main.replaceChildren(
		head(inst.name, h("h1", "Approvazioni"), "Tutto ciò che aspetta una tua decisione: le bozze della segreteria e i tool che Annie scrive da sola, spenti finché un approvatore non li legge e li approva."),
		h("div.stack", drafts, pending.length ? pending.map(card) : drafts.length ? null : h("div.card.empty", h("b", "Niente da approvare"), "Le bozze della segreteria e i tool che Annie propone compaiono qui (e su Telegram o WhatsApp)."), decided.length ? [h("div.kicker", "Decisi"), decided.map(card)] : null),
	);
}

// ---------- task ----------
async function viewTasks(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ schedules }, threads, briefState] = await Promise.all([
		api(`/api/instances/${inst.id}/schedules`),
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
	const drawWhen = () => whenBox.replaceChildren(mode === "cron" ? h("label.field", h("span", "Ripetizione (cron, fuso Europe/Rome)"), cron, presets, h("small", "minuto ora giorno mese giorno-settimana")) : h("label.field", h("span", "Data e ora"), at));
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
	main.replaceChildren(
		head(inst.name, h("h1", "Task programmati"), "Istruzioni che Annie esegue da sola, una volta o a ripetizione. Il risultato arriva nella chat scelta."),
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
	);
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
	main.replaceChildren(
		head(inst.name, h("h1", "File"), `Il workspace di ${inst.name}: i file che crea e quelli che le date. ${files.length} file, ${fmt.bytes(total)}.`, h("label.btn.accent", "Carica un file", upload)),
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
	main.replaceChildren(
		head(inst.name, h("h1", "Memoria"), "Quello che Annie ricorda di te tra una conversazione e l'altra, e le cose che valgono per tutti. Lo vede solo chi ne è il soggetto; quelle condivise le vede chiunque scriva ad Annie."),
		h(
			"div.grid-2",
			h("div.card", h("div.pad", h("h3", "Su di te")), list(mine, true, "Annie non ricorda ancora niente di te. Puoi dirle «ricordati che…» in chat, o aggiungerlo qui."), add(false)),
			h("div.card", h("div.pad", h("h3", "Condivise")), list(shared, canEditShared, "Nessuna memoria condivisa."), canEditShared ? add(true) : h("p.muted.pad", "Solo l'owner aggiunge o toglie memorie condivise.")),
		),
	);
}

// ---------- connettori ----------
async function viewConnectors(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { connectors } = await api(`/api/instances/${inst.id}/connectors`);
	const cards = connectors.map((c) => {
		const st = c.status;
		const chip = !c.enabled ? h("span.chip", "Spento") : !c.allowed ? h("span.chip.warn", "Non consentito") : st?.connected ? h("span.chip.ok", `${st.tools.length} tool`) : h("span.chip.bad", "Non collegato");
		return h(
			"div.card.pad.stack",
			h("div.row-gap", h("h3", c.name), chip),
			h("div.mono.muted", c.transport.type === "http" ? c.transport.url : `${c.transport.command} ${(c.transport.args ?? []).join(" ")}`),
			st?.error ? h("p.chip.bad", st.error) : null,
			st?.tools?.length ? h("p.mono", st.tools.join("  ")) : null,
			h(
				"div.row-gap",
				h("button.btn.small.ghost", { onclick: () => connectorForm(inst, c) }, "Modifica"),
				h(
					"button.btn.small.danger",
					{
						onclick: () =>
							confirmDialog(`Rimuovere ${c.name}?`, "Annie perde i suoi tool. I segreti restano nel secret store.", "Rimuovi", async () => {
								await api(`/api/instances/${inst.id}/connectors/${c.id}`, { method: "DELETE" });
								render();
							}),
					},
					"Rimuovi",
				),
			),
		);
	});
	main.replaceChildren(
		head(inst.name, h("h1", "Connettori"), "Server MCP che danno ad Annie i tool dei vostri sistemi. Ognuno raggiunge solo il suo host, e solo se consentito.", h("button.btn.accent", { onclick: () => connectorForm(inst) }, "+ Connettore")),
		connectors.length ? h("div.grid-2", cards) : h("div.card.empty", h("b", "Nessun connettore"), "Aggiungi un server MCP (HTTP o locale) per dare ad Annie nuovi strumenti."),
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
	const box = h("div");
	const draw = () => box.replaceChildren(type.value === "http" ? h("label.field", h("span", "URL"), url) : h("label.field", h("span", "Comando"), command, h("small", "Gira sul server di Annie: solo comandi di cui ti fidi.")));
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
									? { type: "http", url: url.value.trim(), headerSecrets: { ...(prev.type === "http" ? prev.headerSecrets : {}), ...secrets } }
									: (() => {
											const [cmd, ...args] = command.value.trim().split(/\s+/);
											return { type: "stdio", command: cmd, args, envSecrets: { ...(prev.type === "stdio" ? prev.envSecrets : {}), ...secrets } };
										})();
							const { status } = await api(`/api/instances/${inst.id}/connectors/${encodeURIComponent(cid)}`, { method: "PUT", body: { name: name.value.trim() || cid, transport, enabled: enabled.checked, allowed: allowed.checked } });
							dialog.close();
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
	const instructions = h("textarea", { rows: 5, placeholder: "Lascia vuoto per le istruzioni predefinite di Annie." });
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
			go("chat");
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
		h("label.field", h("span", "Istruzioni"), instructions),
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
	const [{ settings }, { people }, tg, wa, google, voice] = await Promise.all([
		api(`/api/instances/${inst.id}/settings`),
		api("/api/people"),
		api(`/api/instances/${inst.id}/telegram`).catch(() => undefined),
		api(`/api/instances/${inst.id}/whatsapp`).catch(() => undefined),
		api("/api/google").catch(() => ({ available: false })),
		api("/api/voice").catch(() => ({ available: false })),
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
	main.replaceChildren(
		head(inst.name, h("h1", "Impostazioni"), "Chi può usare questa istanza dal web, chi approva le sue azioni, e come si comporta.", h("button.btn.accent", { onclick: save }, "Salva")),
		h(
			"div.grid-2",
			h(
				"div.stack",
				h("div.card.pad", h("label.field", h("span", "Nome"), name), h("label.field", h("span", "Istruzioni"), instructions, h("small", "Il carattere e le regole di Annie per questa istanza."))),
				tg === undefined ? null : telegramCard(inst, tg.telegram),
				wa === undefined ? null : whatsappCard(inst, wa.whatsapp),
				google.available ? googleCard(inst, (settings.egress.connectors ?? []).includes("google")) : null,
				voice.available ? voiceCard(inst, voice.host, (settings.egress.connectors ?? []).includes("voice")) : null,
				webCard(inst, settings.egress.web ?? []),
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
		h("label.field", h("span", "Chi può scrivere"), allowed, h("small", "ID numerici di Telegram, separati da virgole. Chi non è in elenco non riceve risposta.")),
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
	const numbers = (input) => input.value.split(/[\s,]+/).map((n) => n.replace(/^\+/, "")).filter(Boolean);
	const save = async () => {
		try {
			const given = { accessToken: accessToken.value.trim(), phoneNumberId: phoneNumberId.value.trim(), appSecret: appSecret.value.trim() };
			const body = { ...Object.fromEntries(Object.entries(given).filter(([, v]) => v)), allowedUsers: numbers(allowed), approvers: numbers(approvers) };
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
		h("label.field", h("span", "Chi approva"), approvers, h("small", "Ricevono su WhatsApp le schede dei tool da approvare, se hanno scritto ad Annie nelle ultime 24 ore.")),
		h("div.actions", h("button.btn.accent", { onclick: save }, w.connected ? "Salva" : "Collega"), w.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
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
	main.replaceChildren(
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
	main.replaceChildren(
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
