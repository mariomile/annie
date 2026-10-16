import { randomBytes } from "node:crypto";

/**
 * The HTML forms of a page, as web_read lists them and web_submit sends them. Parsed with
 * indexOf and regexes on single tags only, so a hostile page costs linear time.
 */
export type FormField = {
	readonly name: string;
	/** input type, or "select" / "textarea". */
	readonly kind: string;
	readonly value: string;
	readonly checked: boolean;
	readonly required: boolean;
	/** What the page shows for it: its label, aria-label or placeholder. */
	readonly label: string;
	/** For select and radio: the values that may be chosen. */
	readonly options?: readonly string[];
};

export type WebForm = {
	readonly index: number;
	readonly method: "GET" | "POST";
	/** Absolute URL the form is sent to. */
	readonly action: string;
	readonly enctype: "application/x-www-form-urlencoded" | "multipart/form-data" | "other";
	readonly fields: readonly FormField[];
};

const MAX_FORMS = 20;
const MAX_FIELDS = 100;
const MAX_TAG = 4096;
const HIDDEN_KINDS = new Set(["hidden"]);
const BUTTON_KINDS = new Set(["submit", "button", "image", "reset"]);

/** Fields the model may fill: visible ones that carry a value (no hidden, buttons or files). */
export function fillable(field: FormField): boolean {
	return !HIDDEN_KINDS.has(field.kind) && !BUTTON_KINDS.has(field.kind) && field.kind !== "file";
}

export function pageForms(html: string, pageUrl: string): WebForm[] {
	const lower = html.toLowerCase();
	const labels = labelTexts(html, lower);
	const forms: WebForm[] = [];
	let from = 0;
	while (forms.length < MAX_FORMS) {
		const start = lower.indexOf("<form", from);
		if (start < 0) break;
		const open = tagAt(html, start);
		if (open === undefined) break;
		const close = lower.indexOf("</form", open.end);
		const end = close < 0 ? html.length : close;
		const attrs = attributes(open.text);
		let action: string;
		try {
			action = new URL(attrs.get("action") || pageUrl, pageUrl).toString();
		} catch {
			from = end;
			continue;
		}
		const method = (attrs.get("method") ?? "get").toLowerCase() === "post" ? "POST" : "GET";
		const type = (attrs.get("enctype") ?? "").toLowerCase();
		const enctype = type === "" || type === "application/x-www-form-urlencoded" ? "application/x-www-form-urlencoded" : type === "multipart/form-data" ? "multipart/form-data" : "other";
		forms.push({ index: forms.length, method, action, enctype, fields: formFields(html.slice(open.end, end), labels) });
		from = end + 1;
	}
	return forms;
}

function formFields(html: string, labels: ReadonlyMap<string, string>): FormField[] {
	const lower = html.toLowerCase();
	const fields: FormField[] = [];
	const radios = new Map<string, string[]>();
	let at = 0;
	while (fields.length < MAX_FIELDS) {
		const next = nextTag(lower, at, ["<input", "<select", "<textarea", "<button"]);
		if (next === undefined) break;
		const tag = tagAt(html, next.start);
		if (tag === undefined) break;
		at = tag.end;
		const attrs = attributes(tag.text);
		const name = attrs.get("name");
		const label = (attrs.get("aria-label") ?? labels.get(attrs.get("id") ?? "") ?? attrs.get("placeholder") ?? "").slice(0, 120);
		const required = attrs.has("required");
		if (next.tag === "<select") {
			const close = lower.indexOf("</select", at);
			const inner = html.slice(at, close < 0 ? html.length : close);
			const options = optionValues(inner);
			at = close < 0 ? html.length : close;
			if (name) fields.push({ name, kind: "select", value: options.selected ?? options.values[0] ?? "", checked: false, required, label, options: options.values });
			continue;
		}
		if (next.tag === "<textarea") {
			const close = lower.indexOf("</textarea", at);
			const value = decode(html.slice(at, close < 0 ? html.length : close));
			at = close < 0 ? html.length : close;
			if (name) fields.push({ name, kind: "textarea", value, checked: false, required, label });
			continue;
		}
		const kind = next.tag === "<button" ? (attrs.get("type") ?? "submit").toLowerCase() : (attrs.get("type") ?? "text").toLowerCase();
		if (!name) continue;
		const value = attrs.get("value") ?? (kind === "checkbox" || kind === "radio" ? "on" : "");
		if (kind === "radio") {
			const list = radios.get(name);
			if (list !== undefined) {
				list.push(value);
				if (attrs.has("checked")) {
					const i = fields.findIndex((f) => f.name === name && f.kind === "radio");
					if (i >= 0) fields[i] = { ...(fields[i] as FormField), value, checked: true };
				}
				continue;
			}
			const values = [value];
			radios.set(name, values);
			fields.push({ name, kind, value, checked: attrs.has("checked"), required, label, options: values });
			continue;
		}
		fields.push({ name, kind, value, checked: attrs.has("checked"), required, label });
	}
	return fields;
}

/**
 * The body of a form sent with the model's values over the page's defaults. Hidden fields come
 * only from the page; a value for a name the form lacks, or for a field the model may not fill,
 * is refused before anything leaves.
 */
