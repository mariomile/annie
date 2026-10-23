// Shell: sidebar, account menu, theme.
import { accountDialog } from "./account.js";
import { $app, api, ApiError, emptyNote, face, fmt, go, h, icon, initials, mount, route, state, store, toast } from "./common.js";
import { renderLogin } from "./login.js";
import { viewActivity } from "./pages/activity.js";
import { agentForm, viewAgents } from "./pages/agents.js";
import { viewApprovals } from "./pages/approvals.js";
import { viewAutomations } from "./pages/automations.js";
import { viewBoard } from "./pages/board.js";
import { closeModelMenu, viewChat } from "./pages/chat.js";
import { viewConnectors } from "./pages/connectors.js";
import { viewFiles } from "./pages/files.js";
import { viewMemory } from "./pages/memory.js";
import { viewPeople } from "./pages/people.js";
import { viewRooms } from "./pages/rooms.js";
import { viewSegreteria } from "./pages/segreteria.js";
import { viewSettings } from "./pages/settings.js";
import { viewSkills } from "./pages/skills.js";
import { viewStart } from "./pages/start.js";
import { viewTasks } from "./pages/tasks.js";
import { openPalette } from "./palette.js";
import { install, installed, installOffer } from "./pwa.js";
import { applyTheme, refreshSetup } from "./session.js";

// ---------- shell ----------
/**
 * Every page of the console, in the order of the sidebar and of the command palette. `sidebar`: reached
 * from the sidebar (the rest sits in the account menu). `owner`: only for the owner. `when(instance)`:
 * shown only then. `count()`: the number beside it. A new page is its file in pages/, one row here and
 * one line in sw.js.
 */
export const PAGES = [
	{ id: "inizia", label: "Primi passi", group: "Lavoro", sidebar: true, owner: true, when: () => state.setupLeft > 0, count: () => state.setupLeft, view: viewStart },
	{ id: "chat", label: "Chat", group: "Lavoro", view: viewChat },
	{ id: "agenti", label: "Agenti", group: "Lavoro", sidebar: true, count: () => (state.instances.length > 1 ? state.instances.length : 0), view: viewAgents },
	{ id: "stanze", label: "Stanze", group: "Lavoro", sidebar: true, when: () => state.instances.filter((i) => i.canChat).length > 1, view: viewRooms },
	{ id: "board", label: "Board", group: "Lavoro", sidebar: true, count: () => state.boardReview, view: viewBoard },
	{ id: "segreteria", label: "Segreteria", group: "Lavoro", sidebar: true, when: (i) => i?.hasSegreteria, view: viewSegreteria },
	{ id: "approvazioni", label: "Approvazioni", group: "Lavoro", sidebar: true, count: () => state.pendingApprovals, view: viewApprovals },
	{ id: "task", label: "Task e sentinelle", group: "Lavoro", sidebar: true, view: viewTasks },
	{ id: "automazioni", label: "Automazioni", group: "Lavoro", sidebar: true, view: viewAutomations },
	{ id: "file", label: "File", group: "Lavoro", sidebar: true, view: viewFiles },
	{ id: "memoria", label: "Memoria", group: "Lavoro", sidebar: true, view: viewMemory },
	{ id: "skill", label: "Skill", group: "Lavoro", sidebar: true, view: viewSkills },
	{ id: "connettori", label: "Connettori", group: "Gestione", owner: true, view: viewConnectors },
	{ id: "impostazioni", label: "Impostazioni", group: "Gestione", owner: true, view: viewSettings },
	{ id: "persone", label: "Persone", group: "Gestione", owner: true, view: viewPeople },
	{ id: "attivita", label: "Attività e spesa", group: "Gestione", view: viewActivity },
];
const railPhone = matchMedia("(max-width: 860px)");
railPhone.addEventListener("change", syncRailControls);

export function render() {
	if (!state.me) return renderLogin();
	const { view } = route();
	const item = PAGES.find((p) => p.id === view) ?? PAGES.find((p) => p.id === "chat");
	if (item.owner && state.me.role !== "owner") return go("chat");
	closeMenu();
	closeModelMenu();
	const main = h("main", { id: "main", class: item.id === "chat" || (item.id === "stanze" && route().rest[0]) ? "is-chat" : "is-page" });
	const shell = h(
		`div.shell${store("annie.rail") === "closed" ? ".collapsed" : ""}`,
		h(
			"header.topbar",
			h("button.icon-btn.rail-menu", {
				"aria-label": "Apri la barra laterale", "aria-controls": "rail", "aria-expanded": "false",
				onclick: () => {
					shell.classList.toggle("open");
					syncRailControls();
				},
			}, icon("menu")),
			// With more agenti, the open one: who a new chat goes to.
			state.instances.length > 1 && state.instance ? h("b.topbar-who", face(state.instance, 22), state.instance.name) : h("b", "Annie"),
			h("button.icon-btn", { "aria-label": "Nuova chat", title: "Nuova chat", onclick: () => go("chat") }, icon("compose")),
		),
		h("div.scrim", { onclick: closeRailOnPhone }),
		h("aside.rail", { id: "rail" }),
		main,
	);
	mount($app, shell);
	renderRail();
	void refreshThreads().then(renderRail);
	state.onEntry = undefined;
	state.onRoom = undefined;
	state.onRun = undefined;
	state.onRunsReconnect = undefined;
	item.view(main).catch((error) => {
		if (error instanceof ApiError && error.status === 401) return;
		mount(main, emptyNote("div.empty", "Qualcosa non va", error.message));
	});
}

