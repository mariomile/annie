import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Browser, BrowseSessions } from "../src/core/web-session.ts";

// Real Chromium: a page built with web components shows its buttons and fields to the agent (ADR 0014).
const chrome = process.env.ANNIE_CHROMIUM_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const available = chrome !== undefined && existsSync(chrome);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const pages: Record<string, string> = {
	"/": `<title>Componenti</title><main><x-modulo><span>Testo nello slot</span></x-modulo></main><x-chiuso></x-chiuso><iframe src="/dentro"></iframe>
<script>
customElements.define("x-modulo", class extends HTMLElement {
	constructor() {
		super();
		const root = this.attachShadow({ mode: "open" });
		root.innerHTML = '<label>Nome <input></label><p>Testo nel componente</p><button>Conferma</button><slot></slot><x-nipote></x-nipote>';
		root.querySelector("button").addEventListener("click", () => { root.querySelector("p").textContent = "Confermato"; });
	}
});
customElements.define("x-nipote", class extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" }).innerHTML = '<a href="/due">Link annidato</a>';
	}
});
customElements.define("x-chiuso", class extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "closed" }).innerHTML = '<button>Pulsante chiuso</button>';
	}
});
</script>`,
	"/dentro": "<button>Pulsante nel riquadro</button>",
};

async function start() {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(pages[req.url ?? ""] ?? "no");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(() => r())));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const { chromium } = await import("playwright-core");
	const browser = (await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] })) as unknown as Browser;
	const sessions = new BrowseSessions();
	closers.push(async () => {
		await sessions.closeAll();
		await browser.close();
	});
	return { base, sessions, browser };
}
const guard = { hostAllowed: () => true, addressAllowed: () => true };

describe.skipIf(!available)("web components, in real Chromium", () => {
	it("numbers the buttons, fields and links inside open shadow roots, and clicks and types on them", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/`, guard);
		const named = (label: string) => view.elements.find((e) => e.label === label);
		const field = named("Nome");
		const button = named("Conferma");
		expect(field).toMatchObject({ kind: "campo di testo", tag: "input" });
		expect(button).toMatchObject({ kind: "pulsante", tag: "button" });
		expect(named("Link annidato")).toMatchObject({ kind: "link" });
		// The text inside a shadow root is read as well.
		expect(view.text).toContain("Testo nel componente");
		// Text passed through a slot is not read twice.
		expect(view.text.split("Testo nello slot")).toHaveLength(2);

		const typed = await sessions.type("k", field?.ref as number, "Mario", false, guard);
		expect(typed.elements.find((e) => e.label === "Nome")?.value).toBe("Mario");
		const clicked = await sessions.click("k", typed.elements.find((e) => e.label === "Conferma")?.ref as number, guard);
		expect(clicked.text).toContain("Confermato");
	}, 60_000);

	it("still does not read closed shadow roots or the content of iframes, and still reports the iframe", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/`, guard);
		expect(view.elements.map((e) => e.label)).not.toContain("Pulsante chiuso");
		expect(view.elements.map((e) => e.label)).not.toContain("Pulsante nel riquadro");
		expect(view.details.join("\n")).toContain("Riquadri con altre pagine dentro (si aprono con web_browse): http://127.0.0.1");
	}, 60_000);
});
