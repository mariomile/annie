// Primi passi page.
import { agentLabel, api, go, h, head, icon, mount, needInstance, state, store, toast } from "../common.js";
import { providerOverview } from "./settings.js";
import { appleTouch, install, installed, installOffer } from "../pwa.js";
import { setupHidden } from "../session.js";
import { render, renderRail } from "../shell.js";

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
		{ id: "model", own: true, done: setup.model, title: "Collega il tuo provider AI", text: setup.model ? "Annie usa un modello AI vero: puoi cambiarlo quando vuoi." : "Annie riconosce Claude Code e Codex già connessi su questo computer e usa il tuo abbonamento. Puoi anche scegliere un altro provider e aggiungere la sua chiave API.", go: ["impostazioni", "providers"] },
		...(can.computerUse ? [{ id: "computerUse", own: true, done: setup.computerUse, title: "Abilita Computer Use", text: "Consenti Registrazione schermo e Accessibilità in macOS, poi scegli se questo agente può vedere lo schermo, cliccare e scrivere su questo Mac.", go: ["impostazioni", "computer-use"] }] : []),
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
export function setupLeft(setup) {
	return setupSteps(setup).filter((s) => !s.done && s.own).length;
}

export function stepsLeftText(n) {
	return n === 1 ? "Primi passi: ne manca 1" : `Primi passi: ne mancano ${n}`;
}

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

