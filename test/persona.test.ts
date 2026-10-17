import { describe, expect, it } from "vitest";
import { AnnieRuntime, type DurableEngine } from "../src/core/index.ts";
import { checkPersona, PersonaError, withPersona } from "../src/core/persona.ts";
import { FAUX_MODEL, tempDataDir } from "./helpers.ts";

describe("persona (ADR 0040)", () => {
	it("keeps what a person typed, trimmed, and leaves out empty parts and the natural tone", () => {
		expect(checkPersona({ emoji: " 🔎 ", tagline: "  Cerca   e confronta\nfornitori ", tone: "formale" })).toEqual({ emoji: "🔎", tagline: "Cerca e confronta fornitori", tone: "formale" });
		expect(checkPersona({ emoji: "", tagline: "  ", tone: "naturale" })).toEqual({});
		expect(checkPersona(undefined)).toEqual({});
		expect(checkPersona({ emoji: "👩🏽‍💻" }).emoji).toBe("👩🏽‍💻");
		expect(checkPersona({ emoji: "🇮🇹" }).emoji).toBe("🇮🇹");
	});

	it("refuses words for an emoji, an unknown tone and a long description", () => {
		expect(() => checkPersona({ emoji: "ciao" })).toThrow(PersonaError);
		expect(() => checkPersona({ emoji: "🔎 ciao" })).toThrow(/una sola emoji/);
		expect(() => checkPersona({ tone: "arrogante" })).toThrow(/Tono/);
		expect(() => checkPersona({ tagline: "x".repeat(121) })).toThrow(/120/);
		expect(() => checkPersona("🔎")).toThrow(PersonaError);
	});

	it("adds nothing for Annie with no persona, so old conversations keep their instructions", () => {
		expect(withPersona("Sei Annie.", "Annie", undefined)).toBe("Sei Annie.");
		expect(withPersona("Sei Annie.", " annie ", {})).toBe("Sei Annie.");
		expect(withPersona(undefined, "Annie", { emoji: "🙂" })).toBeUndefined();
	});

	it("tells another agente its name, its job and its tone after its instructions", () => {
		const text = withPersona("Sei Annie.", "Ricercatore", { tagline: "Cerca e confronta fornitori", tone: "conciso" }) as string;
		expect(text.startsWith("Sei Annie.\n\nChi sei:\n")).toBe(true);
		expect(text).toContain("Il tuo nome è «Ricercatore»");
		expect(text).toContain("Il tuo compito: Cerca e confronta fornitori");
		expect(text).toContain("Sii conciso");
		expect(withPersona(undefined, "Annie", { tone: "formale" })).toBe("Chi sei:\nUsa un registro formale: dai del Lei, frasi complete, niente battute.");
	});
});

describe("an agente opens with its persona", () => {
	it("passes name, job and tone to the engine, and a reopen applies a change", async () => {
		const seen: (string | undefined)[] = [];
		const engine: DurableEngine = {
			open: async (options) => {
				seen.push(options.instructions);
				return { submit: async () => ({ submissionId: "s" }), resume: async () => ({ pending: 0 }), reattach: async () => false, setThreadModel: async () => {}, threadModel: async () => undefined, onReply: () => () => {}, idle: async () => {}, close: async () => {} };
			},
		};
		const runtime = new AnnieRuntime({ dataDir: tempDataDir(), engine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ricerca", name: "Ricercatore", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: [] }, instructions: "Sei Annie.", persona: { emoji: "🔎", tone: "formale" } });
		await runtime.openInstance("acme", "ricerca");
		expect(seen[0]).toContain("Il tuo nome è «Ricercatore»");
		expect(seen[0]).toContain("dai del Lei");
		await runtime.registry.updateInstance("acme", "ricerca", { persona: null, name: "Annie" });
		expect((await runtime.registry.getInstance("acme", "ricerca")).persona).toBeUndefined();
		await runtime.reopen("acme", "ricerca");
		expect(seen[1]).toBe("Sei Annie.");
		await runtime.close();
	});
});
