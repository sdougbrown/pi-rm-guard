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
mkdirSync(path.join(proj, "sub"), { recursive: true });
mkdirSync(path.join(tmpdir(), `rmguard-tmp-${process.pid}/build-123`), { recursive: true });
const homeOutside = path.join(process.env.HOME ?? "/tmp", `.rmguard-test-${process.pid}/.ssh`);
mkdirSync(homeOutside, { recursive: true });
writeFileSync(path.join(homeOutside, "id_ed25519"), "key");
symlinkSync(homeOutside, path.join(proj, "leak"));
symlinkSync(path.dirname(homeOutside), path.join(proj, "to-home")); // -> $HOME/.rmguard-test-<pid>
symlinkSync("/", path.join(proj, "to-root"));
symlinkSync(path.join(proj, "to-home"), path.join(proj, "to-home-2")); // symlink -> symlink

const eligible = (cmd: string) => analyzeCommand(cmd, proj);
const defer = (cmd: string) => {
	const r = analyzeCommand(cmd, proj);
	assert.equal(r.kind, "defer", `expected defer: ${cmd} -> ${JSON.stringify(r)}`);
};
const deny = (cmd: string) => {
	const r = analyzeCommand(cmd, proj);
	assert.equal(r.kind, "deny", `expected deny: ${cmd} -> ${JSON.stringify(r)}`);
};
const absent = (cmd: string) => {
	const r = analyzeCommand(cmd, proj);
	assert.equal(r.kind, "absent", `expected absent: ${cmd} -> ${JSON.stringify(r)}`);
};

test("recursive rm with literal targets under cwd is eligible", () => {
	assert.deepEqual(eligible("rm -rf node_modules/.cache"), { kind: "eligible", targets: ["node_modules/.cache"] });
	assert.equal(eligible("rm -rf build dist").kind, "eligible");
	assert.equal(eligible("rm -fr dist").kind, "eligible");
	assert.equal(eligible("rm -Rf ./dist").kind, "eligible");
	assert.equal(eligible("/bin/rm -rf dist").kind, "eligible");
	assert.equal(eligible("rm --one-file-system -rf dist").kind, "eligible");
	assert.equal(eligible("rm -rf -- dist").kind, "eligible");
});

test("benign non-rm segments pass through with the judged rm", () => {
	assert.equal(eligible("rm -rf dist; echo done").kind, "eligible");
	assert.equal(eligible("echo hi && rm -rf dist").kind, "eligible");
});

