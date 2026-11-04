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
	if (!response.ok) throw new Error(`decisions API ${response.status}`);
	return await response.json() as { answers?: WireAnswer[] };
}

type PiQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

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
		if (typeof answer.name !== "string") continue;
		if (!asked.has(answer.name)) throw new Error(`decisions API answered the unasked question ${JSON.stringify(answer.name)}`);
		if (byName.has(answer.name)) throw new Error(`decisions API answered ${JSON.stringify(answer.name)} twice`);
		byName.set(answer.name, answer);
	}
	const unnamed = answers.filter((answer) => answer.name == null);
	const matched = new Map<string, WireAnswer>();
	let next = 0;
	for (const question of questions) {
		const named = byName.get(question.name);
		if (named) {
			matched.set(question.name, named);
			continue;
		}
		const positional = unnamed[next++];
		if (!positional) throw new Error(`decisions API missing answer for ${question.name}`);
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

/** Decisions API answer -> pi classifier answer. */
export function toPiAnswer(q: PiQuestion, a: WireAnswer) {
	if (q.type === "bool") {
		return { type: "bool" as const, probability: typeof a.probability === "number" ? a.probability : 0 };
	}
	if (q.type === "choice") {
		const names = Object.keys(q.criteria);
		const probabilities: Record<string, number> = {};
		for (const { value, probability } of a.probabilities ?? []) {
			if (typeof value === "string" && names.includes(value)) probabilities[value] = probability;
		}
		if (a.choice === undefined || a.choice === null) throw new Error("decisions API missing choice");
		const choice = resolveChoice(q, a.choice);
		if (!choice) throw new Error("decisions API returned an unknown choice");
		return { type: "choice" as const, choice, probabilities, confidence: typeof a.confidence === "number" ? a.confidence : (probabilities[choice] ?? 0) };
	}
	const probabilities = a.probabilities ?? [];
	const confidence = typeof a.confidence === "number" ? a.confidence : Math.max(...probabilities.map((p) => p.probability));
	return { type: "score" as const, score: a.score ?? 0, confidence: Number.isFinite(confidence) ? confidence : 0 };
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
					const body = await requestDecisions({
						url: `${baseUrl}/decisions`, model: model.id, input: context.state,
						questions: asked.map(([id, q]) => toWireQuestion(id, q)),
						timeoutMs: options.timeoutMs ?? 10_000, apiKey: options.apiKey,
					});
					// Answers echo the question's name; an endpoint that omits it is
					// read positionally, since the API answers in question order.
					const matched = matchAnswers(asked.map(([id, q]) => toWireQuestion(id, q)), body.answers ?? []);
					const answers: Record<string, ReturnType<typeof toPiAnswer>> = {};
					for (const [id, q] of asked) answers[id] = toPiAnswer(q, matched.get(id)!);
					return { api: "decisions-v2", provider: "decisions", model: model.id, answers, stopReason: "stop" as const, timestamp: Date.now() };
				},
			},
		},
	});
}
