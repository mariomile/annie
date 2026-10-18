import type { ScreenViews } from "../core/screen-views.ts";
import type { Person } from "./auth.ts";
import { type AddRoute, HttpError, STREAMED } from "./http.ts";

export type ScreenRoutesDeps = {
	readonly screens: ScreenViews | undefined;
	/** Refuses unless the person may see this conversation of the agente: theirs, with an agente they can open. */
	readonly thread: (person: Person, instanceId: string, threadId: string) => Promise<void>;
};

/**
 * The agente's screen, live next to the chat (ADR 0067): the last picture it took of its screen in
 * this conversation. Only read: the person watches, the agente works.
 */
export function screenRoutes(route: AddRoute, { screens, thread }: ScreenRoutesDeps): void {
	const view = async (person: Person | undefined, instanceId: string, threadId: string) => {
		await thread(person as Person, instanceId, threadId);
		return screens?.get(instanceId, "web", threadId);
	};
	route("GET", "/api/instances/:id/threads/:thread/screen", "person", async ({ person, params }) => {
		const seen = await view(person, params[0] as string, params[1] as string);
		return { screen: seen === undefined ? null : { version: seen.version, at: seen.at, ...(seen.action === undefined ? {} : { action: seen.action }) } };
	});
	route("GET", "/api/instances/:id/threads/:thread/screen.png", "person", async ({ person, params, res }) => {
		const seen = await view(person, params[0] as string, params[1] as string);
		if (seen === undefined) throw new HttpError(404, "Lo schermo non è ancora stato usato in questa conversazione");
		res.writeHead(200, { "content-type": "image/png", "content-length": seen.png.length, "x-content-type-options": "nosniff", "cache-control": "no-store" });
		res.end(seen.png);
		return STREAMED;
	});
}
