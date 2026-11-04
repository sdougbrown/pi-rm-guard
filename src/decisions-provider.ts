import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers OpenAI's Decisions API (`POST /v1/decisions`, `client.decisions.create`)
 * as a pi classifier provider, so `findOfType("classifier", "decisions", <model>)`
 * works anywhere in pi (rm-guard, codemode scripts, other extensions). Callers can
 * supply an endpoint token or leave it unauthenticated.
 *
 * The wire is OpenAI's: text input, `predicate`/`choice`/`score` questions with
 * valued choices and labeled levels, and answers listed in question order.
 */

export interface DecisionsProviderOptions {
	/** Base URL up to /v1, e.g. http://grace:4000/v1 */
	baseUrl: string;
	models: string[];
	/** Optional Bearer token for this endpoint. */
	apiKey?: string;
	timeoutMs?: number;
}

export type WireChoiceValue = string | boolean;

interface WireQuestionBase {
	name: string;
	instructions: string;
}

export interface WirePredicateQuestion extends WireQuestionBase {
	type: "predicate";
}

export interface WireChoiceQuestion extends WireQuestionBase {
	type: "choice";
	choices: { value: WireChoiceValue; description?: string }[];
}

export interface WireScoreQuestion extends WireQuestionBase {
	type: "score";
	levels: { label: string; description?: string }[];
}

export type WireQuestion = WirePredicateQuestion | WireChoiceQuestion | WireScoreQuestion;

/** One answer, in question order. The per-type fields are checked where they are read. */
export interface WireAnswer {
	type?: string;
	/** The question's name, echoed back; absent answers are matched by position. */
	name?: string | null;
	/** Probability of true, on a predicate answer. */
	probability?: number;
	/** The chosen value, on a choice answer. */
	choice?: WireChoiceValue;
	/** The distribution over values or levels, on a choice or score answer. */
	probabilities?: { value: WireChoiceValue | number; label?: string; probability: number }[];
	/** The winning label's share of the full-vocabulary distribution. */
	confidence?: number;
	/** Probability-weighted mean level index, on a score answer. */
	score?: number;
}

/**
 * The Decisions API takes text, so structured state travels as JSON text. A
 * string or a message list passes through untouched.
 */
export function wireInput(input: unknown): unknown {
	return typeof input === "string" || Array.isArray(input) ? input : JSON.stringify(input);
}

export async function requestDecisions(options: {
	url: string;
	model: string;
	input: unknown;
	questions: WireQuestion[];
	timeoutMs: number;
	apiKey?: string;
	fetch?: typeof fetch;
}): Promise<{ answers?: WireAnswer[] }> {
	const response = await (options.fetch ?? globalThis.fetch)(options.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
		},
		body: JSON.stringify({ model: options.model, input: wireInput(options.input), questions: options.questions }),
		signal: AbortSignal.timeout(options.timeoutMs),
	});
	if (!response.ok) {
		// A 4xx refuses the request itself, so no other question would fare
		// better; a 5xx may be transient.
		if (response.status < 500) throw new ProtocolError(`HTTP ${response.status}`);
		throw new Error(`decisions API ${response.status}`);
	}
	return await response.json() as { answers?: WireAnswer[] };
}

type PiChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
type PiScoreAnswer = { type: "score"; score: number; confidence: number };
type PiBoolAnswer = { type: "bool"; probability: number };

export type PiAnswer = PiChoiceAnswer | PiScoreAnswer | PiBoolAnswer;
// A choice answer's confidence is the endpoint's when it reports one, and the
// chosen label's share of the distribution when it does not; the two are not
// distinguishable downstream.

/**
 * The marker every ProtocolError message begins with. The registered provider's
 * classify runs behind pi's model registry, which flattens a thrown error into
 * an error result that keeps only the message text, so the classifier route
 * re-derives the type from this prefix.
 */
export const PROTOCOL_MARK = "decisions API";

