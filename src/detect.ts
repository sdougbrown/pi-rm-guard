/**
 * Route raw rm mentions, including quoted data, to the decision model.
 * Detection does not decide whether the command deletes anything or is safe.
 *
 * This is a router, not a security boundary: it makes no promise to catch
 * obfuscated commands or rm invoked from external scripts.
 */

const RM_TOKEN = /(^|[^A-Za-z0-9_-])rm(?![A-Za-z0-9_-])/;

/** True when the command possibly runs (or mentions) rm anywhere in its text. */
export function mayInvokeRm(command: string): boolean {
	return RM_TOKEN.test(command);
}
