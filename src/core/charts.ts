import { CHART_KINDS, CHART_LIMITS, type Chart, ChartError, type ChartKind, type ChartSpec } from "./chart-spec.ts";
import { type Contour, circle, type Face, fitText, measure, missingCharacters, Raster, type Rgb, roundedRect, sector, stroke, textContours, wrapText } from "./raster.ts";

/**
 * Charts as pictures (ADR 0030): bars, lines and a ring (pie) drawn into a PNG that goes to a
 * chat or into a document. The look follows a few fixed rules: thin bars with a rounded end and
 * a square base, 2-pixel lines, a legend from two series up, values written where they fit and
 * never cut, text in ink and never in the series colour, eight colours in a fixed order checked
 * for colour blindness. Pictures are drawn at twice the size they are meant to be seen, and the
 * text is large enough to read in a chat bubble on a phone. Only erasable TypeScript here: the
 * document worker runs this file by stripping the types.
 */
export { CHART_KINDS, CHART_LIMITS, type Chart, ChartError, type ChartKind, type ChartSeries, type ChartSpec } from "./chart-spec.ts";

const W = 1200;
const H = 900;
const PAD = 44;
const SURFACE: Rgb = [252, 252, 251];
const INK: Rgb = [11, 11, 11];
const INK_2: Rgb = [82, 81, 78];
const GRID: Rgb = [230, 229, 225];
const BASELINE: Rgb = [169, 168, 163];
/** «Altri» in a ring: grey, so it does not look like one more category (or like an alarm in red). */
const OTHERS: Rgb = [168, 167, 162];
/** The categorical colours, in their fixed order (blue, orange, aqua, yellow, magenta, green, violet, red). */
export const SERIES_COLORS: readonly Rgb[] = [
	[0x2a, 0x78, 0xd6],
	[0xeb, 0x68, 0x34],
	[0x1b, 0xaf, 0x7a],
	[0xed, 0xa1, 0x00],
	[0xe8, 0x7b, 0xa4],
	[0x00, 0x83, 0x00],
	[0x62, 0x50, 0xd6],
	[0xe3, 0x49, 0x48],
];

/** Text sizes for a picture shown about 360 points wide in a chat: the axis comes out near 9 points. */
const SIZE = { title: 50, subtitle: 34, legend: 32, axis: 30, value: 30, hero: 84, small: 24 } as const;
const BAR_MAX = 48;
const RADIUS = 8;
const GAP = 4;

type Series = { name: string; values: (number | null)[] };
/** How numbers are written on one chart: the same short scale (mila, Mln, Mld) on the axis and on the values. */
type Format = { unit?: string; decimals: number; scale: number; suffix: string };
type Prepared = {
	kind: ChartKind;
	title?: string;
	subtitle?: string;
	labels: string[];
	series: Series[];
	stacked: boolean;
	horizontal?: boolean;
	target?: { value: number; label: string };
	format: Format;
	timeLike: boolean;
	/** The last slice of a ring gathers the smallest ones. */
	others?: boolean;
	notes: string[];
};
type Box = { x0: number; y0: number; x1: number; y1: number };

export function drawChart(spec: ChartSpec): Chart {
	const p = prepare(spec);
	const r = new Raster(W, H, SURFACE);
	let top = PAD;
	top = header(r, p, top);
	if (p.kind === "pie") pie(r, p, top);
	else {
		if (p.series.length > 1 || p.target !== undefined) top = legend(r, p, top) + 8;
		if (p.kind === "line") lines(r, p, top);
		else bars(r, p, top);
	}
	return { data: r.png(), width: W, height: H, notes: p.notes };
}

/** Emoji and other pictographs are left out: the chart font has letters, not pictures. */
const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}︎️‍⃣]/gu;

