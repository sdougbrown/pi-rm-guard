import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers the llama.cpp-router-style /v1/decisions API as a pi classifier
 * provider, so `findOfType("classifier", "decisions", <model>)` works anywhere
 * in pi (rm-guard, codemode scripts, other extensions) with keys resolved
 * through pi's own credential config.
 */

export interface DecisionsProviderOptions {
	/** Base URL up to /v1, e.g. http://grace:4000/v1 */
	baseUrl: string;
	models: string[];
	/** Resolved by pi from $ENV / !command interpolation before it reaches here. */
	apiKey?: string;
}

interface WireQuestion {
	id: string;
	question: string;
	type: "yes_no" | "choice" | "score";
	options?: { name: string }[];
	levels?: string[];
}

interface WireAnswer {
	type: string;
	probabilities?: Record<string, number>;
	choice?: string;
	score?: number;
}

type PiQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** pi question -> /v1/decisions wire question. */
export function toWireQuestion(id: string, q: PiQuestion): WireQuestion {
	const question = q.instructions;
	if (q.type === "bool") {
		const parts = [q.criteria.true ? `Yes means: ${q.criteria.true}` : "", q.criteria.false ? `No means: ${q.criteria.false}` : ""].filter(Boolean);
		return { id, type: "yes_no", question: parts.length > 0 ? `${question}\n${parts.join("\n")}` : question };
	}
	if (q.type === "choice") {
		return { id, type: "choice", question, options: Object.entries(q.criteria).map(([name, criterion]) => ({ name: `${name} — ${criterion}` })) };
	}
	return { id, type: "score", question, levels: q.criteria };
}

/** /v1/decisions answer -> pi classifier answer. */
export function toPiAnswer(q: PiQuestion, a: WireAnswer): Record<string, unknown> {
	if (q.type === "bool") {
		return { type: "bool", probability: a.probabilities?.yes ?? 0 };
	}
	if (q.type === "choice") {
		const names = Object.keys((q as { criteria: Record<string, string> }).criteria);
		const probabilities: Record<string, number> = {};
		for (const [index, name] of names.entries()) {
			probabilities[name] = a.probabilities?.[LETTERS[index]] ?? 0;
		}
		if (!a.choice) throw new Error("decisions API missing choice");
		const wireOptions = toWireQuestion("", q).options ?? [];
		const choice = names.includes(a.choice) ? a.choice : names[wireOptions.findIndex((option, index) => a.choice === LETTERS[index] || a.choice === option.name)];
		if (!choice) throw new Error("decisions API returned an unknown choice");
		return { type: "choice", choice, probabilities, confidence: probabilities[choice] };
	}
	return { type: "score", score: a.score ?? 0, confidence: a.probabilities ? Math.max(...Object.values(a.probabilities)) : 0 };
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
			api: "decisions-v1",
			baseUrl,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
		})),
		classifiers: {
			"decisions-v1": {
				classify: async (model, context) => {
					const questions: Record<string, WireQuestion> = {};
					const answers: Record<string, unknown> = {};
					for (const [id, q] of Object.entries(context.questions as Record<string, PiQuestion>)) {
						questions[id] = toWireQuestion(id, q);
					}
					const response = await fetch(`${baseUrl}/decisions`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
						},
						body: JSON.stringify({ model: model.id, input: context.state, questions: Object.values(questions) }),
						signal: AbortSignal.timeout(10_000),
					});
					if (!response.ok) throw new Error(`decisions API ${response.status}`);
					const body = (await response.json()) as { answers?: Record<string, WireAnswer> };
					for (const [id, q] of Object.entries(context.questions as Record<string, PiQuestion>)) {
						const wire = body.answers?.[id];
						if (!wire) throw new Error(`decisions API missing answer for ${id}`);
						answers[id] = toPiAnswer(q, wire);
					}
					return { provider: "decisions", model: model.id, answers, stopReason: "stop" as const };
				},
			},
		},
	});
}