function toggleRail() {
	const shell = document.querySelector(".shell");
	if (!shell) return;
	shell.classList.toggle("collapsed");
	store("annie.rail", shell.classList.contains("collapsed") ? "closed" : "open");
	syncRailControls();
}

/** The same desktop control expands the icon rail; the phone keeps its full overlay. */
function syncRailControls() {
	const shell = document.querySelector(".shell");
	if (!shell) return;
	const expanded = !shell.classList.contains("collapsed");
	const toggle = shell.querySelector(".rail .collapse");
	if (toggle) {
		const label = expanded ? "Chiudi la barra laterale" : "Apri la barra laterale";
		toggle.setAttribute("aria-expanded", String(expanded));
		toggle.setAttribute("aria-label", label);
		toggle.setAttribute("title", label);
	}
	const menu = shell.querySelector(".rail-menu");
	const open = shell.classList.contains("open");
	if (menu) {
		menu.setAttribute("aria-expanded", String(open));
		menu.setAttribute("aria-label", open ? "Chiudi la barra laterale" : "Apri la barra laterale");
	}
	const rail = shell.querySelector(".rail");
	if (rail) rail.inert = railPhone.matches && !open;
}

/** The current instance's conversations, for the sidebar; none for someone who cannot chat there. */
export async function refreshThreads() {
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
	syncRailControls();
}

export function renderRail() {
	const rail = document.getElementById("rail");
	if (!rail) return;
	const scrollTop = rail.querySelector(".rail-scroll")?.scrollTop ?? 0;
	const { view, rest } = route();
	const items = PAGES.filter((p) => p.sidebar && (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance)));
	const nav = h("nav.sections", { "aria-label": "Sezioni" });
	for (const item of items) {
		const count = item.count?.() ?? 0;
		const label = count > 0 ? `${item.label} (${count})` : item.label;
		nav.append(h("a", { href: `#/${item.id}`, "aria-current": view === item.id ? "page" : undefined, "aria-label": label, title: label, onclick: closeRailOnPhone }, icon(item.id), h("span.label", item.label), count > 0 ? h("span.count", { "aria-hidden": "true" }, String(count)) : null));
	}
	const past = h("nav.history", { "aria-label": "Conversazioni" });
	const agent = state.instance;
	let group;
	for (const t of state.threads ?? []) {
		const g = threadGroup(t.updatedAt);
		if (g !== group) {
			group = g;
			past.append(h("div.group", g));
		}
		const current = view === "chat" && rest[0] === t.id;
		const label = `${agent?.name ?? "Agente"} · ${t.title}`;
		const unread = state.unread.has(t.id);
		past.append(
			h(
				"a",
				{ href: `#/chat/${encodeURIComponent(t.id)}`, "aria-current": current ? "page" : undefined, "aria-label": `${label}${unread ? ", non letto" : ""}`, title: label, onclick: closeRailOnPhone },
				face(agent, 24),
				h("span.thread-text", h("span.name", agent?.name ?? "Agente"), h("span.title", t.title)),
				unread ? h("span.dot", { "aria-hidden": "true" }) : null,
			),
		);
	}
	mount(
		rail,
		h(
			"div.rail-top",
			h("a.brand", { href: "#/chat", "aria-label": "Annie", title: "Annie", onclick: closeRailOnPhone }, h("img", { src: "/icon.svg", alt: "", width: "22", height: "22" }), h("b", "Annie")),
			h("button.icon-btn.collapse", { "aria-label": "Chiudi la barra laterale", "aria-controls": "rail", "aria-expanded": "true", title: "Chiudi la barra laterale", onclick: toggleRail }, icon("sidebar")),
		),
		h(
			"div.rail-actions",
			h("a.rail-btn", { href: "#/chat", "aria-current": view === "chat" && !rest[0] ? "page" : undefined, "aria-label": "Nuova chat", title: "Nuova chat", onclick: closeRailOnPhone }, icon("compose"), h("span.label", "Nuova chat")),
			h("button.rail-btn", { onclick: openPalette, "aria-label": "Vai a una sezione", title: "Cerca" }, icon("search"), h("span.label", "Cerca"), h("kbd", navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
		),
		h(
			"div.rail-scroll",
			state.instances.length
				? h(
						"nav.roster",
						{ "aria-label": "Agenti" },
						state.instances.map((i) =>
							h(
								"button.roster-item",
								{
									"aria-current": i.id === state.instance?.id ? "true" : undefined,
									"aria-label": i.name,
									title: i.tagline ? `${i.name}: ${i.tagline}` : i.name,
									onclick: () => {
										closeRailOnPhone();
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
								h("span.roster-text", h("span.name", i.name), i.tagline ? h("span.line", i.tagline) : null),
							),
						),
					)
				: null,
			nav,
			past.childElementCount ? past : null,
		),
		h(
			"div.rail-foot",
			h(
				"button.who-id",
				{ onclick: openMenu, "aria-haspopup": "menu", "aria-expanded": document.querySelector(".menu") ? "true" : "false", "aria-label": `Account e gestione, ${state.me.name}`, title: "Account e gestione" },
				h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)),
				h("span.who-text", h("span.name", state.me.name), h("span.role", state.instance?.name ?? (state.me.role === "owner" ? "Owner" : "Membro"))),
				icon("more"),
			),
		),
	);
	rail.querySelector(".rail-scroll").scrollTop = scrollTop;
	syncRailControls();
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
		const item = PAGES.find((p) => p.id === id);
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
export function closeMenu() {
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

