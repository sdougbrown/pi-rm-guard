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
mkdirSync(path.join("/tmp", `rmguard-tmp-${process.pid}/build-123`), { recursive: true });
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

test("bounded globs expand in the gate and are eligible with expanded targets", () => {
	const tmpDir = path.join("/tmp", `rmguard-tmp-${process.pid}`);
	writeFileSync(path.join(tmpDir, "avenor-verify.123"), "x");
	writeFileSync(path.join(tmpDir, "avenor-verify.abc"), "x");
	mkdirSync(path.join(tmpDir, "avenor-verify.dir"));
	const verdict = eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/avenor-verify.*`);
	// readdirSync order is filesystem-dependent; compare as sets
	assert.deepEqual([...verdict.targets].sort(), [
		`/tmp/rmguard-tmp-${process.pid}/avenor-verify.123`,
		`/tmp/rmguard-tmp-${process.pid}/avenor-verify.abc`,
		`/tmp/rmguard-tmp-${process.pid}/avenor-verify.dir`,
	].sort());
	// question-mark glob, single component
	writeFileSync(path.join(tmpDir, "leaf1.log"), "x");
	assert.deepEqual(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/leaf?.log`), {
		kind: "eligible",
		targets: [`/tmp/rmguard-tmp-${process.pid}/leaf1.log`],
	});
});

test("dot-anchored glob matches dotfiles; a non-dot pattern skips them (bash semantics)", () => {
	const tmpDir = path.join("/tmp", `rmguard-tmp-${process.pid}`);
	const dotDir = path.join(tmpDir, "dotcheck");
	mkdirSync(dotDir, { recursive: true });
	writeFileSync(path.join(dotDir, ".cache-junk"), "x");
	writeFileSync(path.join(dotDir, "cache-junk"), "x");
	// dot-anchored pattern: the dotfile is part of the judged delete set
	assert.deepEqual(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/dotcheck/.cache-*`), {
		kind: "eligible",
		targets: [`/tmp/rmguard-tmp-${process.pid}/dotcheck/.cache-junk`],
	});
	// non-dot pattern: the dotfile must NOT appear in the judged targets
	// (bash would not pass it to rm either); the plain file is judged. A
	// leading-* pattern regex-matches the dotfile, so this case only passes
	// when the dotfile skip actually runs.
	assert.deepEqual(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/dotcheck/*cache*`), {
		kind: "eligible",
		targets: [`/tmp/rmguard-tmp-${process.pid}/dotcheck/cache-junk`],
	});
});

test("glob with no matches is eligible (rm will no-op with an error)", () => {
	const verdict = eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/no-such-thing-*.log`);
	assert.deepEqual(verdict, { kind: "eligible", targets: [] });
});

test("glob under a system root denies even with no matches", () => {
	deny("rm -rf /etc/foo-bar-verify*");
	deny("rm -rf /etc/*");
	deny("rm -rf /*");
});

test("glob matching a symlink that escapes scope denies via the per-match scope check", () => {
	const link = path.join("/tmp", `rmguard-tmp-${process.pid}`, "escape-link");
	rmSync(link, { force: true }); // tolerate a crashed prior run at the same pid
	symlinkSync("/etc", link);
	assert.equal(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/escape-link`).kind, "deny");
	// a glob whose expansion includes the escaping link is judged per match:
	// the in-scope matches stay eligible only if the escaping match also stays
	// in scope — here it denies, which is the safe direction.
	deny(`rm -rf /tmp/rmguard-tmp-${process.pid}/escape*`);
});

test("glob with a .. component after the glob defers", () => {
	defer(`rm -rf /tmp/rmguard-tmp-${process.pid}/escape*/..`);
	defer(`rm -rf /tmp/rmguard-tmp-${process.pid}/build-*/..`);
});

test("glob anchored at the home directory denies", () => {
	deny("rm -rf ~/*");
});

test("relative glob with a literal subdirectory prefix expands", () => {
	writeFileSync(path.join(proj, "sub", "build-stamp-a"), "x");
	writeFileSync(path.join(proj, "sub", "build-stamp-b"), "x");
	const verdict = eligible("rm -rf sub/build-stamp-*");
	assert.deepEqual([...verdict.targets].sort(), [
		`${proj}/sub/build-stamp-a`,
		`${proj}/sub/build-stamp-b`,
	].sort());
});

test("glob in the cwd expands relative to the session cwd", () => {
	writeFileSync(path.join(proj, "cache-part-a"), "x");
	writeFileSync(path.join(proj, "cache-part-b"), "x");
	const verdict = eligible("rm -rf cache-part-*");
	assert.deepEqual([...verdict.targets].sort(), [`${proj}/cache-part-a`, `${proj}/cache-part-b`].sort());
});