/**
 * A response that violates the Decisions contract: a malformed answer, or a
 * request the endpoint refused. Retrying with a different question cannot fix
 * it, so callers must escalate instead of falling back.
 */
export class ProtocolError extends Error {
	constructor(message: string) {
		super(`${PROTOCOL_MARK}: ${message}`);
	}
}

/**
 * Every number handed to a caller is a real probability: a string or an
 * out-of-range value would coerce into a verdict downstream.
 */
function reported(what: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new ProtocolError(`reported ${what} as ${JSON.stringify(value)}`);
	}
	return value;
}

type PiChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
type PiScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
type PiBoolQuestion = { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export type PiQuestion = PiChoiceQuestion | PiScoreQuestion | PiBoolQuestion;

/**
 * Bind the answers to the questions asked. The API answers in question order and
 * echoes each question's name; an answer that names nothing is bound by
 * position. A foreign name or a repeated name is an error, not another
 * question's verdict.
 */
export function matchAnswers(questions: WireQuestion[], answers: WireAnswer[]): Map<string, WireAnswer> {
	const asked = new Set(questions.map((q) => q.name));
	const byName = new Map<string, WireAnswer>();
	for (const answer of answers) {
		if (answer.name != null && typeof answer.name !== "string") {
			throw new ProtocolError(`answered with a non-string name: ${JSON.stringify(answer.name)}`);
		}
		if (typeof answer.name !== "string") continue;
		if (!asked.has(answer.name)) throw new ProtocolError(`answered the unasked question ${JSON.stringify(answer.name)}`);
		if (byName.has(answer.name)) throw new ProtocolError(`answered ${JSON.stringify(answer.name)} twice`);
		byName.set(answer.name, answer);
	}
	const unnamed = answers.filter((answer) => answer.name == null);
	// One answer per question: extra unnamed answers would shift every later
	// positional binding onto the wrong question instead of being refused.
	const unmatched = questions.length - byName.size;
	if (unnamed.length > unmatched) {
		throw new ProtocolError(`returned ${unnamed.length} unnamed answers for ${unmatched} questions`);
	}
	const matched = new Map<string, WireAnswer>();
	let next = 0;
	for (const question of questions) {
		const named = byName.get(question.name);
		if (named) {
			matched.set(question.name, named);
			continue;
		}
		const positional = unnamed[next++];
		if (!positional) throw new ProtocolError(`no answer for ${question.name}`);
		matched.set(question.name, positional);
	}
	return matched;
}

/** pi question -> Decisions API question. */
export function toWireQuestion(id: string, q: PiQuestion): WireQuestion {
	if (q.type === "bool") {
		// A predicate question carries no per-side descriptions, so the criteria
		// travel in the instructions, where the model reads them as one question.
		const parts = [q.criteria.true ? `Yes means: ${q.criteria.true}` : "", q.criteria.false ? `No means: ${q.criteria.false}` : ""].filter(Boolean);
		return { type: "predicate", name: id, instructions: parts.length > 0 ? `${q.instructions}\n${parts.join("\n")}` : q.instructions };
	}
	if (q.type === "choice") {
		return {
			type: "choice",
			name: id,
			instructions: q.instructions,
			choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })),
		};
	}
	return { type: "score", name: id, instructions: q.instructions, levels: q.criteria.map((label) => ({ label })) };
}

/** A choice answer's value is the criteria name it was offered under. */
export function resolveChoice<Criteria extends Record<string, string>>(
	q: { type: "choice"; instructions: string; criteria: Criteria },
	choice: WireChoiceValue,
): (keyof Criteria & string) | undefined {
	const names = Object.keys(q.criteria);
	const matched = names.find((name) => name === choice);
	return matched as (keyof Criteria & string) | undefined;
}

