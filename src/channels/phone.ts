import { createHmac, timingSafeEqual } from "node:crypto";
import { ChannelRefused, type ChannelAdapter, type InboundMessage, type OutboundMessage } from "./types.ts";

/**
 * Phone calls on a Twilio number, one turn at a time (ADR 0012): Twilio turns speech into text
 * (<Gather input="speech">) and text into speech (<Say>), the cell only sees text in webhooks.
 * A conversation is the caller's number. Replies are kept aside (on disk, through `pending`)
 * and spoken as soon as they are ready, or at the start of the next call.
 */
export type PhoneCredentials = {
	readonly accountSid: string;
	readonly authToken: string;
	/** E.164, e.g. +390612345678. */
	readonly number: string;
	readonly numberSid: string;
};

/** Replies waiting to be spoken, per caller number. */
export type PendingReplies = {
	take(number: string): string[];
	put(number: string, text: string): void;
};

export type PhoneOptions = {
	readonly credentials: PhoneCredentials;
	readonly tenantId: string;
	readonly instanceId: string;
	/** The cell's public https address: Twilio is sent here and signs these URLs. */
	readonly publicUrl: string;
	readonly pending: PendingReplies;
	/** May this number call? (the instance's allowlist for "phone"). */
	readonly mayCall: (number: string) => Promise<boolean>;
	/** BCP-47 language for recognition and speech. */
	readonly language?: string;
	readonly log?: (message: string) => void;
	/** Tests: how long one webhook waits for a reply, and how many waits before giving up. */
	readonly waitMs?: number;
	readonly maxWaits?: number;
};

export const PHONE_NUMBER = /^\+[1-9]\d{6,14}$/;
const MAX_SPOKEN = 1500;
const GOODBYE = /^(ciao|ciao ciao|grazie,? ciao|basta|fine|arrivederci|a dopo)[.!]?$/i;

export class PhoneAdapter implements ChannelAdapter {
	readonly name = "phone";
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private readonly waiters = new Map<string, Set<() => void>>();

	constructor(private readonly options: PhoneOptions) {}

	async start(): Promise<void> {}

	async stop(): Promise<void> {
		for (const set of this.waiters.values()) for (const wake of set) wake();
		this.waiters.clear();
	}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	/** Kept aside for the caller; a call waiting on it speaks it at once. */
	async send(message: OutboundMessage): Promise<void> {
		if (!PHONE_NUMBER.test(message.threadId)) throw new ChannelRefused("not a phone number");
		this.options.pending.put(message.threadId, message.text);
		for (const wake of this.waiters.get(message.threadId) ?? []) wake();
	}

	/** The webhook's address as Twilio called it, for the signature. */
	hookUrl(query = ""): string {
		return `${this.options.publicUrl}/hooks/phone/${this.options.instanceId}${query}`;
	}

