// Sign-in: link, code, Google.
import { $app, api, h, mount, state } from "./common.js";
import { enter } from "./session.js";
import { closeMenu } from "./shell.js";

// ---------- login ----------
export function renderLogin(error) {
	closeMenu();
	state.events?.close();
	mount($app, 
		h(
			"div.login",
			h(
				"div.card",
				h("div.login-mark", h("img", { src: "/icon.svg", alt: "", width: "40", height: "40" })),
				h("h1", "Accedi ad Annie"),
				h("p", "Per entrare usa il link personale che ti ha dato chi gestisce Annie. Il link ti riconosce: non condividerlo."),
				error ? h("p.chip.bad", error) : null,
				pasteLink(),
				h("p.muted", "Hai perso il link? Chiedi all'owner di generarne uno nuovo: quello vecchio smetterà di funzionare."),
			),
		),
	);
}

/**
 * The personal link pasted by hand: the app on the iPhone Home screen has no address bar, and a link
 * tapped in a mail opens in Safari, which keeps its own session.
 */
function pasteLink() {
	const link = h("input", { type: "url", autocomplete: "off", placeholder: "https://…/login#…", class: "mono", "aria-label": "Il tuo link personale" });
	const submit = async (event) => {
		event.preventDefault();
		const token = link.value.trim().split("#")[1] ?? "";
		if (!/^[\w-]{20,}$/.test(token)) return renderLogin("Questo non sembra il tuo link personale: copialo per intero.");
		try {
			await api("/api/login", { method: "POST", body: { token } });
		} catch (error) {
			if (error.data?.twoFactor) return renderCode(token);
			return renderLogin(error.message);
		}
		history.replaceState(null, "", "/");
		await enter();
	};
	return h("form.stack", { onsubmit: submit }, h("label.field", h("span", "Hai il link ma sei nell'app? Incollalo qui"), link), h("button.btn", { type: "submit" }, "Entra"));
}

/** The six-digit field of the verifica in due passaggi. */
export function codeInput() {
	return h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", placeholder: "123 456", class: "mono code-input", "aria-label": "Codice" });
}

/** Second step of the login, for people with two-factor on. The link token stays in memory only. */
export function renderCode(token, error) {
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
	mount($app, 
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

