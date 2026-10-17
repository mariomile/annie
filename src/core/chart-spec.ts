/**
 * What a chart is made of (ADR 0030), apart from the drawing: the tool reads these without
 * loading the rasteriser and its font into the main process. Only erasable TypeScript here: the
 * document worker runs this file by stripping the types.
 */
export class ChartError extends Error {
	override readonly name = "ChartError";
}

export const CHART_KINDS = ["bar", "line", "pie"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export type ChartSeries = { readonly name?: string; readonly values: readonly (number | null)[] };
export type ChartSpec = {
	readonly kind: ChartKind;
	readonly title?: string;
	readonly subtitle?: string;
	readonly labels: readonly string[];
	readonly series: readonly ChartSeries[];
	readonly stacked?: boolean;
	readonly horizontal?: boolean;
	/** Bars in order of value (of the first series, or of the stack). */
	readonly sort?: "asc" | "desc";
	/** €, $, % or a unit written after the number (kg, ore). */
	readonly unit?: string;
	readonly decimals?: number;
	/** A reference line: a goal, a budget, an average. */
	readonly target?: number;
	readonly targetLabel?: string;
};
export type Chart = { readonly data: Uint8Array; readonly width: number; readonly height: number; readonly notes: readonly string[] };

export const CHART_LIMITS = { maxSeries: 8, maxPoints: 1000, maxBars: 120, maxSlices: 6, maxPieValues: 1000, maxLabel: 80, maxTitle: 160, maxValue: 1e15, minValue: 1e-9 } as const;
