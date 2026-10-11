import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createDecisionsBackend, createJevBackend } from "../src/backends.ts";

const choiceResponse = (a: number, b: number, c: number) =>
	new Response(
		JSON.stringify({
			answers: { action: { probabilities: { A: a, B: b, C: c }, choice: a > 0.5 ? "approve" : b > 0.5 ? "ask" : "deny" } },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

test("decisions backend maps the 3-way choice to approve/deny/defer", async () => {
	let captured: RequestInit | undefined;
	const backend = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "test-model",
		timeoutMs: 1000,
		fetch: async (_url, init) => {
			captured = init;
			return choiceResponse(0.99, 0.005, 0.005);
		},
	});
	const result = await backend.decide({ command: "rm -rf dist", intent: "clean up" });
	assert.deepEqual(result, { action: "approve", probability: 0.99 });
	const body = JSON.parse(String(captured?.body));
	assert.equal(body.model, "test-model");
	assert.equal(body.questions[0].type, "choice");
	assert.equal(body.questions.length, 1);
	assert.match(body.input, /rm -rf dist/);
	assert.match(body.input, /clean up/);

	const deny = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.001, 0.001, 0.999) }).decide({ command: "rm -rf /", intent: "i" });
	assert.deepEqual(deny, { action: "deny", probability: 0.999 });

	const defer = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.5, 0.49, 0.01) }).decide({ command: "rm -rf x", intent: "i" });
	assert.deepEqual(defer, { action: "defer", probability: 0.5 });

	// Deny needs near-certainty; 0.9 is not enough and defers instead.
	const softDeny = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.05, 0.05, 0.9) }).decide({ command: "rm -rf x", intent: "i" });
	assert.deepEqual(softDeny, { action: "defer", probability: 0.9 });
});

test("decisions backend maps HTTP failures and bad bodies to errors", async () => {
	const failing = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "m",
		timeoutMs: 1000,
		fetch: async () => new Response("boom", { status: 500 }),
	});
	assert.deepEqual(await failing.decide({ command: "rm -rf dist", intent: "i" }), { error: "decision API 500" });

	const malformed = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "m",
		timeoutMs: 1000,
		fetch: async () => new Response("{}", { status: 200 }),
	});
	assert.ok("error" in (await malformed.decide({ command: "rm -rf dist", intent: "i" })));
});

test("decisions backend maps network failures to errors, not throws", async () => {
	const backend = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "m",
		timeoutMs: 1000,
		fetch: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	assert.deepEqual(await backend.decide({ command: "rm -rf dist", intent: "i" }), { error: "ECONNREFUSED" });
});

type ClassifyFn = NonNullable<Parameters<typeof createJevBackend>[1]["classify"]>;

test("jev backend passes state and returns approve on high probability", async () => {
	let captured: Record<string, unknown> | undefined;
	const classify: ClassifyFn = async (state) => {
		captured = state;
		return { probability: 0.87 };
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify });
	const result = await backend.decide({ command: "rm -rf dist", intent: "delete dist" });
	assert.deepEqual(result, { action: "approve", probability: 0.87 });
	assert.equal(captured?.command, "rm -rf dist");
	assert.equal(captured?.userRequest, "delete dist");
});

test("jev backend defers on low probability and surfaces failures as errors", async () => {
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify: async () => ({ probability: 0.1 }) });
	assert.deepEqual(await backend.decide({ command: "rm -rf dist", intent: "i" }), { action: "defer", probability: 0.1 });

	const failing = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify: async () => { throw new Error("rate limited"); } });
	assert.deepEqual(await failing.decide({ command: "rm -rf dist", intent: "i" }), { error: "rate limited" });
});

test("backends report their default thresholds", () => {
	assert.equal(createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify: async () => ({ probability: 0 }) }).defaultThreshold, 0.6);
	assert.equal(createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1 }).defaultThreshold, 0.85);
});

function fakeRegistry() {
	return {
		findOfType: () => ({ id: "jev-latest" }),
		classify: async () => ({ answers: { safe: { probability: 0.5 } }, stopReason: "stop" }),
	};
}
