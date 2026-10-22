// Approvals page, with the connector and Google action cards.
import { agentLabel, api, decisionCard, emptyNote, fmt, go, h, head, mount, needInstance, state, store, toast } from "../common.js";
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
			pendingActions.map(actionCard),
			pending.map(card),
			drafts.length || pendingGoogle.length || pendingConnector.length || pendingActions.length || pending.length ? null : emptyNote("div.card.empty", "Niente da approvare", "Le mail e gli eventi che Annie prepara per te compaiono qui e in chat; le azioni sui servizi collegati, le bozze della segreteria, i moduli da inviare e i tool che Annie propone qui e su Telegram o WhatsApp."),
			decidedGoogle.length || decidedConnector.length || decidedActions.length || decided.length ? [h("h3.section-title", "Decisi"), decidedGoogle, decidedConnector, decidedActions.slice(0, 20).map(actionCard), decided.map(card)] : null,
		),
	);
}

// ---------- Connettori: azioni che cambiano qualcosa ----------
const CONNECTOR_STAMP = { done: ["ok", "Fatto"], failed: ["bad", "Non riuscito"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In corso"] };

/** A call to a connected service waiting for a person: why, what, with which values, whole; approve runs it once. */
export function connectorActionCard(inst, a, after, compact = false) {
	const el = h(
		"article.card.pad.dossier",
		h("header", h("div", h("h2", a.reason), h("small.dossier-meta", `${a.connectorName} · ${fmt.time(a.proposedAt)}`)), a.status === "pending" ? h(a.destructive ? "span.chip.bad" : "span.chip.accent", a.destructive ? "Può cancellare o sovrascrivere" : "In attesa") : null),
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
	return compact ? el : decisionCard(el, inst, a.status === "pending");
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
export function googleActionCard(inst, a, after, compact = false) {
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
		h("header", h("div", h("h2", googleTitle(a)), h("small.dossier-meta", kicker)), a.status === "pending" ? h("span.chip.accent", "Da approvare") : null),
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
	return compact ? el : decisionCard(el, inst, a.status === "pending");
}

