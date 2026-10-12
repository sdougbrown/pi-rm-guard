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
 * Usage: node stub-servers.mjs <stateDir> [--selftest]
 * Emits {"chatPort":N,"decisionsPort":N,"pid":N} on stdout and writes ports.json.
 * Run in the foreground; the caller records the PID and kills it on cleanup.
 * With --selftest the process drives both endpoints in-process and exits
 * 0/1 instead of staying up (self-contained harness check; writes its own
 * directive.json and decision.json into <stateDir>).
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
		const DECISION_FILE = `${stateDir}/decision.json`;
		let decision;
		try {
			decision = JSON.parse(readFileSync(DECISION_FILE, "utf8"));
		} catch (err) {
			if (err.code === "ENOENT") {
				// Absent file: fall back to the default verdict (approve), as before.
				decision = { action: "A", probabilities: { A: 0.95, B: 0.03, C: 0.02 } };
			} else {
				// Present but unparseable: fail closed — 500 makes the guard record a
				// model error and defer. A typo'd verdict must not silently approve.
				const msg = `stub-servers: ${DECISION_FILE} is present but unparseable (${err.message}) — responding 500 so the guard defers`;
				console.error(msg);
				try {
					writeFileSync(`${stateDir}/decision-error.txt`, `${msg}\n${err.stack ?? ""}\n`);
				} catch {}
				res.statusCode = 500;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ error: "decision.json unparseable" }));
				return;
			}
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ answers: { action: { choice: decision.action, probabilities: decision.probabilities } } }));
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

if (process.argv[3] === "--selftest") {
	const fail = (msg) => {
		console.error(`selftest: FAIL — ${msg}`);
		process.exit(1);
	};
	try {
		const directive = { command: "rm -rf /tmp/rmguard-selftest-victim" };
		const decision = { action: "A", probabilities: { A: 0.95, B: 0.03, C: 0.02 } };
		writeFileSync(`${stateDir}/directive.json`, JSON.stringify(directive));
		writeFileSync(`${stateDir}/decision.json`, JSON.stringify(decision));

		// Chat endpoint: minimal chat-completions request (stream true) must yield
		// an SSE stream with a bash tool call carrying the directive command.
		const chatRes = await fetch(`http://127.0.0.1:${chatPort}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "stub", stream: true, messages: [{ role: "user", content: "delete the build artifacts" }] }),
		});
		if (!chatRes.ok) fail(`chat endpoint returned HTTP ${chatRes.status}`);
		const sse = await chatRes.text();
		let command;
		for (const frame of sse.split("\n\n")) {
			if (!frame.startsWith("data: ") || frame.includes("[DONE]")) continue;
			const chunk = JSON.parse(frame.slice(6));
			const args = chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
			if (args) command = JSON.parse(args).command;
		}
		if (!command) fail("no bash tool call with arguments in the SSE stream");
		if (command !== directive.command) fail(`tool call command ${JSON.stringify(command)} != directive ${JSON.stringify(directive.command)}`);

		// Decisions endpoint: response must be {answers:{action:{choice,probabilities}}}
		// echoing the known decision.json.
		const decRes = await fetch(`http://127.0.0.1:${decPort}/v1/decisions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: directive.command, intent: "selftest" }),
		});
		if (!decRes.ok) fail(`decisions endpoint returned HTTP ${decRes.status}`);
		const answer = (await decRes.json())?.answers?.action;
		if (!answer || answer.choice !== decision.action || JSON.stringify(answer.probabilities) !== JSON.stringify(decision.probabilities))
			fail(`decisions response does not echo decision.json: ${JSON.stringify(answer)}`);

		console.log("selftest: OK");
		process.exit(0);
	} catch (err) {
		fail(err?.message ?? String(err));
	}
}

setInterval(() => {}, 1 << 30);
