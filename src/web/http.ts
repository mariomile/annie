import type { IncomingMessage, ServerResponse } from "node:http";
import type { Person } from "./auth.ts";

/** An answer other than 200: its status, its message, and fields the console reads. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export type Ctx = {
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
	readonly url: URL;
	readonly params: string[];
	readonly person: Person | undefined;
};

export type Handler = (ctx: Ctx) => Promise<unknown>;
export type Route = { method: string; pattern: RegExp; auth: "none" | "person" | "owner"; handler: Handler };
/** How a group of routes is added to the console's server. */
export type AddRoute = (method: string, path: string, auth: Route["auth"], handler: Handler) => void;

export const MAX_JSON = 1024 * 1024;

export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > max) throw new HttpError(413, `Troppo grande: oltre ${max} byte`);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const data = await readBody(req, MAX_JSON);
	if (data.length === 0) return {};
	try {
		const value: unknown = JSON.parse(data.toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "JSON non valido");
	}
}