function clean(text: string | undefined, max: number): string | undefined {
	if (text === undefined) return undefined;
	const t = text.replace(PICTOGRAPHS, "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
	if (t === "") return undefined;
	if (t.length <= max) return t;
	// Cut at a word, with «…»: half a word reads as a typo.
	const cut = t.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function prepare(spec: ChartSpec): Prepared {
	if (!CHART_KINDS.includes(spec.kind)) throw new ChartError("il tipo di grafico deve essere bar, line o pie");
	const notes: string[] = [];
	if (spec.labels.length === 0) throw new ChartError("servono le etichette (labels): le categorie o le date dei valori");
	if (spec.series.length === 0) throw new ChartError("non ci sono dati: serve almeno una serie di valori");
	if (spec.series.length > CHART_LIMITS.maxSeries) throw new ChartError(`al massimo ${CHART_LIMITS.maxSeries} serie in un grafico: con più serie i colori non si distinguono. Raggruppa le minori in «Altri» o fai più grafici`);
	const limit = spec.kind === "line" ? CHART_LIMITS.maxPoints : spec.kind === "pie" ? CHART_LIMITS.maxPieValues : CHART_LIMITS.maxBars;
	if (spec.labels.length > limit) {
		throw new ChartError(spec.kind === "line" ? `al massimo ${limit} punti per linea: raggruppa i dati (per settimana o per mese)` : spec.kind === "pie" ? `al massimo ${limit} fette` : `troppe barre (al massimo ${limit}): raggruppa i dati o usa una linea`);
	}
	const series: Series[] = spec.series.map((s, i) => {
		if (s.values.length > spec.labels.length) throw new ChartError(`la serie ${i + 1} ha ${s.values.length} valori ma le etichette sono ${spec.labels.length}: devono essere tante quante`);
		const values = spec.labels.map((_, j) => {
			const v = s.values[j];
			if (v === undefined || v === null) return null;
			if (typeof v !== "number" || !Number.isFinite(v)) throw new ChartError(`la serie ${i + 1} ha un valore che non è un numero`);
			if (Math.abs(v) > CHART_LIMITS.maxValue) throw new ChartError(`la serie ${i + 1} ha un valore troppo grande da disegnare`);
			if (v !== 0 && Math.abs(v) < CHART_LIMITS.minValue) throw new ChartError(`la serie ${i + 1} ha un valore troppo piccolo da disegnare: cambia unità (mg invece di g)`);
			return v;
		});
		return { name: clean(s.name, CHART_LIMITS.maxLabel) ?? `Serie ${i + 1}`, values };
	});
	if (series.every((s) => s.values.every((v) => v === null))) throw new ChartError("tutti i valori sono vuoti");
	if (spec.target !== undefined && (!Number.isFinite(spec.target) || Math.abs(spec.target) > CHART_LIMITS.maxValue)) throw new ChartError("la linea di riferimento (target) deve essere un numero");
	const stacked = spec.stacked === true && spec.kind === "bar" && series.length > 1;
	const raw = spec.labels.map((l) => clean(String(l), CHART_LIMITS.maxLabel) ?? "");
	const dates = dateLabels(raw);
	const labels = dates ?? raw;
	const p: Prepared = {
		kind: spec.kind,
		labels,
		series,
		stacked,
		notes,
		timeLike: dates !== undefined || labels.filter((l) => TIME.test(l)).length >= labels.length * 0.8,
		format: { decimals: 0, scale: 1, suffix: "" },
		...(spec.horizontal === undefined ? {} : { horizontal: spec.horizontal }),
	};
	const title = clean(spec.title, CHART_LIMITS.maxTitle);
	const subtitle = clean(spec.subtitle, CHART_LIMITS.maxTitle);
	if (title !== undefined) p.title = title;
	if (subtitle !== undefined) p.subtitle = subtitle;
	if (spec.kind === "pie") preparePie(p);
	else if (spec.kind === "line" && labels.length < 2) throw new ChartError("una linea ha bisogno di almeno due punti: per un valore solo usa le barre");
	if (spec.kind === "bar" && spec.sort !== undefined) sortBars(p, spec.sort);
	if (spec.target !== undefined && spec.kind !== "pie") p.target = { value: spec.target, label: clean(spec.targetLabel, 40) ?? "Obiettivo" };
	p.format = numberFormat(p, clean(spec.unit, 12), spec.decimals);
	const missing = [p.title, p.subtitle, p.target?.label, ...p.labels, ...p.series.map((s) => s.name)].reduce((n, t) => n + (t === undefined ? 0 : missingCharacters(t)), 0);
	if (missing > 0) notes.push(`${missing === 1 ? "Una lettera" : `${missing} lettere`} di alfabeti diversi dal latino ${missing === 1 ? "è scritta" : "sono scritte"} come «?»: nel grafico ci sono solo lettere latine.`);
	return p;
}

/** Labels that are mostly periods: months, quarters, weeks, years, dates. They stay in order and under the bars. */
const TIME =
	/^(\d{1,2} )?(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic|jan|may|jun|jul|aug|sep|oct|dec)[a-z]*\.?( '?\d{2,4})?$|^(t|q|trim\.?|sett?\.?|settimana|week|w|h|s)\s?\d{1,2}( '?\d{2,4})?$|^\d{4}$|^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$|^\d{4}-\d{2}(-\d{2})?$/i;

const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

/** Dates (2026-10-17 or 17/10/2026) written the Italian way, «17 ott», with the year where it changes. */
function dateLabels(labels: readonly string[]): string[] | undefined {
	const parsed = labels.map((l) => {
		const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(l);
		const it = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(l);
		const [y, m, d] = iso !== null ? [iso[1], iso[2], iso[3]].map(Number) : it !== null ? [it[3], it[2], it[1]].map(Number) : [];
		if (y === undefined || m === undefined || d === undefined || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
		return { y, m, d };
	});
	if (parsed.some((x) => x === undefined)) return undefined;
	let year = -1;
	return parsed.map((x) => {
		const { y, m, d } = x as { y: number; m: number; d: number };
		const label = `${d} ${MONTHS[m - 1]}${y !== year ? ` ${y}` : ""}`;
		year = y;
		return label;
	});
}

function preparePie(p: Prepared): void {
	if (p.series.length > 1) throw new ChartError("una torta mostra una serie sola: per confrontare più serie usa le barre");
	const values = (p.series[0] as Series).values;
	if (values.some((v) => v !== null && v < 0)) throw new ChartError("una torta non può avere valori negativi: usa le barre");
	let slices = p.labels.map((label, i) => ({ label, value: values[i] ?? 0 })).filter((s) => s.value > 0);
	if (slices.length === 0) throw new ChartError("la torta è vuota: tutti i valori sono zero");
	slices.sort((a, b) => b.value - a.value);
	if (slices.length > CHART_LIMITS.maxSlices) {
		const kept = slices.slice(0, CHART_LIMITS.maxSlices - 1);
		const rest = slices.slice(CHART_LIMITS.maxSlices - 1);
		p.notes.push(`Le ${rest.length} voci più piccole sono raccolte in «Altri»: in una torta se ne distinguono al massimo ${CHART_LIMITS.maxSlices}. Per vederle tutte usa le barre.`);
		slices = [...kept, { label: "Altri", value: rest.reduce((n, s) => n + s.value, 0) }];
		p.others = true;
	}
	p.labels = slices.map((s) => s.label);
	(p.series[0] as Series).values = slices.map((s) => s.value);
}

function sortBars(p: Prepared, order: "asc" | "desc"): void {
	const key = (j: number) => (p.stacked ? p.series.reduce((n, s) => n + (s.values[j] ?? 0), 0) : (p.series[0]?.values[j] ?? -Infinity));
	const index = p.labels.map((_, j) => j).sort((a, b) => (order === "desc" ? key(b) - key(a) : key(a) - key(b)));
	p.labels = index.map((j) => p.labels[j] as string);
	for (const s of p.series) s.values = index.map((j) => s.values[j] as number | null);
	p.timeLike = false;
}

/** Decimals that show what the data says: what it was written with (up to 2), and two significant digits for small numbers. */
function numberFormat(p: Prepared, unit: string | undefined, decimals: number | undefined): Format {
	const all = p.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
	if (p.target !== undefined) all.push(p.target.value);
	let most = 0;
	for (const v of all) {
		const written = (String(v).split(".")[1] ?? "").replace(/e.*$/, "").length;
		const abs = Math.abs(v);
		const needed = abs === 0 || abs >= 1 ? Math.min(written, 2) : Math.min(written, Math.max(2, Math.ceil(-Math.log10(abs)) + 1));
		most = Math.max(most, needed);
	}
	let max = Math.max(...all.map(Math.abs));
	if (p.stacked) for (let j = 0; j < p.labels.length; j++) max = Math.max(max, p.series.reduce((n, s) => n + Math.abs(s.values[j] ?? 0), 0));
	const [scale, suffix] = max >= 1e9 ? [1e9, " Mld"] : max >= 1e6 ? [1e6, " Mln"] : max >= 1e4 ? [1e3, " mila"] : [1, ""];
	const chosen = decimals !== undefined ? Math.max(0, Math.min(4, Math.floor(decimals))) : (unit === "€" || unit === "$") && most > 0 ? Math.max(2, most) : Math.min(4, most);
	return { decimals: chosen, scale, suffix, ...(unit === undefined ? {} : { unit }) };
}

/** A number the Italian way: 1.234,5. */
export function formatNumber(value: number, decimals: number): string {
	// 12,45 is 12.4499… as a float: a nudge first, so it rounds the way it is written.
	const abs = Math.abs(value);
	const fixed = (abs < 1e12 ? Math.round(abs * 10 ** decimals * (1 + Number.EPSILON * 4)) / 10 ** decimals : abs).toFixed(decimals);
	const [whole, fraction] = fixed.split(".") as [string, string | undefined];
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
	return `${sign}${grouped}${fraction === undefined ? "" : `,${fraction}`}`;
}

export function withUnit(text: string, unit: string | undefined): string {
	if (unit === undefined) return text;
	if (unit === "€" || unit === "$") return text.startsWith("-") ? `-${unit} ${text.slice(1)}` : `${unit} ${text}`;
	if (unit === "%") return `${text}%`;
	return `${text} ${unit}`;
}

/** A value on the chart: in its short scale when the chart has one (12,5 mila, 2,3 Mln), in full otherwise. */
export function valueText(f: Format, value: number): string {
	if (f.scale === 1) return withUnit(formatNumber(value, f.decimals), f.unit);
	const scaled = value / f.scale;
	const decimals = Math.abs(scaled) < 10 && f.scale > 1e3 ? 2 : 1;
	return withUnit(`${formatNumber(scaled, decimals).replace(/,0+$/, "").replace(/(,\d*?)0+$/, "$1")}${suffix(f, scaled)}`, f.unit);
}

function suffix(f: Format, scaled: number): string {
	return scaled === 0 ? "" : f.suffix;
}

/** An axis label, in the chart's scale, with as many decimals as the step needs. */
export function tickText(f: Format, value: number, step: number): string {
	const scaled = value / f.scale;
	const scaledStep = step / f.scale;
	const decimals = scaledStep >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(scaledStep) - 1e-9));
	return withUnit(`${formatNumber(scaled, decimals)}${suffix(f, scaled)}`, f.unit);
}

/** Round axis steps (1, 2, 2.5, 5 times a power of ten) covering lo..hi in about `count` steps. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
	if (!(hi - lo > Math.max(Math.abs(lo), Math.abs(hi)) * 1e-9)) {
		const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
		lo -= pad;
		hi += pad;
	}
	const raw = (hi - lo) / count;
	const power = 10 ** Math.floor(Math.log10(raw));
	const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw * (1 - 1e-12)) ?? 10) * power;
	const start = Math.floor(lo / step + 1e-9);
	const end = Math.ceil(hi / step - 1e-9);
	const ticks: number[] = [];
	// Whole multiples of the step: never more than a dozen, whatever the numbers.
	for (let k = start; k <= end && ticks.length < 12; k++) ticks.push(k === 0 ? 0 : Number((k * step).toPrecision(12)));
	return ticks;
}

function text(r: Raster, t: string, x: number, y: number, size: number, color: Rgb, options: { face?: Face; align?: "left" | "center" | "right"; angle?: number } = {}): void {
	r.fill(textContours(t, x, y, { size, ...options }), color);
}

function header(r: Raster, p: Prepared, top: number): number {
	let y = top;
	const lines = (t: string, size: number, face: Face) => {
		const out = wrapText(t, W - 2 * PAD, size, face, 2);
		if ((out.at(-1) ?? "").endsWith("…") && !t.endsWith("…")) p.notes.push("Il titolo non entrava ed è stato accorciato: tienilo sotto le 60 lettere e metti i dettagli nel sottotitolo.");
		return out;
	};
	if (p.title !== undefined) {
		for (const line of lines(p.title, SIZE.title, "bold")) {
			y += SIZE.title;
			text(r, line, PAD, y, SIZE.title, INK, { face: "bold" });
			y += 14;
		}
	}
	if (p.subtitle !== undefined) {
		y += 2;
		for (const line of lines(p.subtitle, SIZE.subtitle, "regular")) {
			y += SIZE.subtitle;
			text(r, line, PAD, y, SIZE.subtitle, INK_2);
			y += 10;
		}
	}
	return y === top ? top : y + 26;
}

/**
 * The legend in rows: a coloured key and the series name in ink (from two series up), and the
 * reference line with its value, so its name never sits on the bars.
 */
function legend(r: Raster, p: Prepared, top: number): number {
	const key = 26;
	let x = PAD;
	let y = top;
	const maxName = (W - 2 * PAD) / 2;
	const items: { name: string; color?: Rgb }[] = p.series.length > 1 ? p.series.map((s, i) => ({ name: s.name, color: SERIES_COLORS[i] as Rgb })) : [];
	if (p.target !== undefined) items.push({ name: `${p.target.label}: ${valueText(p.format, p.target.value)}` });
	for (const item of items) {
		const name = fitText(item.name, maxName, SIZE.legend);
		const width = key + 12 + measure(name, SIZE.legend);
		if (x > PAD && x + width > W - PAD) {
			x = PAD;
			y += 46;
		}
		if (item.color !== undefined) r.fill([roundedRect(x, y + 4, key, key, [6, 6, 6, 6])], item.color);
		else r.fill([roundedRect(x, y + 4 + key / 2 - 1.5, key, 3)], INK_2);
		text(r, name, x + key + 12, y + 4 + key - 2, SIZE.legend, INK);
		x += width + 36;
	}
	return y + 46 + 10;
}

type Scale = { ticks: number[]; at: (v: number) => number };

function valueRange(p: Prepared): [number, number] {
	let lo = Infinity;
	let hi = -Infinity;
	if (p.stacked) {
		for (let j = 0; j < p.labels.length; j++) {
			let up = 0;
			let down = 0;
			for (const s of p.series) {
				const v = s.values[j] ?? 0;
				if (v >= 0) up += v;
				else down += v;
			}
			lo = Math.min(lo, down);
			hi = Math.max(hi, up);
		}
	} else {
		for (const s of p.series) {
			for (const v of s.values) {
				if (v === null) continue;
				lo = Math.min(lo, v);
				hi = Math.max(hi, v);
			}
		}
	}
	if (p.target !== undefined) {
		lo = Math.min(lo, p.target.value);
		hi = Math.max(hi, p.target.value);
	}
	return [lo, hi];
}

function scale(lo: number, hi: number, from: number, to: number, zero: boolean): Scale {
	const ticks = niceTicks(zero ? Math.min(0, lo) : lo, zero ? Math.max(0, hi) : hi);
	const t0 = ticks[0] as number;
	const t1 = ticks.at(-1) as number;
	return { ticks, at: (v) => from + ((v - t0) / (t1 - t0)) * (to - from) };
}

function overlaps(a: Box, b: Box): boolean {
	return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

type Label = { text: string; x: number; y: number; align: "left" | "center" | "right"; size: number; priority: number };

/** Write the labels that fit: none crossing a bar or another label; when some do not fit, only the ones that matter most. */
function placeLabels(r: Raster, labels: readonly Label[], taken: readonly Box[], all: boolean): void {
	const boxOf = (l: Label): Box => {
		const w = measure(l.text, l.size);
		const x0 = l.align === "center" ? l.x - w / 2 : l.align === "right" ? l.x - w : l.x;
		return { x0: x0 - 4, y0: l.y - l.size * 0.8, x1: x0 + w + 4, y1: l.y + l.size * 0.25 };
	};
	// A label at the edge of the picture moves in rather than out.
	const within = (l: Label): Label => {
		const b = boxOf(l);
		const shift = b.x0 < 4 ? 4 - b.x0 : b.x1 > W - 4 ? W - 4 - b.x1 : 0;
		return shift === 0 ? l : { ...l, x: l.x + shift };
	};
	const inside = (b: Box) => b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= H;
	const fit = (set: readonly Label[]) => {
		const placed: Box[] = [];
		const ok: Label[] = [];
		for (const original of set) {
			const l = within(original);
			const b = boxOf(l);
			if (!inside(b) || taken.some((t) => overlaps(b, t)) || placed.some((t) => overlaps(b, t))) continue;
			placed.push(b);
			ok.push(l);
		}
		return ok;
	};
	let chosen = all ? fit(labels) : [];
	if (chosen.length < labels.length) chosen = fit([...labels].filter((l) => l.priority > 0).sort((a, b) => b.priority - a.priority));
	for (const l of chosen) text(r, l.text, l.x, l.y, l.size, INK, { align: l.align });
}

/** Which values of a series matter most when not all can be written: the highest, the lowest, the last. */
function priorities(values: readonly (number | null)[]): number[] {
	const out = values.map(() => 0);
	let hi = -1;
	let lo = -1;
	let last = -1;
	for (const [j, v] of values.entries()) {
		if (v === null) continue;
		if (hi < 0 || v > (values[hi] as number)) hi = j;
		if (lo < 0 || v < (values[lo] as number)) lo = j;
		last = j;
	}
	if (last >= 0) out[last] = 1;
	if (lo >= 0) out[lo] = 2;
	if (hi >= 0) out[hi] = 3;
	return out;
}

function axisLabelEvery(labels: readonly string[], spacing: number, maxWidth: number): { every: number; texts: string[] } {
	const widest = Math.min(maxWidth, Math.max(...labels.map((l) => measure(l, SIZE.axis))));
	const every = Math.max(1, Math.ceil((widest + 28) / spacing));
	const room = Math.max(every * spacing - 28, 60);
	return { every, texts: labels.map((l) => fitText(l, Math.min(room, maxWidth), SIZE.axis)) };
}

function bars(r: Raster, p: Prepared, top: number): void {
	const [lo, hi] = valueRange(p);
	const n = p.labels.length;
	const probe = scale(lo, hi, 0, 1, true);
	const probeStep = (probe.ticks[1] as number) - (probe.ticks[0] as number);
	const left = PAD + Math.max(...probe.ticks.map((t) => measure(tickText(p.format, t, probeStep), SIZE.axis))) + 18;
	const band = (W - PAD - left) / n;
	const fits = p.labels.every((l) => wrapText(l, band - 10, SIZE.axis, "regular", 2).every((line) => !line.endsWith("…")));
	// Sideways when names do not fit under their bars, unless they are periods (they read left to
	// right) or too many to write one per row.
	const sideways = p.horizontal ?? (!fits && !p.timeLike && n <= 24);
	if (sideways) return sidewaysBars(r, p, top, lo, hi);
	const wrapped = fits ? p.labels.map((l) => wrapText(l, band - 10, SIZE.axis, "regular", 2)) : undefined;
	const lines = wrapped === undefined ? 1 : Math.max(...wrapped.map((w) => w.length));
	const plotBottom = H - PAD - lines * 36 - 10;
	const plotTop = top + 40;
	const s = scale(lo, hi, plotBottom, plotTop, true);
	const step = (s.ticks[1] as number) - (s.ticks[0] as number);
	for (const t of s.ticks) {
		const y = s.at(t);
		if (t !== 0) r.fill([roundedRect(left, y - 1, W - PAD - left, 2)], GRID);
		text(r, tickText(p.format, t, step), left - 18, y + 10, SIZE.axis, INK_2, { align: "right" });
	}
	const zero = s.at(0);
	const groups = p.stacked ? 1 : p.series.length;
	const thick = barThickness(band, groups);
	const groupWidth = groups * thick + (groups - 1) * GAP;
	const taken: Box[] = [];
	const labels: Label[] = [];
	const rank = p.stacked ? priorities(p.labels.map((_, j) => p.series.reduce((sum, ser) => sum + (ser.values[j] ?? 0), 0))) : p.series.map((ser) => priorities(ser.values));
	for (let j = 0; j < n; j++) {
		const cx = left + band * (j + 0.5);
		const x0 = cx - groupWidth / 2;
		if (p.stacked) {
			const box = stack(r, p, j, x0, thick, s, false);
			if (box !== undefined) taken.push(box);
			const { total, mixed, up } = stackTotal(p, j);
			// A stack with pieces on both sides of zero has no single top to write its total on.
			if (!mixed) labels.push({ text: valueText(p.format, total), x: cx, y: total >= 0 ? s.at(up) - 12 : s.at(total) + 12 + SIZE.value, align: "center", size: SIZE.value, priority: (rank as number[])[j] as number });
		} else {
			for (const [i, ser] of p.series.entries()) {
				const v = ser.values[j];
				if (v === null || v === undefined) continue;
				const x = x0 + i * (thick + GAP);
				const y = s.at(v);
				const h = Math.abs(y - zero);
				if (h >= 0.5) r.fill([v >= 0 ? roundedRect(x, y, thick, h, [RADIUS, RADIUS, 0, 0]) : roundedRect(x, zero, thick, h, [0, 0, RADIUS, RADIUS])], SERIES_COLORS[i] as Rgb);
				taken.push({ x0: x, y0: Math.min(y, zero), x1: x + thick, y1: Math.max(y, zero) });
				labels.push({ text: valueText(p.format, v), x: x + thick / 2, y: v >= 0 ? y - 12 : y + 12 + SIZE.value * 0.8, align: "center", size: SIZE.value, priority: groups <= 2 ? ((rank as number[][])[i]?.[j] ?? 0) : 0 });
			}
		}
	}
	// The names under the bars: all of them when they fit, otherwise one every few.
	if (wrapped !== undefined) wrapped.forEach((ls, j) => ls.forEach((line, k) => text(r, line, left + band * (j + 0.5), plotBottom + 46 + k * 36, SIZE.axis, INK_2, { align: "center" })));
	else {
		const { every, texts } = axisLabelEvery(p.labels, band, 260);
		if (!p.timeLike && (every > 1 || texts.some((t) => t.endsWith("…")))) {
			p.notes.push(p.horizontal === false ? "I nomi sotto le barre non entrano tutti: accorciali o lascia le barre in orizzontale (senza horizontal: false)." : `Con ${n} barre i nomi sotto non entrano tutti: per una classifica leggibile tieni le prime 15-20 voci (o raggruppa le altre).`);
		}
		for (let j = 0; j < n; j += every) {
			const half = measure(texts[j] as string, SIZE.axis) / 2;
			text(r, texts[j] as string, Math.min(W - PAD - half, Math.max(PAD + half, left + band * (j + 0.5))), plotBottom + 46, SIZE.axis, INK_2, { align: "center" });
		}
	}
	r.fill([roundedRect(left, zero - 1, W - PAD - left, 2)], BASELINE);
	if (p.target !== undefined) targetLine(r, p, s, left, W - PAD, false);
	placeLabels(r, labels, taken, n * groups <= 16);
}

/** As thick as the room allows, up to the 24 points of the rules; too thin to see is refused. */
function barThickness(band: number, groups: number): number {
	const thick = Math.min(BAR_MAX, (band * 0.72 - (groups - 1) * GAP) / groups);
	if (thick < 6) throw new ChartError(groups > 1 ? "troppe barre per lo spazio: con tante serie usa meno etichette, impilale (stacked) o fai una linea" : "troppe barre per lo spazio: raggruppa i dati o usa una linea");
	return thick;
}

function stackTotal(p: Prepared, j: number): { total: number; up: number; mixed: boolean } {
	let up = 0;
	let down = 0;
	for (const ser of p.series) {
		const v = ser.values[j] ?? 0;
		if (v > 0) up += v;
		else down += v;
	}
	return { total: up + down, up, mixed: up > 0 && down < 0 };
}

/** A stacked bar: positive pieces up from zero, negative down, a 4-pixel gap between pieces, the outer end rounded. */
function stack(r: Raster, p: Prepared, j: number, at: number, thick: number, s: Scale, sideways: boolean): Box | undefined {
	let box: Box | undefined;
	for (const sign of [1, -1]) {
		const pieces = p.series.map((ser, i) => ({ i, v: ser.values[j] ?? 0 })).filter((x) => x.v * sign > 0);
		let base = 0;
		for (const [k, piece] of pieces.entries()) {
			const from = s.at(base);
			const to = s.at(base + piece.v);
			base += piece.v;
			const outer = k === pieces.length - 1;
			// The gap is taken from the piece's own start, so the base of the stack stays on zero.
			const inset = k === 0 ? 0 : GAP;
			const lo = Math.min(from, to);
			const len = Math.abs(to - from);
			let shape: Contour;
			let b: Box;
			if (sideways) {
				const x = sign > 0 ? from + inset : to;
				const w = len - inset;
				if (w < 0.5) continue;
				shape = roundedRect(x, at, w, thick, outer ? (sign > 0 ? [0, RADIUS, RADIUS, 0] : [RADIUS, 0, 0, RADIUS]) : [0, 0, 0, 0]);
				b = { x0: x, y0: at, x1: x + w, y1: at + thick };
			} else {
				const y = sign > 0 ? lo : from + inset;
				const h = len - inset;
				if (h < 0.5) continue;
				shape = roundedRect(at, y, thick, h, outer ? (sign > 0 ? [RADIUS, RADIUS, 0, 0] : [0, 0, RADIUS, RADIUS]) : [0, 0, 0, 0]);
				b = { x0: at, y0: y, x1: at + thick, y1: y + h };
			}
			r.fill([shape], SERIES_COLORS[piece.i] as Rgb);
			box = box === undefined ? b : { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) };
		}
	}
	return box;
}

/** The reference line across the plot, in ink; its name and value are in the legend. */
function targetLine(r: Raster, p: Prepared, s: Scale, from: number, to: number, sideways: boolean): void {
	const at = s.at((p.target as { value: number }).value);
	r.fill([sideways ? roundedRect(at - 1, from, 2, to - from) : roundedRect(from, at - 1, to - from, 2)], INK_2);
}

function sidewaysBars(r: Raster, p: Prepared, top: number, lo: number, hi: number): void {
	const n = p.labels.length;
	const groups = p.stacked ? 1 : p.series.length;
	const bottom = H - PAD - 46;
	const band = (bottom - top) / n;
	const labelSize = Math.min(SIZE.axis, Math.max(SIZE.small, band * (band > 70 ? 0.4 : 0.7)));
	// Names on up to two lines, in at most a third of the width.
	const maxLabel = (W - 2 * PAD) * 0.34;
	const twoLines = band >= labelSize * 2.6;
	const names = p.labels.map((l) => wrapText(l, maxLabel, labelSize, "regular", twoLines ? 2 : 1));
	const labelWidth = Math.max(...names.flat().map((l) => measure(l, labelSize)));
	const left = PAD + labelWidth + 18;
	const valueWidth = Math.max(...p.series.flatMap((ser) => ser.values.map((v) => (v === null ? 0 : measure(valueText(p.format, v), SIZE.value))))) + 16;
	const totals = p.labels.map((_, j) => stackTotal(p, j));
	const right = W - PAD - (p.stacked ? Math.max(...totals.map((t) => measure(valueText(p.format, t.total), SIZE.value))) + 16 : valueWidth);
	const s = scale(lo, hi, lo < 0 ? left + valueWidth : left, right, true);
	const step = (s.ticks[1] as number) - (s.ticks[0] as number);
	const ticks = s.ticks.map((t) => ({ t, label: tickText(p.format, t, step) }));
	const tickRoom = Math.max(...ticks.map((t) => measure(t.label, SIZE.axis))) + 24;
	const tickEvery = Math.max(1, Math.ceil(tickRoom / Math.abs(s.at(s.ticks[1] as number) - s.at(s.ticks[0] as number))));
	for (const [k, { t, label }] of ticks.entries()) {
		const x = s.at(t);
		if (t !== 0) r.fill([roundedRect(x - 1, top, 2, bottom - top)], GRID);
		if (k % tickEvery === 0) text(r, label, x, bottom + 40, SIZE.axis, INK_2, { align: "center" });
	}
	const thick = barThickness(band, groups);
	const groupHeight = groups * thick + (groups - 1) * GAP;
	const zero = s.at(0);
	const taken: Box[] = [];
	const labels: Label[] = [];
	const valueSize = Math.min(SIZE.value, Math.max(SIZE.small, thick + 6));
	for (let j = 0; j < n; j++) {
		const cy = top + band * (j + 0.5);
		const y0 = cy - groupHeight / 2;
		const lines = names[j] as string[];
		lines.forEach((line, k) => text(r, line, left - 18, cy + labelSize * 0.35 + (k - (lines.length - 1) / 2) * labelSize * 1.15, labelSize, INK_2, { align: "right" }));
		if (p.stacked) {
			const box = stack(r, p, j, y0, thick, s, true);
			if (box !== undefined) taken.push(box);
			const { total, up, mixed } = totals[j] as { total: number; up: number; mixed: boolean };
			if (!mixed) labels.push({ text: valueText(p.format, total), x: total >= 0 ? s.at(up) + 12 : s.at(total) - 12, y: cy + valueSize * 0.35, align: total >= 0 ? "left" : "right", size: valueSize, priority: 1 });
			continue;
		}
		for (const [i, ser] of p.series.entries()) {
			const v = ser.values[j];
			if (v === null || v === undefined) continue;
			const y = y0 + i * (thick + GAP);
			const x = s.at(v);
			const w = Math.abs(x - zero);
			if (w >= 0.5) r.fill([v >= 0 ? roundedRect(zero, y, w, thick, [0, RADIUS, RADIUS, 0]) : roundedRect(x, y, w, thick, [RADIUS, 0, 0, RADIUS])], SERIES_COLORS[i] as Rgb);
			taken.push({ x0: Math.min(x, zero), y0: y, x1: Math.max(x, zero), y1: y + thick });
			labels.push({ text: valueText(p.format, v), x: v >= 0 ? x + 12 : x - 12, y: y + thick / 2 + valueSize * 0.35, align: v >= 0 ? "left" : "right", size: valueSize, priority: 1 });
		}
	}
	r.fill([roundedRect(zero - 1, top, 2, bottom - top)], BASELINE);
	if (p.target !== undefined) targetLine(r, p, s, top, bottom, true);
	placeLabels(r, labels, taken, true);
}

function lines(r: Raster, p: Prepared, top: number): void {
	const [lo, hi] = valueRange(p);
	const n = p.labels.length;
	// Zero is on the axis when it is near the data; a line far from zero gets the room to show its changes.
	const zero = lo >= 0 ? lo <= hi * 0.5 : hi <= 0 ? hi >= lo * 0.5 : true;
	const probe = scale(lo, hi, 0, 1, zero);
	const step = (probe.ticks[1] as number) - (probe.ticks[0] as number);
	const left = PAD + Math.max(...probe.ticks.map((t) => measure(tickText(p.format, t, step), SIZE.axis))) + 18;
	// The last value of each series is written at its end, while they are few and apart.
	const ends = p.series.length <= 4 ? p.series.map((s) => [...s.values].reverse().find((v) => v !== null) ?? null) : [];
	const endWidth = ends.length === 0 ? 0 : Math.max(...ends.map((v) => (v === null ? 0 : measure(valueText(p.format, v), SIZE.value, "bold")))) + 22;
	const right = W - PAD - endWidth;
	const plotBottom = H - PAD - 60;
	const plotTop = top + 16;
	const s = scale(lo, hi, plotBottom, plotTop, zero);
	for (const t of s.ticks) {
		const y = s.at(t);
		r.fill([roundedRect(left, y - 1, right - left, 2)], t === 0 ? BASELINE : GRID);
		text(r, tickText(p.format, t, step), left - 18, y + 10, SIZE.axis, INK_2, { align: "right" });
	}
	const inset = 12;
	const xAt = (j: number) => left + inset + (j / (n - 1)) * (right - left - 2 * inset);
	const { every, texts } = axisLabelEvery(p.labels, (right - left - 2 * inset) / (n - 1), 260);
	for (let j = 0; j < n; j += every) {
		const half = measure(texts[j] as string, SIZE.axis) / 2;
		text(r, texts[j] as string, Math.min(W - PAD - half, Math.max(PAD + half, xAt(j))), plotBottom + 46, SIZE.axis, INK_2, { align: "center" });
	}
	const markers = n <= 24;
	if (p.series.length === 1 && zero) {
		const ser = p.series[0] as Series;
		for (const run of runs(ser.values)) {
			if (run.length < 2) continue;
			const area: Contour = [xAt(run[0] as number), s.at(0)];
			for (const j of run) area.push(xAt(j), s.at(ser.values[j] as number));
			area.push(xAt(run.at(-1) as number), s.at(0));
			r.fill([area], SERIES_COLORS[0] as Rgb, 0.1);
		}
	}
	if (p.target !== undefined) targetLine(r, p, s, left, right, false);
	for (const [i, ser] of p.series.entries()) {
		const color = SERIES_COLORS[i] as Rgb;
		for (const run of runs(ser.values)) {
			const pts = run.map((j) => [xAt(j), s.at(ser.values[j] as number)] as [number, number]);
			if (pts.length > 1) r.fill(stroke(pts, 4), color);
			if (markers || pts.length === 1) {
				for (const [x, y] of pts) {
					r.fill([circle(x, y, 12)], SURFACE);
					r.fill([circle(x, y, 8)], color);
				}
			}
		}
	}
	// End values: written when they do not crowd each other.
	const placed = ends.map((v, i) => ({ v, i, y: v === null ? 0 : s.at(v) })).filter((e) => e.v !== null);
	const apart = placed.every((a) => placed.every((b) => a === b || Math.abs(a.y - b.y) >= SIZE.value + 6));
	if (apart) {
		for (const e of placed) {
			const ser = p.series[e.i] as Series;
			const last = ser.values.length - 1 - [...ser.values].reverse().findIndex((v) => v !== null);
			text(r, valueText(p.format, e.v as number), xAt(last) + 18, e.y + 10, SIZE.value, INK, { face: "bold" });
		}
	}
}

/** The indexes of the values, split where a value is missing. */
function runs(values: readonly (number | null)[]): number[][] {
	const out: number[][] = [];
	let current: number[] = [];
	for (const [j, v] of values.entries()) {
		if (v === null) {
			if (current.length > 0) out.push(current);
			current = [];
		} else current.push(j);
	}
	if (current.length > 0) out.push(current);
	return out;
}

function pie(r: Raster, p: Prepared, top: number): void {
	const values = (p.series[0] as Series).values as number[];
	const total = values.reduce((a, b) => a + b, 0);
	const colorOf = (i: number) => (p.others === true && i === values.length - 1 ? OTHERS : (SERIES_COLORS[i] as Rgb));
	const area = H - PAD - top;
	const radius = Math.min(area / 2, (W - 2 * PAD) * 0.22);
	const cx = PAD + radius;
	const cy = top + area / 2;
	const inner = radius * 0.62;
	let angle = 0;
	const cuts: number[] = [];
	for (const [i, v] of values.entries()) {
		const sweep = (v / total) * 2 * Math.PI;
		r.fill([sector(cx, cy, inner, radius, angle, angle + sweep)], colorOf(i));
		angle += sweep;
		cuts.push(angle);
	}
	if (values.length > 1) {
		for (const a of cuts) r.fill(stroke([[cx + Math.sin(a) * (inner - 2), cy - Math.cos(a) * (inner - 2)], [cx + Math.sin(a) * (radius + 2), cy - Math.cos(a) * (radius + 2)]], GAP), SURFACE);
	}
	// Percentages are already shares: their sum is not a total worth writing.
	const percent = p.format.unit === "%";
	if (!percent) {
		const hero = valueText(p.format, total);
		const heroSize = Math.min(SIZE.hero, (inner * 1.7 * SIZE.hero) / Math.max(1, measure(hero, SIZE.hero, "bold")));
		text(r, hero, cx, cy + heroSize * 0.3, heroSize, INK, { face: "bold", align: "center" });
		text(r, "Totale", cx, cy + heroSize * 0.3 + 44, SIZE.axis, INK_2, { align: "center" });
	}
	// The legend: key, name, then value and share, one row per slice.
	const x0 = cx + radius + 56;
	const x1 = W - PAD;
	const row = Math.min(76, area / values.length);
	const size = Math.min(SIZE.legend, row * 0.5);
	let y = cy - (row * values.length) / 2;
	for (const [i, v] of values.entries()) {
		const share = (v / total) * 100;
		const right = percent ? valueText(p.format, v) : `${valueText(p.format, v)} · ${formatNumber(share, share < 10 ? 1 : 0)}%`;
		const rightWidth = measure(right, size);
		const key = Math.min(26, row * 0.45);
		r.fill([roundedRect(x0, y + (row - key) / 2, key, key, [6, 6, 6, 6])], colorOf(i));
		const name = wrapText(p.labels[i] as string, x1 - x0 - key - 16 - rightWidth - 20, size, "regular", row >= size * 2.6 ? 2 : 1);
		name.forEach((line, k) => text(r, line, x0 + key + 14, y + row / 2 + size * 0.35 + (k - (name.length - 1) / 2) * size * 1.15, size, INK));
		text(r, right, x1, y + row / 2 + size * 0.35, size, INK_2, { align: "right" });
		y += row;
	}
}
