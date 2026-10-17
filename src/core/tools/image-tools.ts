import type { AnnieTool } from "../engine.ts";
import { IMAGE_CONNECTOR, IMAGE_SHAPES, type GenerateImage, ImageGenerationError, type ImageShape } from "../image-generation.ts";
import { imageProblem, imageType } from "../images.ts";
import type { EgressPolicy } from "../policy.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";
import { slugify } from "./research-tools.ts";

export type ImageToolsOptions = {
	readonly policy: () => Promise<EgressPolicy>;
	readonly workspace: Workspace;
	readonly generate: GenerateImage;
	/** Whether the account still has pictures today; counts this one if so. */
	readonly allow: () => boolean;
	/** Send a workspace file to a thread (through the outbox). */
	readonly sendFile: (file: { channel: string; threadId: string; path: string; caption?: string; key: string }) => Promise<void>;
	/** One line in the audit: whether a picture was changed, never the request. */
	readonly record: (event: { type: "image.generated"; changed: boolean }) => Promise<void>;
};

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * Pictures on request (ADR 0023): a new one from a description, or a picture of the workspace
 * changed (a photo someone sent). The picture is saved in `immagini/` and sent to the
 * conversation; the model is told where it is, not shown it.
 */
export function createImageTools(options: ImageToolsOptions): AnnieTool[] {
	return [
		{
			name: "image_generate",
			description:
				"Make a picture from a description (an illustration, a logo, a poster, a photo-like scene) or change a picture of your workspace (from: a photo someone sent, in uploads/). " +
				"The picture is saved in your workspace and sent to the person; do not describe it at length afterwards. " +
				"Write the prompt in English, detailed: subject, style, colors, light, composition, and any text to show in quotes. " +
				"Not for pictures of real people who did not ask for it, or to fake documents.",
			parameters: {
				type: "object",
				properties: {
					prompt: { type: "string", minLength: 3, maxLength: 4000 },
					shape: { type: "string", enum: [...IMAGE_SHAPES], description: "square (default), portrait (tall) or landscape (wide)" },
					from: { type: "string", minLength: 1, maxLength: 300, description: "To change a picture: its path in the workspace (JPEG, PNG or WebP)" },
				},
				required: ["prompt"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const policy = await options.policy();
				if (!(policy.connectors ?? []).includes(IMAGE_CONNECTOR)) return "Errore: la generazione di immagini non è attiva per questa istanza. La accende l'owner in Impostazioni, «Immagini».";
				const prompt = String(args.prompt).trim();
				const shape = (IMAGE_SHAPES.includes(args.shape as ImageShape) ? args.shape : "square") as ImageShape;
				let from: { data: Uint8Array; name: string } | undefined;
				if (typeof args.from === "string") {
					try {
						const data = await options.workspace.read(args.from);
						const problem = imageProblem(data);
						if (problem !== undefined) return `Errore: ${args.from} ${problem}.`;
						if (EXTENSION[imageType(data) ?? ""] === undefined) return `Errore: ${args.from} è una GIF: si possono cambiare solo JPEG, PNG e WebP.`;
						from = { data, name: args.from.split("/").at(-1) ?? "immagine" };
					} catch (error) {
						if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
						throw error;
					}
				}
				// The picture is made and saved in one step: a rerun after a crash finds it, not a second one.
				const made = await ctx.step("generate", async (): Promise<{ path: string } | { error: string }> => {
					if (!options.allow()) return { error: "per oggi le immagini di questo account sono finite. Dillo alla persona: si può riprovare domani." };
					try {
						const data = await options.generate(prompt, { shape, ...(from === undefined ? {} : { from }) });
						const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						const path = `immagini/${slugify(prompt).slice(0, 40).replace(/-+$/, "")}-${stamp}.${EXTENSION[imageType(data) ?? ""] ?? "png"}`;
						await options.workspace.write(path, data);
						await options.record({ type: "image.generated", changed: from !== undefined });
						return { path };
					} catch (error) {
						if (error instanceof ImageGenerationError || error instanceof WorkspaceError) return { error: error.message };
						throw error;
					}
				});
				if ("error" in made) return `Errore: ${made.error}`;
				const thread = ctx.thread;
				if (thread === undefined) return `Immagine creata: ${made.path}. Nessuna conversazione a cui inviarla: si manda con file_send.`;
				try {
					await ctx.step("send", async () => {
						await options.sendFile({ channel: thread.channel, threadId: thread.threadId, path: made.path, key: ctx.callId });
						return true;
					});
				} catch (error) {
					return `Immagine creata in ${made.path}, ma non sono riuscita a inviarla (${error instanceof Error ? error.message : String(error)}).`;
				}
				return `Immagine creata e inviata in questa conversazione: ${made.path}. Rispondi con una riga al massimo; se la persona vuole cambiarla, usa from con questo percorso.`;
			},
		},
	];
}
