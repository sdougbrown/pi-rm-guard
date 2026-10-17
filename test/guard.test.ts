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
	assert.deepEqual(eligible("WT=/tmp/x; rm -rf $WT"), { kind: "eligible", targets: ["/tmp/x"] });
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

test("assignments apply in command order, so a later one cannot mask the value at the rm", () => {
	// bash expands $X to /etc at the rm; the later dist write runs after
	deny("X=/etc; rm -rf $X; X=dist");
	// no assignment before the rm: $X is unresolvable and defers
	defer("rm -rf -- $X; X=/etc");
	defer("rm -rf $X; X=dist");
	// short-circuit and control-flow writes make the value uncertain, not old
	defer("X=/tmp/x; a && X=/etc; rm -rf $X");
	defer("X=dist; if true; then X=/etc; fi; rm -rf $X");
	// pipeline and background components run in subshells: the write dies there
	deny("X=/etc; X=dist | rm -rf $X");
	deny("X=/etc; X=dist & rm -rf $X");
	// a rejected write still executes in bash and clobbers the earlier literal
	defer("X=/etc; X=$OTHER; rm -rf $X");
	defer("X=/etc; X=a b; rm -rf $X");
	// interpreter-heredoc bodies run in a child shell: their assignments never
	// reach the parent timeline
	deny(["X=/etc; bash <<EOF", "X=dist", "EOF", "rm -rf $X"].join("\n"));
});

test("assignment values that word-split are not substituted", () => {
	// bash would run `rm -rf my dir` — two arguments, not one target
	defer("WT=my dir; rm -rf $WT");
	// IFS=: makes X=delme:/etc two arguments in bash
	defer("IFS=:; X=delme:/etc; rm -rf $X");
});

test("HOME assignment shadows the environment value only from that point on", () => {
	deny("rm -rf $HOME; HOME=/tmp/x");
	assert.equal(eligible("HOME=./sub; rm -rf $HOME").kind, "eligible");
	// a leading prologue of pure assignments is fully judged; a write after
	// the first non-assignment segment may be inside a compound construct,
	// so it unresolves — safe over-gate
	defer("X=dist; rm -rf $X; X=dist2; rm -rf $X");
});

test("conditional writes survive a newline after their guard", () => {
	// the && continues across the newline: the write is still conditional
	defer(["X=/etc; false &&", "X=dist; rm -rf $X"].join("\n"));
	defer(["X=/etc; true ||", "X=dist; rm -rf $X"].join("\n"));
});

test("writes inside compound commands unresolve even as plain segments", () => {
	// the case-branch write is a plain ; separated segment, but its
	// execution is conditional on the branch
	defer("X=/etc; case $Y in z) echo hi; X=dist;; esac; rm -rf $X");
});

