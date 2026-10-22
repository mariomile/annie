/**
 * What a turn should know now, given to the model with the newest message of the person for that
 * request only (ADR 0097): never stored, so the history keeps the person's words and a long thread
 * does not carry an old note with every message.
 */

/** Where the time line starts: the dev model leaves it out of what it echoes (it changes every minute). */
export const NOW_MARKER = "\n\n[Ora]";

/** The agenti speak to Italian businesses: their clock is Rome's. */
const ZONE = "Europe/Rome";

const format = new Intl.DateTimeFormat("it-IT", { timeZone: ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** «[Ora] giovedì 22 ottobre 2026 alle ore 16:40, ora italiana.» */
export function nowLine(now: Date): string {
	return `${NOW_MARKER} ${format.format(now)}, ora italiana.`;
}
