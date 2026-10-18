/** The arguments of the reminder ops (reminder-tools.ts), checked and typed. */
import { validAddress } from "../email-address.ts";
import type { ReminderLevel } from "../reminder-book.ts";
import { parseRate, type Rate } from "./reminder-sources.ts";
import { MAX_NOTE, type ReminderTerms } from "./reminder-text.ts";

/** The arguments of the reminder ops, typed; a problem in Italian otherwise. */
export type ReminderArgs = { number?: string; party?: string; path?: string; email?: string; terms: ReminderTerms; send: boolean; attach: boolean };

/** Arguments that only make sense for writing a letter: reminder_sent refuses them rather than ignore them. */
export const LETTER_ONLY = ["send", "email", "compensation", "interest_rate", "pay_within", "note", "attach_invoice"] as const;

export function reminderArgs(args: Record<string, unknown>): ReminderArgs | { problem: string } {
	const text = (name: string) => (typeof args[name] === "string" && (args[name] as string).trim() !== "" ? (args[name] as string).trim() : undefined);
	const level = args.level;
	if (level !== undefined && level !== 1 && level !== 2 && level !== 3) return { problem: "level è 1 (cortese), 2 (più fermo) o 3 (formale)" };
	let rate: Rate | undefined;
	if (args.interest_rate !== undefined) {
		if (typeof args.interest_rate !== "string" && typeof args.interest_rate !== "number") return { problem: "interest_rate è il tasso annuo dato dalla persona, per esempio «8,5»" };
		const parsed = parseRate(String(args.interest_rate));
		if ("problem" in parsed) return { problem: parsed.problem };
		rate = parsed;
	}
	const within = args.pay_within;
	if (within !== undefined && !(Number.isInteger(within) && (within as number) >= 1 && (within as number) <= 90)) return { problem: "pay_within è un numero di giorni, da 1 a 90" };
	for (const flag of ["send", "compensation", "attach_invoice"] as const) if (args[flag] !== undefined && typeof args[flag] !== "boolean") return { problem: `${flag} è true o false` };
	if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > MAX_NOTE)) return { problem: `note è un testo di al più ${MAX_NOTE} caratteri` };
	const email = text("email")?.toLowerCase();
	if (email !== undefined && !validAddress(email)) return { problem: "email non è un indirizzo valido" };
	const send = args.send === true;
	const attach = args.attach_invoice === true;
	const terms: ReminderTerms = {
		...(level === undefined ? {} : { level: level as ReminderLevel }),
		...(args.compensation === true ? { compensation: true } : {}),
		...(rate === undefined ? {} : { rate }),
		...(typeof within === "number" ? { payWithin: within } : {}),
		...(typeof args.note === "string" && args.note.trim() !== "" ? { note: args.note } : {}),
		...(attach && send ? { attached: true } : {}),
	};
	const number = text("number");
	const party = text("party");
	const path = text("path");
	return { ...(number === undefined ? {} : { number }), ...(party === undefined ? {} : { party }), ...(path === undefined ? {} : { path }), ...(email === undefined ? {} : { email }), terms, send, attach };
}
