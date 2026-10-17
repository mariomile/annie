import { DESKTOP_LIMITS, DESKTOP_TOOLS, DesktopError, type DesktopResult } from "../core/desktop.ts";
import { imageProblem, imageType } from "../core/images.ts";
import type { McpHttpClient } from "./mcp-client.ts";

/**
 * One Cua desktop as its daemon (cua-spacesd) offers it over MCP: a tool is checked against the
 * daemon's list before it is called, so an image older or newer than the one Annie expects is
 * said plainly; replies become text and checked pictures.
 */
export class Spaces {
	constructor(private readonly client: McpHttpClient) {}

	async call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<DesktopResult> {
		if (!(await this.client.listTools(signal)).includes(tool)) throw new DesktopError(`lo schermo non offre lo strumento ${tool}: serve l'immagine di Cua indicata nella documentazione (docs/chiavi.md)`);
		const result = await this.client.callTool(tool, args, signal);
		const text = result.content
			.flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : []))
			.join("\n")
			.trim();
		if (result.isError) throw new DesktopError(`lo schermo ha risposto: ${text.slice(0, 300) || "errore senza spiegazione"}`);
		const images = result.content.flatMap((c) => {
			if (c.type !== "image" || typeof c.data !== "string") return [];
			const data = Buffer.from(c.data, "base64");
			return imageProblem(data) === undefined ? [{ mimeType: imageType(data) as string, data }] : [];
		});
		return { text: text.slice(0, DESKTOP_LIMITS.maxTextChars), images, ...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }) };
	}

	/** The tools Annie needs that this desktop does not offer. */
	async missing(signal?: AbortSignal): Promise<string[]> {
		const offered = await this.client.listTools(signal);
		return DESKTOP_TOOLS.filter((tool) => !offered.includes(tool));
	}

	/** A new session at the next call: the daemon restarted with its desktop. */
	reset(): void {
		this.client.reset();
	}
}
