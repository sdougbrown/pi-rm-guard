import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createDecisionsBackend, createJevBackend } from "../src/backends.ts";

const okResponse = (probability: number) =>
	new Response(JSON.stringify({ answers: { safe: { probabilities: { yes: probability, no: 1 - probability } } } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

test("decisions backend returns probability on a well-formed response", async () => {
	let captured: RequestInit | undefined;
	const backend = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "test-model",
		timeoutMs: 1000,
		fetch: async (_url, init) => {
			captured = init;
			return okResponse(0.93);
		},
	});
	const result = await backend.decide({ command: "rm -rf dist", intent: "clean up" });
	assert.deepEqual(result, { probability: 0.93 });
	const body = JSON.parse(String(captured?.body));
	assert.equal(body.model, "test-model");
	assert.equal(body.questions[0].type, "yes_no");
	assert.equal(body.questions.length, 1);
	assert.match(body.input, /rm -rf dist/);
	assert.match(body.input, /clean up/);
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
		fetch: async () => okResponse(undefined as unknown as number),
	});
	const bad = await malformed.decide({ command: "rm -rf dist", intent: "i" });
	assert.ok("error" in bad);
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

test("jev backend passes state and returns probability", async () => {
	let captured: Record<string, unknown> | undefined;
	const classify: ClassifyFn = async (state) => {
		captured = state;
		return { probability: 0.87 };
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify });
	const result = await backend.decide({ command: "rm -rf dist", intent: "delete dist" });
	assert.deepEqual(result, { probability: 0.87 });
	assert.equal(captured?.command, "rm -rf dist");
	assert.equal(captured?.userRequest, "delete dist");
});

test("jev backend surfaces classifier failures as errors", async () => {
	const classify: ClassifyFn = async () => {
		throw new Error("rate limited");
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify });
	assert.deepEqual(await backend.decide({ command: "rm -rf dist", intent: "i" }), { error: "rate limited" });
});

test("jev backend uses its own default threshold", () => {
	assert.equal(createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify: async () => ({ probability: 0 }) }).defaultThreshold, 0.6);
	assert.equal(createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1 }).defaultThreshold, 0.85);
});

function fakeRegistry() {
	return {
		findOfType: () => ({ id: "jev-latest" }),
		classify: async () => ({ answers: { safe: { probability: 0.5 } }, stopReason: "stop" }),
	};
}
