import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildDecisionsInput, createDecisionsBackend, createJevBackend, type DecisionInput } from "../src/backends.ts";

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

const input = (command = "rm -rf dist"): DecisionInput => ({
	command,
	cwd: "/repo",
	userRequests: ["clean up the build cache", "clean the build cache"],
	evidence: ["bash: du -sh node_modules", "result: 2.1G node_modules"],
});

test("decisions input presents the raw command and context without claiming verified targets", () => {
	const built = buildDecisionsInput(input());
	assert.match(built, /rm -rf dist/);
	assert.match(built, /\/repo/);
	assert.match(built, /clean up the build cache/);
	assert.match(built, /du -sh node_modules/);
	assert.doesNotMatch(built, /gate has verified|statically resolved/);
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
	const result = await backend.decide(input());
	assert.deepEqual(result, { action: "approve", probability: 0.99, label: "approve" });
	const body = JSON.parse(String(captured?.body));
	assert.equal(body.model, "test-model");
	assert.equal(body.questions[0].type, "choice");
	assert.equal(body.questions.length, 1);
	assert.match(body.input, /rm -rf dist/);

	const deny = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.001, 0.001, 0.999) }).decide(input("rm -rf /"));
	assert.deepEqual(deny, { action: "deny", probability: 0.999, label: "deny" });

	const askDefer = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.1, 0.85, 0.05) }).decide(input("rm -rf x"));
	assert.deepEqual(askDefer, { action: "defer", probability: 0.85, label: "ask" });

	const defer = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.5, 0.49, 0.01) }).decide(input("rm -rf x"));
	assert.deepEqual(defer, { action: "defer", probability: 0.5, label: "approve" });

	// Deny needs near-certainty; 0.9 is not enough and defers instead.
	const softDeny = await createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, fetch: async () => choiceResponse(0.05, 0.05, 0.9) }).decide(input("rm -rf x"));
	assert.deepEqual(softDeny, { action: "defer", probability: 0.9, label: "deny" });
});

test("decisions backend honors a configured threshold", async () => {
	const atThreshold = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, threshold: 0.95, fetch: async () => choiceResponse(0.9, 0.05, 0.05) });
	assert.deepEqual(await atThreshold.decide(input()), { action: "defer", probability: 0.9, label: "approve" });
	const aboveThreshold = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 1, threshold: 0.8, fetch: async () => choiceResponse(0.82, 0.1, 0.08) });
	assert.deepEqual(await aboveThreshold.decide(input()), { action: "approve", probability: 0.82, label: "approve" });
});

test("a low approval threshold does not override the model's ask verdict", async () => {
	const direct = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100, threshold: 0.2, fetch: async () => choiceResponse(0.3, 0.6, 0.1) });
	assert.deepEqual(await direct.decide(input()), { action: "defer", probability: 0.6, label: "ask" });
	const classifier = createJevBackend(fakeRegistry(), {
		modelId: "j", apiKey: undefined, threshold: 0.2,
		classify: async () => ({ answers: { action: { probabilities: { approve: 0.3, ask: 0.6, deny: 0.1 } } } }),
	});
	assert.deepEqual(await classifier.decide(input()), { action: "defer", probability: 0.6, label: "ask" });
});

test("decisions backend maps HTTP failures and bad bodies to errors", async () => {
	const failing = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "m",
		timeoutMs: 1000,
		fetch: async () => new Response("boom", { status: 500 }),
	});
	assert.deepEqual(await failing.decide(input()), { error: "decision API 500" });

	const malformed = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "m",
		timeoutMs: 1000,
		fetch: async () => new Response("{}", { status: 200 }),
	});
	assert.deepEqual(await malformed.decide(input()), {
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
	assert.deepEqual(await backend.decide(input()), { error: "ECONNREFUSED" });
});

type ClassifyFn = NonNullable<Parameters<typeof createJevBackend>[1]["classify"]>;

