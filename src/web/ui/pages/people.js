// Persone page.
import { api, confirmDialog, fmt, h, head, icon, monogram, mount, state, toast } from "../common.js";
import { render } from "../shell.js";

// ---------- persone ----------
export async function viewPeople(main) {
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
		head(null, h("h1", "Persone"), "Chi può entrare nella console. Ognuno ha un link personale; rigenerarlo chiude le sue sessioni."),
		h(
			"div.grid-2",
			h(
				"div.card",
				h(
					"ul.task-list.people-list",
					people.map((p) =>
						h(
							"li.task-row.person-row",
							monogram(p.name),
							h(
								"div.task-text",
								h("b", p.name, p.id === state.me.id ? h("span.chip", "tu") : null),
								h("small", p.role === "owner" ? "Owner" : "Membro", ` · dal ${fmt.day(p.createdAt)}`, p.twoFactor ? " · verifica in 2 passaggi" : ""),
							),
							h(
								"div.person-actions",
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
											"button.icon-btn.task-remove",
											{
												title: `Rimuovi ${p.name}`,
												"aria-label": `Rimuovi ${p.name}`,
												onclick: () =>
													confirmDialog(`Rimuovere ${p.name}?`, "Non potrà più entrare.", "Rimuovi", async () => {
														await api(`/api/people/${p.id}`, { method: "DELETE" });
														render();
													}),
											},
											icon("trash"),
										)
									: null,
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

