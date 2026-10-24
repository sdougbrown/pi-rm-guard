/**
 * Route recursive-force rm (pi's built-in guard scope) to the decision model.
 * Detection does not decide whether the command deletes anything or is safe.
 *
 * This is a router, not a security boundary: it makes no promise to catch
 * obfuscated commands or rm invoked from external scripts.
 */

const RM_TOKEN = /(^|[^A-Za-z0-9_-])rm(?![A-Za-z0-9_-])/;

/** Split points between pipeline, sequence, and line command segments. */
const SEGMENT_BREAK = /[|;&\n]/;

function segmentHasRecursiveForce(segment: string): boolean {
	const rm = segment.search(RM_TOKEN);
	if (rm === -1) return false;
	let recursive = false;
	let force = false;
	for (const token of segment.slice(rm + 2).split(/\s+/)) {
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
	return command.split(SEGMENT_BREAK).some(segmentHasRecursiveForce);
}
