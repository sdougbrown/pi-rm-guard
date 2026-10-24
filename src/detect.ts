/**
 * Route recursive-force rm (pi's built-in guard scope) to the decision model.
 * Detection does not decide whether the command deletes anything or is safe.
 *
 * This is a router, not a security boundary: it makes no promise to catch
 * obfuscated commands or rm invoked from external scripts.
 */

const RM_TOKEN = /(^|[^A-Za-z0-9_-])rm(?![A-Za-z0-9_-])/;

/** Command separators between pipeline, sequence, and line segments. */
const SEGMENT_BREAK = /[|;&\n]/;

/**
 * Split a command into command segments at unquoted, unescaped separators, so
 * that a flag of one command never combines with a flag of the next. An &
 * adjacent to > is a redirect operator (2>&1, &>), not a separator.
 */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
		} else if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
		} else if (SEGMENT_BREAK.test(ch) && !(ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">"))) {
			segments.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	segments.push(current);
	return segments;
}

function segmentHasRecursiveForce(segment: string): boolean {
	const match = RM_TOKEN.exec(segment);
	if (!match) return false;
	let recursive = false;
	let force = false;
	for (const raw of segment.slice(match.index + match[0].length).split(/\s+/)) {
		const token = raw.replace(/^['"]+|['"]+$/g, "");
		if (token === "--") break;
		if (!token.startsWith("-") || token === "-") continue;
		if (token.startsWith("--")) {
			recursive ||= token === "--recursive";
			force ||= token === "--force";
		} else {
			const letters = token.replace(/^-+/, "");
			recursive ||= /[rR]/.test(letters);
			force ||= letters.includes("f");
		}
		if (recursive && force) return true;
	}
	return false;
}

/**
 * True when the command text contains an rm token together with both recursive
 * and force flags (in any arrangement), matching pi's built-in rm -rf guard
 * scope. Plain rm, single-flag rm, and other commands pass through.
 */
export function mayDeleteForceRecursive(command: string): boolean {
	return splitSegments(command).some(segmentHasRecursiveForce);
}
