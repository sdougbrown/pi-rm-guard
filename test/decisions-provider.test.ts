import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchAnswers, ProtocolError, PROTOCOL_MARK, requestDecisions, toPiAnswer, toWireQuestion } from "../src/decisions-provider.ts";
import type { PiQuestion, WireAnswer } from "../src/decisions-provider.ts";

test("bool questions map to predicate with criteria in the instructions", () => {
	const wire = toWireQuestion("safe", {
		type: "bool",
		instructions: "Did the user ask?",
		criteria: { true: "Yes they did", false: "No they did not" },
	});
	assert.deepEqual(wire, {
		type: "predicate",
		name: "safe",
		instructions: "Did the user ask?\nYes means: Yes they did\nNo means: No they did not",
	});
});

test("choice questions map criteria to valued choices in order", () => {
	const wire = toWireQuestion("cat", { type: "choice", instructions: "Which?", criteria: { build: "generated files", system: "system files" } });
	assert.deepEqual(wire, {
		type: "choice",
		name: "cat",
		instructions: "Which?",
		choices: [
			{ value: "build", description: "generated files" },
			{ value: "system", description: "system files" },
		],
	});
});

test("score questions map levels as labeled entries", () => {
	const wire = toWireQuestion("risk", { type: "score", instructions: "How bad?", criteria: ["none", "high"] });
	assert.deepEqual(wire, {
		type: "score",
		name: "risk",
		instructions: "How bad?",
		levels: [{ label: "none" }, { label: "high" }],
	});
});

test("predicate answers map back to bool probability", () => {
	const answer = toPiAnswer({ type: "bool", instructions: "", criteria: { true: "", false: "" } }, {
		type: "predicate",
		name: "safe",
		probability: 0.93,
	});
	assert.deepEqual(answer, { type: "bool", probability: 0.93 });
});

test("choice answers map values back to criteria names and keep confidence", () => {
	assert.deepEqual(toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice",
		name: "cat",
		choice: "system",
		confidence: 0.9,
		probabilities: [
			{ value: "build", probability: 0.1 },
			{ value: "system", probability: 0.9 },
		],
	}), { type: "choice", choice: "system", probabilities: { build: 0.1, system: 0.9 }, confidence: 0.9 });
});

test("choice probabilities for values outside the criteria are ignored", () => {
	const answer = toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice",
		choice: "build",
		probabilities: [
			{ value: "build", probability: 0.7 },
			{ value: "system", probability: 0.2 },
			{ value: "unoffered", probability: 0.1 },
		],
	});
	assert.deepEqual(answer, { type: "choice", choice: "build", probabilities: { build: 0.7, system: 0.2 }, confidence: 0.7 });
});

test("missing choices are not fabricated from the first option", () => {
	assert.throws(() => toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice",
		probabilities: [{ value: "build", probability: 0.6 }],
	}), /missing choice/);
});

test("unknown choices are not fabricated from the first option", () => {
	assert.throws(() => toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice",
		choice: "zzz",
		probabilities: [{ value: "build", probability: 0.6 }],
	}), /unknown choice/);
});

test("score answers carry the reported score and confidence", () => {
	assert.deepEqual(toPiAnswer({ type: "score", instructions: "", criteria: ["none", "some", "high"] }, {
		type: "score",
		name: "risk",
		score: 1.4,
		confidence: 0.8,
		probabilities: [
			{ value: 0, label: "none", probability: 0.2 },
			{ value: 1, label: "some", probability: 0.3 },
			{ value: 2, label: "high", probability: 0.5 },
		],
	}), { type: "score", score: 1.4, confidence: 0.8 });
});

test("score answers without confidence use the winning level's probability", () => {
	assert.deepEqual(toPiAnswer({ type: "score", instructions: "", criteria: ["none", "some", "high"] }, {
		type: "score",
		score: 1.2,
		probabilities: [
			{ value: 0, label: "none", probability: 0.2 },
			{ value: 1, label: "some", probability: 0.6 },
			{ value: 2, label: "high", probability: 0.2 },
		],
	}), { type: "score", score: 1.2, confidence: 0.6 });
});

