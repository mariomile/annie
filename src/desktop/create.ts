import type { DesktopProvider } from "../core/desktop.ts";
import type { DesktopConfig } from "../main/config.ts";
import { DockerDesktopProvider } from "./docker-desktop.ts";
import { RemoteDesktopProvider } from "./remote-desktop.ts";

/** The desktops this configuration asks for (ADR 0045): a container each on this Docker host, or one run elsewhere. */
export function createDesktopProvider(config: DesktopConfig, context: { readonly log?: (message: string) => void; readonly fetch?: typeof fetch } = {}): DesktopProvider {
	const extra = { ...(context.log === undefined ? {} : { log: context.log }), ...(context.fetch === undefined ? {} : { fetch: context.fetch }) };
	if (config.kind === "docker") return new DockerDesktopProvider({ network: config.network, socketPath: config.socketPath, ...extra });
	return new RemoteDesktopProvider({ url: config.url, token: config.token, ...(context.fetch === undefined ? {} : { fetch: context.fetch }) });
}

/** What the desktops are, for the log and `pnpm annie check`. */
export function desktopLabel(config: DesktopConfig): string {
	return config.kind === "docker" ? `Docker${config.network === "internet" ? ", con internet" : ""}` : "remoto";
}
