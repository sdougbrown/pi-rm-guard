import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createClassifierBackend, createDecisionsBackend, type DecisionInput } from "../src/backends.ts";
import { ProtocolError, PROTOCOL_MARK, registerDecisionsProvider, toWireQuestion } from "../src/decisions-provider.ts";

const choiceResponse = (approve: number, ask: number, deny: number) =>
	new Response(
		JSON.stringify({
			answers: [
				{
					type: "choice",
					name: "action",
					choice: approve >= ask && approve >= deny ? "approve" : deny >= ask ? "deny" : "ask",
					confidence: Math.max(approve, ask, deny),
					probabilities: [
						{ value: "approve", probability: approve },
						{ value: "ask", probability: ask },
						{ value: "deny", probability: deny },
					],
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

const input = (command = "rm -rf dist"): DecisionInput => ({
	command,
	cwd: "/repo",
	userRequests: ["clean up the build cache", "clean the build cache"],
	evidence: ["bash: du -sh node_modules", "result: 2.1G node_modules"],
});

test("both endpoint routes send identical decision state and questions", async () => {
	let directBody: { input: unknown; questions: unknown[] } | undefined;
	const direct = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async (_url, init) => { directBody = JSON.parse(String(init?.body)); return choiceResponse(0.99, 0.005, 0.005); },
	});
	let state: Record<string, unknown> | undefined;
	let questions: { action: Parameters<typeof toWireQuestion>[1] } | undefined;
	const classifier = createJevBackend(fakeRegistry(), { modelId: "m", apiKey: undefined,
		classify: async (s, q) => { state = s; questions = q as typeof questions; return { action: { probabilities: { approve: 0.99, ask: 0.005, deny: 0.005 } } }; },
	});
	await direct.decide(input());
	await classifier.decide(input());
	// The Decisions API takes text, so the direct route sends the state as JSON text
	assert.deepEqual(JSON.parse(String(directBody?.input)), state);
	assert.ok(questions);
	assert.deepEqual(directBody?.questions, [toWireQuestion("action", questions.action)]);
	assert.equal(state?.command, input().command);
	assert.deepEqual(state?.userRequests, input().userRequests);
	assert.deepEqual(state?.evidence, input().evidence);
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
	assert.equal(JSON.parse(body.input).command, "rm -rf dist");

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
	const failed = await failing.decide(input());
	assert.ok("error" in failed);
	assert.match(failed.error, /\b500\b/);

	const malformed = createDecisionsBackend({
		url: "http://test/v1/decisions",
		model: "m",
		timeoutMs: 1000,
		fetch: async () => new Response("{}", { status: 200 }),
	});
	assert.deepEqual(await malformed.decide(input()), {
		error: "decisions API: no answer for action",
	});
});

test("a choice the criteria never offered is an error, including a non-string one", async () => {
	for (const choice of [false, "unoffered", "A"]) {
		const backend = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
			fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice, confidence: 1, probabilities: [{ value: "approve", probability: 0.99 }, { value: "ask", probability: 0.005 }, { value: "deny", probability: 0.005 }] }] })),
		});
		const result = await backend.decide(input());
		assert.ok("error" in result, `choice ${JSON.stringify(choice)} must not approve`);
	}
});

test("the label that authorizes execution must be a reported one", async () => {
	const unreported = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "approve", probabilities: [{ value: "ask", probability: 0.01 }, { value: "deny", probability: 0.01 }] }] })),
	});
	assert.deepEqual(await unreported.decide(input()), { error: "decisions API: reported no probability for approve" });

	// A sparse report is read as the unreported labels being zero, which is why
	// the chosen label's own entry is the one that has to be there.
	const sparse = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "approve", probabilities: [{ value: "approve", probability: 0.99 }] }] })),
	});
	assert.deepEqual(await sparse.decide(input()), { action: "approve", probability: 0.99, label: "approve" });
});