test("a score outside the levels, or an unvalidated number, is a contract violation", () => {
	const q = { type: "score" as const, instructions: "", criteria: ["none", "high"] };
	assert.throws(
		() => toPiAnswer(q, { type: "score", score: 1.4, probabilities: [{ value: 0, label: "none", probability: 1 }] }),
		/score 1.4 outside the 2 levels/,
	);
	assert.throws(
		() => toPiAnswer(q, { type: "score", score: 0.5, confidence: 7, probabilities: [{ value: 0, label: "none", probability: 1 }] }),
		/reported confidence as 7/,
	);
	assert.throws(
		() => toPiAnswer(q, { type: "score", score: 0.5, probabilities: [{ value: 0, label: "none", probability: "1" } as never] }),
		/reported the probability of level 0 as "1"/,
	);
	// A level absent from the distribution reads as zero mass, not an error:
	// only the numbers the fallback reads are validated.
	assert.deepEqual(
		toPiAnswer(q, { type: "score", score: 0.5, confidence: 0.5, probabilities: [{ value: 0, label: "none", probability: 1 }] }),
		{ type: "score", score: 0.5, confidence: 0.5 },
	);
});

test("requests carry text input, the questions, and the endpoint token", async () => {
	let captured: { url: string; body: Record<string, unknown>; auth: string | undefined } | undefined;
	const body = await requestDecisions({
		url: "http://test/v1/decisions",
		model: "gemma4",
		input: { command: "rm -rf dist", cwd: "/repo" },
		questions: [toWireQuestion("safe", { type: "bool", instructions: "Is this safe?", criteria: { true: "yes", false: "no" } })],
		timeoutMs: 1000,
		apiKey: "token",
		fetch: async (url, init) => {
			captured = { url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.authorization };
			return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "safe", probability: 0.9 }] }), { status: 200 });
		},
	});
	assert.equal(captured?.url, "http://test/v1/decisions");
	assert.equal(captured?.auth, "Bearer token");
	assert.equal(captured?.body.model, "gemma4");
	// The Decisions API takes text, so structured state travels as JSON text
	assert.equal(typeof captured?.body.input, "string");
	assert.deepEqual(JSON.parse(String(captured?.body.input)), { command: "rm -rf dist", cwd: "/repo" });
	assert.equal((captured?.body.questions as { type: string }[])[0]?.type, "predicate");
	assert.deepEqual(body.answers, [{ type: "predicate", name: "safe", probability: 0.9 }]);
});

test("string input is sent as text without re-encoding", async () => {
	let input: unknown;
	await requestDecisions({
		url: "u",
		model: "m",
		input: "just some text",
		questions: [],
		timeoutMs: 1000,
		fetch: async (_url, init) => {
			input = JSON.parse(String(init?.body)).input;
			return new Response("{}", { status: 200 });
		},
	});
	assert.equal(input, "just some text");
});

test("named answers bind by name, whatever order they arrive in", () => {
	const questions = [
		toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } }),
		toWireQuestion("b", { type: "bool", instructions: "Is B?", criteria: { true: "yes", false: "no" } }),
	];
	const matched = matchAnswers(questions, [
		{ type: "predicate", name: "b", probability: 0.8 },
		{ type: "predicate", name: "a", probability: 0.2 },
	]);
	assert.equal(matched.get("a")?.probability, 0.2);
	assert.equal(matched.get("b")?.probability, 0.8);
});

test("unnamed answers bind by position", () => {
	const questions = [
		toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } }),
		toWireQuestion("b", { type: "bool", instructions: "Is B?", criteria: { true: "yes", false: "no" } }),
	];
	const matched = matchAnswers(questions, [
		{ type: "predicate", probability: 0.2 },
		{ type: "predicate", name: null, probability: 0.8 },
	]);
	assert.equal(matched.get("a")?.probability, 0.2);
	assert.equal(matched.get("b")?.probability, 0.8);
});

