import { strict as assert } from "node:assert";
import { test } from "node:test";
import { requestDecisions, toPiAnswer, toWireQuestion } from "../src/decisions-provider.ts";

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
	assert.deepEqual(toPiAnswer({ type: "score", instructions: "", criteria: ["none", "high"] }, {
		type: "score",
		name: "risk",
		score: 1.4,
		confidence: 0.8,
		probabilities: [
			{ value: 0, label: "none", probability: 0.2 },
			{ value: 1, label: "high", probability: 0.8 },
		],
	}), { type: "score", score: 1.4, confidence: 0.8 });
});

test("score answers without confidence use the winning level's probability", () => {
	assert.deepEqual(toPiAnswer({ type: "score", instructions: "", criteria: ["none", "high"] }, {
		type: "score",
		score: 1.2,
		probabilities: [
			{ value: 0, label: "none", probability: 0.2 },
			{ value: 1, label: "high", probability: 0.6 },
			{ value: 2, label: "certain", probability: 0.2 },
		],
	}), { type: "score", score: 1.2, confidence: 0.6 });
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