	/** Twilio's signature: HMAC-SHA1 with the auth token over the URL and the sorted parameters. */
	signed(url: string, params: URLSearchParams, signature: string | undefined): boolean {
		if (signature === undefined) return false;
		const data = url + [...params.keys()].sort().map((k) => `${k}${params.getAll(k).join("")}`).join("");
		const expected = createHmac("sha1", this.options.credentials.authToken).update(data).digest();
		const given = Buffer.from(signature, "base64");
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	/** One webhook: the call starting, a phrase heard, or a wait for the reply. Answers TwiML. */
	async handle(query: URLSearchParams, params: URLSearchParams): Promise<string> {
		const from = params.get("From") ?? "";
		const call = (params.get("CallSid") ?? "").replace(/[^\w]/g, "").slice(0, 64);
		if (!PHONE_NUMBER.test(from) || call === "" || !(await this.options.mayCall(from))) return twiml("<Reject/>");
		const step = query.get("step");
		const turn = Math.max(0, Math.min(1000, Number(query.get("turn") ?? 0) || 0));
		if (step === null) {
			const waiting = this.options.pending.take(from);
			const hello = waiting.length > 0 ? `Ciao, sono Annie. Ti avevo lasciato una risposta. ${waiting.map(spoken).join(" ")}` : "Ciao, sono Annie. Dimmi pure.";
			return this.listen(call, 1, hello);
		}
		if (step === "heard") {
			const said = (params.get("SpeechResult") ?? "").trim().slice(0, 2000);
			if (said === "") return this.listen(call, turn, "Non ho sentito. Puoi ripetere?");
			if (GOODBYE.test(said)) return twiml(`${this.say("Ciao, a presto.")}<Hangup/>`);
			if (this.handler === undefined) throw new Error("phone: no inbound handler");
			// The message ID is the call and the turn: a webhook Twilio sends again is dropped by the core.
			await this.handler({ tenantId: this.options.tenantId, instanceId: this.options.instanceId, channel: this.name, threadId: from, userId: from, text: said, privateThread: true, messageId: `${call}:${turn}` });
			return this.reply(from, call, turn, 0);
		}
		if (step === "wait") return this.reply(from, call, turn, Math.max(0, Number(query.get("n") ?? 0) || 0));
		return twiml("<Hangup/>");
	}

	/** Speak the reply if it comes within one wait; otherwise "un momento" and Twilio comes back. */
	private async reply(from: string, call: string, turn: number, waited: number): Promise<string> {
		const ready = await this.waitFor(from, this.options.waitMs ?? 8_000);
		if (ready.length > 0) return this.listen(call, turn + 1, ready.map(spoken).join(" "));
		if (waited + 1 >= (this.options.maxWaits ?? 6)) return twiml(`${this.say("Ci vuole ancora un po'. Richiamami tra qualche minuto: la risposta ti aspetta.")}<Hangup/>`);
		const again = escapeXml(this.hookUrl(`?step=wait&call=${call}&turn=${turn}&n=${waited + 1}`));
		return twiml(`${this.say(waited === 0 ? "Un momento." : "Ancora un attimo.")}<Redirect method="POST">${again}</Redirect>`);
	}

	private async waitFor(from: string, ms: number): Promise<string[]> {
		const now = this.options.pending.take(from);
		if (now.length > 0) return now;
		await new Promise<void>((resolve) => {
			const set = this.waiters.get(from) ?? new Set<() => void>();
			const done = () => {
				clearTimeout(timer);
				set.delete(done);
				if (set.size === 0) this.waiters.delete(from);
				resolve();
			};
			const timer = setTimeout(done, ms);
			set.add(done);
			this.waiters.set(from, set);
		});
		return this.options.pending.take(from);
	}

	/** Say something, then listen for the next phrase; silence ends the call politely. */
	private listen(call: string, turn: number, text: string): string {
		const action = escapeXml(this.hookUrl(`?step=heard&call=${call}&turn=${turn}`));
		return twiml(`<Gather input="speech" language="${this.language()}" speechTimeout="auto" action="${action}" method="POST">${this.say(text)}</Gather>${this.say("Non ti sento più. Ciao!")}<Hangup/>`);
	}

	private say(text: string): string {
		return `<Say language="${this.language()}">${escapeXml(text)}</Say>`;
	}

	private language(): string {
		return /^[a-z]{2}-[A-Z]{2}$/.test(this.options.language ?? "") ? (this.options.language as string) : "it-IT";
	}
}

/**
 * A written reply made fit to be read aloud: no markup, links named instead of spelled out,
 * and cut when it would take minutes.
 */
export function spoken(text: string): string {
	const plain = text
		.replace(/```[\s\S]*?```/g, " (c'è del codice: te lo mando per iscritto se me lo chiedi) ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "un link")
		.replace(/^\s*>+\s?/gm, "")
		.replace(/[*_`#|~]+/g, "")
		.replace(/^\s*[-•]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > MAX_SPOKEN ? `${plain.slice(0, MAX_SPOKEN).replace(/\s\S*$/, "")}… La risposta è più lunga: chiedimela per iscritto.` : plain;
}

function twiml(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Check the credentials with Twilio and point the number's calls at this cell. Returns the
 * number's SID. `apiBase` is Twilio's REST API (the Ireland region for data in the EU).
 */
export async function connectTwilioNumber(input: { accountSid: string; authToken: string; number: string; voiceUrl: string; apiBase?: string; fetch?: typeof fetch }): Promise<{ numberSid: string }> {
	const base = `${input.apiBase ?? "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}`;
	const auth = `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString("base64")}`;
	const call = input.fetch ?? fetch;
	const found = await call(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(input.number)}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15_000) });
	if (found.status === 401 || found.status === 403 || found.status === 404) throw new ChannelRefused("Twilio non accetta queste credenziali");
	if (!found.ok) throw new Error(`Twilio answered ${found.status}`);
	const sid = ((await found.json()) as { incoming_phone_numbers?: { sid?: string }[] }).incoming_phone_numbers?.[0]?.sid;
	if (sid === undefined || !/^PN[0-9a-f]{32}$/i.test(sid)) throw new ChannelRefused("questo numero non è nell'account Twilio");
	const set = await call(`${base}/IncomingPhoneNumbers/${sid}.json`, {
		method: "POST",
		headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ VoiceUrl: input.voiceUrl, VoiceMethod: "POST" }).toString(),
		signal: AbortSignal.timeout(15_000),
	});
	if (!set.ok) throw new ChannelRefused(`Twilio non ha accettato l'indirizzo delle chiamate (${set.status})`);
	return { numberSid: sid };
}

export class MissingPhoneField extends Error {
	override readonly name = "MissingPhoneField";
}

export function parsePhoneCredentials(saved: string): PhoneCredentials | undefined {
	try {
		const value = JSON.parse(saved) as Partial<PhoneCredentials>;
		if (typeof value.accountSid === "string" && typeof value.authToken === "string" && typeof value.number === "string" && typeof value.numberSid === "string") return value as PhoneCredentials;
	} catch {
		/* unreadable: undefined */
	}
	return undefined;
}
