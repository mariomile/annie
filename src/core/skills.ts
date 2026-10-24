import { statSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { clip, fold } from "./text-match.ts";

/**
 * The skill of an agente (ADR 0059): a procedure the people who use it saved once, with a name
 * and a line saying when it applies («chiusura-mese»: «Quando chiedono di chiudere il mese»).
 * The agente sees the names and the lines in its instructions and opens the one it needs with
 * skill_read; a person runs one with `/nome` from any channel. Same shape as an Agent Skills
 * SKILL.md (agentskills.io), so one can come in from a file and go out as one.
 */
export type Skill = {
	readonly name: string;
	readonly description: string;
	readonly body: string;
	/** "<channel>:<userId>" of the person who saved it: from a chat, or "web:<id>" from the console. */
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
};

export const SKILL_LIMITS = {
	/** Skills and drafts: every name and line is in the instructions of each conversation. */
	perInstance: 40,
	/** Telegram's commands are at most 32 characters, and a menu of them is the next step. */
	name: 32,
	/** What the Agent Skills format allows; the instructions carry the first `catalogLine` of it. */
	description: 1024,
	catalogLine: 200,
	body: 20_000,
} as const;

/** Commands that are not skills: the model command, the local model's, Telegram's start, the list, activation. */
const RESERVED = new Set(["modello", "model", "tool", "start", "help", "aiuto", "skill", "skills", "settings", "stop", "attiva-skill"]);

export class SkillError extends Error {
	override readonly name = "SkillError";
}

/** A name as a command: «Chiusura del mese» is «chiusura-del-mese». */
export function skillName(name: string): string {
	return fold(name.normalize("NFC").trim())
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

type SkillFile = { readonly skills: readonly Skill[]; readonly drafts: readonly Skill[] };
const EMPTY: SkillFile = { skills: [], drafts: [] };

/**
 * The skills of one instance, in `skills.json` beside its memoria: the active ones, and the
 * drafts the agente wrote in a chat, which count only once their author activates them.
 */
export class SkillStore {
	private readonly file: string;
	private cache: { readonly stamp: string; readonly data: SkillFile } | undefined;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "skills.json");
	}

	/** The active skills, by name. A damaged file counts as none: the agente keeps answering. */
	list(): Skill[] {
		return [...this.read().skills].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Drafts waiting for their author, by name. */
	drafts(): Skill[] {
		return [...this.read().drafts].sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): Skill | undefined {
		const wanted = skillName(name);
		return this.list().find((s) => s.name === wanted);
	}

	/**
	 * Save a skill, active at once (from the console, where the person is signed in), or as a
	 * draft of its author (from a chat). Only `may` decides whether an active one with that name
	 * can be replaced (its author, or the owner). Returns it and whether it replaced one.
	 */
	save(input: { name: string; description: string; body: string; by: string; draft?: boolean }, may: (existing: Skill) => boolean, now = new Date()): { skill: Skill; replaced: boolean } {
		const name = skillName(input.name);
		if (name === "") throw new SkillError("Serve un nome, con lettere o numeri");
		if (name.length > SKILL_LIMITS.name) throw new SkillError(`Il nome è troppo lungo: al massimo ${SKILL_LIMITS.name} caratteri («${name}»)`);
		if (RESERVED.has(name)) throw new SkillError(`«${name}» è un comando di Owni: scegli un altro nome`);
		const description = input.description.replace(/\s+/g, " ").trim();
		if (description === "") throw new SkillError("Serve una riga che dica quando usarla");
		if (description.length > SKILL_LIMITS.description) throw new SkillError(`La descrizione è troppo lunga: al massimo ${SKILL_LIMITS.description} caratteri`);
		const body = input.body.replace(/\r\n?/g, "\n").trim();
		if (body === "") throw new SkillError("Le istruzioni della skill sono vuote");
		if (body.length > SKILL_LIMITS.body) throw new SkillError(`Le istruzioni sono troppo lunghe: al massimo ${SKILL_LIMITS.body} caratteri`);
		let saved: Skill | undefined;
		let replaced = false;
		this.update((file) => {
			const existing = file.skills.find((s) => s.name === name);
			if (existing !== undefined && !may(existing)) throw new SkillError(`C'è già una skill «${name}» salvata da un'altra persona: scegli un altro nome`);
			const own = file.drafts.find((d) => d.name === name && d.createdBy === input.by);
			if (existing === undefined && own === undefined && file.skills.length + file.drafts.length >= SKILL_LIMITS.perInstance) throw new SkillError(`Al massimo ${SKILL_LIMITS.perInstance} skill per agente: cancellane qualcuna`);
			const at = now.toISOString();
			saved = { name, description, body, createdBy: existing?.createdBy ?? input.by, createdAt: existing?.createdAt ?? at, updatedAt: at };
			replaced = existing !== undefined;
			if (input.draft === true) return { skills: file.skills, drafts: [...file.drafts.filter((d) => d !== own), { ...saved, createdBy: input.by }] };
			return { skills: [...file.skills.filter((s) => s !== existing), saved], drafts: file.drafts.filter((d) => d.name !== name || d.createdBy !== input.by) };
		});
		return { skill: saved as Skill, replaced };
	}

	/**
	 * The draft `by` wrote with that name becomes the active skill. Only from the author's own
	 * message (the core checks that), so nothing an agente reads can turn a draft on.
	 */
	activate(name: string, by: string, now = new Date()): { skill: Skill; replaced: boolean } | undefined {
		const wanted = skillName(name);
		const draft = this.read().drafts.find((d) => d.name === wanted && d.createdBy === by);
		if (draft === undefined) return undefined;
		return this.save({ ...draft, by }, (existing) => existing.createdBy === by, now);
	}

	/** Delete an active skill or a draft if `may` allows it; returns the deleted one, or undefined. */
	remove(name: string, may: (skill: Skill) => boolean): Skill | undefined {
		const wanted = skillName(name);
		let removed: Skill | undefined;
		this.update((file) => {
			const found = file.skills.find((s) => s.name === wanted && may(s)) ?? file.drafts.find((d) => d.name === wanted && may(d));
			if (found === undefined) return file;
			removed = found;
			return { skills: file.skills.filter((s) => s !== found), drafts: file.drafts.filter((d) => d !== found) };
		});
		return removed;
	}

	private read(): SkillFile {
		// Read on every message (the instructions and the commands): parsed again only when the file changed.
		let stamp: string;
		try {
			const stat = statSync(this.file);
			stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		} catch {
			return EMPTY;
		}
		if (this.cache?.stamp === stamp) return this.cache.data;
		let data: SkillFile;
		try {
			data = readJsonFile<SkillFile>(this.file, EMPTY);
		} catch {
			return EMPTY;
		}
		this.cache = { stamp, data };
		return data;
	}

	private update(change: (file: SkillFile) => SkillFile): void {
		this.cache = undefined;
		updateJsonFile<SkillFile>(this.file, EMPTY, change);
	}
}

/**
 * What the instructions say about skills: always how to save one, then, when there are any, each
 * name with its line. Read on every message, so a saved skill counts from the next one.
 */
export function skillCatalog(skills: readonly Skill[]): string {
	const how =
		"Skill: procedure salvate dalle persone che ti usano. Quando una persona ti chiede di ricordare un modo di lavorare come procedura («salvalo come skill», «d'ora in poi fai sempre così quando...»), scrivila con skill_save: un nome breve, una riga che dica quando usarla, i passi; poi dille che per attivarla deve scrivere /attiva-skill e il nome. Prima di un compito che corrisponde a una skill, aprila con skill_read e seguila; una persona la lancia anche scrivendo /nome.";
	if (skills.length === 0) return how;
	const line = (s: Skill) => clip(s.description, SKILL_LIMITS.catalogLine);
	return `${how}\nLe skill che hai (nome e quando usarla, scritti dalle persone):\n${skills.map((s) => `- ${s.name}: ${line(s)}`).join("\n")}`;
}

/**
 * A message that runs a skill: «/chiusura-mese ottobre», also «/chiusura-mese@NomeBot» in a
 * Telegram group. undefined when the text is not a command of a skill this instance has.
 */
export function skillCommand(text: string, skills: readonly Skill[]): { skill: Skill; rest: string } | undefined {
	const match = /^\/([A-Za-z0-9][\w-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match?.[1] === undefined) return undefined;
	const name = skillName(match[1].replace(/_/g, "-"));
	const skill = skills.find((s) => s.name === name);
	return skill === undefined ? undefined : { skill, rest: (match[2] ?? "").trim() };
}

/** A skill as an entry of Telegram's menu: «chiusura-del-mese» is /chiusura_del_mese, which skillCommand reads back. */
export function skillMenuEntry(skill: Skill): { command: string; description: string } {
	return { command: skill.name.replace(/-/g, "_"), description: clip(skill.description, 256) };
}

/** The person's message with the skill they ran: their words stay first, the steps follow. */
export function withSkill(text: string, skill: Skill, rest: string): string {
	const ask = rest === "" ? "Non ha aggiunto altro: se ti manca qualcosa per seguirla, chiedilo." : "Quello che ha scritto dopo il comando è la sua richiesta.";
	return `${text}\n\n[Skill «${skill.name}»] La persona ha lanciato questa skill: seguine i passi per questa richiesta. ${ask}\n${skill.body}\n[Fine della skill]`;
}

/**
 * «/attiva-skill chiusura-mese»: the name of the draft the person turns on, "" when they gave
 * none; undefined when the text is not that command.
 */
export function activateCommand(text: string): string | undefined {
	const match = /^\/attiva[-_]skill(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return match === null ? undefined : (match[1] ?? "").trim();
}

/** A skill as a SKILL.md file. */
export function toSkillMd(skill: Pick<Skill, "name" | "description" | "body">): string {
	return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`;
}

/**
 * A SKILL.md as name, description and body: YAML front matter with `name` and `description` on
 * one line each (quoted or not, or a folded `>` block), the rest of the file is the body.
 */
export function parseSkillMd(text: string): { name: string; description: string; body: string } {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (match === null) throw new SkillError("Non è un SKILL.md: manca l'intestazione fra due righe ---");
	const fields: Record<string, string> = {};
	const lines = (match[1] as string).split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i] as string);
		if (field === null) continue;
		let value = (field[2] as string).trim();
		if (/^[>|][+-]?$/.test(value)) {
			const block: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) block.push((lines[++i] as string).trim());
			value = block.join(" ");
		} else if (/^".*"$/.test(value)) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				value = value.slice(1, -1);
			}
		} else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
		fields[(field[1] as string).toLowerCase()] = value;
	}
	if (fields.name === undefined || fields.name === "") throw new SkillError("Nel SKILL.md manca il nome (name:)");
	if (fields.description === undefined || fields.description === "") throw new SkillError("Nel SKILL.md manca la descrizione (description:)");
	return { name: fields.name, description: fields.description, body: (match[2] as string).trim() };
}
