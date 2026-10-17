import { strict as assert } from "node:assert";
import { test } from "node:test";
import { registerDecisionsProvider } from "../src/decisions-provider.ts";

type Classify = (model: { id: string }, context: { state: unknown; questions: Record<string, unknown> }) => Promise<{ answers: Record<string, unknown> }>;

function registeredProvider(timeoutMs?: number): Classify {
	let classify: Classify | undefined;
	const pi = { registerProvider(_name: string, config: { classifiers: Record<string, { classify: Classify }> }) {
		classify = config.classifiers["decisions-v1"].classify;
	} };
	registerDecisionsProvider(pi as never, { baseUrl: "http://test/v1", models: ["m"], timeoutMs });
	assert.ok(classify);
	return classify;
}

const context = { state: { command: "rm cache" }, questions: { action: { type: "choice", instructions: "Which?", criteria: { approve: "safe", ask: "unclear" } } } };

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
	for (const timeoutMs of [20_000, 5_000]) {
		const pending = registeredProvider(timeoutMs)({ id: "m" }, context);
		const checked = timeoutMs > 15_000
			? pending.then((result) => assert.equal((result.answers.action as { choice: string }).choice, "approve"))
			: assert.rejects(pending);
		t.mock.timers.tick(15_000);
		await checked;
	}
});

test("registered provider rejects a successful response missing the requested answer", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ answers: {} })));
	await assert.rejects(registeredProvider()({ id: "m" }, context));
});
