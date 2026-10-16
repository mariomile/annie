import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import type { AuditLog } from "./audit.ts";

export type UsageRecord = {
	readonly at: string;
	readonly provider: string;
	readonly model: string;
	readonly role: "extract" | "draft" | "classify" | "other";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly estimatedUsd: number;
	readonly submissionId?: string;
};

export type CostCaps = {
	readonly softUsdPerDay: number;
	readonly hardUsdPerDay: number;
};

export const DEFAULT_COST_CAPS: CostCaps = { softUsdPerDay: 5, hardUsdPerDay: 20 };

/** Rough public list prices (USD / MTok) used only for estimates in tests and caps. */
const PRICE: Record<string, { in: number; out: number }> = {
	"claude-haiku-5-5": { in: 0.1, out: 0.5 },
	"claude-sonnet-5-5": { in: 2, out: 10 },
	"gpt-5-mini": { in: 0.25, out: 2 },
	"gpt-5": { in: 1.25, out: 10 },
	"annie-dev": { in: 0, out: 0 },
};

export function estimateUsd(modelId: string, inputTokens: number, outputTokens: number): number {
	const p = PRICE[modelId] ?? { in: 2, out: 10 };
	return (inputTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
}

/** Europe/Rome civil day key YYYY-MM-DD. */
export function romeDayKey(date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Rome",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

/**
 * Per-tenant daily usage ledger (append-only JSONL + day totals JSON).
 * Soft cap: warn; hard cap: reject new model calls (send-only Approva still allowed).
 */
export class UsageLedger {
	constructor(
		private readonly tenantDir: string,
		private readonly caps: CostCaps = DEFAULT_COST_CAPS,
	) {}

	private usagePath(): string {
		return join(this.tenantDir, "usage.jsonl");
	}

	private totalsPath(): string {
		return join(this.tenantDir, "usage-totals.json");
	}

	async ensure(): Promise<void> {
		await mkdir(this.tenantDir, { recursive: true });
	}

	async todaySpent(): Promise<number> {
		const totals = await this.readTotals();
		return totals[romeDayKey()] ?? 0;
	}

	async record(rec: UsageRecord, audit?: AuditLog): Promise<{ softExceeded: boolean; hardExceeded: boolean }> {
		await this.ensure();
		await appendFile(this.usagePath(), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
		const day = romeDayKey(new Date(rec.at));
		const totals = await this.readTotals();
		totals[day] = (totals[day] ?? 0) + rec.estimatedUsd;
		await writeFileAtomic(this.totalsPath(), `${JSON.stringify(totals, null, "\t")}\n`);
		const spent = totals[day]!;
		const softExceeded = spent >= this.caps.softUsdPerDay;
		const hardExceeded = spent >= this.caps.hardUsdPerDay;
		if (audit) {
			if (hardExceeded) {
				await audit.append({ type: "cost.denied", day, spentUsd: spent, hardUsd: this.caps.hardUsdPerDay });
			} else if (softExceeded) {
				await audit.append({ type: "cost.warn", day, spentUsd: spent, softUsd: this.caps.softUsdPerDay });
			}
		}
		return { softExceeded, hardExceeded };
	}

	/** Spent this month (Europe/Rome), or in the month "YYYY-MM". */
	async monthSpent(month = romeDayKey().slice(0, 7)): Promise<number> {
		const totals = await this.readTotals();
		return Object.entries(totals).reduce((sum, [day, usd]) => (day.startsWith(`${month}-`) ? sum + usd : sum), 0);
	}

	/** true when new model generations must be rejected. */
	async isHardCapped(): Promise<boolean> {
		return (await this.todaySpent()) >= this.caps.hardUsdPerDay;
	}

	async isSoftCapped(): Promise<boolean> {
		return (await this.todaySpent()) >= this.caps.softUsdPerDay;
	}

	private async readTotals(): Promise<Record<string, number>> {
		try {
			return JSON.parse(await readFile(this.totalsPath(), "utf8")) as Record<string, number>;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
	}
}

export const TELEGRAM_SOFT_CAP = `Limite soft di spesa · oggi

Questo tenant ha superato circa 5 USD di modelli nel giorno civile.
Continuo a preparare le bozze già in corso. Le nuove mail restano in coda e ti avviso se il ritmo non cala.
Se serve alzare il tetto, chiedilo all'owner.`;

export const TELEGRAM_HARD_CAP = `Limite hard di spesa · oggi

Ho smesso di usare il modello per questo tenant: raggiunto il tetto di circa 20 USD nel giorno civile.
Nessuna nuova bozza partirà fino a domani (o finché l'owner non alza il tetto).
Le mail in arrivo restano salvate e non vengono inviate risposte automatiche.
Pratiche già in approvazione: puoi ancora Approvare una bozza già pronta (parte solo l'invio mail).`;

export const TELEGRAM_HARD_CAP_REGEN = `Non posso rigenerare la bozza: tetto di spesa giornaliero raggiunto.
Puoi Scartare, oppure Approvare la bozza già mostrata (v{n}) senza rigenerarla.`;
