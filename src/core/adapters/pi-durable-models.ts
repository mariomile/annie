/**
 * Model providers the Pi Durable adapter can register. Part of the adapter: the only
 * other place, besides pi-durable.ts, that imports Pi packages.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { MEMORY_NOTE_MARKER } from "../memory.ts";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL_ID = "annie-dev";

export const SUPPORTED_PROVIDERS = ["anthropic", "openai", FAUX_PROVIDER] as const;

export function createProvider(id: string): Provider {
	switch (id) {
		case "anthropic":
			return anthropicProvider();
		case "openai":
			return openaiProvider();
		case FAUX_PROVIDER:
			return createDevModel();
		default:
			throw new Error(`Unsupported model provider "${id}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`);
	}
}

/**
 * A local, deterministic model: no network, no key. Its answer depends only on the
 * transcript, so a new process after a crash continues exactly where the old one was.
 *
 * - "conta fino a N" / "count to N" → calls the slow_counter tool with n = N
 * - "/tool <name> <json args>" → calls that tool (for tests and development)
 * - after a tool result → "Fatto. <tool output>", and "[N immagini]" when it shows pictures
 * - anything else → echoes the message, saying which pictures came with it
 */
function createDevModel(): Provider {
	const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL_ID, name: "Annie dev (deterministic)" }] });
	// Faux responses are consumed one per request; this step re-queues itself forever.
	const step = (context: { messages: Message[] }): AssistantMessage => {
		faux.appendResponses([step]);
		return respond(context.messages);
	};
	faux.setResponses([step]);
	return faux.provider;
}

function respond(messages: readonly Message[]): AssistantMessage {
	// Pi appends system entries (tool or instruction changes) after the person's message.
	const last = messages.filter((m) => m.role === "user" || m.role === "toolResult" || m.role === "assistant").at(-1);
	if (last?.role === "toolResult") {
		const output = last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const shown = last.content.filter((block) => block.type === "image").length;
		return fauxAssistantMessage(`Fatto. ${output}${shown === 0 ? "" : ` [${shown} ${shown === 1 ? "immagine" : "immagini"}]`}`);
	}
	const text = last?.role === "user" ? userText(last.content) : "";
	// The memoria note the core appends after the person's words is not part of a command.
	const direct = /^\/tool\s+([\w-]+)\s*([\s\S]*)$/.exec((text.split(MEMORY_NOTE_MARKER)[0] ?? "").trim());
	if (direct?.[1] !== undefined) {
		let args: Record<string, unknown> = {};
		try {
			args = direct[2] ? (JSON.parse(direct[2]) as Record<string, unknown>) : {};
		} catch {
			return fauxAssistantMessage(`Argomenti non validi per ${direct[1]}: serve JSON.`);
		}
		return fauxAssistantMessage(fauxToolCall(direct[1], args as never), { stopReason: "toolUse" });
	}
	const count = /(?:conta(?:re)? fino a|count to)\s+(\d+)/i.exec(text);
	if (count?.[1] !== undefined) {
		return fauxAssistantMessage(fauxToolCall("slow_counter", { n: Number(count[1]) }), { stopReason: "toolUse" });
	}
	return fauxAssistantMessage(`Annie (modello locale di sviluppo): hai scritto «${text}»${last?.role === "user" ? imagesSeen(last.content) : ""}`);
}

/** The pictures of a message as the model received them: how many, of which type and size. */
function imagesSeen(content: string | readonly { type: string; data?: string; mimeType?: string }[]): string {
	if (typeof content === "string") return "";
	const images = content.filter((block) => block.type === "image");
	if (images.length === 0) return "";
	const each = images.map((image) => `${image.mimeType}, ${Buffer.from(image.data ?? "", "base64").length} byte`);
	return ` e mandato ${images.length} ${images.length === 1 ? "immagine" : "immagini"} (${each.join("; ")})`;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
}
