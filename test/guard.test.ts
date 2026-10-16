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

test("non-recursive rm is not this gate's business, even with unresolvable targets", () => {
	// the token loop used to defer on these before ever checking for -r
	absent("rm -f /tmp/probe.sh /tmp/heredoc-probe /tmp/repro*.ts");
	absent("rm dist/*.log");
	absent("rm ~/Code/x*.ts");
	absent("rm -f dist?build ./.cache[0-9]");
});

test("non-recursive rm still defers on executing or flag-shaped targets", () => {
	defer("rm $X"); // a variable can expand to flags: rm "-r ~"
	defer("rm -f $(rm -rf ~)"); // the substitution executes
	defer("rm *"); // unanchored glob can match a file literally named -rf
	defer("rm *.log");
	defer("rm [a-z]*");
	defer('rm "-rf x"'); // quoted target whose content could be a flag
});

test("unresolvable targets still defer when the rm is recursive", () => {
	defer("rm -rf /tmp/repro*.ts");
	defer("rm dist* -rf"); // flags after the target still count
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

test("redirection tokens around a recursive rm are inert", () => {
	assert.equal(eligible("rm -rf dist 2>/dev/null").kind, "eligible", "attached stderr redirect");
	assert.equal(eligible("rm -rf dist > /dev/null").kind, "eligible", "separated redirect");
	assert.equal(eligible("rm -rf dist >>build.log").kind, "eligible", "append redirect");
	assert.equal(eligible("rm -rf dist 2>&1").kind, "eligible", "fd duplication");
	assert.equal(eligible("rm -rf dist &>log").kind, "eligible", "bash both-streams form");
	assert.equal(eligible("rm -rf dist </dev/null").kind, "eligible", "attached input redirect");
	assert.equal(eligible("rm -rf dist < /dev/null").kind, "eligible", "separated input redirect");
	assert.equal(eligible("rm -rf dist 2>/dev/null; echo done").kind, "eligible", "redirect with follow-on segment");
	assert.equal(eligible("rm -rf -- -dist").kind, "eligible", "literal dash operand after --");
});

test("redirection words with expansions defer", () => {
	defer("rm -rf dist 2>$(mktemp)");
	defer("rm -rf dist > $(mktemp)");
	defer("rm -rf dist > `pwd`/log");
});

test("quoted heredoc bodies are data, not shell", () => {
	// prompt-shaped: apostrophe in a comment plus a bare rm word inside the body
	const comment = ["cat > /tmp/x <<'EOF'", "// what the user's rm segment is, roughly:", "echo done", "EOF", "node /tmp/x"].join("\n");
	absent(comment);
	// prompt-shaped: rm with a redirection inside a template literal in the body
	const bodyRm = ["cat > /tmp/x <<'EOF'", 'const cmd = `ln -sfn a b && rm x 2>/dev/null; ls y | grep -i "c"`;', "EOF", "node /tmp/x"].join("\n");
	absent(bodyRm);
	// even a literal "rm -rf /" in a quoted body never executes
	absent(["cat > /tmp/x <<'EOF'", "rm -rf /", "EOF", "echo done"].join("\n"));
	// heredoc text is skipped but a live rm in the same command is still judged
	assert.equal(eligible(["cat > /tmp/x <<'EOF'", "rm -rf ~", "EOF", "rm -rf dist"].join("\n")).kind, "eligible");
	// <<"EOF" quoted delimiter, and <<- with a tab-indented terminator
	absent(["cat > /tmp/x <<\"EOF\"", "rm -rf /etc", "EOF", "ls"].join("\n"));
	absent(["cat > /tmp/x <<-EOF", "\trm -rf /etc", "\tEOF", "ls"].join("\n"));
});

test("unquoted heredoc bodies run substitutions, so rm inside defers", () => {
	defer(["cat <<EOF", "$(rm -rf /tmp/x)", "EOF", "ls"].join("\n"));
	defer(["cat <<EOF", "`rm -rf ~`", "EOF", "ls"].join("\n"));
	// quotes are literal at body top level: $(...) inside "..." still runs
	defer(['cat <<EOF', '"$(rm -rf /tmp/x)"', "EOF", "ls"].join("\n"));
	// inside a substitution, shell grammar governs the span
	defer(["cat <<EOF", "$(echo ')' && rm -rf /tmp/x)", "EOF", "ls"].join("\n"));
	defer(["cat <<EOF", "$( (rm -rf /tmp/x) )", "EOF", "ls"].join("\n"));
});

test("subshell grouping around rm never hides it, at any nesting level", () => {
	defer("echo $( (rm -rf $HOME) )");
	defer("echo $((rm -rf /etc))");
});

test("plain rm text in an unquoted body is data, not a command", () => {
	absent(["cat <<EOF", "rm -rf /etc", "EOF", "ls"].join("\n"));
});

test("a heredoc feeding a script interpreter is judged, not skipped", () => {
	// the body executes as a script, so it is left as live text
	deny(["bash <<'EOF'", "rm -rf /", "EOF", "ls"].join("\n"));
	assert.equal(eligible(["bash <<EOF", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind, "eligible");
	absent(["bash <<'EOF'", "echo hi", "EOF", "ls"].join("\n"));
	// interpreter anywhere in the consuming segment counts, including pipes
	assert.equal(
		eligible(["cat <<EOF | bash", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind,
		"eligible",
	);
	// quoted and path-prefixed interpreter names, and backslash continuations,
	// are still script consumers
	deny(['"bash" <<EOF', "rm -rf /", "EOF", "ls"].join("\n"));
	deny(["'/bin/bash' <<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
	assert.equal(
		eligible(["/usr/bin/bash <<'EOF'", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind,
		"eligible",
		"path-prefixed interpreter",
	);
	deny(["bash \\", "<<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
	absent(["python <<'EOF'", "print('hi')", "EOF", "ls"].join("\n"));
});

test("variables cannot carry flags into target position", () => {
	defer("X=-rf; Y=/etc; rm $X $Y");
	defer("X=-rf; rm $X /etc");
	defer("X=-r; rm $X ~");
	// after `--` every token is an operand: expansion cannot inject a flag
	assert.equal(eligible("X=-dist; rm -rf -- $X").kind, "eligible");
});

test("exotic heredoc delimiters are left unparsed and fully judged", () => {
	// $, backtick, or backslash in the delimiter changes the terminator bash
	// looks for; the heredoc is not extracted, so every line — body or live —
	// is judged as live shell. The real post-terminator rm must be judged.
	assert.equal(eligible(["cat <<$EOF", "data", "", "rm -rf /tmp/x", "ls"].join("\n")).kind, "eligible");
	assert.equal(
		eligible(["cat <<EOF\\ ", "data", "EOF ", "rm -rf /tmp/x", "ls"].join("\n")).kind,
		"eligible",
	);
});

test("heredoc delimiters without a terminator consume the rest as body", () => {
	absent(["cat <<'EOF'", "rm -rf /", "echo never-a-terminator"].join("\n"));
});

test("mixed-gate constructs without heredocs keep their verdicts", () => {
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

test("git rm --cached only unstages: index-only, so the segment is inert", () => {
	absent("git rm --cached mcp.pid mcp2.pid -q");
	absent("git rm --cached -r build/ -q");
	absent('git rm --cached mcp.pid -q && rm -f mcp.pid mcp2.pid && git commit --amend --no-edit -q && git push -f 2>&1 | tail -1');
});

test("git rm without --cached deletes from disk and still defers", () => {
	defer("git rm mcp.pid");
	defer("git rm -rf dist");
	defer("git rm -r build/");
});

test("git rm --cached carve-out never hides an rm inside a substitution", () => {
	defer("git rm --cached foo $(rm -rf /tmp/x)");
	defer("git rm --cached $(rm -rf $HOME)");
	defer('git rm --cached `rm -rf ~`');
});
