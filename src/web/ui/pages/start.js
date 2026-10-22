// Primi passi page.
import { agentLabel, api, go, h, head, icon, mount, needInstance, state, store, toast } from "../common.js";
import { providerOverview } from "../models.js";
import { setupLeft, setupSteps } from "../setup.js";
import { appleTouch, install, installOffer } from "../pwa.js";
import { setupHidden } from "../session.js";
import { render, renderRail } from "../shell.js";

// ---------- primi passi ----------
const TEMPLATES = [
	["Assistente personale", "Assistente personale di chi ti scrive. Rispondi in italiano, breve e diretta. Prima di fare qualcosa che manda messaggi o spende soldi, chiedi conferma."],
	["Negozio o studio", "Assistente di [nome dell'attività], a [città]. Aiuti il titolare con clienti, ordini e appuntamenti. Tono cordiale e professionale. Non promettere prezzi o date senza conferma."],
	["Team di lavoro", "Assistente del team di [azienda]. Prepari riassunti, documenti e promemoria, e cerchi informazioni aggiornate citando le fonti. Rispondi in italiano, in punti quando serve."],
];
const PLACEHOLDER = /\[[^\]\n]{1,60}\]/;

export async function viewStart(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ setup }, providers] = await Promise.all([
		api(`/api/instances/${inst.id}/setup`),
		api("/api/providers").catch(() => ({ localEnabled: false, providers: [] })),
	]);
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
		instructions: () => h("div.stack", h("div.choices", { role: "group", "aria-label": "Parti da un esempio" }, TEMPLATES.map(([label, text]) => h("button", { type: "button", onclick: () => fill(text) }, label))), instructions, h("div.row-gap", save)),
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
	// The first step left is the one to do now: it gets the accent, the others wait in line.
	const next = steps.find((s) => !s.done);
	const bar = h("div.steps-bar", h("span"));
	bar.firstChild.style.setProperty("width", `${Math.round((done / steps.length) * 100)}%`);
	const progress = h("div.steps-progress", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(steps.length), "aria-valuenow": String(done), "aria-label": "Primi passi fatti" }, bar);
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
		providerOverview(providers),
		progress,
		h(
			"ol.steps",
			steps.map((step, i) =>
				h(
					`li.step${step.done ? ".done" : ""}${step === next ? ".next" : ""}`,
					h("span.step-mark", { "aria-hidden": "true" }, step.done ? icon("check") : String(i + 1)),
					h(
						"div.step-text",
						h("b", step.title, step.done ? h("span.visually-hidden", " (fatto)") : null),
						step.done ? null : h("p", step.text),
						!step.done && extra[step.id] ? extra[step.id]() : null,
					),
					!step.done && step.go ? h(`button.btn.small${step === next ? ".accent" : ".ghost"}`, { onclick: () => go(...step.go) }, "Vai") : null,
				),
			),
		),
	);
}

