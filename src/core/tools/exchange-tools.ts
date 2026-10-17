import { formatResult } from "../calc.ts";
import type { AnnieTool } from "../engine.ts";
import { currenciesOf, type ExchangeRates, ExchangeRateError, FIRST_RATES_DATE, type Fallback, PUBLICATION_TIME, type RatesOn, rateBetween } from "../exchange-rates.ts";
import { italianDay } from "../weather.ts";

export type ExchangeToolsOptions = { readonly rates: ExchangeRates };

/** Amounts above this are not an invoice: a typo, refused rather than converted. */
const MAX_AMOUNT = 1e12;
const CODE = /^[A-Za-z]{3}$/;

/**
 * Exchange rates and conversions with the ECB's reference rates. The numbers come from outside
 * but are validated numbers, and the answer echoes no provider text: no fence is needed.
 */
export function createExchangeTools(options: ExchangeToolsOptions): AnnieTool[] {
	return [
		{
			name: "exchange_rate",
			description:
				"Official exchange rates of the European Central Bank (euro foreign exchange reference rates, about 30 currencies, published on working days around 16:00 CET), and conversions with them. " +
				"Use it whenever money in another currency appears or a rate is asked, rather than guessing a rate or giving one from memory. " +
				"For an invoice or a payment pass its date, so the rate is that day's; without date it is the latest published. " +
				"It converts amount itself; combine it with calculate for VAT, discounts or totals on the converted amount, and with document_create for a quote in another currency. " +
				"Give the date of the rate, and say these are reference rates: a bank or a card applies its own.",
			parameters: {
				type: "object",
				properties: {
					from: { type: "string", pattern: CODE.source, description: "The currency of the amount, an ISO 4217 code: USD, GBP, CHF, JPY…" },
					to: { type: "string", pattern: CODE.source, description: "The currency to convert to, an ISO 4217 code (EUR if not given)" },
					amount: { type: "number", minimum: 0, maximum: MAX_AMOUNT, description: "The amount in from to convert; without it, only the rate" },
					date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `The day of the rate, YYYY-MM-DD, e.g. the invoice date: not in the future, not before ${FIRST_RATES_DATE} (today if not given)` },
				},
				required: ["from"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const from = currencyCode(args.from);
				const to = args.to === undefined ? "EUR" : currencyCode(args.to);
				if (from === undefined || to === undefined) return "Errore: le valute vanno scritte con il codice di tre lettere (USD, GBP, CHF…).";
				if (from === to) return `Errore: ${from} e ${to} sono la stessa valuta.`;
				const amount = args.amount;
				if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT)) return "Errore: l'importo è un numero da 0 a mille miliardi.";
				const date = typeof args.date === "string" ? args.date : undefined;
				return ctx.step("rates", async () => {
					try {
						return exchangeAnswer(await options.rates.rateOn(date), from, to, amount);
					} catch (error) {
						return `Errore: ${error instanceof ExchangeRateError ? error.message : "i cambi della BCE non sono disponibili"}.`;
					}
				});
			},
		},
	];
}

function currencyCode(value: unknown): string | undefined {
	return typeof value === "string" && CODE.test(value.trim()) ? value.trim().toUpperCase() : undefined;
}

/** The conversion, the rate both ways, its date and source, why that date, and what a reference rate is. */
function exchangeAnswer(found: RatesOn, from: string, to: string, amount: number | undefined): string {
	const { day } = found;
	const rate = rateBetween(day, from, to);
	if (rate === undefined) {
		const missing = [from, to].filter((code) => rateBetween(day, code, "EUR") === undefined);
		return `Errore: la BCE non pubblica un cambio per ${missing.join(" né per ")} (${day.date}). Valute disponibili: ${currenciesOf(day).join(", ")}.`;
	}
	const through = from !== "EUR" && to !== "EUR" ? " (calcolato passando dall'euro: la BCE pubblica i cambi contro l'euro)" : "";
	return [
		...(amount === undefined ? [] : [`${formatResult(amount, Math.round(amount * 100) / 100 === amount ? 2 : undefined)} ${from} = ${formatResult(amount * rate, 2)} ${to}`]),
		`Cambio: 1 ${from} = ${rateText(rate)} ${to}; 1 ${to} = ${rateText(1 / rate)} ${from}${through}`,
		`Data del cambio: ${dayText(day.date)}; fonte: BCE, tassi di riferimento.`,
		...(found.fallback === undefined ? [] : [fallbackText(found.fallback, found.asked)]),
		"Sono tassi di riferimento: una banca o una carta applicano un proprio cambio, con le loro commissioni.",
	].join("\n");
}

/** Four decimals, more for a small rate so that four significant digits show (1 JPY = 0,006158 EUR). */
function rateText(rate: number): string {
	return formatResult(rate, Math.max(4, 3 - Math.floor(Math.log10(rate))));
}

/** venerdì 16 ottobre 2026. */
function dayText(date: string): string {
	return `${italianDay(date)} ${date.slice(0, 4)}`;
}

function fallbackText(fallback: Fallback, asked: string): string {
	const before = "quindi vale quello dell'ultimo giorno lavorativo prima.";
	if (fallback === "weekend") return `Hai chiesto ${dayText(asked)}: nel fine settimana la BCE non pubblica cambi, ${before}`;
	if (fallback === "holiday") return `Hai chiesto ${dayText(asked)}: quel giorno era festivo per la BCE e non sono usciti cambi, ${before}`;
	if (fallback === "not_yet") return `I cambi di oggi escono verso le ${PUBLICATION_TIME} (ora italiana): per ora vale l'ultimo pubblicato.`;
	return "I cambi di oggi non sono ancora usciti, o oggi è festivo per la BCE: vale l'ultimo pubblicato.";
}
