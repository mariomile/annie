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

export type ImageQuality = "low" | "medium" | "high";
export const IMAGE_QUALITIES: readonly ImageQuality[] = ["low", "medium", "high"];

export type ImageRequest = {
	/** Undefined: square for a new picture, the source's own proportions for a change. */
	readonly shape?: ImageShape;
	/** A picture to change. */
	readonly from?: { readonly data: Uint8Array; readonly name: string };
	/** Variations, 1 to 4. */
	readonly count?: number;
	/** A PNG with no background: logos, stickers. */
	readonly transparent?: boolean;
	readonly quality?: ImageQuality;
	readonly signal?: AbortSignal;
};

export type GenerateImage = (prompt: string, request: ImageRequest) => Promise<Uint8Array[]>;

/** Why there is no picture, in words for the person: never the request or the key. */
export class ImageGenerationError extends Error {
	override readonly name = "ImageGenerationError";
}

/** The largest answer accepted: a 20 MB picture in base64, and the JSON around it, for each picture asked. */
const MAX_ANSWER_BYTES = 28 * 1024 * 1024;

export function imageGenerator(config: ImageGenerationConfig, fetchImpl: typeof fetch = fetch): GenerateImage {
	const base = config.url.replace(/\/+$/, "");
	// DALL·E 3 has its own sizes and qualities, one picture a request, no changes to a picture, no
	// transparency, and sends a link unless asked for the bytes; gpt-image-1 always sends the bytes.
	const dalle = config.model.startsWith("dall-e");
	const sizes: Record<ImageShape, string> = dalle ? { square: "1024x1024", portrait: "1024x1792", landscape: "1792x1024" } : { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };
	const ask = async (prompt: string, request: ImageRequest, n: number): Promise<Uint8Array[]> => {
		const { shape, from, transparent, quality } = request;
		const size = shape === undefined ? (from === undefined ? sizes.square : "auto") : sizes[shape];
		const fields: Record<string, string | number> = {
			model: config.model,
			prompt,
			n,
			size,
			...(quality === undefined ? {} : { quality: dalle ? (quality === "high" ? "hd" : "standard") : quality }),
			...(transparent === true ? { background: "transparent", output_format: "png" } : {}),
			...(dalle ? { response_format: "b64_json" } : {}),
		};
		let body: string | FormData;
		if (from === undefined) body = JSON.stringify(fields);
		else {
			body = new FormData();
			for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
			body.set("image", new Blob([Uint8Array.from(from.data)], { type: imageType(from.data) ?? "application/octet-stream" }), from.name);
		}
		// A picture takes its time; past this, the person is told. A run stopped meanwhile stops it too.
		const timeout = AbortSignal.timeout(120_000);
		let response: Response;
		let text: string;
		try {
			response = await fetchImpl(`${base}/images/${from === undefined ? "generations" : "edits"}`, {
				method: "POST",
				headers: { authorization: `Bearer ${config.apiKey}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
				body,
				signal: request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]),
			});
			text = await readCapped(response, MAX_ANSWER_BYTES * n);
		} catch (error) {
			if (error instanceof ImageGenerationError) throw error;
			throw new ImageGenerationError(timeout.aborted ? "il servizio di immagini non ha risposto in due minuti" : "il servizio di immagini non risponde");
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
			if (response.status === 400 && /moderation|content_policy|safety/.test(code))
				throw new ImageGenerationError("il servizio di immagini ha rifiutato la richiesta per i suoi limiti sui contenuti: riformula senza persone reali, marchi o contenuti espliciti, oppure spiegalo alla persona");
			if (response.status === 400) throw new ImageGenerationError("il servizio di immagini non ha accettato la richiesta: prova una descrizione più corta e semplice");
			if (response.status === 401 || response.status === 403) throw new ImageGenerationError("il servizio di immagini rifiuta la chiave: va avvisato chi gestisce il server");
			if (response.status === 429) throw new ImageGenerationError("troppe richieste al servizio di immagini, riprova tra poco");
			throw new ImageGenerationError(`il servizio di immagini risponde ${response.status}, riprova più tardi`);
		}
		const pictures = (parsed?.data ?? []).map((d) => (typeof d?.b64_json === "string" ? Buffer.from(d.b64_json, "base64") : undefined));
		// A link is not followed: the bytes come in the answer or not at all.
		if (pictures.length === 0 || pictures.some((p) => p === undefined || imageType(p) === undefined)) throw new ImageGenerationError("il servizio non ha dato un'immagine");
		return (pictures as Uint8Array[]).slice(0, n);
	};
	return async (prompt, request) => {
		const count = Math.min(4, Math.max(1, request.count ?? 1));
		if (dalle && request.from !== undefined) throw new ImageGenerationError("questo servizio di immagini crea immagini nuove ma non ritocca quelle esistenti");
		if (dalle && request.transparent === true) throw new ImageGenerationError("questo servizio di immagini non fa sfondi trasparenti");
		if (!dalle) return ask(prompt, request, count);
		return (await Promise.all(Array.from({ length: count }, () => ask(prompt, request, 1)))).flat();
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
	return Buffer.concat(chunks, size).toString("utf8");
}
