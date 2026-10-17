import { strict as assert } from "node:assert";
import { test } from "node:test";
import { registerDecisionsProvider } from "../src/decisions-provider.ts";

test("registered provider lets the configured deadline govern slow verdicts", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.mock.method(AbortSignal, "timeout", (ms: number) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("deadline expired")), ms);
		return controller.signal;
	});
	t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		setTimeout(() => resolve(new Response(JSON.stringify({ answers: { action: { choice: "A", probabilities: { A: 1, B: 0 } } } }))), 15_000);
	}));
	type Classify = (model: { id: string }, context: { state: unknown; questions: Record<string, unknown> }) => Promise<{ answers: Record<string, unknown> }>;
	let classify: Classify | undefined;
	const pi = { registerProvider(_name: string, config: { classifiers: Record<string, { classify: Classify }> }) {
		classify = config.classifiers["decisions-v1"].classify;
	} };
	const context = { state: { command: "rm cache" }, questions: { action: { type: "choice", instructions: "Which?", criteria: { approve: "safe", ask: "unclear" } } } };
	for (const timeoutMs of [20_000, 5_000]) {
		registerDecisionsProvider(pi as never, { baseUrl: "http://test/v1", models: ["m"], timeoutMs });
		assert.ok(classify);
		const pending = classify({ id: "m" }, context);
		const checked = timeoutMs > 15_000
			? pending.then((result) => assert.equal((result.answers.action as { choice: string }).choice, "approve"))
			: assert.rejects(pending);
		t.mock.timers.tick(15_000);
		await checked;
	}
});
