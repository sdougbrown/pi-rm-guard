/**
 * Route recursive-force rm to the decision model.
 * Detection does not decide whether the command deletes anything or is safe.
 *
 * This is a router, not a security boundary: it makes no promise to catch
 * obfuscated commands or rm invoked from external scripts. Flags are matched
 * lexically anywhere in the command text, so a neighboring command's flags can
 * over-route; over-routing costs one model call, never a missed route.
 */

const RM_TOKEN = /(^|[^A-Za-z0-9_-])rm(?![A-Za-z0-9_-])/;

function isRecursive(token: string): boolean {
	if (token.startsWith("--")) return token === "--recursive";
	return /[rR]/.test(token.replace(/^-+/, ""));
}

function isForce(token: string): boolean {
	if (token.startsWith("--")) return token === "--force";
	return token.replace(/^-+/, "").includes("f");
}

/**
 * True when the command text contains an rm token together with both recursive
 * and force flags (in any arrangement, anywhere in the text). Plain rm,
 * single-flag rm, and other commands pass through.
 */
export function mayDeleteForceRecursive(command: string): boolean {
	if (!RM_TOKEN.test(command)) return false;
	let recursive = false;
	let force = false;
	for (const raw of command.split(/\s+/)) {
		const token = raw.replace(/^['"]+|['"]+$/g, "");
		if (!token.startsWith("-") || token === "-") continue;
		recursive ||= isRecursive(token);
		force ||= isForce(token);
		if (recursive && force) return true;
	}
	return false;
}
