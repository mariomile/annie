import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Browser, BrowseSessions } from "../src/core/web-session.ts";

// Real Chromium: the file chooser is refused where it opens, whatever way the page reaches it (ADR 0103).
const chrome = process.env.ANNIE_CHROMIUM_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const available = chrome !== undefined && existsSync(chrome);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A target at 100,100 to 300,200 in every page, so one click point (150, 150) reaches it. */
const BOX = "position:fixed;left:100px;top:100px;width:200px;height:100px;margin:0;border:0";
const pages: Record<string, string> = {
	"/direct": `<input type="file" style="${BOX}">`,
	"/label": `<label for="f" style="${BOX};background:#ccc">Scegli</label><input id="f" type="file" style="display:none">`,
	"/shadow": `<div id="h" style="${BOX}"></div><script>document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = '<input type="file" style="width:200px;height:100px">'</script>`,
	"/iframe": `<iframe src="/inside" style="${BOX}"></iframe>`,
	"/inside": `<body style="margin:0"><input type="file" style="width:200px;height:100px"></body>`,
	"/button": `<button style="${BOX}" onclick="const i = document.createElement('input'); i.type = 'file'; i.click()">Carica</button>`,
	"/plain": `<button style="${BOX}" onclick="document.title = 'cliccato'">Vai</button>`,
};

async function start() {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(pages[req.url ?? ""] ?? "no");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(() => r())));
	const { chromium } = await import("playwright-core");
	const browser = (await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] })) as unknown as Browser;
	const sessions = new BrowseSessions();
	closers.push(async () => {
		await sessions.closeAll();
		await browser.close();
	});
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sessions, browser };
}
const guard = { hostAllowed: () => true, addressAllowed: () => true };

describe.skipIf(!available)("no file uploads, in real Chromium", () => {
	for (const name of ["direct", "label", "shadow", "iframe", "button"]) {
		it(`refuses a person's click that opens a file chooser: ${name}`, async () => {
			const { base, sessions, browser } = await start();
			await sessions.open("k", browser, `${base}/${name}`, guard);
			await expect(sessions.clickAt("k", 150 / 1280, 150 / 800, guard, { person: true })).rejects.toMatchObject({ kind: "no-files", message: "Annie non carica file sui siti" });
			// The session stays usable after a refusal.
			await sessions.open("k", browser, `${base}/plain`, guard);
			expect((await sessions.clickAt("k", 150 / 1280, 150 / 800, guard)).title).toBe("cliccato");
		}, 60_000);
	}

	it("refuses the agent's click on a numbered input and button, and its typing in a file input", async () => {
		const { base, sessions, browser } = await start();
		for (const name of ["direct", "button"]) {
			const view = await sessions.open("a", browser, `${base}/${name}`, guard);
			const element = view.elements[0];
			expect(element).toBeDefined();
			await expect(sessions.click("a", element?.ref as number, guard)).rejects.toMatchObject({ kind: "no-files" });
		}
		const view = await sessions.open("a", browser, `${base}/direct`, guard);
		expect(await sessions.type("a", view.elements[0]?.ref as number, "x", false, guard)).toMatchObject({ failed: true });
	}, 60_000);
});