export function formBody(form: WebForm, values: Readonly<Record<string, string>>): { contentType: string; body: Buffer } {
	const pairs: [string, string][] = [];
	const given = new Map(Object.entries(values));
	for (const name of given.keys()) {
		const field = form.fields.find((f) => f.name === name);
		if (field === undefined) throw new FormRefused(`il modulo non ha un campo «${name}»`);
		if (!fillable(field)) throw new FormRefused(`il campo «${name}» lo decide il sito, non si compila`);
	}
	let button = false;
	for (const field of form.fields) {
		if (field.kind === "file" || field.kind === "reset" || field.kind === "button") continue;
		if (BUTTON_KINDS.has(field.kind)) {
			// Only the first submit button counts, as if it were pressed.
			if (!button) pairs.push([field.name, field.value]);
			button = true;
			continue;
		}
		const value = given.get(field.name);
		if (field.kind === "checkbox") {
			const on = value === undefined ? field.checked : value !== "" && value !== "false" && value !== "no";
			if (on) pairs.push([field.name, field.value]);
			continue;
		}
		if (value !== undefined && field.options !== undefined && !field.options.includes(value)) {
			throw new FormRefused(`«${value}» non è tra le scelte di «${field.name}» (${field.options.slice(0, 10).join(", ")})`);
		}
		if (field.kind === "radio") {
			if (value !== undefined) pairs.push([field.name, value]);
			else if (field.checked) pairs.push([field.name, field.value]);
			continue;
		}
		pairs.push([field.name, value ?? field.value]);
	}
	if (form.enctype === "multipart/form-data") {
		const boundary = `----annie${randomBytes(12).toString("hex")}`;
		const parts = pairs.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/["\r\n]/g, "_")}"\r\n\r\n${v}\r\n`);
		return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.from(`${parts.join("")}--${boundary}--\r\n`) };
	}
	return { contentType: "application/x-www-form-urlencoded", body: Buffer.from(new URLSearchParams(pairs).toString()) };
}

export class FormRefused extends Error {
	override readonly name = "FormRefused";
}

/** One line per form, for web_read: what can be sent and with which fields. */
export function describeForms(forms: readonly WebForm[]): string {
	return forms
		.map((form) => {
			const fields = form.fields.filter(fillable).map((f) => {
				const choices = f.options === undefined ? "" : ` [${f.options.slice(0, 8).join("|")}]`;
				return `${f.name} (${f.kind}${f.required ? ", obbligatorio" : ""}${f.label ? `, «${f.label}»` : ""})${choices}`;
			});
			return `Modulo ${form.index}: ${form.method} ${form.action}${fields.length > 0 ? `\n  campi: ${fields.join("; ")}` : "\n  nessun campo da compilare"}`;
		})
		.join("\n");
}

function labelTexts(html: string, lower: string): Map<string, string> {
	const out = new Map<string, string>();
	let at = 0;
	for (let n = 0; n < 500; n++) {
		const start = lower.indexOf("<label", at);
		if (start < 0) break;
		const tag = tagAt(html, start);
		if (tag === undefined) break;
		const close = lower.indexOf("</label", tag.end);
		const end = close < 0 ? tag.end : close;
		const target = attributes(tag.text).get("for");
		if (target) out.set(target, decode(html.slice(tag.end, end).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim());
		at = end + 1;
	}
	return out;
}

function optionValues(html: string): { values: string[]; selected?: string } {
	const lower = html.toLowerCase();
	const values: string[] = [];
	let selected: string | undefined;
	let at = 0;
	while (values.length < 200) {
		const start = lower.indexOf("<option", at);
		if (start < 0) break;
		const tag = tagAt(html, start);
		if (tag === undefined) break;
		const attrs = attributes(tag.text);
		const close = lower.indexOf("<", tag.end);
		const value = attrs.get("value") ?? decode(html.slice(tag.end, close < 0 ? html.length : close)).trim();
		values.push(value);
		if (attrs.has("selected") && selected === undefined) selected = value;
		at = tag.end;
	}
	return selected === undefined ? { values } : { values, selected };
}

function nextTag(lower: string, from: number, tags: readonly string[]): { start: number; tag: string } | undefined {
	let best: { start: number; tag: string } | undefined;
	for (const tag of tags) {
		let i = lower.indexOf(tag, from);
		// "<input" must not match "<inputx": the next character ends the name.
		while (i >= 0 && /[\w-]/.test(lower[i + tag.length] ?? "")) i = lower.indexOf(tag, i + 1);
		if (i >= 0 && (best === undefined || i < best.start)) best = { start: i, tag };
	}
	return best;
}

/** The tag that starts at `start`, up to its ">" (bounded: a tag longer than 4 KB is dropped). */
function tagAt(html: string, start: number): { text: string; end: number } | undefined {
	const close = html.indexOf(">", start);
	if (close < 0) return undefined;
	if (close - start > MAX_TAG) return { text: "<x>", end: close + 1 };
	return { text: html.slice(start, close + 1), end: close + 1 };
}

function attributes(tag: string): Map<string, string> {
	const out = new Map<string, string>();
	const body = tag.replace(/^<[\w-]+/, "").replace(/\/?>$/, "");
	for (const m of body.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		const name = (m[1] ?? "").toLowerCase();
		if (!out.has(name)) out.set(name, decode(m[2] ?? m[3] ?? m[4] ?? ""));
	}
	return out;
}

function decode(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
		.replace(/&amp;/g, "&");
}
