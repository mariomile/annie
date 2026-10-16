/**
 * Where the cells of Annie Cloud run (ADR 0007). The control plane only knows this interface;
 * a provider runs each cell (the same Annie as self-host) with its own volume, isolated from the
 * other cells: a container on one server today (ADR 0008), a micro-VM later.
 */
export interface CellProvider {
	/** Create a stopped cell with this environment. The id is the tenant's. */
	create(id: string, env: Readonly<Record<string, string>>): Promise<void>;
	/** Start it and wait until it answers; nothing happens if it is running. */
	start(id: string): Promise<void>;
	/** Stop it; its data stays. */
	stop(id: string): Promise<void>;
	/** Stop it and delete it with its data. */
	destroy(id: string): Promise<void>;
	status(id: string): Promise<CellStatus>;
	list(): Promise<string[]>;
	/** Where the control plane reaches the cell's web server: 127.0.0.1 for a cell on this host, its https domain on a platform (Railway), where the cell guards itself as a self-hosted Annie does. */
	baseUrl(id: string): Promise<string>;
}

export type CellStatus = "running" | "stopped" | "missing";