test("a value reported twice is an error, not a last-write verdict", async () => {
	const backend = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "approve", probabilities: [{ value: "approve", probability: 0.2 }, { value: "approve", probability: 0.99 }] }] })),
	});
	assert.deepEqual(await backend.decide(input()), { error: "decisions API: reported approve twice" });
});


test("the direct route accepts an unnamed answer only for the question it asked", async () => {
	const unnamed = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", choice: "approve", probabilities: [{ value: "approve", probability: 0.99 }, { value: "ask", probability: 0.005 }, { value: "deny", probability: 0.005 }] }] })),
	});
	assert.deepEqual(await unnamed.decide(input()), { action: "approve", probability: 0.99, label: "approve" });

	const foreign = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "somethingelse", choice: "approve", probabilities: [{ value: "approve", probability: 0.99 }] }] })),
	});
	const result = await foreign.decide(input());
	assert.ok("error" in result, "another question's answer must not approve");
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
	const questionsSeen: object[] = [];
	const classify: ClassifyFn = async (_state, questions) => {
		assert.ok(questions && typeof questions === "object");
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
	await backend.decide(input());
	assert.equal(questionsSeen.length, 4);
	assert.ok("action" in questionsSeen[2]);
	assert.ok("safe" in questionsSeen[3]);

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

test("a transient failure does not disable later three-way verdicts", async () => {
	let recovered = false;
	const seen: unknown[] = [];
	const backend = createJevBackend(fakeRegistry(), {
		modelId: "j", apiKey: undefined,
		classify: async (_state, questions) => {
			seen.push(questions);
			if (!recovered) throw new Error("temporarily offline");
			return { answers: { action: { probabilities: { approve: 0.001, ask: 0.001, deny: 0.998 } } } };
		},
	});
	assert.ok("error" in await backend.decide(input()));
	recovered = true;
	assert.equal((await backend.decide(input()) as { action: string }).action, "deny");
	assert.ok("action" in (seen.at(-1) as object));
});

test("backends reject malformed probabilities and honor the model's explicit choice", async () => {
	const malformed = [
		[{ value: "approve", probability: "1" }, { value: "ask", probability: 0 }, { value: "deny", probability: 0 }],
		[{ value: "approve", probability: 1.1 }, { value: "ask", probability: 0 }, { value: "deny", probability: 0 }],
	];
	for (const probabilities of malformed) {
		const backend = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
			fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "approve", probabilities }] })),
		});
		assert.ok("error" in await backend.decide(input()));
	}
	const direct = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100, threshold: 0.5,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "deny", probabilities: [{ value: "approve", probability: 0.51 }, { value: "ask", probability: 0 }, { value: "deny", probability: 0.49 }] }] })),
	});
	assert.deepEqual(await direct.decide(input()), { action: "defer", probability: 0.49, label: "deny" });
	const classifier = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined, threshold: 0.5,
		classify: async () => ({ answers: { action: { choice: "deny", probabilities: { approve: 0.51, ask: 0, deny: 0.49 } } } }),
	});
	assert.deepEqual(await classifier.decide(input()), { action: "defer", probability: 0.49, label: "deny" });
});

test("the registry route escalates a contract violation in production shape", async (t) => {
	// In production the provider's classify runs behind pi's model registry,
	// which flattens a thrown error into an error result that keeps only the
	// message text. Emulate that around the real provider and assert the guard
	// still escalates instead of falling back to the boolean probe.
	let providerClassify: ((model: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = { registerProvider(_name: string, config: { classifiers: Record<string, { classify: (m: unknown, c: unknown) => Promise<unknown> }> }) {
		providerClassify = config.classifiers["decisions-v2"].classify;
	} };
	registerDecisionsProvider(pi as never, { baseUrl: "http://test/v1", models: ["m"] });
	assert.ok(providerClassify);
	let registryCalls = 0;
	const registry = {
		findOfType: () => ({ id: "m" }),
		classify: async (model: unknown, ctx: unknown) => {
			registryCalls++;
			try {
				return await providerClassify!(model, ctx);
			} catch (err) {
				return { answers: {}, stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) };
			}
		},
	};
	t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "approve", probabilities: [
		{ value: "approve", probability: 0.2 },
		{ value: "approve", probability: 0.99 },
		{ value: "ask", probability: 0.01 },
	] }] })));
	const backend = createClassifierBackend(registry as never, { provider: "decisions", modelId: "m", apiKey: undefined });
	const result = await backend.decide(input("rm -rf /"));
	assert.ok("error" in result);
	assert.match(result.error, /reported approve twice/);
	assert.equal(registryCalls, 1, "the boolean probe must not run on a contract violation");
});

