/**
 * Well-known MCP servers the owner adds in one click (ADR 0024). Each is a remote server over
 * Streamable HTTP, run by the company that makes the service; Annie only connects to it.
 *
 * - "oauth": the owner signs in on the service's page (MCP authorization, dynamic registration).
 * - "token": the owner pastes a personal token, sent as `Authorization: Bearer …`.
 * - "none": public, nothing to sign in to.
 *
 * Addresses checked on 2026-10-17 against the vendors' published endpoints; services whose MCP
 * server takes only pre-approved apps (Asana, Vercel) are left out until they take Annie. A service
 * that moves its endpoint shows up as «Non collegato» and is fixed here.
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
	/** The gallery's groups, in this order. */
	readonly category: "lavoro" | "pagamenti" | "conoscenza" | "sviluppo";
};

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
	{ id: "notion", name: "Notion", description: "Cerca, legge e scrive pagine e database del vostro Notion.", url: "https://mcp.notion.com/mcp", auth: "oauth", category: "lavoro" },
	{ id: "linear", name: "Linear", description: "Legge e crea issue, progetti e commenti su Linear.", url: "https://mcp.linear.app/mcp", auth: "oauth", category: "lavoro" },
	{ id: "monday", name: "monday.com", description: "Board, elementi e aggiornamenti di monday.com.", url: "https://mcp.monday.com/mcp", auth: "oauth", category: "lavoro" },
	{ id: "atlassian", name: "Jira e Confluence", description: "Issue di Jira e pagine di Confluence (Atlassian Cloud). L'amministratore Atlassian può doverlo approvare.", url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth", category: "lavoro" },
	{ id: "stripe", name: "Stripe", description: "Clienti, pagamenti, fatture e abbonamenti del vostro account Stripe. Può anche creare link di pagamento e rimborsi: collegalo solo se ti serve.", url: "https://mcp.stripe.com", auth: "oauth", category: "pagamenti" },
	{
		id: "github",
		name: "GitHub",
		description: "Repository, issue e pull request su GitHub.",
		url: "https://api.githubcopilot.com/mcp/",
		auth: "token",
		tokenHelp:
			"Su GitHub apri Settings, Developer settings, Personal access tokens, Fine-grained tokens, e crea un token: scegli una scadenza, solo i repository che servono e, nei permessi, lettura (o scrittura, se vuoi che Annie apra issue) su Contents, Issues e Pull requests.",
		category: "sviluppo",
	},
	{ id: "sentry", name: "Sentry", description: "Errori e problemi delle vostre app, da Sentry.", url: "https://mcp.sentry.dev/mcp", auth: "oauth", category: "sviluppo" },
	{ id: "supabase", name: "Supabase", description: "Database, tabelle e progetti Supabase.", url: "https://mcp.supabase.com/mcp", auth: "oauth", category: "sviluppo" },
	{ id: "context7", name: "Context7", description: "Documentazione aggiornata di librerie e framework.", url: "https://mcp.context7.com/mcp", auth: "none", category: "conoscenza" },
	{ id: "huggingface", name: "Hugging Face", description: "Modelli, dataset e Space di Hugging Face.", url: "https://huggingface.co/mcp", auth: "none", category: "conoscenza" },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
	return CONNECTOR_CATALOG.find((e) => e.id === id);
}
