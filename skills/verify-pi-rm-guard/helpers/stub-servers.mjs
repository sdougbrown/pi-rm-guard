#!/usr/bin/env node
/**
 * Stub engines for driving pi + rm-guard end to end without network or real models.
 *
 * Two servers on ephemeral localhost ports:
 *  - an OpenAI chat-completions SSE endpoint that issues exactly one `bash`
 *    tool call (command taken from <stateDir>/directive.json), then replies
 *    "done" once the tool result arrives — a deterministic stand-in for the
 *    coding model;
 *  - a /v1/decisions endpoint answering the guard's action question from
 *    <stateDir>/decision.json — a deterministic stand-in for the decision model.
 *
 * Both request streams are appended to <stateDir>/chat-requests.jsonl and
 * <stateDir>/decisions-requests.jsonl as evidence.
 *
 * Usage: node stub-servers.mjs <stateDir>
 * Emits {"chatPort":N,"decisionsPort":N,"pid":N} on stdout and writes ports.json.
 * Run in the foreground; the caller records the PID and kills it on cleanup.
 */
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const stateDir = process.argv[2];
if (!stateDir) {
	console.error("usage: node stub-servers.mjs <stateDir>");
	process.exit(1);
}
mkdirSync(stateDir, { recursive: true });

const readJSON = (file, fallback) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
};

const sseChunk = (delta, finish) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub",
		choices: [{ index: 0, delta, finish_reason: finish }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	})}\n\n`;

const chat = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		appendFileSync(`${stateDir}/chat-requests.jsonl`, body + "\n");
		const parsed = JSON.parse(body);
		const sawToolResult = parsed.messages?.some((m) => m.role === "tool");
		res.setHeader("content-type", "text/event-stream");
		if (sawToolResult) {
			res.write(sseChunk({ role: "assistant", content: "done" }));
			res.write(sseChunk({}, "stop"));
		} else {
			const directive = readJSON(`${stateDir}/directive.json`, {});
			res.write(sseChunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }));
			res.write(sseChunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: directive.command }) } }] }));
			res.write(sseChunk({}, "tool_calls"));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const decisions = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		appendFileSync(`${stateDir}/decisions-requests.jsonl`, body + "\n");
		const d = readJSON(`${stateDir}/decision.json`, { action: "A", probabilities: { A: 0.95, B: 0.03, C: 0.02 } });
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ answers: { action: { choice: d.action, probabilities: d.probabilities } } }));
	});
});

const listen = (srv) => new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
const chatPort = await listen(chat);
const decPort = await listen(decisions);
writeFileSync(`${stateDir}/ports.json`, JSON.stringify({ chatPort, decPort, pid: process.pid }));
console.log(JSON.stringify({ chatPort, decPort, pid: process.pid }));

const shutdown = () => {
	chat.close();
	decisions.close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1 << 30);
