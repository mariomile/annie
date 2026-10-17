import { imageType } from "./images.ts";

/**
 * Pictures made on request (ADR 0023), through any service that speaks OpenAI's image API
 * (`POST <base>/images/generations`, and `/images/edits` to change a picture): OpenAI's
 * gpt-image-1, or another model behind the same API. The operator chooses the service; the owner
 * allows it instance by instance (connector "image_generation"). Only the request and, to change
 * one, the picture leave the server, for that service and nowhere else.
 */

/** The egress name of image generation: an instance asks for pictures only with it in its connectors. */
export const IMAGE_CONNECTOR = "image_generation";

export type ImageGenerationConfig = {
	/** The API base, e.g. https://api.openai.com/v1. */
	readonly url: string;
	readonly apiKey: string;
	readonly model: string;
	/** Pictures per day for each account; then the tool says so. */
	readonly maxPerDay: number;
};

export type ImageShape = "square" | "portrait" | "landscape";
export const IMAGE_SHAPES: readonly ImageShape[] = ["square", "portrait", "landscape"];

export type GenerateImage = (prompt: string, options: { readonly shape: ImageShape; readonly from?: { readonly data: Uint8Array; readonly name: string } }) => Promise<Uint8Array>;

/** Why there is no picture, in words for the person: never the request or the key. */
export class ImageGenerationError extends Error {
	override readonly name = "ImageGenerationError";
}

/** The largest answer accepted: a 20 MB picture in base64, and the JSON around it. */
const MAX_ANSWER_BYTES = 28 * 1024 * 1024;

export function imageGenerator(config: ImageGenerationConfig, fetchImpl: typeof fetch = fetch): GenerateImage {
	const base = config.url.replace(/\/+$/, "");
	// DALL·E 3 has its own sizes and sends a link unless asked for the bytes; gpt-image-1 always sends the bytes.
	const dalle = config.model.startsWith("dall-e");
	const sizes: Record<ImageShape, string> = dalle ? { square: "1024x1024", portrait: "1024x1792", landscape: "1792x1024" } : { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };
	return async (prompt, { shape, from }) => {
		const size = sizes[shape];
		let body: string | FormData;
		if (from === undefined) {
			body = JSON.stringify({ model: config.model, prompt, n: 1, size, ...(dalle ? { response_format: "b64_json" } : {}) });
		} else {
			body = new FormData();
			body.set("model", config.model);
			body.set("prompt", prompt);
			body.set("size", size);
			body.set("image", new Blob([Uint8Array.from(from.data)], { type: imageType(from.data) ?? "application/octet-stream" }), from.name);
		}
		let response: Response;
		try {
			response = await fetchImpl(`${base}/images/${from === undefined ? "generations" : "edits"}`, {
				method: "POST",
				headers: { authorization: `Bearer ${config.apiKey}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
				body,
				// A picture takes its time; past this, the person is told.
				signal: AbortSignal.timeout(120_000),
			});
		} catch {
			throw new ImageGenerationError("il servizio di immagini non risponde");
		}
		let text: string;
		try {
			text = await readCapped(response, MAX_ANSWER_BYTES);
		} catch (error) {
			if (error instanceof ImageGenerationError) throw error;
			throw new ImageGenerationError("il servizio di immagini non risponde");
		}
		let parsed: { data?: { b64_json?: unknown }[]; error?: { code?: unknown } } | undefined;
		try {
			parsed = JSON.parse(text) as typeof parsed;
		} catch {
			parsed = undefined;
		}
		if (!response.ok) {
			// Only the status and the error's code: the messages can repeat the request.
			const code = typeof parsed?.error?.code === "string" ? parsed.error.code : "";
			if (response.status === 400 && /moderation|content_policy|safety/.test(code)) throw new ImageGenerationError("il servizio di immagini ha rifiutato la richiesta per i suoi limiti sui contenuti");
			if (response.status === 401 || response.status === 403) throw new ImageGenerationError("il servizio di immagini rifiuta la chiave");
			if (response.status === 429) throw new ImageGenerationError("troppe richieste al servizio di immagini, riprova tra poco");
			throw new ImageGenerationError(`il servizio di immagini risponde ${response.status}`);
		}
		const b64 = parsed?.data?.[0]?.b64_json;
		const data = typeof b64 === "string" ? Buffer.from(b64, "base64") : undefined;
		// A link is not followed: the bytes come in the answer or not at all.
		if (data === undefined || imageType(data) === undefined) throw new ImageGenerationError("il servizio non ha dato un'immagine");
		return new Uint8Array(data);
	};
}

/** The body as text, refused past `max` bytes whatever the headers say. */
async function readCapped(response: Response, max: number): Promise<string> {
	if (Number(response.headers.get("content-length") ?? "0") > max) throw new ImageGenerationError("la risposta del servizio di immagini è troppo grande");
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			throw new ImageGenerationError("la risposta del servizio di immagini è troppo grande");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}
