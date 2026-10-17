import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("live evaluation reports unavailable judgments as failures, never successful rejections", async (t) => {
	const server = createServer((_request, response) => {
		response.writeHead(500);
		response.end("model unavailable");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval-live.ts", import.meta.url))], {
		env: { ...process.env, TYPESAFE_API_KEY: "", RM_GUARD_URL: `http://127.0.0.1:${address.port}/v1/decisions` },
	});
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	assert.equal(code, 1);
	assert.match(output, /FAIL decisions error.*decision API 500/);
	assert.doesNotMatch(output, /\bok\s+decisions error/);
});