test("glob expansion cap: exactly 64 matches is eligible, 65 defers", () => {
	const dir = path.join("/tmp", `rmguard-cap-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	// unrelated over-cap fixture: still defers
	for (let i = 0; i < 70; i++) writeFileSync(path.join(dir, `many-${String(i).padStart(3, "0")}`), "x");
	defer(`rm -rf /tmp/rmguard-cap-${process.pid}/many-*`);
	// boundary: GLOB_MATCH_CAP (64) matches stay judgeable, one more defers
	for (let i = 0; i < 64; i++) writeFileSync(path.join(dir, `edge-${String(i).padStart(3, "0")}`), "x");
	const at = eligible(`rm -rf /tmp/rmguard-cap-${process.pid}/edge-*`);
	assert.equal(at.kind, "eligible");
	assert.deepEqual([...at.targets].sort(), Array.from({ length: 64 }, (_, i) => `/tmp/rmguard-cap-${process.pid}/edge-${String(i).padStart(3, "0")}`).sort());
	writeFileSync(path.join(dir, "edge-064"), "x");
	defer(`rm -rf /tmp/rmguard-cap-${process.pid}/edge-*`);
});

test("mixed literal and glob targets in one rm are each judged", () => {
	writeFileSync(path.join(proj, "cache-part-a"), "x");
	// a denied literal target denies the whole command, even with an eligible glob
	deny("rm -rf /etc cache-part-*");
	// an unresolvable target defers the whole command
	defer("rm -rf $CACHE_DIR cache-part-*");
	// when all targets judge, the expansion applies alongside literals
	writeFileSync(path.join(proj, "cache-part-b"), "x");
	const both = eligible("rm -rf node_modules/.cache cache-part-*");
	assert.deepEqual([...both.targets].sort(), [`node_modules/.cache`, `${proj}/cache-part-a`, `${proj}/cache-part-b`].sort());
});

test("a dot-only glob component defers (stricter than 'any literal character')", () => {
	// the check requires an alphanumeric/_/- character, so ".*" is unbounded
	defer(`rm -rf /tmp/rmguard-tmp-${process.pid}/.*`);
});

test("glob rm in a multi-segment command defers (prior segment could create a symlink the glob follows)", () => {
	defer("ln -s /etc /tmp/d/a.txt && rm -rf /tmp/d/a.txt/*");
	defer("mkdir -p /tmp/d && rm -rf /tmp/d/*");
	// single-segment glob rm is unaffected
	assert.equal(eligible("rm -rf /tmp/rmguard-tmp-" + process.pid + "/build-123").kind, "eligible");
});

test("out-of-scope literal prefix defers even with zero matches", () => {
	defer("rm -rf /home/other-user/project/build-*");
	defer("rm -rf /home/other-user/project/file-*");
});

test("literal component after a glob resolves to the targeted files", () => {
	mkdirSync(path.join(proj, "node_modules/cache-a"), { recursive: true });
	mkdirSync(path.join(proj, "node_modules/cache-b"), { recursive: true });
	writeFileSync(path.join(proj, "node_modules/cache-a/package.json"), "{}");
	// a join bug resolving to the matched directory instead of the file would
	// still be in scope — this pins the resolution to the file exactly
	assert.deepEqual(eligible("rm -rf node_modules/cach*/package.json"), {
		kind: "eligible",
		targets: [`${proj}/node_modules/cache-a/package.json`],
	});
});

test("benign non-rm segments pass through with the judged rm", () => {
	assert.equal(eligible("rm -rf dist; echo done").kind, "eligible");
	assert.equal(eligible("echo hi && rm -rf dist").kind, "eligible");
});

test("recursive rm on a /tmp target is eligible", () => {
	assert.equal(eligible(`rm -rf /tmp/rmguard-tmp-${process.pid}/build-123`).kind, "eligible");
});

test("variable indirection, quotes and substitution defer", () => {
	defer("rm -rf $CACHE_DIR");
	defer("rm -rf ${BUILD_DIR}/dist");
	defer("rm -rf $(dirname dist)/x");
	defer("rm -rf `echo dist`");
	defer('rm -rf "my dir"');
	defer("rm -rf 'dist*'"); // quoted globs do not expand in bash either
});

test("delete-everything glob shapes defer", () => {
	defer("rm -rf *");
	defer("rm -rf dist/*");
	defer("rm -rf ?");
	defer("rm -rf */tmp");
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
	rmSync(path.join("/tmp", `rmguard-tmp-${process.pid}`), { recursive: true, force: true });
	rmSync(path.join("/tmp", `rmguard-cap-${process.pid}`), { recursive: true, force: true });
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
});

test("<< inside arithmetic is a left shift, not a heredoc", () => {
	absent("echo $(( 1<<2 ))");
	absent("a=$((1<<2))");
	absent("((1<<2))");
	absent('echo "$((1<<2))"');
	absent("[[ 1<<2 == 4 ]] 2>/dev/null || true");
	absent("a=$[1<<2]");
	// the umpire's confirmed regression shape: a real rm after the arithmetic is still judged
	assert.deepEqual(eligible("echo $(( 1<<2 ))\nrm -rf /tmp/build-123"), {
		kind: "eligible",
		targets: ["/tmp/build-123"],
	});
	assert.deepEqual(eligible("x=$((1<<2)); rm -rf dist"), { kind: "eligible", targets: ["dist"] });
	assert.deepEqual(eligible("[[ 1<<2 -eq 4 ]] && rm -rf dist"), { kind: "eligible", targets: ["dist"] });
});

test("heredoc delimiter may be space-separated from <<", () => {
	absent("cat << EOF\nrm -rf x\nEOF");
});

test("delimiter dequoting: quotes and backslashes in the delimiter are not part of the terminator", () => {
	absent('cat <<E"OF"\nrm -rf x\nEOF');
	absent("cat <<E\\OF\nrm -rf x\nEOF");
});

test("case-context << is copied literally, never a phantom heredoc", () => {
	// the umpire's confirmed silent-bypass shape: gate must NOT return absent
	defer("case $x in\n*<<2*) true ;;\nesac\nrm -rf ~/.ssh");
		// a genuine heredoc inside a case body is not recognized either: its body
	// lines are judged as standalone commands (deny here) - never absent
	deny("case $x in\na) cat <<'EOF'\nrm -rf /\nEOF\n;;\nesac");
});

test("pending queue does not leak past the heredoc consumer", () => {
	assert.deepEqual(eligible('git commit -m "$(cat <<\'EOF\'\nEOF\n)" && rm -rf dist'), {
		kind: "eligible",
		targets: ["dist"],
	});
});

test("same-line multiple heredocs consume their bodies in order (FIFO)", () => {
	absent("cat <<A <<B\nfirstA\nA\nfirstB\nB");
});
