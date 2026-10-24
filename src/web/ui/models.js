// What the console knows about models and providers: the chat picker's cache, what a model does and costs, the subscriptions' state.
import { api, h } from "./common.js";

/** What the chat model picker reads, asked once per chat view: the choices, and each provider's models. */
export const chatModelCache = new Map();
export const chatModelChoices = (inst) => cached(chatModelCache, inst.id, () => api(`/api/instances/${inst.id}/chat-models`));
export const chatModelList = (inst, provider) => cached(chatModelCache, `${inst.id}/${provider}`, () => api(`/api/instances/${inst.id}/chat-models/${encodeURIComponent(provider)}`).then((r) => r.models));

function cached(map, key, load) {
	if (!map.has(key)) {
		const loading = load();
		loading.catch(() => map.delete(key));
		map.set(key, loading);
	}
	return map.get(key);
}

/** Connection state comes from the local CLI, never from a saved UI preference. */
export function subscriptionState(provider) {
	if (provider.connected) return { label: "Connesso", tone: "ok" };
	return {
		connecting: { label: "Accesso in corso", tone: "warn" },
		"not-installed": { label: "Da installare", tone: "" },
		"login-required": { label: "Accesso richiesto", tone: "warn" },
		unavailable: { label: "Non disponibile", tone: "warn" },
		disconnected: { label: "Scollegato", tone: "" },
	}[provider.status] ?? { label: "Non verificato", tone: "warn" };
}

/** First steps make the automatic detection visible, with management in Settings. */
export function providerOverview(catalog) {
	const subscriptions = (catalog.providers ?? []).filter((p) => p.kind === "subscription");
	if (!catalog.localEnabled || subscriptions.length === 0) return null;
	return h("section.card.pad.provider-overview", h("div.settings-heading", h("div", h("h2", "I tuoi provider AI"), h("p.muted", "Owni riconosce gli accessi già presenti su questo computer e usa il tuo abbonamento.")), h("a.btn.ghost", { href: "#/impostazioni/providers" }, "Gestisci provider")),
		h("div.provider-overview-list", subscriptions.map((p) => {
			const status = subscriptionState(p);
			return h("div.row-gap", h("b", p.label), h(`span.chip${status.tone ? `.${status.tone}` : ""}`, status.label));
		})),
	);
}

/** What a model does and costs: «foto · ragiona · entrata $3 · uscita $15 per M token». */
export function modelFacts(m, subscription = false) {
	const usd = (n) => `$${n < 1 ? Number(n.toFixed(2)) : Math.round(n * 10) / 10}`;
	const price = subscription ? "nel tuo abbonamento" : m.inputUsd > 0 || m.outputUsd > 0 ? `entrata ${usd(m.inputUsd)} · uscita ${usd(m.outputUsd)} per M token` : "gratis";
	return [m.images ? "foto" : null, m.reasoning ? "ragiona" : null, price].filter(Boolean).join(" · ");
}
