import type { AnnieTool } from "../engine.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";

export type WorkspaceToolsOptions = {
	readonly workspace: Workspace;
	/** Send a workspace file to a thread (through the outbox). */
	readonly sendFile: (file: { channel: string; threadId: string; path: string; caption?: string; key: string }) => Promise<void>;
};

/** Largest text file_read returns, in characters. */
const MAX_READ = 100_000;

const pathParam = { type: "string", description: "Relative path in the workspace, e.g. report/ottobre.md", minLength: 1, maxLength: 300 };

/** The instance's file tools: write, read, list, delete, and send to the current conversation. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): AnnieTool[] {
	const { workspace } = options;
	const fail = (error: unknown): string => {
		if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
		throw error;
	};
	return [
		{
			name: "file_write",
			description: "Create or replace a text file in your workspace (reports, notes, CSV, Markdown, code). Returns the path and size.",
			parameters: { type: "object", properties: { path: pathParam, content: { type: "string", description: "Full text content" } }, required: ["path", "content"], additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				try {
					const file = await workspace.write(String(args.path), String(args.content));
					return `Salvato ${file.path} (${file.size} byte).`;
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "file_read",
			description: "Read a text file from your workspace, including files people uploaded.",
			parameters: { type: "object", properties: { path: pathParam }, required: ["path"], additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				try {
					const data = await workspace.read(String(args.path));
					if (data.includes(0)) return `${String(args.path)} è un file binario (${data.length} byte): non posso leggerlo come testo.`;
					const text = data.toString("utf8");
					return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[... troncato: ${text.length} caratteri in tutto]` : text;
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "file_list",
			description: "List the files in your workspace, optionally under a folder.",
			parameters: { type: "object", properties: { folder: { type: "string", description: "Folder to list; empty for all", maxLength: 300 } }, additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				try {
					const files = await workspace.list(typeof args.folder === "string" ? args.folder : "");
					if (files.length === 0) return "Nessun file.";
					return files.map((f) => `${f.path}\t${f.size} byte\t${f.modifiedAt}`).join("\n");
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "file_delete",
			description: "Delete a file from your workspace. Only when the person asks for it.",
			parameters: { type: "object", properties: { path: pathParam }, required: ["path"], additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				try {
					await workspace.remove(String(args.path));
					return `Eliminato ${String(args.path)}.`;
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "file_send",
			description: "Send a file from your workspace to the person you are talking to, as an attachment.",
			parameters: { type: "object", properties: { path: pathParam, caption: { type: "string", maxLength: 900 } }, required: ["path"], additionalProperties: false },
			replaySafe: true,
			async execute(args, ctx) {
				if (ctx.thread === undefined) return "Errore: non so a chi inviarlo (nessuna conversazione attiva).";
				const thread = ctx.thread;
				const path = String(args.path);
				try {
					if ((await workspace.stat(path)) === undefined) return `Errore: File not found: ${path}`;
				} catch (error) {
					return fail(error);
				}
				// One send per call, also when the call reruns after a crash.
				await ctx.step("send", async () => {
					await options.sendFile({ channel: thread.channel, threadId: thread.threadId, path, ...(typeof args.caption === "string" ? { caption: args.caption } : {}), key: ctx.callId });
					return true;
				});
				return `Inviato ${path}.`;
			},
		},
	];
}
