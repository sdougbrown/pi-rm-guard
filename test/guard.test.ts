import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeCommand, resolveReal } from "../src/guard.ts";

// Fixture: a project dir, a /tmp target, and a symlink inside the project
// pointing outside (to $HOME) — the classic symlink escape.
const proj = path.join(tmpdir(), `rmguard-test-${process.pid}`);
mkdirSync(path.join(proj, "node_modules/.cache"), { recursive: true });
mkdirSync(path.join(tmpdir(), `rmguard-tmp-${process.pid}/build-123`), { recursive: true });
const homeOutside = path.join(process.env.HOME ?? "/tmp", `.rmguard-test-${process.pid}/.ssh`);
mkdirSync(homeOutside, { recursive: true });
writeFileSync(path.join(homeOutside, "id_ed25519"), "key");
symlinkSync(homeOutside, path.join(proj, "leak"));

const eligible = (cmd: string) => analyzeCommand(cmd, proj);
const defer = (cmd: string) => {
	const r = analyzeCommand(cmd, proj);
	assert.equal(r.eligible, false, `expected defer: ${cmd} -> ${JSON.stringify(r)}`);
};

test("recursive rm with literal targets under cwd is eligible", () => {
	assert.deepEqual(eligible("rm -rf node_modules/.cache"), { eligible: true, targets: ["node_modules/.cache"] });
	assert.equal(eligible("rm -rf build dist").eligible, true);
	assert.equal(eligible("rm -fr dist").eligible, true);
	assert.equal(eligible("rm -Rf ./dist").eligible, true);
	assert.equal(eligible("/bin/rm -rf dist").eligible, true);
	assert.equal(eligible("rm --one-file-system -rf dist").eligible, true);
	assert.equal(eligible("rm -rf -- dist").eligible, true);
});

test("recursive rm on a /tmp target is eligible", () => {
	assert.equal(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/build-123`).eligible, true);
});

test("variable indirection, globs, quotes and substitution defer", () => {
	defer("rm -rf $CACHE_DIR");
	defer("rm -rf ${BUILD_DIR}/dist");
	defer("rm -rf $(dirname dist)/x");
	defer("rm -rf `echo dist`");
	defer("rm -rf *");
	defer("rm -rf dist/*");
	defer('rm -rf "my dir"');
});

test("non-rm segments defer the whole command", () => {
	defer("rm -rf dist; echo done");
	defer("echo hi && rm -rf dist");
	defer("sudo rm -rf dist");
	defer("rm -rf dist && rm notes.txt");
	defer("rm -rf dist > /dev/null");
	defer("cd build && rm -rf .");
});

test("targets outside cwd and /tmp defer, including via symlink", () => {
	defer("rm -rf /etc");
	defer("rm -rf ~");
	defer("rm -rf ~/.ssh");
	defer("rm -rf /");
	defer("rm -rf /tmp");
	defer("rm -rf leak");
	defer("rm -rf ..");
	defer("rm -rf /rmguard-outside");
});

test("whole-project deletion defers even though it is in scope", () => {
	defer("rm -rf .");
});

test("non-recursive rm is not eligible", () => {
	assert.equal(eligible("rm notes.txt").eligible, false);
});

test("realpath resolves new leaves through their existing ancestor", () => {
	const newLeaf = path.join(proj, "will-be-created/dist");
	assert.equal(resolveReal(newLeaf, proj), path.join(resolveReal(proj, proj), "will-be-created/dist"));
});

test("deleting /tmp itself or an ancestor defers", () => {
	defer("rm -rf ../..");
	defer("rm -rf /tmp/..");
});

test("cleanup", () => {
	rmSync(proj, { recursive: true, force: true });
	rmSync(path.join(tmpdir(), `rmguard-tmp-${process.pid}`), { recursive: true, force: true });
	rmSync(path.join(process.env.HOME ?? "/tmp", `.rmguard-test-${process.pid}`), { recursive: true, force: true });
});
