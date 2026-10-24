/**
 * «Primi passi» (ADR 0019): the owner's own words about who uses Owni, kept as one block after the
 * default instructions, so what Owni can do stays said and saving again replaces the block.
 */
export const ABOUT_HEADING = "Informazioni su chi ti usa:";
export const ABOUT_MAX = 2000;
export const INSTRUCTIONS_MAX = 20_000;

/** The instructions with the owner's block put in, or replaced; the base without a block when `about` is empty. */
export function withAbout(instructions: string, about: string): string {
	const base = withoutAbout(instructions);
	const text = about.replace(/\r\n/g, "\n").trim();
	return text === "" ? base : `${base}\n\n${ABOUT_HEADING}\n${text}`.trim();
}

function withoutAbout(instructions: string): string {
	const at = instructions.lastIndexOf(`\n${ABOUT_HEADING}\n`);
	return (at === -1 ? instructions : instructions.slice(0, at)).trim();
}

/**
 * Whether the owner said something of their own: a block from «Primi passi», or instructions that do
 * not start like the defaults (whose wording changes between versions, so an old copy still counts as default).
 */
export function ownInstructions(instructions: string | undefined, defaults: string | undefined): boolean {
	const text = (instructions ?? "").trim();
	if (text === "") return false;
	if (text.includes(`\n${ABOUT_HEADING}\n`)) return true;
	if (defaults === undefined) return true;
	const opening = (defaults.split(/[.\n]/)[0] ?? "").trim();
	return opening === "" || !text.startsWith(opening);
}
