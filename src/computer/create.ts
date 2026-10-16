import type { ComputerProvider } from "../core/computer.ts";
import type { ComputerConfig } from "../main/config.ts";
import { DockerComputerProvider } from "./docker-computer.ts";
import { FlyComputerProvider } from "./fly-computer.ts";
import { RemoteComputerProvider } from "./remote-computer.ts";

/** The computers this configuration asks for: Docker (ADR 0013), Fly or the control plane's (ADR 0015). */
export function createComputerProvider(config: ComputerConfig, context: { readonly tenant: string; readonly cellSecret?: string; readonly log?: (message: string) => void }): ComputerProvider {
	const log = context.log === undefined ? {} : { log: context.log };
	if (config.kind === "docker") return new DockerComputerProvider({ ...config, ...log });
	if (config.kind === "fly") return new FlyComputerProvider({ ...config, ...log });
	if (context.cellSecret === undefined) throw new Error("ANNIE_COMPUTER=cloud needs ANNIE_CELL_SECRET");
	return new RemoteComputerProvider({ url: config.url, tenant: context.tenant, cellSecret: context.cellSecret });
}

/** What the computers are, for the log and `pnpm annie check`. */
export function computerLabel(config: ComputerConfig): string {
	return { docker: "Docker", fly: "Fly", cloud: "Annie Cloud" }[config.kind];
}