test("an unnamed answer fills the first question a name did not", () => {
	const questions = [
		toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } }),
		toWireQuestion("b", { type: "bool", instructions: "Is B?", criteria: { true: "yes", false: "no" } }),
	];
	const matched = matchAnswers(questions, [
		{ type: "predicate", name: "b", probability: 0.8 },
		{ type: "predicate", probability: 0.2 },
	]);
	assert.equal(matched.get("a")?.probability, 0.2);
	assert.equal(matched.get("b")?.probability, 0.8);
});

test("an answer that names another question is not that question's verdict", () => {
	const questions = [toWireQuestion("action", { type: "bool", instructions: "Is it?", criteria: { true: "yes", false: "no" } })];
	assert.throws(
		() => matchAnswers(questions, [{ type: "predicate", name: "unrelated", probability: 0.99 }]),
		/unasked question/,
	);
});

test("a repeated answer name is an error, not the last or first word", () => {
	const questions = [
		toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } }),
		toWireQuestion("b", { type: "bool", instructions: "Is B?", criteria: { true: "yes", false: "no" } }),
	];
	assert.throws(
		() => matchAnswers(questions, [
			{ type: "predicate", name: "a", probability: 0.9 },
			{ type: "predicate", name: "a", probability: 0.1 },
		]),
		/twice/,
	);
});

test("more unnamed answers than unanswered questions is an error", () => {
	const questions = [
		toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } }),
		toWireQuestion("b", { type: "bool", instructions: "Is B?", criteria: { true: "yes", false: "no" } }),
	];
	// An extra answer in the middle shifts every later positional binding.
	assert.throws(
		() => matchAnswers(questions, [
			{ type: "predicate", probability: 0.1 },
			{ type: "predicate", probability: 0.2 },
			{ type: "predicate", probability: 0.3 },
		]),
		/returned 3 unnamed answers for 2 questions/,
	);
	// Named answers fill their own questions, so the rest stay positional.
	assert.equal(matchAnswers(questions, [
		{ type: "predicate", name: "a", probability: 0.9 },
		{ type: "predicate", probability: 0.2 },
	]).get("b")?.probability, 0.2);
});

test("a probability that is not a number in [0,1] is an error, not a coercion", () => {
	const q = { type: "choice" as const, instructions: "", criteria: { approve: "safe", ask: "unclear" } };
	for (const probability of ["0.99", 1.5, -0.1, Number.NaN] as unknown[]) {
		assert.throws(
			() => toPiAnswer(q, { type: "choice", choice: "approve", probabilities: [{ value: "approve", probability: probability as number }] }),
			ProtocolError,
			`probability ${JSON.stringify(probability)} must not reach a verdict`,
		);
	}
	assert.throws(
		() => toPiAnswer(q, { type: "choice", choice: "approve", confidence: 7, probabilities: [{ value: "approve", probability: 0.9 }] }),
		ProtocolError,
	);
});

test("an answer named with a non-string is a broken endpoint, not an unnamed one", () => {
	const questions = [toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } })];
	assert.throws(
		() => matchAnswers(questions, [{ type: "predicate", name: 7 as unknown as string, probability: 0.9 }]),
		/non-string name/,
	);
});

