/**
 * Well-known MCP servers the owner adds in one click (ADR 0024). Each is a remote server over
 * Streamable HTTP, run by the company that makes the service; Annie only connects to it.
 *
 * - "oauth": the owner signs in on the service's page (MCP authorization, dynamic registration).
 * - "token": the owner pastes a personal token, sent as `Authorization: Bearer …`.
 * - "none": public, nothing to sign in to.
 *
 * Addresses checked on 2026-10-17 against the vendors' published endpoints; a service that moves
 * its endpoint shows up as «Non collegato» and is fixed here.
 */
export type CatalogEntry = {
	readonly id: string;
	readonly name: string;
	/** What Annie can do with it, in Italian, one line. */
	readonly description: string;
	readonly url: string;
	readonly auth: "oauth" | "token" | "none";
	/** For "token": where the owner makes one. */
	readonly tokenHelp?: string;
	readonly category: "lavoro" | "sviluppo" | "pagamenti" | "conoscenza";
};

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
	{ id: "notion", name: "Notion", description: "Cerca, legge e scrive pagine e database del vostro Notion.", url: "https://mcp.notion.com/mcp", auth: "oauth", category: "lavoro" },
	{ id: "linear", name: "Linear", description: "Legge e crea issue, progetti e commenti su Linear.", url: "https://mcp.linear.app/mcp", auth: "oauth", category: "lavoro" },
	{ id: "asana", name: "Asana", description: "Task, progetti e scadenze del vostro Asana.", url: "https://mcp.asana.com/mcp", auth: "oauth", category: "lavoro" },
	{ id: "monday", name: "monday.com", description: "Board, elementi e aggiornamenti di monday.com.", url: "https://mcp.monday.com/mcp", auth: "oauth", category: "lavoro" },
	{ id: "atlassian", name: "Jira e Confluence", description: "Issue di Jira e pagine di Confluence (Atlassian Cloud).", url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth", category: "lavoro" },
	{ id: "stripe", name: "Stripe", description: "Clienti, pagamenti, fatture e abbonamenti del vostro account Stripe.", url: "https://mcp.stripe.com", auth: "oauth", category: "pagamenti" },
	{
		id: "github",
		name: "GitHub",
		description: "Repository, issue e pull request su GitHub.",
		url: "https://api.githubcopilot.com/mcp/",
		auth: "token",
		tokenHelp: "Su GitHub: Settings, Developer settings, Personal access tokens. Dai solo i permessi che servono.",
		category: "sviluppo",
	},
	{ id: "sentry", name: "Sentry", description: "Errori e problemi delle vostre app, da Sentry.", url: "https://mcp.sentry.dev/mcp", auth: "oauth", category: "sviluppo" },
	{ id: "vercel", name: "Vercel", description: "Progetti, deploy e log su Vercel.", url: "https://mcp.vercel.com", auth: "oauth", category: "sviluppo" },
	{ id: "supabase", name: "Supabase", description: "Database, tabelle e progetti Supabase.", url: "https://mcp.supabase.com/mcp", auth: "oauth", category: "sviluppo" },
	{ id: "context7", name: "Context7", description: "Documentazione aggiornata di librerie e framework.", url: "https://mcp.context7.com/mcp", auth: "none", category: "conoscenza" },
	{ id: "huggingface", name: "Hugging Face", description: "Modelli, dataset e Space di Hugging Face.", url: "https://huggingface.co/mcp", auth: "none", category: "conoscenza" },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
	return CONNECTOR_CATALOG.find((e) => e.id === id);
}
