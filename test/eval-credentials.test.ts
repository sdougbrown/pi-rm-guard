import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("standalone Jev evaluation uses the runtime's custom key-file override", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "rm-guard-eval-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	writeFileSync(join(home, "custom.key"), "  fixture-jev-key\n");
	let authenticated = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			if (request.url === "/jev" && request.headers.authorization === "Bearer fixture-jev-key") authenticated++;
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "model unavailable" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const preload = join(home, "redirect.mjs");
	writeFileSync(preload, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
 const url = new URL(String(input));
 if (url.hostname === "api.typesafe.ai") return nativeFetch(${JSON.stringify(`${base}/jev`)}, init);
 if (url.hostname !== "127.0.0.1") throw new Error("unexpected external request");
 return nativeFetch(input, init);
};
`);
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RM_GUARD_JEV_KEY_FILE: "~/custom.key", RM_GUARD_URL: `${base}/v1/decisions`, RM_GUARD_API_KEY: "" };
	delete env.TYPESAFE_API_KEY;
	const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../scripts/eval-live.ts", import.meta.url))], { env });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	assert.equal(code, 1);
	assert.ok(authenticated > 0, "the configured file credential must reach the Jev endpoint");
	assert.doesNotMatch(output, /jev:.*skipping/);
});