test("a transient 5xx still takes the boolean fallback on the registry route", async (t) => {
	let providerClassify: ((model: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = { registerProvider(_name: string, config: { classifiers: Record<string, { classify: (m: unknown, c: unknown) => Promise<unknown> }> }) {
		providerClassify = config.classifiers["decisions-v2"].classify;
	} };
	registerDecisionsProvider(pi as never, { baseUrl: "http://test/v1", models: ["m"] });
	assert.ok(providerClassify);
	let httpCalls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		httpCalls++;
		// One transient failure, then the endpoint answers the boolean probe.
		if (httpCalls === 1) return new Response("upstream hiccup", { status: 502 });
		return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "safe", probability: 0.9 }] }));
	});
	const registry = {
		findOfType: () => ({ id: "m" }),
		// Flatten the way pi's registry does, so the marker re-derivation in
		// classifyVia is on the path this test pins: a wording regression that
		// puts a 5xx under the protocol marker would fail here.
		classify: async (model: unknown, ctx: unknown) => {
			try {
				return await providerClassify!(model, ctx);
			} catch (err) {
				return { answers: {}, stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) };
			}
		},
	};
	const backend = createClassifierBackend(registry as never, { provider: "decisions", modelId: "m", apiKey: undefined });
	assert.deepEqual(await backend.decide(input("rm -rf /")), { action: "approve", probability: 0.9, label: "approve" });
	assert.equal(httpCalls, 2, "the boolean probe must run after a transient failure");
});

test("a rate limit is transient: the fallback rides it out on the registry route", async (t) => {
	let providerClassify: ((model: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = { registerProvider(_name: string, config: { classifiers: Record<string, { classify: (m: unknown, c: unknown) => Promise<unknown> }> }) {
		providerClassify = config.classifiers["decisions-v2"].classify;
	} };
	registerDecisionsProvider(pi as never, { baseUrl: "http://test/v1", models: ["m"] });
	assert.ok(providerClassify);
	let httpCalls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		httpCalls++;
		// One rate-limited response, then the endpoint answers the boolean probe.
		if (httpCalls === 1) return new Response("slow down", { status: 429 });
		return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "safe", probability: 0.9 }] }));
	});
	const registry = {
		findOfType: () => ({ id: "m" }),
		classify: async (model: unknown, ctx: unknown) => {
			try {
				return await providerClassify!(model, ctx);
			} catch (err) {
				return { answers: {}, stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) };
			}
		},
	};
	const backend = createClassifierBackend(registry as never, { provider: "decisions", modelId: "m", apiKey: undefined });
	assert.deepEqual(await backend.decide(input("rm -rf /")), { action: "approve", probability: 0.9, label: "approve" });
	assert.equal(httpCalls, 2, "the boolean probe must run after a rate limit");
});

test("a contract violation on the boolean probe escalates rather than crashing the guard", async () => {
	let boolCalls = 0;
	const backend = createClassifierBackend(fakeRegistry(), { provider: "typesafe", modelId: "j", apiKey: undefined,
		classify: async (_state, questions) => {
			if ("action" in (questions as Record<string, unknown>)) throw new Error("choice unsupported");
			boolCalls++;
			throw new ProtocolError("HTTP 422");
		},
	});
	const result = await backend.decide(input("rm -rf /"));
	assert.ok("error" in result);
	assert.match(result.error, /HTTP 422/);
	assert.equal(boolCalls, 1);
});

