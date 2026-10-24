import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClassifierBackend, createDecisionsBackend, type DecisionBackend, type DecisionOutcome } from "./backends.ts";
import { mayDeleteForceRecursive } from "./detect.ts";
import { registerDecisionsProvider } from "./decisions-provider.ts";

export interface RmGuardConfig {
	/** "decisions": a /v1/decisions endpoint. "classifier": any pi-known classifier model. */
	backend: "decisions" | "classifier";
	/** Auto-approval threshold override; when unset each backend uses its own default. */
	threshold?: number;
	decisionsUrl: string;
	decisionsModel: string;
	timeoutMs: number;
	/** "provider/model-id" resolved through pi's model registry. */
	classifier: string;
	classifierApiKey: string | undefined;
	/** Register the decisions endpoint as a pi classifier provider at startup. */
	registerProvider: boolean;
	providerApiKey: string | undefined;
}

/** Settings block: `rmGuard` in pi settings.json (global or project). */
export interface RmGuardSettings {
	backend?: string;
	url?: string;
	model?: string;
	timeoutMs?: number;
	classifier?: string;
	threshold?: number;
	registerProvider?: boolean;
	keyFile?: string;
}

function readRmGuardSettings(pi: { getSettings?: () => unknown }): RmGuardSettings | undefined {
	try {
		const settings = pi.getSettings?.() as { rmGuard?: RmGuardSettings } | undefined;
		return settings?.rmGuard;
	} catch {
		return undefined;
	}
}

/**
 * Precedence: environment variables > pi settings `rmGuard` block > defaults.
 * Env is the per-machine override; the settings block is the portable config.
 * pi merges global and project settings (PI_CODING_AGENT_DIR-aware) before
 * this sees them.
 */
export function resolveConfig(pi: { getSettings?: () => unknown }): RmGuardConfig {
	const settings = readRmGuardSettings(pi) ?? {};
	const env = (name: string): string | undefined => process.env[name];
	const str = (key: keyof RmGuardSettings, envName: string, fallback: string): string =>
		env(envName) ?? (settings[key] as string | undefined) ?? fallback;
	const num = (key: keyof RmGuardSettings, envName: string, fallback: number): number => {
		const raw = env(envName) ?? (settings[key] as number | undefined);
		return raw === undefined ? fallback : Number(raw);
	};

	const backend = env("RM_GUARD_BACKEND") ?? settings.backend ?? "classifier";
	if (backend !== "classifier" && backend !== "decisions") {
		throw new Error(`unknown rm-guard backend ${JSON.stringify(backend)}; expected classifier or decisions`);
	}
	return {
		backend,
		threshold: env("RM_GUARD_THRESHOLD") ? Number(env("RM_GUARD_THRESHOLD")) : (settings.threshold as number | undefined),
		decisionsUrl: str("url", "RM_GUARD_URL", "http://localhost:4000/v1/decisions"),
		decisionsModel: str("model", "RM_GUARD_MODEL", "gemma4"),
		timeoutMs: num("timeoutMs", "RM_GUARD_TIMEOUT_MS", 1500),
		classifier: str("classifier", "RM_GUARD_CLASSIFIER", "typesafe/jev-latest"),
		classifierApiKey: process.env.TYPESAFE_API_KEY ?? readKeyFile(str("keyFile", "RM_GUARD_JEV_KEY_FILE", "~/.secrets/jev.key")),
		registerProvider: env("RM_GUARD_REGISTER_PROVIDER") !== undefined ? env("RM_GUARD_REGISTER_PROVIDER") === "1" : (settings.registerProvider ?? false),
		providerApiKey: env("RM_GUARD_API_KEY"),
	};
}

function readKeyFile(file: string): string | undefined {
	const path = file.startsWith("~") ? `${process.env.HOME ?? ""}${file.slice(1)}` : file;
	if (!path) return undefined;
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

const MAX_USER_REQUESTS = 5;
const MAX_EVIDENCE = 8;
const MAX_SNIPPET = 1000;

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((block) => (block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join(" ");
	}
	return "";
}

function snippet(text: string): string {
	if (text.length <= MAX_SNIPPET) return text;
	const half = Math.floor(MAX_SNIPPET / 2);
	return `${text.slice(0, half)}\n[...truncated...]\n${text.slice(-half)}`;
}

/**
 * Recent user requests and assistant tool-call/result evidence, walked newest
 * first from the session branch and returned in chronological order.
 */
function sessionContext(ctx: { sessionManager: { getBranch(): { type: string; message?: { role?: string; content?: unknown } }[] } }): {
	userRequests: string[];
	evidence: string[];
} {
	try {
		const branch = ctx.sessionManager.getBranch();
		const userRequests: string[] = [];
		const evidence: string[] = [];
		for (let i = branch.length - 1; i >= 0 && (userRequests.length < MAX_USER_REQUESTS || evidence.length < MAX_EVIDENCE); i--) {
			const entry = branch[i];
			if (entry.type !== "message" || !entry.message) continue;
			if (entry.message.role === "user" && userRequests.length < MAX_USER_REQUESTS) {
				const text = messageText(entry.message.content).trim();
				if (text.length > 0) userRequests.unshift(snippet(text));
			} else if (entry.message.role === "assistant" && evidence.length < MAX_EVIDENCE) {
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const block of content.toReversed()) {
					if (block && typeof block === "object" && block.type === "toolCall" && evidence.length < MAX_EVIDENCE) {
						evidence.unshift(snippet(`${(block as { name?: string }).name}: ${JSON.stringify((block as { arguments?: unknown }).arguments)}`));
					}
				}
			} else if (entry.message.role === "toolResult" && evidence.length < MAX_EVIDENCE) {
				const text = messageText(entry.message.content).trim();
				if (text.length > 0) evidence.unshift(snippet(`result: ${text}`));
			}
		}
		return { userRequests, evidence };
	} catch {
		return { userRequests: [], evidence: [] };
	}
}

