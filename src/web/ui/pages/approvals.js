// Approvals page, with the connector and Google action cards.
import { agentLabel, api, emptyNote, fmt, go, h, head, mount, needInstance, state, store, toast } from "../common.js";
import { agentRequestCard, askedByNote, connectorActionCard, decisionCard, googleActionCard } from "../cards.js";
import { refreshCounters } from "../session.js";
import { render } from "../shell.js";

// ---------- approvazioni ----------
/** A proposed tool's name as a title: «cambio_eur» reads «Cambio eur». */
function toolTitle(name) {
	const words = name.replace(/[_-]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function viewApprovals(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { proposals } = await api(`/api/instances/${inst.id}/proposals`);
	const pending = proposals.filter((p) => p.status === "pending");
	const decided = proposals.filter((p) => p.status !== "pending").reverse();
	const card = (p) => {
		const el = h(
			"article.card.pad.dossier",
			h("header", h("div", h("h2", toolTitle(p.name)), h("small.dossier-meta", `Strumento nuovo · ${fmt.time(p.proposedAt)}`)), p.status === "pending" ? h("span.chip.accent", "In attesa") : null),
			h("p", p.description),
			h("div.reach", h("span", "Si chiama"), h("span.chip.mono", `custom_${p.name}`), h("span", "e può raggiungere"), p.hosts.length ? p.hosts.map((x) => h("span.chip.mono", x)) : h("span.chip.ok", "Nessun sito: niente rete")),
			h("details", { open: p.status === "pending" ? true : undefined }, h("summary", `Codice · ${p.code.split("\n").length} righe`), h("pre.code", p.code)),
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
		return decisionCard(el, inst, p.status === "pending");
	};
	const { actions } = await api(`/api/instances/${inst.id}/web-actions`);
	const ACTION_STAMP = { done: ["ok", "Inviato"], failed: ["bad", "Non inviato"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In invio"] };
	const actionCard = (a) => {
		const el = h(
			"article.card.pad.dossier",
			h("header", h("div", h("h2", `${inst.name} vuole inviare un modulo a `, h("span.mono", new URL(a.action).host)), h("small.dossier-meta", `Modulo da inviare · ${fmt.time(a.proposedAt)}`)), a.status === "pending" ? h("span.chip.accent", "In attesa") : null),
			askedByNote(a.askedBy),
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
		return decisionCard(el, inst, a.status === "pending");
	};
	const pendingActions = actions.filter((a) => a.status === "pending");
	const decidedActions = actions.filter((a) => a.status !== "pending").reverse();
	const { actions: connectorActions } = await api(`/api/instances/${inst.id}/connector-actions`).catch(() => ({ actions: [] }));
	const afterConnector = () => setTimeout(() => void refreshCounters().then(render), 600);
	const pendingConnector = connectorActions.filter((a) => a.status === "pending").map((a) => connectorActionCard(inst, a, afterConnector));
	const decidedConnector = connectorActions.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => connectorActionCard(inst, a, afterConnector));
	const { requests: agentRequests } = await api(`/api/instances/${inst.id}/agent-requests`).catch(() => ({ requests: [] }));
	const pendingAgent = agentRequests.filter((a) => a.status === "pending").map((a) => agentRequestCard(inst, a, afterConnector));
	const decidedAgent = agentRequests.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => agentRequestCard(inst, a, afterConnector));
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
					h("header", h("div", h("h2", `${waiting.length} ${waiting.length === 1 ? "bozza aspetta" : "bozze aspettano"} Approva`), h("small.dossier-meta", s.name)), h("span.chip.accent", "Segreteria")),
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
			pendingAgent,
			pendingActions.map(actionCard),
			pending.map(card),
			drafts.length || pendingGoogle.length || pendingConnector.length || pendingAgent.length || pendingActions.length || pending.length ? null : emptyNote("div.card.empty", "Niente da approvare", "Le mail e gli eventi che Annie prepara per te compaiono qui e in chat; le azioni sui servizi collegati, le bozze della segreteria, i moduli da inviare e i tool che Annie propone qui e su Telegram o WhatsApp."),
			decidedGoogle.length || decidedConnector.length || decidedAgent.length || decidedActions.length || decided.length ? [h("h3.section-title", "Decisi"), decidedGoogle, decidedConnector, decidedAgent, decidedActions.slice(0, 20).map(actionCard), decided.map(card)] : null,
		),
	);
}
