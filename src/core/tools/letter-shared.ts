/**
 * What the letters Owni writes for the person's customers share: payment reminders
 * (reminder-text.ts) and quotes sent by mail (quote-send.ts).
 */

/** A person, not a business: no partita IVA, no numeric codice fiscale. */
export function isPrivateParty(party: { readonly vat?: unknown; readonly fiscal?: string }): boolean {
	return party.vat === undefined && !/^\d{11}$/.test(party.fiscal ?? "");
}

/** RFC 3986 percent-encoding: encodeURIComponent and also !'()*, which some mail apps take apart. */
function encoded(text: string): string {
	return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A mailto: link that opens the letter ready in the phone's mail app (RFC 6068): the address with
 * its @ as it is, line breaks as CRLF; undefined past ~1800 characters, which some apps cut.
 */
export function mailtoLink(to: string | undefined, subject: string, body: string): string | undefined {
	const at = to === undefined ? -1 : to.lastIndexOf("@");
	const address = to === undefined ? "" : at < 0 ? encoded(to) : `${encoded(to.slice(0, at))}@${encoded(to.slice(at + 1))}`;
	const crlf = (text: string) => encoded(text.replace(/\r?\n/g, "\r\n"));
	const link = `mailto:${address}?subject=${crlf(subject)}&body=${crlf(body)}`;
	return link.length > 1800 ? undefined : link;
}
