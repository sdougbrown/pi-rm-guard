import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Static analysis for recursive `rm` commands. Every unresolvable construct
 * (variables, globs, quotes, redirections, non-rm segments) forces a defer to
 * human approval — this module never widens what it can judge.
 */

export interface EligibleRm {
	ok: true;
	/** rm invocations with their literal, statically-resolved targets */
	invocations: { command: string; targets: string[] }[];
}

export type IneligibleRm = { ok: false; reason: string };

const UNRESOLVABLE = new Set(["$", "`", '"', "'", "\\", "*", "?", "[", "<", ">", "(", ")", "{", "}", "!", "&"]);

function hasUnresolvableChars(token: string): boolean {
	for (const ch of token) if (UNRESOLVABLE.has(ch)) return true;
	return false;
}

function isRecursiveFlag(token: string): boolean {
	if (token === "--recursive") return true;
	if (!token.startsWith("-") || token.startsWith("--")) return false;
	return /[rR]/.test(token.slice(1));
}

function isFlag(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

/**
 * Split on ; && || | and newlines, respecting quotes and command substitutions
 * (a `|` inside `$(...)` or a quoted string is not a separator).
 */
function splitSegments(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	let paren = 0;
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
		if (paren === 0 && (ch === ";" || ch === "|" || ch === "&" || ch === "\n")) {
			if (current.trim().length > 0) out.push(current.trim());
			current = "";
			if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) out.push(current.trim());
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
		if ((ch === "$" && segment[i + 1] === "(") || ch === "`") {
			const closer = ch === "`" ? "`" : ")";
			const opener = ch === "`" ? "`" : "$(";
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

/** Whether a command string (no quotes assumed) invokes rm as a command token. */
function hasRmToken(command: string): boolean {
	return command
		.split(/\s+/)
		.filter(Boolean)
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

/**
 * Literal assignments from earlier segments in the same command (NAME=value,
 * optionally exported). Values with any expansion defer later, so this only
 * ever substitutes text that is literally present in the command itself.
 */
function literalAssignments(segments: string[]): Map<string, string> {
	const vars = new Map<string, string>();
	for (const segment of segments) {
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(segment);
		if (match && !hasUnresolvableChars(match[2])) vars.set(match[1], match[2]);
	}
	return vars;
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
function analyzeSegment(segment: string, home: string, vars: Map<string, string>): { targets: string[] } | { defer: string } {
	const tokens = segment.split(/\s+/).filter(Boolean);
	let i = 0;
	if (tokens[i] !== "rm" && !tokens[i].endsWith("/rm")) {
		return { defer: "segment is not a plain rm invocation" };
	}
	i++;

	let sawRecursive = false;
	let pastDashDash = false;
	const targets: string[] = [];

	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (!pastDashDash && token === "--") {
			pastDashDash = true;
			continue;
		}
		if (!pastDashDash && isFlag(token)) {
			if (hasUnresolvableChars(token)) return { defer: `flag with expansion chars: ${token}` };
			if (isRecursiveFlag(token)) sawRecursive = true;
			continue;
		}
		const expanded = expandTilde(token, home);
		const substituted = substituteVars(expanded, vars, home);
		if (hasUnresolvableChars(substituted)) {
			return { defer: `target is not statically resolvable: ${token}` };
		}
		targets.push(expandTilde(substituted, home));
	}

	if (!sawRecursive) return { defer: "rm without a recursive flag" };
	if (targets.length === 0) return { defer: "rm with no targets" };
	return { targets };
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
	const segments = splitSegments(command);
	if (segments.length === 0) return { kind: "defer", reason: "empty command" };

	let sawRecursive = false;
	let sawPlainRm = false;
	let rmDeferred = false;
	let reason = "";
	const vars = literalAssignments(segments);
	const targets: string[] = [];

	for (const segment of segments) {
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
		const firstToken = remainder.trim().split(/\s+/)[0] ?? "";

		if (firstToken === "rm" || firstToken.endsWith("/rm")) {
			const verdict = analyzeSegment(segment, home, vars);
			if ("targets" in verdict) {
				sawRecursive = true;
				targets.push(...verdict.targets);
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

	if (!sawRecursive && !rmDeferred) return { kind: "absent" };
	if (rmDeferred || sawPlainRm) return { kind: "defer", reason: reason || "mixed recursive and non-recursive rm" };

	const tmpReal = resolveReal("/tmp", cwd);
	const scope = isTargetInScope(targets, cwd, tmpReal);
	if (scope.denied) return { kind: "deny", reason: scope.reason };
	if (!scope.inScope) return { kind: "defer", reason: scope.reason };
	return { kind: "eligible", targets };
}