test("a request the endpoint refuses is a protocol error, so callers escalate", async () => {
	await assert.rejects(
		requestDecisions({ url: "u", model: "m", input: "x", questions: [], timeoutMs: 1000,
			fetch: async () => new Response("old wire", { status: 422 }) }),
		ProtocolError,
	);
	// A rate limit or a request timeout clears on its own: the fallback rides
	// it out instead of the guard escalating on a healthy endpoint.
	for (const status of [408, 429]) {
		let err: Error | undefined;
		try {
			await requestDecisions({ url: "u", model: "m", input: "x", questions: [], timeoutMs: 1000,
				fetch: async () => new Response("slow down", { status }) });
		} catch (e) { err = e as Error; }
		assert.equal(err instanceof ProtocolError, false, `HTTP ${status} is transient`);
		assert.match(err?.message ?? "", new RegExp(`\\b${status}\\b`));
	}
	// A server failure may be transient; it is not a contract violation, and the
	// message must stay out from under the protocol marker so the fallback that
	// reads it does not mistake the two.
	let err: Error | undefined;
	try {
		await requestDecisions({ url: "u", model: "m", input: "x", questions: [], timeoutMs: 1000,
			fetch: async () => new Response("boom", { status: 500 }) });
	} catch (e) { err = e as Error; }
	assert.equal(err instanceof ProtocolError, false);
	assert.match(err?.message ?? "", /\b500\b/);
	assert.equal((err?.message ?? "").startsWith(PROTOCOL_MARK), false);
});

test("a repeated offered value is an error, not a last write", () => {
	assert.throws(
		() => toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
			type: "choice",
			choice: "build",
			probabilities: [{ value: "build", probability: 0.2 }, { value: "build", probability: 0.9 }],
		}),
		/reported build twice/,
	);
});

test("a question with no answer at all is an error", () => {
	const questions = [
		toWireQuestion("a", { type: "bool", instructions: "Is A?", criteria: { true: "yes", false: "no" } }),
		toWireQuestion("b", { type: "bool", instructions: "Is B?", criteria: { true: "yes", false: "no" } }),
	];
	assert.throws(() => matchAnswers(questions, [{ type: "predicate", name: "a", probability: 0.9 }]), /no answer for b/);
});

test("reported confidence wins over the distribution it disagrees with", () => {
	assert.deepEqual(toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice",
		choice: "build",
		confidence: 0.42,
		probabilities: [{ value: "build", probability: 0.9 }, { value: "system", probability: 0.1 }],
	}), { type: "choice", choice: "build", probabilities: { build: 0.9, system: 0.1 }, confidence: 0.42 });
	assert.deepEqual(toPiAnswer({ type: "score", instructions: "", criteria: ["none", "high"] }, {
		type: "score",
		score: 0.5,
		confidence: 0.31,
		probabilities: [{ value: 0, label: "none", probability: 0.6 }, { value: 1, label: "high", probability: 0.4 }],
	}), { type: "score", score: 0.5, confidence: 0.31 });
});

test("malformed answers never invent a confident verdict", () => {
	const boolQ = { type: "bool" as const, instructions: "", criteria: { true: "yes", false: "no" } };
	const choiceQ = { type: "choice" as const, instructions: "", criteria: { build: "b", system: "s" } };
	const scoreQ = { type: "score" as const, instructions: "", criteria: ["none", "high"] };
	const cases: [string, PiQuestion, WireAnswer, RegExp][] = [
		["predicate without a number", boolQ, { type: "predicate", probability: "0.99" } as unknown as WireAnswer, /probability of true as "0\.99"/],
		["predicate without a probability", boolQ, { type: "predicate" }, /probability of true as undefined/],
		["null choice", choiceQ, { type: "choice", choice: null, probabilities: [{ value: "build", probability: 1 }] } as unknown as WireAnswer, /missing choice/],
		["score without a number", scoreQ, { type: "score", probabilities: [{ value: 0, label: "none", probability: 1 }] }, /the score as null/],
	];
	for (const [label, q, answer, message] of cases) {
		assert.throws(() => toPiAnswer(q, answer), ProtocolError, `${label} must escalate`);
		let thrown: unknown;
		try {
			toPiAnswer(q, answer);
		} catch (err) {
			thrown = err;
		}
		assert.match((thrown as Error).message, message, label);
	}
});

test("message-list input passes through as the API's own input list", async () => {
	let input: unknown;
	await requestDecisions({
		url: "u",
		model: "m",
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
		questions: [],
		timeoutMs: 1000,
		fetch: async (_url, init) => {
			input = JSON.parse(String(init?.body)).input;
			return new Response("{}", { status: 200 });
		},
	});
	assert.deepEqual(input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
});