test("jev backend maps choice answers to approve/deny/defer and carries full context", async () => {
	let captured: Record<string, unknown> | undefined;
	let called = 0;
	const classify: ClassifyFn = async (state) => {
		called++;
		captured = state;
		return { answers: { action: { probabilities: { approve: 0.87, ask: 0.1, deny: 0.03 } } }, stopReason: "stop" };
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify });
	const result = await backend.decide(input());
	assert.deepEqual(result, { action: "approve", probability: 0.87, label: "approve" });
	assert.equal(captured?.command, "rm -rf dist");
	assert.equal(captured?.cwd, "/repo");
	assert.deepEqual(captured?.userRequests, ["clean up the build cache", "clean the build cache"]);
	assert.deepEqual(captured?.evidence, ["bash: du -sh node_modules", "result: 2.1G node_modules"]);
	assert.equal(called, 1); // choice worked, no bool retry

	const deny = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify: async () => ({ answers: { action: { probabilities: { approve: 0.001, ask: 0.001, deny: 0.999 } } }, stopReason: "stop" }) });
	assert.deepEqual(await deny.decide(input("rm -rf /")), { action: "deny", probability: 0.999, label: "deny" });

	const softDeny = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify: async () => ({ answers: { action: { probabilities: { approve: 0.05, ask: 0.05, deny: 0.9 } } }, stopReason: "stop" }) });
	assert.deepEqual(await softDeny.decide(input("rm -rf x")), { action: "defer", probability: 0.9, label: "deny" });
});

test("jev backend honors a configured threshold", async () => {
	const backend = createJevBackend(fakeRegistry(), {
		modelId: "j",
		apiKey: undefined,
		threshold: 0.95,
		classify: async () => ({ answers: { action: { probabilities: { approve: 0.9, ask: 0.08, deny: 0.02 } } }, stopReason: "stop" }),
	});
	assert.deepEqual(await backend.decide(input()), { action: "defer", probability: 0.9, label: "approve" });
});

test("jev backend falls back to bool when choice is rejected", async () => {
	const questionsSeen: unknown[] = [];
	const classify: ClassifyFn = async (_state, questions) => {
		questionsSeen.push(questions);
		if ("action" in questions) throw new Error("choice unsupported");
		return { answers: { safe: { probability: 0.7 } }, stopReason: "stop" };
	};
	const backend = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, classify });
	const result = await backend.decide(input());
	assert.deepEqual(result, { action: "approve", probability: 0.7, label: "approve" });
	assert.equal(questionsSeen.length, 2);
	assert.ok("action" in questionsSeen[0]);
	assert.ok("safe" in questionsSeen[1]);
	// Second call stays in bool mode.
	await backend.decide(input());
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
	assert.deepEqual(await lowBool.decide(input()), { action: "defer", probability: 0.4, label: "ask" });
});

test("jev backend bounds the classify call with a timeout", async () => {
	const backend = createJevBackend(fakeRegistry(), {
		modelId: "j",
		apiKey: undefined,
		timeoutMs: 20,
		classify: () => new Promise((resolve) => setTimeout(() => resolve({ answers: { action: { probabilities: { approve: 1, ask: 0, deny: 0 } } } }), 200)),
	});
	const result = await backend.decide(input());
	assert.ok("error" in result);
	assert.match(result.error, /timed out/);
});

test("a timeout neither retries nor permanently disables choice verdicts", async () => {
	let calls = 0;
	const backend = createJevBackend(fakeRegistry(), {
		modelId: "j", apiKey: undefined, timeoutMs: 5,
		classify: async () => {
			calls++;
			if (calls === 1) return new Promise(() => {});
			return { answers: { action: { probabilities: { approve: 0.001, ask: 0.001, deny: 0.998 } } } };
		},
	});
	assert.ok("error" in await backend.decide(input()));
	assert.equal(calls, 1);
	assert.equal((await backend.decide(input()) as { action: string }).action, "deny");
});

test("jev backend defers on low probability and surfaces failures as errors", async () => {
	const backend = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify: async () => ({ answers: { action: { probabilities: { approve: 0.1, ask: 0.85, deny: 0.05 } } }, stopReason: "stop" }) });
	assert.deepEqual(await backend.decide(input()), { action: "defer", probability: 0.85, label: "ask" });

	const failing = createJevBackend(fakeRegistry(), { modelId: "jev-latest", apiKey: undefined, classify: async () => { throw new Error("rate limited"); } });
	assert.deepEqual(await failing.decide(input()), { error: "rate limited" });
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
