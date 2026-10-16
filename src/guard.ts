import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Static analysis for recursive `rm` commands. Every unresolvable construct
 * (variables, globs, quotes, unparsed redirections, non-rm segments) forces a
 * defer to human approval — this module never widens what it can judge.
 * Redirection operators are inert (their word never enters rm's argv) and
 * heredoc bodies are data, not shell — except that an unquoted heredoc body
 * still runs command substitutions, which are scanned.
 */

export interface EligibleRm {
	ok: true;
	/** rm invocations with their literal, statically-resolved targets */
	invocations: { command: string; targets: string[] }[];
}

export type IneligibleRm = { ok: false; reason: string };

const UNRESOLVABLE = new Set(["$", "`", '"', "'", "\\", "*", "?", "[", "<", ">", "(", ")", "{", "}", "!", "&"]);

/**
 * Commands that execute their stdin as a script. A heredoc consumed by one of
 * these is code, not data — its body is left unextracted so every line is
 * judged as live shell, which restores the pre-heredoc-handling verdicts.
 * Any token in the consuming segment counts, so `cat <<EOF | bash` is caught.
 */
const SCRIPT_INTERPRETERS = new Set([
	"bash", "sh", "ash", "dash", "zsh", "ksh", "csh", "tcsh", "fish", "ssh",
	"python", "python2", "python3", "node", "deno", "bun", "ruby", "irb", "perl",
	"php", "lua", "awk", "gawk", "R", "Rscript", "julia", "osascript",
]);

/**
 * Whether the heredoc's consumer executes its stdin as a script — or cannot
 * be statically resolved, which is judged the same way. Three classes:
 * - a literal stdin script interpreter (`bash`, `sh`, `python`, …), anywhere
 *   in the opening line, so `cat <<EOF | bash` counts
 * - a variable expansion (`$I <<EOF` with `I=bash`): the consumer is the
 *   expansion's value
 * - a function defined in this command (`I() { bash; }; I <<EOF`): the call
 *   runs the function, which can feed the body to an interpreter. A bare
 *   unassigned name is NOT resolvable to a variable — bash looks it up as a
 *   command and fails — so `I=bash; I <<EOF` stays a data heredoc.
 */
function heredocFeedsInterpreter(command: string, heredocStart: number): boolean {
	// A line ending in a backslash or a pipe is a bash continuation: the
	// logical statement spans several physical lines, so the window must join
	// them. A trailing `&&` does NOT join here — its left operand is a
	// separate command whose stdin is not the heredoc — and a trailing single
	// `&` is a background boundary.
	const joins = (s: string) => {
		const t = s.replace(/\s+$/, "");
		return t.endsWith("\\") || t.endsWith("|");
	};
	let lineStart = command.lastIndexOf("\n", heredocStart) + 1;
	while (lineStart >= 2 && joins(command.slice(lineStart - 2 > 0 ? lineStart - 2 : 0, lineStart - 1))) {
		lineStart = command.lastIndexOf("\n", lineStart - 2) + 1;
	}
	let lineEnd = command.indexOf("\n", heredocStart);
	while (lineEnd !== -1 && joins(command.slice(lineStart, lineEnd))) {
		lineEnd = command.indexOf("\n", lineEnd + 1);
	}
	const line = command.slice(lineStart, lineEnd === -1 ? command.length : lineEnd);
	// only the statement that opens the heredoc can consume it: `; node build`
	// after the delimiter is a separate command and must not count
	const offset = heredocStart - lineStart;
	const isBoundary = (i: number) =>
		line[i] === ";" ||
		(line[i] === "&" &&
			(line[i + 1] === "&" || (line[i - 1] !== "<" && line[i - 1] !== ">" && line[i - 1] !== "&" && line[i + 1] !== ">" && line[i + 1] !== "&")));
	let winStart = 0;
	for (let i = 0; i < offset; i++) if (isBoundary(i)) winStart = i + 1;
	let winEnd = line.length;
	for (let i = offset; i < line.length; i++) {
		if (isBoundary(i)) {
			winEnd = i;
			break;
		}
	}
	const tokens = line.slice(winStart, winEnd).split(/[;|&<>]+/).flatMap((part) => part.split(/\s+/));
	const functions = new Set<string>();
	for (const m of command.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/g)) functions.add(m[1]);
	// bash also accepts the `function name {` form (and POSIX `function name()`)
	for (const m of command.matchAll(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*[{(]/g)) functions.add(m[1]);
	return tokens.some((token) => {
		if (/\$/.test(token)) return true;
		const bare = token.replace(/^["']+|["']+$/g, "");
		return SCRIPT_INTERPRETERS.has(bare.replace(/^.*\//, "")) || functions.has(bare);
	});
}

function hasUnresolvableChars(token: string): boolean {
	for (const ch of token) if (UNRESOLVABLE.has(ch)) return true;
	return false;
}

/** Index of the first unresolvable character, or -1 when the token is clean. */
function firstUnresolvableAt(token: string): number {
	for (let i = 0; i < token.length; i++) if (UNRESOLVABLE.has(token[i])) return i;
	return -1;
}

function isRecursiveFlag(token: string): boolean {
	if (token === "--recursive") return true;
	if (!token.startsWith("-") || token.startsWith("--")) return false;
	return /[rR]/.test(token.slice(1));
}

function isFlag(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

const REDIRECT_RE = /^(\d*)(>>?|&>|<)(&\d+)?(.*)$/;

/**
 * POSIX redirection operators ([n]>word, [n]>>word, [n]<word, fd duplication
 * like 2>&1, and bash's &>word). The redirected-to word never enters rm's
 * argv and deletes nothing, so a clean word is inert for the gate. A word
 * with expansions still defers: its text could hide a command substitution
 * that executes. Returns "attached" (skip this token), "next" (skip this
 * token and the following one is the word), "defer", or "none" (not a
 * redirection).
 */
function redirectionKind(token: string): "attached" | "next" | "defer" | "none" {
	const m = REDIRECT_RE.exec(token);
	if (!m) return "none";
	if (m[3]) return "attached";
	const word = m[4];
	if (word === "") return "next";
	return hasUnresolvableChars(word) ? "defer" : "attached";
}

export type Sep = "" | ";" | "\n" | "&&" | "||" | "|" | "&";

interface Segment {
	text: string;
	/** separator that preceded this segment; "" for the first one */
	sepBefore: Sep;
}

/**
 * Split on ; && || | & and newlines, respecting quotes and command
 * substitutions (a `|` inside `$(...)` or a quoted string is not a separator).
 * Each segment carries the separator that preceded it — bash scoping depends
 * on the kind: pipeline and background components run in subshells, and
 * `&&`/`||`-guarded commands may never execute.
 */
function splitSegments(command: string): Segment[] {
	const out: Segment[] = [];
	let current = "";
	let quote: string | null = null;
	let paren = 0;
	let pendingSep: Sep = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			paren++;
			current += "$(";
			i++;
			continue;
		}
		if (ch === "(" && paren > 0) {
			paren++;
			current += ch;
			continue;
		}
		if (ch === ")" && paren > 0) {
			paren--;
			current += ch;
			continue;
		}
		if (paren === 0 && ch === "&" && (command[i + 1] === ">" || /[<>]$/.test(current))) {
			// `&` inside a redirection operator (2>&1, >&2, &>file) is not a separator
			current += ch;
			continue;
		}
		if (paren === 0 && (ch === ";" || ch === "|" || ch === "&" || ch === "\n")) {
			if (current.trim().length > 0) out.push({ text: current.trim(), sepBefore: pendingSep });
			current = "";
			if ((ch === "|" || ch === "&") && command[i + 1] === ch) {
				pendingSep = (ch + ch) as Sep;
				i++;
				continue;
			}
			// a newline directly after & | && || merely continues the statement
			// across the line: the separator kind must survive (a &&-continued
			// write is still conditional; a |-continued one is still piped)
			if (!(ch === "\n" && (pendingSep === "&" || pendingSep === "|" || pendingSep === "&&" || pendingSep === "||"))) pendingSep = ch as Sep;
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) out.push({ text: current.trim(), sepBefore: pendingSep });
	return out;
}

/** Remove quoted spans (and escaped chars). Returns null on unbalanced quotes. */
function stripQuoted(segment: string): string | null {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			i++;
			continue;
		}
		out += ch;
	}
	return quote === null ? out : null;
}

/** Extract the contents of command substitutions; the remainder has them removed. */
function extractSubstitutions(segment: string): { remainder: string; inners: string[] } {
	let remainder = "";
	const inners: string[] = [];
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			remainder += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			remainder += ch;
			continue;
		}
		if ((ch === "$" && segment[i + 1] === "(") || ch === "`" || ((ch === "<" || ch === ">") && segment[i + 1] === "(")) {
			// process substitutions (<(cmd), >(cmd)) run their inner command, so
			// they are treated like command substitutions for scanning
			const closer = ch === "`" ? "`" : ")";
			const opener = ch === "`" ? "`" : segment[i] + "(";
			let depth = 1;
			let inner = "";
			i += opener.length;
			while (i < segment.length && depth > 0) {
				const c = segment[i];
				if (c === "(" && closer === ")") depth++;
				if (c === closer) depth--;
				if (depth > 0) inner += c;
				i++;
			}
			inners.push(inner);
			remainder += " ";
			i--;
			continue;
		}
		remainder += ch;
	}
	return { remainder, inners };
}

interface ParsedHeredoc {
	/** resume scanning live text immediately after the delimiter token */
	afterDelimiter: number;
	/** jump here at the next top-level newline: body + terminator; -1 = no body */
	skipTo: number;
	quoted: boolean;
	body: string;
}

/**
 * Parse one `<<[-]DELIM` heredoc starting at the first `<`. Strict POSIX body
 * rules: the terminator is a line consisting of exactly DELIM (leading tabs
 * allowed with <<-). A missing terminator consumes the rest of the command
 * as body — which is also what bash does, since it keeps waiting for input.
 */
function parseHeredoc(command: string, start: number): ParsedHeredoc | null {
	let i = start + 2; // past <<
	let stripTabs = false;
	if (command[i] === "-") {
		stripTabs = true;
		i++;
	}
	while (command[i] === " " || command[i] === "\t") i++;

	let delimiter = "";
	let quoted = false;
	let quoteChar = "";
	if (command[i] === "'" || command[i] === '"') {
		quoteChar = command[i];
		const close = command.indexOf(quoteChar, i + 1);
		if (close === -1) return null; // unterminated quote: not parseable, stay conservative
		delimiter = command.slice(i + 1, close);
		quoted = true;
		i = close + 1;
	} else {
		const wordStart = i;
		while (i < command.length && !/[\s;&|)<>]/.test(command[i])) i++;
		delimiter = command.slice(wordStart, i);
		if (delimiter === "") return null; // no delimiter word: leave `<<` as literal text
	}
	// `$`, a backtick, or a backslash in the delimiter changes the terminator
	// bash looks for: the word can expand, or escapes can join it. Leave such a
	// heredoc unparsed. Every line is then judged as live shell, which can only
	// over-gate — it never skips a live rm.
	if (/[$`\\]/.test(delimiter) && quoteChar !== "'") return null;

	const newline = command.indexOf("\n", i);
	if (newline === -1) {
		// no body ever arrives: the operator waits for stdin and the command ends
		return { afterDelimiter: i, skipTo: -1, quoted, body: "" };
	}

	let pos = newline + 1;
	while (pos <= command.length) {
		const nl = command.indexOf("\n", pos);
		const lineEnd = nl === -1 ? command.length : nl;
		const line = command.slice(pos, lineEnd);
		const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
		if (candidate === delimiter) {
			return { afterDelimiter: i, skipTo: lineEnd + 1, quoted, body: command.slice(newline + 1, pos) };
		}
		if (nl === -1) break;
		pos = nl + 1;
	}
		// unterminated: everything after the opening line is body
	return { afterDelimiter: i, skipTo: command.length, quoted, body: command.slice(newline + 1) };
}

/**
 * Parse one `<<<word` here-string starting at the first `<`. The word is a
 * single shell word — quoted or bare — and its content is returned without
 * quotes. Unparseable forms (unterminated quote, empty word) yield null so
 * the operator is left as literal text.
 */
function parseHereString(command: string, start: number): { word: string; after: number } | null {
	let i = start + 3;
	while (command[i] === " " || command[i] === "\t") i++;
	if (command[i] === "'" || command[i] === '"') {
		const close = command.indexOf(command[i], i + 1);
		if (close === -1) return null;
		return { word: command.slice(i + 1, close), after: close + 1 };
	}
	const wordStart = i;
	while (i < command.length && !/[\s;&|)<>]/.test(command[i])) i++;
	if (i === wordStart) return null;
	return { word: command.slice(wordStart, i), after: i };
}

/**
 * Remove heredoc bodies from the command: they are data written to stdin,
 * never commands. Quoted delimiters (`<<'EOF'`) make the body fully literal,
 * so it is inert. Unquoted delimiters keep command/parameter expansion in
 * the body, so those bodies are returned and must be scanned for executing
 * substitutions. Heredocs inside quotes or $(…)/backtick spans are left
 * untouched; their text is judged through the normal rules, which can only
 * over-gate it.
 */
function extractHeredocs(command: string): { remainder: string; expansionBodies: string[]; scriptBodies: string[] } {
	let out = "";
	const expansionBodies: string[] = [];
	const scriptBodies: string[] = [];
	let quote: string | null = null;
	let paren = 0;
	let backticks = false;
	let pendingSkip = -1;
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (quote) {
			out += ch;
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			out += ch + command[i + 1];
			i += 2;
			continue;
		}
		if (ch === "`") {
			backticks = !backticks;
			out += ch;
			i++;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			paren++;
			out += "$(";
			i += 2;
			continue;
		}
		if (ch === "(" && paren > 0) {
			paren++;
			out += ch;
			i++;
			continue;
		}
		if (ch === ")" && paren > 0) {
			paren--;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\n" && pendingSkip !== -1 && !quote && paren === 0 && !backticks) {
			// the body starts after the logical line completes, not inside an
			// open quote or substitution
			out += "\n";
			i = pendingSkip;
			pendingSkip = -1;
			continue;
		}
		if (paren === 0 && !backticks && ch === "<" && command[i + 1] === "<" && command[i + 2] === "<" && command[i - 1] !== "<") {
			// Here-string: one word fed to the consumer's stdin. It executes as
			// a script when the consumer is an interpreter — otherwise the
			// normal segment rules already handle it (quoted form inert,
			// unquoted form substitution-scanned), so it is left untouched.
			const parsed = parseHereString(command, i);
			if (parsed && heredocFeedsInterpreter(command, i)) {
				scriptBodies.push(parsed.word);
				i = parsed.after;
				continue;
			}
		}
		if (
			paren === 0 &&
			!backticks &&
			ch === "<" &&
			command[i + 1] === "<" &&
			command[i + 2] !== "<" &&
			command[i - 1] !== "<"
		) {
			const parsed = parseHeredoc(command, i);
			if (parsed) {
				// An interpreter-fed body executes as a script: keep it out of the
				// parent command entirely — its assignments run in a child shell —
				// and judge it on its own below, as a script.
				if (heredocFeedsInterpreter(command, i)) scriptBodies.push(parsed.body);
				else if (!parsed.quoted) expansionBodies.push(parsed.body);
				pendingSkip = parsed.skipTo;
				i = parsed.afterDelimiter;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return { remainder: out, expansionBodies, scriptBodies };
}

/**
 * Quote-aware scan of one `$( ... )` span starting just after the `(`.
 * Quotes and nested parentheses count inside a substitution — that is real
 * shell grammar even inside a heredoc body — and an unterminated span takes
 * the rest of the text as its content.
 */
function subshellSpan(text: string, start: number): { inner: string; end: number } {
	let depth = 1;
	let quote: string | null = null;
	let inner = "";
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			inner += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inner += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			inner += ch + text[i + 1];
			i++;
			continue;
		}
		if (ch === "(") depth++;
		if (ch === ")") {
			depth--;
			if (depth === 0) return { inner, end: i + 1 };
		}
		inner += ch;
	}
	return { inner, end: text.length };
}

/**
 * Quote-blind scan of an unquoted heredoc body for command substitutions.
 * At the body's top level quotes are literal data — `$(...)` inside "..."
 * still executes and must not be skipped — but once inside a substitution,
 * shell grammar (quotes, nesting) governs the span, so subshellSpan is
 * quote-aware.
 */
function heredocInvokesRm(body: string): boolean {
	let i = 0;
	while (i < body.length) {
		if ((body[i] === "$" || body[i] === "<" || body[i] === ">") && body[i + 1] === "(") {
			const span = subshellSpan(body, i + 2);
			if (invokesRm(span.inner)) return true;
			i = span.end;
			continue;
		}
		if (body[i] === "`") {
			const close = body.indexOf("`", i + 1);
			const end = close === -1 ? body.length : close;
			if (invokesRm(body.slice(i + 1, end))) return true;
			i = close === -1 ? body.length : close + 1;
			continue;
		}
		i++;
	}
	return false;
}

/**
 * Command word of a token. Bash tokenizes `rm>f` as the command `rm` plus an
 * attached redirection, so the operator and its word are stripped before any
 * command comparison.
 */
function commandWord(token: string): string {
	return token.replace(/(>>?|<&?|>&?|&>).*$/, "");
}

/** Whether a command string (no quotes assumed) invokes rm as a command token. */
function hasRmToken(command: string): boolean {
	return command
		.split(/\s+/)
		.filter(Boolean)
		.map((token, index) => {
			const bare = token.replace(/^\(+/, ""); // subshell grouping: $( (rm ...) )
			// only a command-position token can hide an rm behind an attached
			// redirection (`rm>f`): `echo rm>build.log` is an argument
			return index === 0 ? commandWord(bare) : bare;
		})
		.some((token) => token === "rm" || token.endsWith("/rm"));
}

/** Whether a command string invokes rm anywhere (top level or nested substitutions). */
function invokesRm(command: string): boolean {
	const stripped = stripQuoted(command);
	if (stripped === null) return hasRmToken(command);
	const { remainder, inners } = extractSubstitutions(stripped);
	if (hasRmToken(remainder)) return true;
	return inners.some((inner) => invokesRm(inner));
}

interface VarSnapshot {
	vars: Map<string, string>;
	/** an IFS= assignment appeared at or before this segment: any later
	 * variable expansion can field-split into several arguments */
	poisoned: boolean;
}

/**
 * Literal assignments per segment position, following bash scoping:
 *
 * - a value counts only for rm segments after it — bash expands $X with the
 *   value it holds at that point; last write before the rm wins
 * - only main-shell writes that actually run count: pipeline and background
 *   components die in subshells, `&&`/`||`-guarded writes may never execute
 * - a write that runs but cannot be resolved (expansions, word-splitting
 *   values) unresolves the name — it clobbers any earlier literal value
 * - a value containing whitespace is never substituted: bash word-splits it
 *   into several arguments, so one resolved target would misstate the command
 * - any IFS= write poisons later variable substitution: field splitting
 *   changes how a value expands
 */
function varsBySegment(segments: Segment[]): VarSnapshot[] {
	const out: VarSnapshot[] = [];
	const vars = new Map<string, string>();
	let poisoned = false;
	// Only the leading run of pure assignments is an unconditional prologue:
	// after the first non-assignment segment, a write may be inside a case
	// branch, loop body, or other compound construct whose execution is not
	// guaranteed — its effect on the value is unmodelable, so it unresolves.
	let prologue = true;
	for (const [i, seg] of segments.entries()) {
		out.push({ vars: new Map(vars), poisoned });
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(seg.text);
		if (!match) {
			prologue = false;
			// assignments inside compound commands (`then X=/etc`, function
			// bodies) may change the value — unresolve the name
			const stripped = stripQuoted(seg.text);
			if (stripped === null) continue;
			for (const token of stripped.split(/\s+/)) {
				const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
				if (m) {
					if (m[1] === "IFS") poisoned = true;
					else vars.delete(m[1]);
				}
			}
			continue;
		}
		const sepAfter = i + 1 < segments.length ? segments[i + 1].sepBefore : "end";
		const inSubshell = seg.sepBefore === "|" || sepAfter === "|" || sepAfter === "&";
		if (inSubshell) continue; // the write dies with the subshell: the parent value stands
		if (match[1] === "IFS") {
			poisoned = true;
			continue;
		}
		if (seg.sepBefore === "&&" || seg.sepBefore === "||" || !prologue) {
			// the write may never run: the value is uncertain, not the old one
			vars.delete(match[1]);
			continue;
		}
		if (!hasUnresolvableChars(match[2]) && !/\s/.test(match[2])) vars.set(match[1], match[2]);
		else vars.delete(match[1]); // a write that runs but cannot be resolved clobbers the name
	}
	return out;
}

function substituteVars(target: string, vars: Map<string, string>, home: string): string | undefined {
	return target.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
		const name = braced ?? plain;
		const value = vars.get(name) ?? (name === "HOME" ? home : undefined);
		return value === undefined ? whole : value;
	});
}

/** Expand a leading ~ or ~/... to $HOME; everything else is left for path.resolve. */
function expandTilde(target: string, home: string): string {
	if (target === "~") return home;
	if (target.startsWith("~/")) return path.join(home, target.slice(2));
	return target;
}

/**
 * Judge one rm segment. Returns its literal targets or a defer reason.
 * Targets are returned unexpanded; path resolution happens in isTargetInScope.
 */
function analyzeSegment(
	segment: string,
	home: string,
	snapshot: VarSnapshot,
): { targets: string[]; redirects: string[] } | { defer: string } {
	const tokens = segment.split(/\s+/).filter(Boolean);
	let i = 0;
	const lead = commandWord(tokens[0]);
	if (lead !== "rm" && !lead.endsWith("/rm")) {
		return { defer: "segment is not a plain rm invocation" };
	}
	i++;

	let sawRecursive = false;
	let pastDashDash = false;
	const targets: string[] = [];
	// Clean redirection words are not rm targets, but they are truncation
	// side effects — analyzeCommand scope-checks them
	const redirects: string[] = [];
	// Unresolvable targets that only matter if the rm turns out recursive.
	// A plain rm with such targets is pi's normal flow, so the defer is held
	// back until the flag scan completes.
	let targetDefer = "";

	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (!pastDashDash && token === "--") {
			pastDashDash = true;
			continue;
		}
		const redir = redirectionKind(token);
		if (redir === "attached") {
			const m = REDIRECT_RE.exec(token);
			if (m && m[4]) redirects.push(m[4]);
			continue;
		}
		if (redir === "defer") return { defer: `redirection is not statically resolvable: ${token}` };
		if (redir === "next") {
			const word = tokens[i + 1];
			if (word === undefined) return { defer: "redirection with a missing word" };
			if (hasUnresolvableChars(word)) return { defer: `redirection is not statically resolvable: ${word}` };
			redirects.push(word);
			i++;
			continue;
		}
		if (!pastDashDash && isFlag(token)) {
			if (hasUnresolvableChars(token)) return { defer: `flag with expansion chars: ${token}` };
			if (isRecursiveFlag(token)) sawRecursive = true;
			continue;
		}
		const expanded = expandTilde(commandWord(token), home);
		if (token.startsWith("~") && token !== "~" && !token.startsWith("~/")) {
			// ~user, ~+, ~- expand to paths the gate cannot place: root's home,
			// the cwd, a prior directory — outside or unjudgeable
			return { defer: `target expands via unhandled tilde form: ${token}` };
		}
		const substituted = substituteVars(expanded, snapshot.vars, home);
		if (snapshot.poisoned && /\$/.test(token)) {
			// an IFS= write changes field splitting: X=delme:/etc can expand to
			// several arguments, so the resolved target would misstate the command
			return { defer: `variable expansion under a changed IFS: ${token}` };
		}
		if (!pastDashDash && substituted.startsWith("-")) {
			// a variable can carry a flag into target position: X=-rf; rm $X /etc.
			// After `--` every token is an operand, so the check stops there.
			return { defer: `target expands flag-shaped: ${token}` };
		}
		if (hasUnresolvableChars(substituted)) {
			const reason = `target is not statically resolvable: ${token}`;
			// Executing constructs (substitution, backticks) and shape-changing ones
			// defer regardless of recursion. Variables can expand to flags. An
			// expansion with no static prefix can match a file literally named
			// "-rf". Either can make a plain rm recursive.
			if (/[$`]/.test(substituted) || firstUnresolvableAt(substituted) === 0) return { defer: reason };
			targetDefer ||= reason;
			continue;
		}
		targets.push(expandTilde(substituted, home));
	}

	if (!sawRecursive) return { defer: "rm without a recursive flag" };
	if (targetDefer) return { defer: targetDefer };
	if (targets.length === 0) return { defer: "rm with no targets" };
	return { targets, redirects };
}

/**
 * Physical resolution of a target against the real cwd. path.resolve is not
 * usable: it cancels ".." lexically, but POSIX resolves ".." against the
 * symlink target, so `link/../x` can escape in ways path.resolve hides.
 * Components are resolved one at a time through realpath; missing leaves
 * (dirs about to be created) are tolerated by keeping the raw suffix.
 */
export function resolveReal(target: string, cwd: string): string {
	const start = target.startsWith("/") ? "/" : resolveReal(cwd, cwd);
	let current = start;
	for (const part of target.split("/").filter((p) => p.length > 0 && p !== ".")) {
		if (part === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = current === "/" ? "/" + part : current + "/" + part;
		try {
			current = realpathSync(next);
		} catch {
			current = next;
		}
	}
	return current;
}

function isUnder(resolved: string, root: string): boolean {
	return resolved === root || resolved.startsWith(root + path.sep);
}

export interface ScopeVerdict {
	inScope: boolean;
	denied: boolean;
	reason: string;
	resolved: string[];
}

const SYSTEM_ROOTS = ["/etc", "/usr", "/var", "/boot", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/dev", "/proc", "/sys", "/run"];

/**
 * A target is model-eligible only when every resolved target is strictly inside
 * cwd or /tmp. Three outcomes: in scope (model may approve), denied (never —
 * filesystem root, system trees, the whole home directory, or a cwd ancestor),
 * or outside scope (human decision).
 */
export function isTargetInScope(targets: string[], cwd: string, tmpReal: string): ScopeVerdict {
	const resolved: string[] = [];
	const cwdReal = resolveReal(cwd, cwd);
	const homeReal = process.env.HOME ? resolveReal(process.env.HOME, cwd) : "";
	for (const target of targets) {
		const real = resolveReal(target, cwd);
		resolved.push(real);
		if (real === "/") {
			return { inScope: false, denied: true, reason: `${target} is the filesystem root`, resolved };
		}
		for (const root of SYSTEM_ROOTS) {
			if (isUnder(real, root)) {
				return { inScope: false, denied: true, reason: `${target} is a system path (${root})`, resolved };
			}
		}
		if (homeReal && real === homeReal) {
			return { inScope: false, denied: true, reason: `${target} is the whole home directory`, resolved };
		}
		if (real === cwdReal) {
			return { inScope: false, denied: false, reason: `${target} is the working directory itself`, resolved };
		}
		if (real === tmpReal || isUnder(tmpReal, real)) {
			return { inScope: false, denied: true, reason: `${target} is /tmp itself or an ancestor`, resolved };
		}
		if (isUnder(cwdReal, real)) {
			return { inScope: false, denied: true, reason: `${target} is an ancestor of the working directory`, resolved };
		}
		if (!(isUnder(real, cwdReal) || isUnder(real, tmpReal))) {
			return { inScope: false, denied: false, reason: `${target} resolves outside the session and /tmp`, resolved };
		}
	}
	return { inScope: true, denied: false, reason: "all targets under cwd or /tmp", resolved };
}

/**
 * Static gate with a three-way verdict: "absent" (no recursive rm — pi's normal
 * flow applies), "defer" (recursive rm present but not judgeable — human), or
 * "eligible" (literal targets inside cwd//tmp — decision model may approve).
 */
export type CommandVerdict =
	| { kind: "absent" }
	| { kind: "defer"; reason: string }
	| { kind: "deny"; reason: string }
	| { kind: "eligible"; targets: string[] };

export function analyzeCommand(command: string, cwd: string): CommandVerdict {
	const home = process.env.HOME ?? "";
	const { remainder, expansionBodies, scriptBodies } = extractHeredocs(command);
	const segments = splitSegments(remainder);
	if (segments.length === 0 && expansionBodies.length === 0 && scriptBodies.length === 0) {
		return { kind: "defer", reason: "empty command" };
	}

	let sawRecursive = false;
	let sawPlainRm = false;
	let rmDeferred = false;
	let reason = "";
	const varsBySeg = varsBySegment(segments);
	const targets: string[] = [];
	const redirectWords: string[] = [];

	for (const body of expansionBodies) {
		if (heredocInvokesRm(body)) {
			rmDeferred = true;
			reason = "rm inside a command substitution";
		}
	}

	for (const [index, seg] of segments.entries()) {
		const segment = seg.text;
		const stripped = stripQuoted(segment);
		if (stripped === null) {
			// Unbalanced quoting: a quoted "rm -rf" mention is harmless, but we
			// cannot tell where the quotes end — any rm mention defers.
			if (hasRmToken(segment)) {
				rmDeferred = true;
				reason = "unbalanced quoting around an rm mention";
			}
			continue;
		}

		const { remainder, inners } = extractSubstitutions(stripped);
		const firstToken = commandWord(remainder.trim().split(/\s+/)[0] ?? "");

		if (firstToken === "rm" || firstToken.endsWith("/rm")) {
			const verdict = analyzeSegment(segment, home, varsBySeg[index]);
			if ("targets" in verdict) {
				sawRecursive = true;
				targets.push(...verdict.targets);
				redirectWords.push(...verdict.redirects);
			} else if (verdict.defer === "rm without a recursive flag") {
				sawPlainRm = true;
			} else {
				rmDeferred = true;
				reason = verdict.defer;
			}
			continue;
		}

		// Non-rm segment: an unquoted rm token means rm runs behind something we
		// cannot verify (sudo, env prefix, xargs). A quoted "rm -rf" is stripped
		// before this point and ignored. rm inside a substitution executes.
		// Exception: `git rm --cached` only unstages — the files stay on disk,
		// so the segment is inert for the gate — but only when the segment
		// carries no rm of its own: a substitution inside it still executes
		// (`git rm --cached foo $(rm -rf /tmp/x)`), and `git rm` without
		// --cached does delete from disk and still defers.
		const segTokens = remainder.trim().split(/\s+/).filter(Boolean);
		const inertGitRmCached =
			segTokens[0] === "git" && segTokens[1] === "rm" && segTokens.some((t) => t === "--cached");
		// the "rm" subcommand token is part of `git rm`, so scan only what follows it
		const restWithoutGitRm = segTokens.slice(2).join(" ");
		if (inertGitRmCached && inners.length === 0 && !hasRmToken(restWithoutGitRm)) {
			continue;
		}
		if (hasRmToken(remainder)) {
			rmDeferred = true;
			reason = "rm is not in leading position";
			continue;
		}
		for (const inner of inners) {
			if (invokesRm(inner)) {
				rmDeferred = true;
				reason = "rm inside a command substitution";
				break;
			}
		}
	}

	// An interpreter-fed heredoc body is a script: judge it on its own, in its
	// own child-shell scope — its assignments never reach the parent timeline.
	// Command substitutions inside the body execute even inside double quotes,
	// so a quote-blind scan catches them; an unquoted expansion or backtick
	// outside a substitution makes what runs unknowable and defers. Single-
	// quoted content is judged as data.
	for (const body of scriptBodies) {
		if (heredocInvokesRm(body)) {
			rmDeferred = true;
			reason = "rm inside a command substitution";
			continue;
		}
		const strippedBody = stripQuoted(body);
		if (strippedBody !== null && /[$`]/.test(strippedBody)) {
			rmDeferred = true;
			reason = "script content is not statically resolvable";
			continue;
		}
		const sub = analyzeCommand(body, cwd);
		if (sub.kind === "deny") return sub;
		if (sub.kind === "defer") {
			rmDeferred = true;
			reason ||= sub.reason;
		} else if (sub.kind === "eligible") {
			sawRecursive = true;
			targets.push(...sub.targets);
		}
	}

	if (!sawRecursive && !rmDeferred) return { kind: "absent" };
	if (rmDeferred || sawPlainRm) return { kind: "defer", reason: reason || "mixed recursive and non-recursive rm" };

	const tmpReal = resolveReal("/tmp", cwd);
	// Redirection words truncate their path: a clean word is scope-checked
	// like a target, with /dev/null exempt (truncating it is harmless). An
	// out-of-scope word defers — the model never sees it as a target because
	// rm does not delete it.
	for (const word of redirectWords) {
		if (word.startsWith("~") && word !== "~" && !word.startsWith("~/")) {
			return { kind: "defer", reason: `redirection expands via unhandled tilde form: ${word}` };
		}
		const real = resolveReal(expandTilde(word, home), cwd);
		if (real === "/dev/null" || isUnder(real, resolveReal(cwd, cwd)) || isUnder(real, tmpReal)) continue;
		return { kind: "defer", reason: `redirection target is outside the session and /tmp: ${word}` };
	}
	const scope = isTargetInScope(targets, cwd, tmpReal);
	if (scope.denied) return { kind: "deny", reason: scope.reason };
	if (!scope.inScope) return { kind: "defer", reason: scope.reason };
	return { kind: "eligible", targets };
}