test("a protocol error on the choice probe escalates instead of re-probing with the bool question", async () => {
	let calls = 0;
	const backend = createClassifierBackend(fakeRegistry(), { provider: "decisions", modelId: "j", apiKey: undefined,
		classify: async (_state, questions) => {
			calls++;
			if ("action" in (questions as Record<string, unknown>)) {
				throw new ProtocolError("decisions API reported approve twice");
			}
			return { answers: { safe: { probability: 0.9 } }, stopReason: "stop" };
		},
	});
	const result = await backend.decide(input("rm -rf /"));
	assert.ok("error" in result);
	assert.match(result.error, /reported approve twice/);
	assert.equal(calls, 1, "the bool probe must not run on a contract violation");
});

test("the decisions request aborts instead of accepting a late approval", async () => {
	const backend = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 5,
		fetch: async (_url, init) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => resolve(choiceResponse(1, 0, 0)), 100);
			init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
		}),
	});
	assert.ok("error" in await backend.decide(input()));
});

test("decisions response with probabilities but no choice is an error, not argmax", async () => {
	const backend = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", probabilities: [{ value: "approve", probability: 1 }] }] }),
			{ status: 200, headers: { "content-type": "application/json" } }),
	});
	const result = await backend.decide(input());
	assert.ok("error" in result, "must be an error, not an argmax approve");
});

test("unknown choices cannot authorize execution through either backend", async () => {
	const direct = createDecisionsBackend({ url: "u", model: "m", timeoutMs: 100,
		fetch: async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "action", choice: "D", probabilities: [{ value: "approve", probability: 0.99 }, { value: "ask", probability: 0.005 }, { value: "deny", probability: 0.005 }] }] })),
	});
	assert.ok("error" in await direct.decide(input()));
	const classifier = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined,
		classify: async () => ({ action: { choice: "weird", probabilities: { approve: 0.99, ask: 0.005, deny: 0.005 } } }),
	});
	assert.ok("error" in await classifier.decide(input()));
});

test("malformed boolean answers are model errors, not model judgments", async () => {
	for (const safe of [{}, { probability: 1.5 }]) {
		const backend = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined,
			classify: async (_state, questions) => {
				if (questions && typeof questions === "object" && "action" in questions) throw new Error("choice unsupported");
				return { answers: { safe } };
			},
		});
		assert.ok("error" in await backend.decide(input()));
	}
});

test("missing classifier models fail before inference and identify the configuration", async () => {
	const backend = createClassifierBackend({ findOfType: () => undefined, classify: async () => { assert.fail("inference must not run without a model"); } },
		{ provider: "typesafe", modelId: "missing-model", apiKey: undefined });
	const result = await backend.decide(input());
	assert.ok("error" in result);
	assert.match(result.error, /missing-model/);
});

test("a successful fallback is a model approval, not permission from the failed probe", async () => {
	let calls = 0;
	const backend = createJevBackend(fakeRegistry(), { modelId: "j", apiKey: undefined,
		classify: async () => { if (++calls === 1) throw new Error("connection reset"); return { safe: { probability: 0.95 } }; },
	});
	assert.deepEqual(await backend.decide(input()), { action: "approve", probability: 0.95, label: "approve" });
});

function createJevBackend(registry: Parameters<typeof createClassifierBackend>[0], options: Omit<Parameters<typeof createClassifierBackend>[1], "provider">) {
	return createClassifierBackend(registry, { provider: "typesafe", ...options });
}

function fakeRegistry() {
	return {
		findOfType: () => ({ id: "jev-latest" }),
		classify: async () => ({ answers: { safe: { probability: 0.5 } }, stopReason: "stop" }),
	};
}
