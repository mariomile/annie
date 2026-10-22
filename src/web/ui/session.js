// Starting the app: who is signed in, the agents, the counters, the live events.
import { $app, api, ApiError, emptyNote, h, mount, route, state, store, toast } from "./common.js";
import { renderCode, renderLogin } from "./login.js";
import { finishGoogle } from "./google.js";
import { setupLeft } from "./setup.js";
import { finishConnector } from "./signin.js";
import { refreshThreads, render, renderRail } from "./shell.js";

// ---------- boot ----------
// api() says a session is gone with this event (common.js imports nothing): show the login.
window.addEventListener("annie:unauthorized", () => renderLogin());

export async function boot() {
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
export async function enter() {
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
		mount($app, emptyNote("div.empty", "Riprovo…"));
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

export async function refreshInstances() {
	state.instances = (await api("/api/instances")).instances;
	const saved = store("annie.instance");
	state.instance = state.instances.find((i) => i.id === saved) ?? state.instances[0];
	await refreshCounters();
}

/** How many «Primi passi» are left, for the owner of the current instance. */
export async function refreshSetup() {
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
export function setupHidden(instanceId, hide) {
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

export async function refreshCounters() {
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
		toast(event.kind === "due" ? `Scheda #${event.n} ${event.text}: ${event.title}` : event.kind === "started" ? `Scheda #${event.n} partita da sola: ${event.title}` : `Scheda #${event.n} da rivedere: ${event.title}`);
	});
	state.events = es;
}

export function applyTheme(next) {
	if (next) store("annie.theme", next);
	const theme = store("annie.theme");
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
}

