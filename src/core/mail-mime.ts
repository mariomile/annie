import { randomBytes } from "node:crypto";
import { validAddress } from "./email-address.ts";
import type { MailDraft } from "./google-actions.ts";
import type { AttachmentData } from "./mail-attachments.ts";

/** A mail that cannot be written safely: in Italian, the person reads it on the card. */
export class MailMimeError extends Error {
	override readonly name = "MailMimeError";
}

/** One header value: no line breaks; outside ASCII, RFC 2047 encoded-words of at most 75 characters, folded. */
export function headerValue(value: string): string {
	if (/[\r\n]/.test(value)) throw new MailMimeError("un'intestazione della mail non può andare a capo");
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const words: string[] = [];
	let chunk = "";
	// 39 bytes of UTF-8 become 52 of base64: with "=?UTF-8?B?", "?=" and "Subject: ", 73. Characters are never split.
	for (const char of value) {
		if (Buffer.byteLength(chunk + char) > 39) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk !== "") words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** The ids of a References header as a reply carries them: well-formed ones only, the last ten, folded. */
function references(previous: string, messageId: string): string {
	const ids = [...`${previous} ${messageId}`.matchAll(/<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>/g)].map((m) => m[0]);
	return [...new Set(ids)].slice(-10).join("\r\n ");
}

/** Base64 in lines of 76 characters (RFC 2045). */
export function base64Lines(data: Buffer): string {
	const text = data.toString("base64");
	const lines: string[] = [];
	for (let i = 0; i < text.length; i += 76) lines.push(text.slice(i, i + 76));
	return lines.join("\r\n");
}

/** A file name safe in a quoted parameter: printable ASCII without quotes, backslashes or semicolons; the rest becomes "_". */
function asciiName(name: string): string {
	const plain = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	return plain.replace(/[^\x20-\x7e]|["\\;]/g, "_").replace(/[\r\n]/g, "") || "allegato";
}

/**
 * The name parameters of an attachment. ASCII names: quoted. Others: an ASCII fallback, then
 * RFC 2231 (filename*, percent-encoded UTF-8, split into continuations), which mail programs
 * prefer; Content-Type's name also as RFC 2047 encoded-words, for the older ones.
 */
function nameParams(name: string): { type: string; disposition: string } {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (/[\u0000-\u001f\u007f"\\]/.test(name)) throw new MailMimeError("nome di allegato non valido");
	if (/^[\x20-\x7e]*$/.test(name) && !name.includes(";") && name.length <= 60) return { type: `name="${name}"`, disposition: `filename="${name}"` };
	// Percent-encoded UTF-8 in pieces of whole characters, so each continuation decodes on its own.
	const pieces: string[] = [];
	let piece = "";
	for (const char of name) {
		const code = [...Buffer.from(char, "utf8")].map((b) => (b < 0x80 && /[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
		if (piece.length + code.length > 54) {
			pieces.push(piece);
			piece = "";
		}
		piece += code;
	}
	if (piece !== "") pieces.push(piece);
	const star = pieces.length === 1 ? `filename*=UTF-8''${pieces[0]}` : pieces.map((p, i) => `filename*${i}*=${i === 0 ? "UTF-8''" : ""}${p}`).join(";\r\n ");
	const ascii = asciiName(name);
	return { type: `name="${headerValue(name)}"`, disposition: `filename="${ascii.slice(0, 60)}";\r\n ${star}` };
}

/** A boundary found nowhere in the parts. */
function boundaryFor(parts: readonly string[]): string {
	for (;;) {
		const boundary = `=_annie_${randomBytes(18).toString("hex")}`;
		if (!parts.some((p) => p.includes(boundary))) return boundary;
	}
}

/**
 * The mail as Gmail takes it (RFC 2822), UTF-8. The sender is the account itself. Without
 * attachments, plain text; with them, multipart/mixed: the text first, then each file in base64.
 */
export function mimeMessage(mail: MailDraft, attachments: readonly AttachmentData[] = []): string {
	if ([...mail.to, ...mail.cc].some((a) => !validAddress(a))) throw new MailMimeError("indirizzo non valido");
	const replyId = mail.inReplyTo === undefined ? "" : (/^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.exec(mail.inReplyTo.messageId.trim())?.[0] ?? "");
	const head = [
		`To: ${mail.to.join(", ")}`,
		...(mail.cc.length === 0 ? [] : [`Cc: ${mail.cc.join(", ")}`]),
		`Subject: ${headerValue(mail.subject)}`,
		...(replyId === "" ? [] : [`In-Reply-To: ${replyId}`, `References: ${references(mail.inReplyTo?.references ?? "", replyId)}`]),
		"MIME-Version: 1.0",
	];
	const text = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
	const body = base64Lines(Buffer.from(mail.body, "utf8"));
	if (attachments.length === 0) return `${[...head, ...text].join("\r\n")}\r\n\r\n${body}`;
	const parts = [
		`${text.join("\r\n")}\r\n\r\n${body}`,
		...attachments.map((a) => {
			if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(a.contentType)) throw new MailMimeError("tipo di allegato non valido");
			const names = nameParams(a.name);
			return `Content-Type: ${a.contentType};\r\n ${names.type}\r\nContent-Disposition: attachment;\r\n ${names.disposition}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(a.data)}`;
		}),
	];
	const boundary = boundaryFor(parts);
	const multipart = `${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
	return `${[...head, `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`].join("\r\n")}\r\n\r\n${multipart}`;
}
