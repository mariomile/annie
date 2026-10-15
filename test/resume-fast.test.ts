import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { AnnieRuntime, type Reply } from "../src/core/index.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

describe("resume with a fast model", () => {
	it("replies to work a previous process admitted but never ran, even when it finishes instantly", async () => {
		const first = await runtimeWithInstance({});
		// Admitted durably, then the process goes away before the run happens.
		const instance = await first.runtime.openInstance("acme", "ops");
		await instance.submit({ channel: "test", threadId: "1", userId: "u", text: "ciao", messageId: "m1" });
		await first.runtime.close();
		expect(first.replies).toEqual([]);

		const second = new AnnieRuntime({ dataDir: first.dataDir, engine: piDurableEngine });
		const replies: Reply[] = [];
		second.onReply((reply) => replies.push(reply));
		expect(await second.resume("acme", "ops")).toEqual({ pending: 1, undelivered: 0 });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadId: "1", status: "answered", text: "Annie (modello locale di sviluppo): hai scritto «ciao»" });

		// A second resume() does not answer again.
		await second.resume("acme", "ops");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(replies).toHaveLength(1);
		await second.close();
	});
});
