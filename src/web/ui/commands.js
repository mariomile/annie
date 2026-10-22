// The slash-command menu of a message box (chat and stanze) and the commands an agente offers.
import { api, h, mount } from "./common.js";

/**
 * The commands a message can start with, offered as soon as the box holds «/» (after the @names
 * of a stanza): Up and Down move, Enter or Tab picks, Esc closes. `load` gives them once, as
 * { name, note, prefix? }: `prefix` is a stanza's @name, written before the command when no name
 * is yet, so the skill reaches the agente that has it.
 */
export function commandMenu(input, load, onChange) {
	const menu = h("div.command-menu", { role: "listbox", "aria-label": "Comandi", hidden: true });
	let commands;
	let shown = [];
	let at = 0;
	const typed = () => /^((?:@[\p{L}\p{N}_-]+[\s,:]*)*)\/([\w-]*)$/u.exec(input.value);
	const close = () => {
		menu.hidden = true;
		shown = [];
		input.removeAttribute("aria-activedescendant");
	};
	const pick = (c) => {
		const [, names = ""] = typed() ?? [];
		input.value = `${names === "" ? (c.prefix ?? "") : names}/${c.name} `;
		close();
		input.focus();
		onChange();
	};
	const draw = () => {
		mount(menu, shown.map((c, i) => h("button.model-option", { type: "button", role: "option", id: `command-${i}`, "aria-selected": i === at ? "true" : "false", onmousedown: (e) => e.preventDefault(), onclick: () => pick(c) }, h("span", h("span.model-option-name", `${c.prefix ?? ""}/${c.name}`), c.note ? h("small", c.note) : null))));
		input.setAttribute("aria-activedescendant", `command-${at}`);
		menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	};
	const update = async () => {
		const match = typed();
		if (match === null) return close();
		commands ??= await load().catch(() => []);
		const word = (match[2] ?? "").toLowerCase();
		// After «@vendite », only what that agente has (all of them after @tutti).
		const names = (match[1] ?? "").toLowerCase();
		const called = (c) => names === "" || c.prefix === undefined || /@(tutti|all)\b/.test(names) || names.includes(c.prefix.trim().toLowerCase());
		shown = commands.filter((c) => c.name.startsWith(word) && called(c)).slice(0, 8);
		// The box may have changed while the commands were loading.
		if (shown.length === 0 || typed() === null) return close();
		at = Math.min(at, shown.length - 1);
		menu.hidden = false;
		draw();
	};
	input.addEventListener("input", () => {
		at = 0;
		void update();
	});
	input.addEventListener("blur", close);
	// Before the box's own keys, so Enter picks a command instead of sending it.
	input.addEventListener(
		"keydown",
		(e) => {
			if (menu.hidden || e.isComposing) return;
			const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
			if (move !== undefined) at = (at + move + shown.length) % shown.length;
			else if (e.key === "Enter" || e.key === "Tab") pick(shown[at]);
			else if (e.key === "Escape") close();
			else return;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (move !== undefined) draw();
		},
		true,
	);
	return menu;
}

/** An agente's commands: its skills, /modello, and /attiva-skill when the person has drafts to turn on. */
export async function agentCommands(instanceId, prefix) {
	const { skills, drafts } = await api(`/api/instances/${encodeURIComponent(instanceId)}/skills`);
	return [
		...skills.map((s) => ({ name: s.name, note: s.description, prefix })),
		...(drafts.length > 0 ? [{ name: "attiva-skill", note: `Attiva una tua bozza: ${drafts.map((d) => d.name).join(", ")}`, prefix }] : []),
		{ name: "modello", note: "Scegli il modello di questa chat", prefix },
	];
}
