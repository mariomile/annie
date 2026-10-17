/**
 * The personality of an agente (ADR 0040): the face it shows in the console and the voice
 * it answers with. Instructions say what it does; the persona says who it is.
 */

export const TONES = ["naturale", "formale", "amichevole", "conciso", "scherzoso"] as const;
export type Tone = (typeof TONES)[number];

export type Persona = {
	/** One emoji, its face in the console. */
	readonly emoji?: string;
	/** What it is for, in one line: «Cerca e confronta fornitori». */
	readonly tagline?: string;
	/** How it talks. "naturale" adds nothing to the instructions. */
	readonly tone?: Tone;
	/**
	 * The owner gave it its face from the console: from then on it introduces itself with the
	 * instance's name. Set by the server, never taken from a request; older instances (named
	 * «Telegram (x)» by a script) keep presenting themselves as before until then.
	 */
	readonly named?: true;
};

export const TAGLINE_MAX = 120;
/** An emoji with skin tone and joiners stays short; anything longer is not one emoji. */
const EMOJI_MAX = 16;
const graphemes = new Intl.Segmenter("it", { granularity: "grapheme" });

export class PersonaError extends Error {}

const TONE_LINES: Record<Exclude<Tone, "naturale">, string> = {
	formale: "Usa un registro formale: dai del Lei, frasi complete, niente battute.",
	amichevole: "Usa un tono caldo e amichevole: dai del tu, incoraggia, resta concreto.",
	conciso: "Sii conciso: vai dritto al punto, poche frasi, elenchi solo se servono.",
	scherzoso: "Puoi essere spiritoso e leggero, con qualche battuta, senza mai sacrificare la precisione.",
};

/** A persona from what a person typed: trimmed, checked, empty parts left out. */
export function checkPersona(input: unknown): Persona {
	if (input === undefined || input === null) return {};
	if (typeof input !== "object") throw new PersonaError("Personalità non valida");
	const { emoji, tagline, tone } = input as Record<string, unknown>;
	const out: { emoji?: string; tagline?: string; tone?: Tone } = {};
	if (emoji !== undefined && emoji !== null && emoji !== "") {
		if (typeof emoji !== "string") throw new PersonaError("Emoji non valida");
		const e = emoji.trim();
		// One grapheme with a pictograph, a flag or a keycap in it; no letters, and no invisible format characters but the emoji joiners.
		const one = [...graphemes.segment(e)].length === 1;
		const picture = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(e);
		if (e.length > EMOJI_MAX || !one || !picture || /\p{L}|\s/u.test(e) || /\p{Cf}/u.test(e.replace(/\u200D/g, ""))) throw new PersonaError("Scegli una sola emoji");
		out.emoji = e;
	}
	if (tagline !== undefined && tagline !== null) {
		if (typeof tagline !== "string") throw new PersonaError("Descrizione non valida");
		const t = tagline.replace(/\s+/g, " ").trim();
		if (t.length > TAGLINE_MAX) throw new PersonaError(`Descrizione troppo lunga: al massimo ${TAGLINE_MAX} caratteri`);
		if (t !== "") out.tagline = t;
	}
	if (tone !== undefined && tone !== null && tone !== "") {
		if (typeof tone !== "string" || !(TONES as readonly string[]).includes(tone)) throw new PersonaError("Tono non valido");
		if (tone !== "naturale") out.tone = tone as Tone;
	}
	return out;
}

/** A name as it goes in the instructions and the console: one line, no quote marks of ours. */
export function cleanName(name: string): string {
	return name.replace(/[\s«»]+/g, " ").trim().slice(0, 80);
}

/**
 * The instructions an agente runs with: its own, then who it is. Nothing is added to an
 * instance the owner never gave a personality, so existing conversations keep their instructions.
 */
export function withPersona(instructions: string | undefined, name: string, persona: Persona | undefined): string | undefined {
	const lines: string[] = [];
	const own = cleanName(name);
	if (persona?.named === true && own !== "" && own.toLowerCase() !== "annie") lines.push(`Il tuo nome è «${own}»: presentati con questo nome, non come Annie (Annie è la piattaforma su cui lavori), e parla di te al maschile o al femminile come si addice al nome.`);
	if (persona?.tagline !== undefined) lines.push(`Il tuo compito: ${persona.tagline}`);
	if (persona?.tone !== undefined && persona.tone !== "naturale") lines.push(TONE_LINES[persona.tone]);
	if (lines.length === 0) return instructions;
	return `${instructions === undefined || instructions === "" ? "" : `${instructions}\n\n`}Chi sei:\n${lines.join("\n")}`;
}