test("redirection words are scope-checked as truncation side effects", () => {
	defer("rm -rf dist >~/.bashrc");
	defer("rm -rf dist 2>/etc/cron.d/x");
	defer("rm -rf dist >>/etc/passwd");
	defer("rm -rf dist > ~/x");
	// the defer variants carry this test's value; the inert eligible forms
	// are pinned in the redirection test above
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
	assert.deepEqual(eligible("rm -rf dist 2>/dev/null"), { kind: "eligible", targets: ["dist"] });
	assert.equal(eligible("rm -rf dist > /dev/null").kind, "eligible", "separated redirect");
	assert.equal(eligible("rm -rf dist >>build.log").kind, "eligible", "append redirect");
	assert.equal(eligible("rm -rf dist 2>&1").kind, "eligible", "fd duplication");
	assert.equal(eligible("rm -rf dist &>log").kind, "eligible", "bash both-streams form");
	assert.equal(eligible("rm -rf dist </dev/null").kind, "eligible", "attached input redirect");
	assert.equal(eligible("rm -rf dist < /dev/null").kind, "eligible", "separated input redirect");
	assert.equal(eligible("rm -rf dist 2>/dev/null; echo done").kind, "eligible", "redirect with follow-on segment");
	assert.equal(eligible("rm -rf -- -dist").kind, "eligible", "literal dash operand after --");
	assert.deepEqual(eligible("X=dist; rm -rf -- $X"), { kind: "eligible", targets: ["dist"] });
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
	assert.equal(eligible(["cat > /tmp/x <<'EOF'", "rm -rf ~", "EOF", "rm -rf dist"].join("\n")).kind, "eligible", "live rm alongside a quoted heredoc");
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

test("a redirection attached to the rm word does not hide the rm", () => {
	// bash tokenizes `rm>f` as the command rm plus a redirection
	deny("rm>f -rf /");
	assert.equal(eligible("rm -rf dist>log").kind, "eligible");
	defer("rm -rf dist >"); // bash: syntax error, nothing runs
});

test("targets from every segment participate in the scope verdict", () => {
	deny("rm -rf dist && rm -rf /etc");
	defer("rm -rf dist && rm -rf leak"); // leak -> symlink escaping to $HOME
});

test("heredoc: quoted and unquoted substitutions in the body differ", () => {
	// double quotes do NOT suppress command substitution
	defer(["bash <<'EOF'", '"$(rm -rf ~)"', "EOF", "ls"].join("\n"));
	defer('bash <<< "$(rm -rf /)"');
	// single-quoted and quoted-arg content is inert data
	absent(["bash <<'EOF'", "echo '$HOME'", "EOF", "ls"].join("\n"));
	absent(["bash <<'EOF'", 'echo "$HOME"', "EOF", "ls"].join("\n"));
	// an unquoted expansion as a command or argument is unknowable
	defer(["bash <<'EOF'", "$X", "EOF", "ls"].join("\n"));
	defer(["bash <<'EOF'", "sudo $X", "EOF", "ls"].join("\n"));
	defer(["bash <<'EOF'", "rm -rf $X", "EOF", "ls"].join("\n"));
});

test("heredoc: interpreter consumers deny, judge, or pass through the body", () => {
	// the body executes as a script, so it is left as live text
	deny(["bash <<'EOF'", "rm -rf /", "EOF", "ls"].join("\n"));
	assert.equal(
		eligible(["bash <<EOF", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind,
		"eligible",
		"unquoted interpreter consumer, in-scope body",
	);
	absent(["bash <<'EOF'", "echo hi", "EOF", "ls"].join("\n"));
	// unresolvable body content reaches the defer branch, not just deny/eligible
	defer(["bash <<EOF", "rm -rf $X", "EOF", "ls"].join("\n"));
	// non-shell interpreters are not judgeable by a shell parser: defer
	defer(["python <<'EOF'", "print('hi')", "EOF", "ls"].join("\n"));
});

test("heredoc: pipe consumers feed the body onward and still judge it", () => {
	assert.equal(
		eligible(["cat <<EOF | bash", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind,
		"eligible",
		"pipeline consumer",
	);
	// a pipeline continues across a bare newline after a trailing pipe
	assert.equal(
		eligible(["cat <<EOF |", "bash", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind,
		"eligible",
		"pipelined continuation consumer",
	);
	// a background boundary ends the statement: the next line is separate
	absent(["bash &", "cat <<'EOF'", "rm -rf /etc", "EOF", "ls"].join("\n"));
	absent(["cat <<'EOF'; node build", "rm -rf /etc", "EOF", "ls"].join("\n"));
});

test("heredoc: quoted, path-prefixed, and continued interpreter names still count", () => {
	deny(['"bash" <<EOF', "rm -rf /", "EOF", "ls"].join("\n"));
	deny(["'/bin/bash' <<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
	assert.equal(
		eligible(["/usr/bin/bash <<'EOF'", "rm -rf /tmp/x", "EOF", "ls"].join("\n")).kind,
		"eligible",
		"path-prefixed interpreter",
	);
	deny(["bash \\", "<<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
});

test("heredoc: variable and function consumers are unresolvable, not data", () => {
	// the consumer identity is unresolvable, so the body defers without
	// needing an rm token — even when the body looks like shell
	defer(["I=bash", "$I <<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
	defer(["I() { bash; }", "I <<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
	defer(["function I { bash; }", "I <<EOF", "rm -rf /etc", "EOF", "ls"].join("\n"));
	defer(["function I() { bash; }", "I <<EOF", "rm -rf /", "EOF", "ls"].join("\n"));
	// a bare unassigned name is not provably data: it may resolve in PATH
	// (the tclsh class), so it defers — bash would error here, an over-gate
	defer(["I=bash", "I <<EOF", "rm -rf /etc", "EOF", "ls"].join("\n"));
});

test("heredocs inside substitutions or quotes are judged as live text", () => {
	// the extractor only handles top-level heredocs; wrapped ones fall
	// through to the normal segment rules (over-gate, never bypass)
	deny(["echo `bash <<'EOF'", "rm -rf /", "EOF`"].join("\n"));
	defer(["$(cat <<'EOF'", "rm -rf /", "EOF", ")"].join("\n"));
});

test("unparseable heredoc operators judge everything as live text", () => {
	// the unterminated delimiter quote defers via the unbalanced-quote path;
	// the missing delimiter word leaves the rm line live
	defer(["cat <<'EOF", "rm -rf /"].join("\n"));
	deny(["cat <<", "rm -rf /"].join("\n"));
});

test("a continuation after the heredoc operator is live, not body", () => {
	// bash joins `cat <<EOF \` + newline into one logical command, so the
	// next line's `; rm -rf /` executes — the body starts after the logical
	// line, and the live segment is judged
	deny("cat <<EOF \\\n; rm -rf /\nEOF");
	// an escaped backslash is not a continuation: the line is body data
	absent("cat <<EOF \\\\\n; rm -rf /\nEOF");
	// an interpreter before a `;` does not consume the heredoc
	absent(["bash; cat <<'EOF'", "rm -rf /", "EOF"].join("\n"));
});

test("redirect-word tilde forms the gate cannot place defer", () => {
	defer("rm -rf dist >~root/x");
	defer("rm -rf dist 2>~+/x");
});

test("heredoc: stdin script readers source the heredoc as a script", () => {
	// `source`/`.` read their file argument — when it is stdin, the
	// here-string/heredoc word is the script and is judged
	deny("source /dev/stdin <<< 'rm -rf /'");
	assert.equal(eligible("source /dev/stdin <<< 'rm -rf /tmp/x'").kind, "eligible", "in-scope sourced word");
	deny(". /dev/stdin <<< 'rm -rf ~'");
	// a file argument means stdin is not the script — the body is data
	absent(["source x.sh <<'EOF'", "rm -rf /etc", "EOF", "ls"].join("\n"));
});

test("process substitution spans are one segment", () => {
	// the ; inside <(...) is not a statement boundary: the whole inner
	// command is scanned as one substitution
	defer("echo <(sleep 1; rm -rf /etc)");
});

test("a heredoc with no following newline leaves the rest of the line live", () => {
	deny("cat <<EOF; rm -rf /etc");
});

test("an attached redirection on an argument word is not a command", () => {
	// bash runs `echo rm` with stdout to build.log — the rm is an argument
	absent("echo rm>build.log");
});

test("IFS poisoning covers compound-command writes", () => {
	defer("X=a/b; if true; then IFS=.; fi; rm -rf $X");
});
test("heredoc: here-strings feed one word to the consumer's stdin", () => {
	deny("bash <<< 'rm -rf /'");
	assert.equal(eligible("bash <<< 'rm -rf /tmp/x'").kind, "eligible", "in-scope here-string word");
	defer('bash <<< "$(rm -rf ~)"');
	absent("cat <<< 'rm -rf /etc'");
	// an unresolvable here-string word defers: the expanded script content
	// is not knowable from its text
	defer("bash <<< $X");
	defer('bash <<< `fetch`');
	defer("X=rm -rf ~; bash <<< $X");
	// a subshell IFS write cannot change the parent IFS
	assert.equal(eligible("IFS=: & X=1; rm -rf $X").kind, "eligible", "subshell IFS write");
})

test("process substitutions run their inner command and defer", () => {
	defer("echo <(rm -rf /etc)");
	defer("diff <(ls) <(rm -rf /etc)");
	defer("tee >(rm -rf /etc)");
	// process substitutions inside unquoted heredoc bodies execute too
	defer(["cat <<EOF", "<(rm -rf /etc)", "EOF", "ls"].join("\n"));
});

test("tilde forms the gate cannot place defer", () => {
	defer("rm -rf ~root/x");
	defer("rm -rf ~+/x");
	defer("rm -rf ~-/x");
	// the plain ~ form resolves to the real home and is scope-checked like
	// any literal target — outside the fixture cwd, so it defers
	defer("rm -rf ~/x");
	assert.equal(eligible("rm -rf sub/../sub").kind, "eligible"); // plain tilde-free target still fine
});

test("a backgrounded write across a newline does not count for the parent", () => {
	// bash: the parent X stays /etc after the backgrounded write dies
	deny(["X=/etc", "X=dist &", "rm -rf $X"].join("\n"));
	// and the same-line form keeps its deny too
	deny("X=/etc; X=dist & rm -rf $X");
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
