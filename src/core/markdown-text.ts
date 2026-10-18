/**
 * Text for the Markdown the document maker reads: a line escaped as text (web addresses kept as
 * links), a cell or line start pushed off a mark with no escape, and the letterhead of the
 * owner's company. Shared by the quotes, the timesheet's reports and the outgoing invoices.
 */
import type { Company } from "./invoices.ts";

const MARKDOWN = /[\\`*_[\]()#+\-.!|>~{}<]/g;
const URL = /https?:\/\/[^\s<>()"|\\]+/g;
/** Punctuation that ends a sentence or a parenthesis right after an address, not part of it. */
const URL_TAIL = /[).,;:!?'\]]+$/;
/** Marks with no backslash escape that change a line when they lead it («==» underlines a heading). */
const LEADING = /^[=:&]/;

function escaped(text: string): string {
	return text.replace(MARKDOWN, (c) => (c === "<" ? "‹" : `\\${c}`));
}

/**
 * Text on one line, as text: Markdown's marks escaped and web addresses written as <address>, so
 * they link to themselves, the marks inside them stay letters, and the punctuation after them
 * (a closing parenthesis, a full stop) stays outside the link.
 */
export function md(text: string): string {
	const line = text.replace(/\n+/g, ", ");
	let out = "";
	let last = 0;
	for (const m of line.matchAll(URL)) {
		const tail = URL_TAIL.exec(m[0])?.[0] ?? "";
		const url = m[0].slice(0, m[0].length - tail.length);
		if (!/^https?:\/\/./.test(url) || url.length > 2000) continue;
		out += `${escaped(line.slice(last, m.index))}<${url}>`;
		last = m.index + url.length;
	}
	return out + escaped(line.slice(last));
}

/**
 * Text that starts a line or a table cell: a mark with no escape at its start is pushed off it by
 * a non-breaking space. Only there: inside **…** the space would show.
 */
export function lead(text: string): string {
	return LEADING.test(text) ? `\u00a0${text}` : text;
}

/** The letterhead: the company's name, address, tax ids, REA and contacts, top left (the timesheet's reports use it too). */
export function letterhead(company: Partial<Company>): string[] {
	const ids = [company.vat === undefined ? undefined : `P.IVA ${company.vat}`, company.cf === undefined || company.cf === company.vat?.replace(/^IT/, "") ? undefined : `C.F. ${company.cf}`, company.rea === undefined ? undefined : `REA ${company.rea}`];
	const contacts = [company.phone === undefined ? undefined : `Tel. ${company.phone}`, company.email];
	return [
		...(company.name === undefined ? [] : [`**${md(company.name)}**`]),
		...(company.address === undefined ? [] : [lead(md(company.address))]),
		...[ids.filter((x) => x !== undefined).join(", ")].filter((x) => x !== "").map((x) => lead(md(x))),
		...[contacts.filter((x) => x !== undefined).join(", ")].filter((x) => x !== "").map((x) => lead(md(x))),
	];
}
