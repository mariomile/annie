import { api, fmt, h, icon, mount, state, store, toast } from "./common.js";

const STATUS = { queued: "In coda", running: "In corso", succeeded: "Risposta pronta", failed: "Non riuscita", cancelled: "Interrotta" };
const SOURCE = { message: "Chat", schedule: "Task programmato", brief: "Brief", watch: "Sentinella", automation: "Automazione", notice: "Avviso", agent: "Passaggio tra agenti" };
const PROGRESS = { model: "Preparo la risposta", tool_start: "Eseguo un'azione", tool_progress: "L'azione è in corso", tool_end: "Azione terminata", retry: "Riprovo la richiesta al modello" };
const stepText = (step) => PROGRESS[step.kind] ?? "Lavoro in corso";
export const activeRun = (run) => run.status === "queued" || run.status === "running";
const clock = (at) => new Date(at).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const label = (run) => run.cancelRequestedAt && activeRun(run) ? "Interruzione in corso…" : STATUS[run.status] ?? run.status;

function details(run) {
	const progress = run.progress ?? [];
	return h("details.run-details", h("summary", `Passaggi${progress.length ? ` · ${progress.length}` : ""}`),
		progress.length ? h("ol.run-steps", progress.map((step) => h("li", h("time", fmt.time(step.at)), h("span", stepText(step))))) : h("p.muted", "Nessun passaggio registrato."),
		run.error ? h("p.error", "L'agente non ha completato il lavoro. Apri la conversazione per riprovare.") : null,
		run.status === "succeeded" && run.delivery === "failed" ? h("p.error", "La risposta è pronta, ma la consegna non è riuscita.") : null,
		run.status === "succeeded" && run.delivery === "pending" ? h("p.muted", "La consegna della risposta è ancora in attesa.") : null);
}

