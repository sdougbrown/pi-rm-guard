import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toWireQuestion, toPiAnswer } from "../src/decisions-provider.ts";

test("bool questions map to yes_no with criteria in the text", () => {
	const wire = toWireQuestion("safe", {
		type: "bool",
		instructions: "Did the user ask?",
		criteria: { true: "Yes they did", false: "No they did not" },
	});
	assert.deepEqual(wire, {
		id: "safe",
		type: "yes_no",
		question: "Did the user ask?\nYes means: Yes they did\nNo means: No they did not",
	});
});

test("choice questions map options in criteria order", () => {
	const wire = toWireQuestion("cat", { type: "choice", instructions: "Which?", criteria: { build: "b", system: "s" } });
	assert.equal(wire.type, "choice");
	assert.deepEqual(wire.options, [{ name: "build" }, { name: "system" }]);
});

test("score questions map levels", () => {
	const wire = toWireQuestion("risk", { type: "score", instructions: "How bad?", criteria: ["none", "high"] });
	assert.deepEqual(wire.levels, ["none", "high"]);
});

test("yes_no answers map back to bool probability", () => {
	const answer = toPiAnswer({ type: "bool", instructions: "", criteria: { true: "", false: "" } }, {
		type: "yes_no",
		probabilities: { yes: 0.93, no: 0.07 },
	});
	assert.deepEqual(answer, { type: "bool", probability: 0.93 });
});

test("letter choices identify the selected label and its confidence", () => {
	assert.deepEqual(toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice", probabilities: { A: 0.1, B: 0.9 }, choice: "B",
	}), { type: "choice", choice: "system", probabilities: { build: 0.1, system: 0.9 }, confidence: 0.9 });
});

test("missing choices are not fabricated from the first option", () => {
	assert.throws(() => toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice", probabilities: { A: 0.1, B: 0.9 },
	}), /missing choice/);
});

test("letter-keyed choice probabilities map back to names", () => {
	const answer = toPiAnswer({ type: "choice", instructions: "", criteria: { build: "b", system: "s" } }, {
		type: "choice",
		probabilities: { A: 0.9, B: 0.1 },
		choice: "build",
	});
	assert.deepEqual(answer, { type: "choice", choice: "build", probabilities: { build: 0.9, system: 0.1 }, confidence: 0.9 });
});
