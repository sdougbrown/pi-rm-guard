import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildDecisionsInput, createDecisionsBackend, createJevBackend } from "../src/backends.ts";

const choiceResponse = (approve: number, ask: number, deny: number) =>
	new Response(
		JSON.stringify({
			answers: {
				action: {
					// /v1/decisions answers are keyed by positional letters
					probabilities: { A: approve, B: ask, C: deny },
					choice: approve >= ask && approve >= deny ? "approve" : deny >= ask ? "deny" : "ask",
				},
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

test("decisions input states the resolved targets and the gate-verified scope", () => {
	const withTargets = buildDecisionsInput("rm -rf dist tmp-x", "delete dist", ["dist", "/tmp/x"]);
	assert.match(withTargets, /Deleting: dist, \/tmp\/x/);
	assert.match(withTargets, /static safety gate has verified/);
	assert.match(withTargets, /safe for system integrity/);
	assert.match(withTargets, /plausibly holds user or project data/);
	const noTargets = buildDecisionsInput("rm -rf *", "(no recent user request in session)");
	assert.match(noTargets, /Deleting: the command's targets/);
});

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
	const result = await backend.decide({ command: "rm -rf dist", intent: "clean up", targets: ["dist"] });
	assert.deepEqual(result, { action: "approve", probability: 0.99, label: "approve" });
	const body = JSON.parse(String(captured?.body));
	assert.equal(body.model, "test-model");
	assert.equal(body.questions[0].type, "choice");
	assert.equal(body.questions.length, 1);
	assert.match(body.input, /rm -rf dist/);
	assert.match(body.input, /Deleting: dist/);
	assert.match(body.input, /clean up/);

	const deny = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.001, 0.001, 0.999) }).decide({ command: "rm -rf /", intent: "i" });
	assert.deepEqual(deny, { action: "deny", probability: 0.999, label: "deny" });

	const askDefer = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.1, 0.85, 0.05) }).decide({ command: "rm -rf x", intent: "i" });
	assert.deepEqual(askDefer, { action: "defer", probability: 0.85, label: "ask" });

	const defer = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.5, 0.49, 0.01) }).decide({ command: "rm -rf x", intent: "i" });
	assert.deepEqual(defer, { action: "defer", probability: 0.5, label: "approve" });

	// Deny needs near-certainty; 0.9 is not enough and defers instead.
	const softDeny = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.05, 0.05, 0.9) }).decide({ command: "rm -rf x", intent: "i" });
	assert.deepEqual(softDeny, { action: "defer", probability: 0.9, label: "deny" });
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
	assert.deepEqual(await malformed.decide({ command: "rm -rf dist", intent: "i" }), {
		error: "decision API missing probabilities",
	});
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

test("jev backend maps choice answers to approve/deny/defer", async () => {
	let captured: Record<string, unknown> | undefined;
	let called = 0;
	const classify: ClassifyFn = async (state) => {
		called++;
		captured = state;
		return { answers: { action: { probabilities: { approve: 0.87, ask: 0.1, deny: 0.03 } } }, stopReason: "stop" };
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify });
	const result = await backend.decide({ command: "rm -rf dist", intent: "delete dist" });
	assert.deepEqual(result, { action: "approve", probability: 0.87, label: "approve" });
	assert.equal(captured?.command, "rm -rf dist");
	assert.equal(captured?.userRequest, "delete dist");
	assert.equal(captured?.targets, "(none resolved statically)");
	// a fresh backend isolates the internal choice-vs-bool `mode` state, so
	// this decide cannot be polluted by a bool-mode fallback from the first
	// classification
	const withTargets = createJevBackend(fakeRegistry(), {
		modelId: "jev-latest",
		apiKey: undefined,
		classify: async (st) => {
			captured = st;
			return { answers: { action: { probabilities: { approve: 0.9, ask: 0.05, deny: 0.05 } } }, stopReason: "stop" };
		},
	});
	await withTargets.decide({ command: "rm -rf dist", intent: "delete dist", targets: ["dist"] });
	assert.equal(captured?.targets, "dist");
	assert.equal(called, 1); // choice worked, no bool retry

	const deny = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify: async () => ({ answers: { action: { probabilities: { approve: 0.001, ask: 0.001, deny: 0.999 } } }, stopReason: "stop" }) });
	assert.deepEqual(await deny.decide({ command: "rm -rf /", intent: "i" }), { action: "deny", probability: 0.999, label: "deny" });

	const softDeny = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify: async () => ({ answers: { action: { probabilities: { approve: 0.05, ask: 0.05, deny: 0.9 } } }, stopReason: "stop" }) });
	assert.deepEqual(await softDeny.decide({ command: "rm -rf x", intent: "i" }), { action: "defer", probability: 0.9, label: "deny" });
});

test("jev backend falls back to bool when choice is rejected", async () => {
	const questionsSeen: unknown[] = [];
	const classify: ClassifyFn = async (_state, questions) => {
		questionsSeen.push(questions);
		if ("action" in questions) throw new Error("choice unsupported");
		return { answers: { safe: { probability: 0.7 } }, stopReason: "stop" };
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify });
	const result = await backend.decide({ command: "rm -rf dist", intent: "i" });
	assert.deepEqual(result, { action: "approve", probability: 0.7, label: "approve" });
	assert.equal(questionsSeen.length, 2);
	assert.ok("action" in questionsSeen[0]);
	assert.ok("safe" in questionsSeen[1]);
	// Second call stays in bool mode.
	await backend.decide({ command: "rm -rf dist", intent: "i" });
	assert.equal(questionsSeen.length, 3);
	assert.ok("safe" in questionsSeen[2]);

	// bool fallback low-probability branch: a "not clearly safe" answer defers
	let lowBoolCalls = 0;
	const lowBool = createJevBackend(fakeRegistry(), {
		modelId: "jev-latest",
		apiKey: undefined,
		classify: async () => {
			lowBoolCalls++;
			if (lowBoolCalls === 1) throw new Error("no choice support");
			return { answers: { safe: { probability: 0.4 } }, stopReason: "stop" };
		},
	});
	assert.deepEqual(await lowBool.decide({ command: "rm -rf dist", intent: "i" }), { action: "defer", probability: 0.4, label: "ask" });
});

test("jev backend defers on low probability and surfaces failures as errors", async () => {
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify: async () => ({ answers: { action: { probabilities: { approve: 0.1, ask: 0.85, deny: 0.05 } } }, stopReason: "stop" }) });
	assert.deepEqual(await backend.decide({ command: "rm -rf dist", intent: "i" }), { action: "defer", probability: 0.85, label: "ask" });

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