/** Real persisted state replaces the guess based on the last chat bubble. */
export function conversationRuns(inst, threadId, changed = () => {}) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}`;
	const el = h("section.run-control", { hidden: true, "aria-label": "Lavoro nella conversazione" });
	const text = h("span", { role: "status", "aria-live": "polite" });
	const stop = h("button.btn.ghost.small", { type: "button", title: "Interrompi il lavoro e i messaggi in coda di questa chat. Le azioni già completate restano.", onclick: () => void cancel() }, icon("stop"), "Stop");
	const steps = h("div");
	const refreshButton = h("button.btn.ghost.small", { type: "button", onclick: () => void refresh() }, "Riprova");
	mount(el, h("div.run-control-head", text, stop, refreshButton), steps);
	let runs = [];
	let refreshing;
	let dirty = false;
	let stopping = false;
	const draw = () => {
		const active = runs.filter(activeRun);
		const latest = active.find((run) => run.status === "running") ?? active[0] ?? runs[0];
		el.hidden = !latest;
		refreshButton.hidden = true;
		stop.hidden = active.length === 0;
		stop.disabled = stopping;
		mount(stop, icon("stop"), active.some((run) => run.cancelRequestedAt) && !stopping ? "Riprova Stop" : "Stop");
		if (latest) {
			const last = latest.progress?.at(-1);
			text.textContent = active.length ? `${label(latest)}${last ? ` · ${stepText(last)}` : ""}${active.length > 1 ? ` · ${active.length - 1} in coda` : ""}` : label(latest);
			mount(steps, latest.progress?.length || latest.error || latest.delivery === "failed" ? details(latest) : null);
		}
		changed(active.length > 0);
	};
	const update = (run) => {
		if (run.instanceId !== inst.id || run.threadId !== threadId) return false;
		const old = runs.find((row) => row.id === run.id);
		if (old && old.updatedAt > run.updatedAt) return true;
		const all = [run, ...runs.filter((row) => row.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		runs = [...all.filter(activeRun), ...all.filter((row) => !activeRun(row)).slice(0, 50)];
		draw();
		return true;
	};
	async function refresh() {
		dirty = true;
		if (refreshing) return refreshing;
		refreshing = (async () => {
			do {
				dirty = false;
				try {
					const result = await api(`${base}/runs`);
					// Events received during the read may be newer than its snapshot.
					for (const run of result.runs) update(run);
					draw();
				} catch (error) {
					el.hidden = false;
					text.textContent = "Stato del lavoro non disponibile";
					refreshButton.hidden = false;
				}
			} while (dirty);
		})().finally(() => { refreshing = undefined; if (dirty) return refresh(); });
		return refreshing;
	}
	async function cancel() {
		if (stopping) return;
		stopping = true;
		draw();
		try {
			const result = await api(`${base}/stop`, { method: "POST" });
			for (const run of result.runs) update(run);
			await refresh();
		} catch (error) {
			toast(error.message, true);
		} finally { stopping = false; draw(); }
	}
	// Reconnect reads durable state to cover events missed while offline.
	state.onRun = update;
	state.onRunsReconnect = () => void refresh();
	const timer = setInterval(() => {
		if (!el.isConnected) return clearInterval(timer);
		if (document.visibilityState === "visible") void refresh();
	}, 15_000);
	void refresh();
	return { el, refresh };
}

/** One outcome history shared by activity, tasks and webhook automations. */
export function runHistory(instances, { sources, names = new Map(), title = "Le tue esecuzioni" } = {}) {
	const list = h("div", h("p.muted", "Caricamento…"));
	const refreshButton = h("button.btn.ghost.small", { type: "button", onclick: () => void refresh() }, "Aggiorna");
	const el = h("section.card.pad.run-history", h("div.run-control-head", h("h2", title), refreshButton),
		h("p.muted", "Il lavoro nelle tue conversazioni della console. «Risposta pronta» indica che l'agente ha risposto: apri la chat per verificare il risultato e le approvazioni ancora necessarie."), list);
	let refreshing;
	let dirty = false;
	async function refresh() {
		dirty = true;
		if (refreshing) return refreshing;
		refreshButton.disabled = true;
		refreshing = (async () => {
			do {
			dirty = false;
			const query = sources ? `?sources=${encodeURIComponent(sources.join(","))}` : "";
			const results = await Promise.allSettled(instances.map(async (inst) => ({ inst, ...(await api(`/api/instances/${inst.id}/runs${query}`)) })));
			const failures = results.filter((result) => result.status === "rejected").length;
			const rows = results.filter((result) => result.status === "fulfilled").flatMap(({ value }) => value.runs.map((run) => ({ run, inst: value.inst })))
				.filter(({ run }) => !sources || sources.includes(run.source)).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)).slice(0, 100);
			mount(list,
				failures ? h("p.error", `Non è stato possibile caricare lo storico di ${failures} agenti. Riprova con Aggiorna.`) : null,
				rows.length ? h("ul.task-list", rows.map(({ run, inst }) => h("li.task-row.run-row",
					h(`span.chip${run.status === "failed" ? ".bad" : run.status === "succeeded" ? ".ok" : ""}`, label(run)),
					h("div.task-text", h("b", names.get(run.sourceId) ?? SOURCE[run.source] ?? "Esecuzione", " · ", inst.name), h("small", clock(run.createdAt)), details(run)),
					h("a.btn.ghost.small", { href: `#/chat/${encodeURIComponent(run.threadId)}`, onclick: () => { state.instance = inst; store("annie.instance", inst.id); } }, "Apri chat"))))
					: failures ? null : h("p.muted", "Nessuna esecuzione registrata. Le nuove attività compariranno qui."));
			} while (dirty);
		})().finally(() => { refreshing = undefined; refreshButton.disabled = false; if (dirty) return refresh(); });
		return refreshing;
	}
	let liveTimer;
	state.onRun = () => {
		if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = undefined; if (el.isConnected) void refresh(); }, 250);
		return false;
	};
	state.onRunsReconnect = () => void refresh();
	void refresh();
	return el;
}
