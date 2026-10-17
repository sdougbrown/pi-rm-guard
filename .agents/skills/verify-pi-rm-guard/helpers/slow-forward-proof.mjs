#!/usr/bin/env node
// A delayed fixture verdict proves deadline propagation, not model judgment.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = createServer((request, response) => {
	request.resume();
	request.on("end", () => {
		setTimeout(() => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ answers: { action: { choice: "A", probabilities: { A: 0.95, B: 0.03, C: 0.02 } } } }));
		}, 16_000);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn(fileURLToPath(new URL("./run-case.sh", import.meta.url)), [
	"approve-var", 'CACHE="@VICTIM@"; rm -rf "$CACHE"', "{}",
], {
	stdio: "inherit",
	timeout: 60_000,
	env: {
		...process.env,
		RM_GUARD_VERIFY_BACKEND: "classifier",
		RM_GUARD_VERIFY_TIMEOUT_MS: "20000",
		RM_GUARD_VERIFY_LIVE_URL: `http://127.0.0.1:${server.address().port}/v1/decisions`,
	},
});
try {
	process.exitCode = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
} finally {
	child.kill();
	server.closeAllConnections();
	server.close();
}