export function createRmGuard(pi: ExtensionAPI, getConfig: () => RmGuardConfig) {
	// Built lazily: the model registry is only reachable through the handler ctx.
	let backend: DecisionBackend | undefined;
	const getBackend = (ctx: { modelRegistry: unknown }): DecisionBackend => {
		const config = getConfig();
		const separator = config.classifier.indexOf("/");
		const classifierProvider = config.classifier.slice(0, separator);
		const classifierModelId = config.classifier.slice(separator + 1);
		return (backend ??= config.backend === "classifier"
				? createClassifierBackend(ctx.modelRegistry as never, {
						provider: classifierProvider,
						modelId: classifierModelId,
						apiKey: config.classifierApiKey,
						timeoutMs: config.timeoutMs,
						threshold: config.threshold,
					})
				: createDecisionsBackend({ url: config.decisionsUrl, model: config.decisionsModel, timeoutMs: config.timeoutMs, threshold: config.threshold, apiKey: config.providerApiKey }));
	};

	// Capture the current request at agent start.
	// It remains available even if the branch snapshot omits it.
	let currentPrompt = "";
	// Custom-message runs (pi.sendMessage with triggerTurn) carry no prompt:
	// keep the last captured one rather than clearing it.
	pi.on("before_agent_start", async (event) => {
		if (typeof event.prompt === "string") currentPrompt = event.prompt.trim();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command;
		if (typeof command !== "string" || !mayDeleteForceRecursive(command)) return undefined;

		const { userRequests, evidence } = sessionContext(ctx);
		const prompt = snippet(currentPrompt);
		if (prompt.length > 0 && userRequests[userRequests.length - 1] !== prompt) {
			userRequests.push(prompt);
		}
		userRequests.splice(0, Math.max(0, userRequests.length - MAX_USER_REQUESTS));
		let decision: DecisionOutcome | { error: string };
		try {
			decision = await getBackend(ctx).decide({ command, cwd: ctx.cwd, userRequests, evidence });
		} catch (error) {
			decision = { error: error instanceof Error ? error.message : String(error) };
		}

		if ("error" in decision) {
			return requireHuman(ctx, command, `decision model unavailable: ${decision.error}`, "model-error", userRequests, evidence);
		}

		pi.appendEntry("rm-guard", {
			command,
			backend: getBackend(ctx).name,
			userRequests,
			evidence,
			action: decision.action,
			probability: decision.probability,
			autoApproved: decision.action === "approve",
		});

		if (decision.action === "approve") {
			if (ctx.hasUI) ctx.ui.notify(`rm-guard auto-approved (${decision.probability.toFixed(2)}): ${command}`, "info");
			return undefined;
		}
		if (decision.action === "deny") {
			return { block: true, reason: `rm-guard: ${getBackend(ctx).name} denied (${decision.probability.toFixed(2)}): ${command}` };
		}

		return requireHuman(ctx, command, `model chose ${decision.label} (p=${decision.probability.toFixed(2)}) — deferring to human`, "model-ask", userRequests, evidence);
	});

	function requireHuman(
		ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } },
		command: string,
		reason: string,
		gate: string,
		userRequests: string[],
		evidence: string[],
	) {
		pi.appendEntry("rm-guard", { command, gate, reason, userRequests, evidence, autoApproved: false });
		if (!ctx.hasUI) {
			return { block: true, reason: `rm-guard: "${command}" requires approval and no UI is available (${reason})` };
		}
		return ctx.ui
			.confirm("rm-guard: approve this rm command?", `${command}\n\n${reason}`)
			.then((approved) => (approved ? undefined : { block: true, reason: "Blocked by user" }));
	}
}

export default function (pi: ExtensionAPI) {
	// Config (and provider registration) resolve lazily: getSettings() throws
	// during extension loading.
	let config: RmGuardConfig | undefined;
	const ensureConfig = (): RmGuardConfig => {
		if (!config) {
			config = resolveConfig(pi);
			if (config.registerProvider) {
				registerDecisionsProvider(pi, {
					baseUrl: config.decisionsUrl.replace(/\/decisions$/, ""),
					models: [config.decisionsModel],
					apiKey: config.providerApiKey,
					timeoutMs: config.timeoutMs,
				});
			}
		}
		return config;
	};
	createRmGuard(pi, () => ensureConfig());
}