/**
 * Decisions API answer -> pi classifier answer. This is the one place a wire
 * answer is read: a repeated value, a choice the question never offered and a
 * chosen label with no reported probability are errors here, so every caller
 * refuses the same malformed answer instead of each deciding for itself.
 */
export function toPiAnswer(q: PiChoiceQuestion, a: WireAnswer): PiChoiceAnswer;
export function toPiAnswer(q: PiScoreQuestion, a: WireAnswer): PiScoreAnswer;
export function toPiAnswer(q: PiBoolQuestion, a: WireAnswer): PiBoolAnswer;
export function toPiAnswer(q: PiQuestion, a: WireAnswer): PiAnswer;
export function toPiAnswer(q: PiQuestion, a: WireAnswer): PiAnswer {
	if (q.type === "bool") {
		return { type: "bool", probability: reported("the probability of true", a.probability) };
	}
	if (q.type === "choice") {
		const offered = new Set(Object.keys(q.criteria));
		const probabilities: Record<string, number> = {};
		for (const { value, probability } of a.probabilities ?? []) {
			if (typeof value !== "string" || !offered.has(value)) continue;
			if (value in probabilities) throw new ProtocolError(`reported ${value} twice`);
			probabilities[value] = reported(`the probability of ${value}`, probability);
		}
		if (a.choice === undefined || a.choice === null) throw new ProtocolError("missing choice");
		const choice = resolveChoice(q, a.choice);
		if (!choice) throw new ProtocolError("returned an unknown choice");
		// The label that authorizes an action has to be one the endpoint reported.
		if (probabilities[choice] === undefined) throw new ProtocolError(`reported no probability for ${choice}`);
		const confidence = typeof a.confidence === "number" ? reported("confidence", a.confidence) : probabilities[choice];
		return { type: "choice", choice, probabilities, confidence };
	}
	const distribution = a.probabilities ?? [];
	const confidence = typeof a.confidence === "number"
		? reported("confidence", a.confidence)
		: Math.max(...distribution.map((p) => reported(`the probability of level ${JSON.stringify(p.value)}`, p.probability)));
	// A score is the probability-weighted mean level index, so it spans the
	// levels rather than the [0,1] a probability is bound to.
	if (typeof a.score !== "number" || !Number.isFinite(a.score)) {
		throw new ProtocolError(`reported the score as ${JSON.stringify(a.score ?? null)}`);
	}
	if (a.score < 0 || a.score > q.criteria.length - 1) {
		throw new ProtocolError(`reported the score ${a.score} outside the ${q.criteria.length} levels`);
	}
	return { type: "score", score: a.score, confidence: Number.isFinite(confidence) ? confidence : 0 };
}

export function registerDecisionsProvider(pi: ExtensionAPI, options: DecisionsProviderOptions): void {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	pi.registerProvider("decisions", {
		// ProviderConfig requires an apiKey for defined models (no oauth here);
		// the empty literal declares an unauthenticated endpoint.
		apiKey: options.apiKey ?? "",
		models: options.models.map((id) => ({
			type: "classifier" as const,
			id,
			name: `Decisions ${id}`,
			api: "decisions-v2",
			baseUrl,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
		})),
		classifiers: {
			"decisions-v2": {
				classify: async (model, context) => {
					const asked = Object.entries(context.questions as Record<string, PiQuestion>);
					const questions = asked.map(([id, q]) => toWireQuestion(id, q));
					const body = await requestDecisions({
						url: `${baseUrl}/decisions`, model: model.id, input: context.state,
						questions, timeoutMs: options.timeoutMs ?? 10_000, apiKey: options.apiKey,
					});
					const matched = matchAnswers(questions, body.answers ?? []);
					const answers: Record<string, PiAnswer> = {};
					for (const [id, q] of asked) answers[id] = toPiAnswer(q, matched.get(id)!);
					return { api: "decisions-v2", provider: "decisions", model: model.id, answers, stopReason: "stop" as const, timestamp: Date.now() };
				},
			},
		},
	});
}
