import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { createDecisionsBackend } from "../src/backends.ts";
import { registerDecisionsProvider } from "../src/decisions-provider.ts";

test("both endpoint routes authenticate to the same protected service", async (t) => {
	const token = "fixture-token";
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			if (request.headers.authorization !== `Bearer ${token}`) {
				response.writeHead(401).end();
				return;
			}
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ answers: { action: { choice: "A", probabilities: { A: 0.99, B: 0.005, C: 0.005 } } } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	type Classify = (model: { id: string }, context: { state: unknown; questions: unknown }) => Promise<{ answers: Record<string, unknown> }>;
	for (const apiKey of [undefined, "wrong-token", token]) {
		const direct = createDecisionsBackend({ url: `${baseUrl}/decisions`, model: "m", timeoutMs: 1000, apiKey });
		const result = await direct.decide({ command: "rm cache", cwd: "/repo", userRequests: [], evidence: [] });
		assert.equal("action" in result ? result.action : "error", apiKey === token ? "approve" : "error");
		let classify: Classify | undefined;
		const pi = { registerProvider(_name: string, config: { classifiers: Record<string, { classify: Classify }> }) {
			classify = config.classifiers["decisions-v1"].classify;
		} };
		registerDecisionsProvider(pi as never, { baseUrl, models: ["m"], apiKey });
		assert.ok(classify);
		const pending = classify({ id: "m" }, { state: {}, questions: { action: { type: "choice", instructions: "Which?", criteria: { approve: "safe", ask: "unclear", deny: "destructive" } } } });
		if (apiKey === token) {
			const answer = (await pending).answers.action;
			assert.ok(answer && typeof answer === "object" && "choice" in answer);
			assert.equal(answer.choice, "approve");
		} else await assert.rejects(pending);
	}
});
