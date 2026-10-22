import type { TelegramCommand } from "./channels/telegram.ts";
import type { Skill } from "./core/skills.ts";

/** Telegram's limits for a bot's menu. */
const COMMAND = /^[a-z0-9_]{1,32}$/;
const DESCRIPTION_MAX = 256;
const MENU_MAX = 100;

/** A skill's name as a Telegram command: «chiusura-del-mese» is `chiusura_del_mese`. The core reads both spellings. */
export function skillCommandName(name: string): string {
	return name.toLowerCase().replace(/-/g, "_");
}

/**
 * The skills as entries of the Telegram menu (ADR 0104), after `base`, the commands that are
 * already there. A skill that cannot be a command, that repeats one, or that does not fit in 100
 * is left out and logged: it still works when typed.
 */
export function skillMenu(skills: readonly Skill[], base: readonly TelegramCommand[], log?: (line: string) => void): TelegramCommand[] {
	const menu: TelegramCommand[] = [...base];
	const taken = new Set(base.map((c) => c.command));
	for (const skill of skills) {
		const command = skillCommandName(skill.name);
		const description = skill.description.length > DESCRIPTION_MAX ? `${skill.description.slice(0, DESCRIPTION_MAX - 1)}…` : skill.description;
		const reason = !COMMAND.test(command) ? "not a valid Telegram command" : description === "" ? "no description" : taken.has(command) ? "command already in the menu" : menu.length >= MENU_MAX ? "menu is full" : undefined;
		if (reason !== undefined) {
			log?.(`telegram: skill "${skill.name}" left out of the menu: ${reason}`);
			continue;
		}
		taken.add(command);
		menu.push({ command, description });
	}
	return menu;
}
