/**
 * Deterministic eval runner for PR CI (no model keys).
 * Builds fixture drafts from gold expectations and runs checks.json
 * (prices, register, mustAsk, multi, PII), and checks the VAT number the heuristics keep or
 * flag as wrong against the gold lead.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDraft } from "../../src/segreteria/draft.ts";
import { extractLead } from "../../src/segreteria/extract.ts";
import { classifyInbound, isValidSender } from "../../src/segreteria/classify.ts";
import { loadChecks, runDeterministicChecks } from "../../src/segreteria/checks.ts";
import type { MissingField } from "../../src/core/practice.ts";

const root = dirname(fileURLToPath(import.meta.url));

type CaseRow = {
	id: string;
	email: {
		messageId: string;
		threadId?: string;
		from: string;
		fromName?: string;
		subject: string;
		body?: string;
		bodyText?: string;
		receivedAt: string;
		inReplyTo?: string;
	};
};

type GoldRow = {
	id: string;
	classification: string;
	lead: Record<string, unknown> | null;
	requests?: Array<string | { productOrService?: string; quantity?: string }>;
	draft: null | {
		language?: "it" | "en";
		register?: string;
		mustAsk?: string[];
		mustNotAskVatNumber?: boolean;
		mustNotInventPrices?: boolean;
		allowedAmounts?: string[];
		mustMention?: string[];
		mustNotMention?: string[];
		mustListItemsAsBullets?: boolean;
		expectedSalutationContains?: string;
		piiCheck?: boolean;
		autonomousSend?: boolean;
	};
	tenantConfig?: { requireVatNumber?: boolean };
	flow: {
		praticaAction?: string;
		action?: string;
		crmUpsertExpected: number;
		telegramButtons: string[];
		sendAllowedOnlyAfterApprove?: boolean;
		expectedStatusAfterPipeline?: string;
	};
};

async function loadJsonl<T>(path: string): Promise<T[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as T);
}

function requestLabels(requests: GoldRow["requests"]): string[] {
	if (!requests) return [];
	return requests.map((r) => (typeof r === "string" ? r : r.productOrService ?? JSON.stringify(r)));
}

const cases = await loadJsonl<CaseRow>(join(root, "dataset/cases.jsonl"));
const golds = await loadJsonl<GoldRow>(join(root, "gold/labels.jsonl"));
const goldById = new Map(golds.map((g) => [g.id, g]));
const checks = await loadChecks(root);

let checkFails = 0;
let schemaFails = 0;
let flowFails = 0;
let vatFails = 0;
const report: unknown[] = [];

for (const c of cases) {
	const g = goldById.get(c.id);
	if (!g) {
		console.error(`missing gold for ${c.id}`);
		process.exit(1);
	}

	const bodyText = c.email.bodyText ?? c.email.body ?? "";
	const mail = {
		messageId: c.email.messageId,
		threadId: c.email.threadId,
		from: c.email.from,
		fromName: c.email.fromName,
		subject: c.email.subject,
		bodyText,
		receivedAt: c.email.receivedAt,
		inReplyTo: c.email.inReplyTo,
	};

	const action = g.flow.praticaAction ?? g.flow.action ?? "";
	const valid = isValidSender(mail);

	if (!valid && g.flow.crmUpsertExpected !== 0) {
		flowFails++;
		report.push({ id: c.id, error: "invalid sender gold expects upsert" });
	}
	if (g.flow.telegramButtons.length > 0) {
		const ok =
			g.flow.telegramButtons.length === 3 &&
			g.flow.telegramButtons[0] === "Approva" &&
			g.flow.telegramButtons[1] === "Modifica" &&
			g.flow.telegramButtons[2] === "Scarta";
		if (!ok) {
			flowFails++;
			report.push({ id: c.id, error: "unexpected buttons", buttons: g.flow.telegramButtons });
		}
	}
	if ((g.classification === "non_commerciale" || action === "log_only" || action === "notify_only") && g.flow.telegramButtons.length !== 0) {
		flowFails++;
		report.push({ id: c.id, error: "expected zero buttons" });
	}
	if (g.classification === "non_commerciale" && g.flow.crmUpsertExpected !== 0) {
		flowFails++;
		report.push({ id: c.id, error: "non_commerciale must not upsert" });
	}

	if (g.lead) {
		if (!("title" in g.lead) || !("originalLanguage" in g.lead)) {
			schemaFails++;
			report.push({ id: c.id, error: "lead missing title/originalLanguage" });
		}
	}

	if (g.draft) {
		const reqs = requestLabels(g.requests);
		const leadForDraft = {
			fullName: (g.lead?.fullName as string | null) ?? "Cliente",
			title: (g.lead?.title as never) ?? null,
			company: (g.lead?.company as string | null) ?? null,
			email: (g.lead?.email as string | null) ?? null,
			phone: (g.lead?.phone as string | null) ?? null,
			productOrService: (g.lead?.productOrService as string | null) ?? "la richiesta",
			quantity: (g.lead?.quantity as string | null) ?? null,
			urgency: (g.lead?.urgency as string | null) ?? null,
			vatNumber: (g.lead?.vatNumber as string | null) ?? null,
			originalLanguage: (g.lead?.originalLanguage as "it" | "en" | "it+en" | "other") ?? "it",
			missingFields: (g.draft.mustAsk ?? []) as MissingField[],
			source: "email" as const,
			rawSubject: c.email.subject,
			rawSnippet: "",
			receivedAt: c.email.receivedAt,
			mailMessageId: c.email.messageId,
		};
		const built = buildDraft(leadForDraft, {
			mustAsk: (g.draft.mustAsk ?? []) as MissingField[],
			requests: reqs,
			allowedAmounts: g.draft.allowedAmounts,
			language: g.draft.language ?? (leadForDraft.originalLanguage === "en" ? "en" : "it"),
		});
		const fails = runDeterministicChecks(checks, {
			subject: built.subject,
			body: built.body,
			language: built.language,
			mustAsk: g.draft.mustAsk,
			mustNotAskVatNumber: g.draft.mustNotAskVatNumber,
			mustNotInventPrices: g.draft.mustNotInventPrices ?? true,
			allowedAmounts: g.draft.allowedAmounts,
			mustMention: g.draft.mustMention,
			mustNotMention: g.draft.mustNotMention,
			mustListItemsAsBullets: g.draft.mustListItemsAsBullets,
			requestCount: reqs.length,
			expectedSalutationContains: g.draft.expectedSalutationContains,
			customerEmail: (g.lead?.email as string | null) ?? null,
			piiCheck: g.draft.piiCheck ?? true,
		});
		if (fails.length) {
			checkFails += fails.length;
			report.push({ id: c.id, checkFails: fails });
		} else {
			report.push({ id: c.id, ok: true });
		}
	} else {
		report.push({ id: c.id, ok: true, draft: null });
	}

	classifyInbound(mail);
	const extracted = extractLead(mail, g.tenantConfig);
	// The VAT number is checked on paper by the heuristics too: kept only when written right, a wrong one asked again.
	if (g.lead) {
		const goldVat = (g.lead.vatNumber as string | null | undefined) ?? null;
		const goldInvalid = ((g.lead.missingFields as string[] | undefined) ?? []).includes("vatNumberInvalid");
		const invalid = extracted.missingFields.includes("vatNumberInvalid");
		if (extracted.vatNumber !== goldVat || invalid !== goldInvalid) {
			vatFails++;
			report.push({ id: c.id, error: "vatNumber", expected: { vatNumber: goldVat, invalid: goldInvalid }, got: { vatNumber: extracted.vatNumber, invalid } });
		}
	}
}

const outDir = join(root, "last-report");
await mkdir(outDir, { recursive: true });
await writeFile(
	join(outDir, "last-report.json"),
	`${JSON.stringify({ cases: cases.length, checkFails, schemaFails, flowFails, vatFails, report }, null, "\t")}\n`,
);

console.log(`eval:segreteria cases=${cases.length} checkFails=${checkFails} schemaFails=${schemaFails} flowFails=${flowFails} vatFails=${vatFails}`);
if (checkFails > 0 || schemaFails > 0 || flowFails > 0 || vatFails > 0) {
	console.error(JSON.stringify(report.filter((r) => r && typeof r === "object" && ("error" in r || "checkFails" in r)), null, 2));
	process.exit(1);
}
console.log("ok");