test("recursive rm on a /tmp target is eligible", () => {
	assert.equal(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/build-123`).kind, "eligible");
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

test("literal assignments from the same command are substituted", () => {
	assert.equal(eligible("WT=/tmp/x; rm -rf $WT").kind, "eligible");
	assert.equal(eligible("WT=./dist; rm -rf $WT").kind, "eligible");
	assert.equal(eligible("export WT=./dist; rm -rf ${WT}").kind, "eligible");
});

test("assignment values that cannot be resolved keep the target unresolvable", () => {
	defer("WT=$(ls -d /tmp/wt-verify.* | tail -1); rm -rf $WT");
	defer("WT=$(ls -d /tmp/wt-verify.* | tail -1)\nrm -rf $WT");
	defer('WT=$(ls -d /tmp/x | tail -1); rm -rf "$WT"');
	defer("rm -rf ${WT}");
});

test("last assignment wins and stays scope-checked", () => {
	deny("WT=/tmp/a; WT=/etc; rm -rf $WT");
	deny("WT=/etc; rm -rf $WT");
});

test("quoted rm mentions in non-rm commands pass through untouched", () => {
	absent('grep -rn "rm -rf" src/');
	absent('echo "run rm -rf to clean up"');
	absent('echo "rm -rf"');
	absent('git log --grep="rm -rf"');
	absent("echo 'run rm -rf now'");
});

test("unquoted bare rm tokens in non-rm segments defer", () => {
	defer("echo rm -rf");
	defer("grep rm -rf src/");
});

test("rm inside a command substitution defers", () => {
	defer("echo $(rm -rf $HOME)");
	defer("echo `rm -rf ~`");
	defer("WT=$(ls -d /tmp/wt-verify.* | tail -1); rm -rf $WT");
});

test("non-rm commands are absent from the gate entirely", () => {
	absent("ls -la /tmp | head");
	absent("test -e x && echo gone");
	absent("rm notes.txt"); // plain rm is pi's normal flow, not this gate
});

test("rm not in leading position defers", () => {
	defer("sudo rm -rf dist");
	defer("FOO=bar rm -rf dist");
	defer("find . | xargs rm -rf");
});

test("mixed recursive and non-recursive rm defers", () => {
	defer("rm -rf dist && rm notes.txt");
});

test("redirections and mixed-gate constructs defer", () => {
	defer("rm -rf dist > /dev/null");
	defer("cd build && rm -rf .");
});

test("system roots, /, and $HOME auto-deny", () => {
	deny("rm -rf /");
	deny("rm -rf ~");
	deny("rm -rf $HOME");
	deny("rm -rf /etc");
	deny("rm -rf /tmp");
	deny("rm -rf ..");
	deny("rm -rf /tmp/..");
});

test("targets outside cwd and /tmp defer, including via symlink", () => {
	defer("rm -rf ~/.ssh");
	defer("rm -rf leak");
	defer("rm -rf /rmguard-outside");
});

test("sneaky symlink escapes defer", () => {
	defer("rm -rf to-home"); // link -> outside
	defer("rm -rf to-home/"); // trailing slash through the link
	defer("rm -rf to-home-2"); // link -> link -> outside
	defer("rm -rf ./to-home/../anything"); // POSIX resolves .. against the link target
	deny("rm -rf to-root/../etc"); // .. on / stays /, then /etc
	deny("rm -rf sub/../.."); // two physical levels up from a subdir lands at /tmp itself
});

test("whole-project deletion defers even though it is in scope", () => {
	defer("rm -rf .");
});

test("non-recursive rm alone is absent from the gate", () => {
	absent("rm notes.txt");
});

test("realpath resolves new leaves through their existing ancestor", () => {
	const newLeaf = path.join(proj, "will-be-created/dist");
	assert.equal(resolveReal(newLeaf, proj), path.join(resolveReal(proj, proj), "will-be-created/dist"));
});

test("deleting /tmp itself or an ancestor denies", () => {
	deny("rm -rf ../..");
});

test("cleanup", () => {
	rmSync(proj, { recursive: true, force: true });
	rmSync(path.join(tmpdir(), `rmguard-tmp-${process.pid}`), { recursive: true, force: true });
	rmSync(path.join(process.env.HOME ?? "/tmp", `.rmguard-test-${process.pid}`), { recursive: true, force: true });
});

test("heredoc bodies are data, not commands", () => {
	// rm mention inside a heredoc body never executes as shell
	absent('git commit -m msg <<\'EOF\'\nrm -rf /\nEOF');
	absent('git commit -F - <<EOF\nrm -rf /etc\nEOF');
	absent('cat <<\'EOF\'\nrm -rf x\nEOF\necho done');
	// a real rm beside a heredoc is still judged
	assert.deepEqual(eligible("rm -rf dist <<'EOF'\nanything rm -rf here\nEOF"), {
		kind: "eligible",
		targets: ["dist"],
	});
	assert.deepEqual(eligible("rm -rf node_modules/.cache <<'EOF'\nbody\nEOF"), {
		kind: "eligible",
		targets: ["node_modules/.cache"],
	});
	deny("rm -rf / <<'EOF'\nbody\nEOF");
	defer("rm -rf $CACHE_DIR <<'EOF'\nbody\nEOF");
	// multiple heredocs, each body data
	absent('cat <<A\nrm -rf x\nA\ncat <<\'B\'\nrm -rf /\nB');
	// <<- strips leading tabs before matching the delimiter
	absent('cat <<-EOF\n\trm -rf x\n\tEOF');
	// the delimiter must be a whole line: "xEOF" does not close
	absent('cat <<EOF\nrm -rf x xEOF\nEOF');
});

test("unterminated heredoc defers", () => {
	defer("git commit -m msg <<EOF\nrm -rf /");
	defer("cat <<'EOF'\nrm -rf x");
});

test("heredoc inside a double-quoted command substitution is data", () => {
	// the exact shape that blocked a git commit in practice
	absent('git add file && git commit -m "$(cat <<\'EOF\'\nmessage mentioning rm -rf /\nhere\nEOF\n)" && git push');
	absent('git commit -m "$(cat <<\'EOF\'\ndeny("rm -rf /*")\nEOF\n)"');
	assert.deepEqual(eligible('rm -rf dist <<\'EOF\'\nbody\nEOF'), { kind: "eligible", targets: ["dist"] });
});
