/**
 * Model providers the Pi Durable adapter can register. Part of the adapter: the only
 * other place, besides pi-durable.ts, that imports Pi packages.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

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
 * - after a tool result → "Fatto. <tool output>"
 * - anything else → echoes the message
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
		return fauxAssistantMessage(`Fatto. ${output}`);
	}
	const text = last?.role === "user" ? userText(last.content) : "";
	const direct = /^\/tool\s+([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
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
	return fauxAssistantMessage(`Annie (modello locale di sviluppo): hai scritto «${text}»`);
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
}
