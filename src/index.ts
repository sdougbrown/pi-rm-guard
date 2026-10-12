import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClassifierBackend, createDecisionsBackend, type DecisionBackend } from "./backends.ts";
import { analyzeCommand } from "./guard.ts";
import { registerDecisionsProvider } from "./decisions-provider.ts";

export interface RmGuardConfig {
	/** "decisions": a /v1/decisions endpoint. "classifier": any pi-known classifier model. */
	backend: "decisions" | "classifier";
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

function readRmGuardSettings(pi: ExtensionAPI): RmGuardSettings | undefined {
	try {
		const settings = (pi as { getSettings?: () => { rmGuard?: RmGuardSettings } }).getSettings?.();
		return settings?.rmGuard;
	} catch {
		return undefined;
	}
}

/**
 * Precedence: environment variables > pi settings `rmGuard` block > defaults.
 * Env is the per-machine override; the settings block is the portable config.
 */
export function resolveConfig(pi: ExtensionAPI): RmGuardConfig {
	const settings = readRmGuardSettings(pi) ?? {};
	const env = (name: string): string | undefined => process.env[name];
	const str = (key: keyof RmGuardSettings, envName: string, fallback: string): string =>
		env(envName) ?? (settings[key] as string | undefined) ?? fallback;
	const num = (key: keyof RmGuardSettings, envName: string, fallback: number): number => {
		const raw = env(envName) ?? (settings[key] as number | undefined);
		return raw === undefined ? fallback : Number(raw);
	};

	return {
		backend: (env("RM_GUARD_BACKEND") as RmGuardConfig["backend"]) ?? (settings.backend as RmGuardConfig["backend"]) ?? "classifier",
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

function recentUserMessages(pi: ExtensionAPI, limit: number): string[] {
	try {
		const branch = pi.sessionManager.getBranch();
		const messages: string[] = [];
		for (let i = branch.length - 1; i >= 0 && messages.length < limit; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "user") {
				const content = entry.message.content;
				const text = typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
				if (text.trim().length > 0) messages.unshift(text.trim());
			}
		}
		return messages;
	} catch {
		return [];
	}
}

export function createRmGuard(pi: ExtensionAPI, getConfig: () => RmGuardConfig) {
	// Built lazily: the model registry is only reachable through the handler ctx.
	let backend: DecisionBackend | undefined;
	const getBackend = (ctx: { modelRegistry: unknown }): DecisionBackend => {
		const config = getConfig();
		const [classifierProvider, classifierModelId] = config.classifier.split("/");
		return (backend ??= config.backend === "classifier"
				? createClassifierBackend(ctx.modelRegistry as never, {
						provider: classifierProvider,
						modelId: classifierModelId,
						apiKey: config.classifierApiKey,
					})
				: createDecisionsBackend({ url: config.decisionsUrl, model: config.decisionsModel, timeoutMs: config.timeoutMs }));
	};

	// The current turn's user message is not yet in getBranch() when tool_call
	// fires, so the prompt is captured at agent start and used as the intent.
	let currentPrompt = "";
	pi.on("before_agent_start", async (event) => {
		currentPrompt = event.prompt.trim();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command;
		if (typeof command !== "string") return undefined;

		const analysis = analyzeCommand(command, ctx.cwd);
		if (analysis.kind === "absent") return undefined;
		if (analysis.kind === "deny") {
			pi.appendEntry("rm-guard", { command, gate: "denied", reason: analysis.reason, intent: [], autoApproved: false });
			return { block: true, reason: `rm-guard: auto-denied — ${analysis.reason}` };
		}
		if (analysis.kind === "defer") {
			return requireHuman(ctx, command, analysis.reason, "ineligible", []);
		}

		const recent = recentUserMessages(pi, 2);
		const intentParts = [...recent, currentPrompt].filter((m) => m.length > 0 && !recent.includes(m));
		const intent = intentParts.join(" | ") || "(no recent user request in session)";
		const decision = await getBackend(ctx).decide({ command, intent, targets: analysis.targets });

		if ("error" in decision) {
			return requireHuman(ctx, command, `decision model unavailable: ${decision.error}`, "model-error", [intent]);
		}

		pi.appendEntry("rm-guard", {
			command,
			backend: getBackend(ctx).name,
			intent,
			action: decision.action,
			probability: decision.probability,
			targets: analysis.targets,
			autoApproved: decision.action === "approve",
		});

		if (decision.action === "approve") {
			if (ctx.hasUI) ctx.ui.notify(`rm-guard auto-approved (${decision.probability.toFixed(2)}): ${command}`, "info");
			return undefined;
		}
		if (decision.action === "deny") {
			return { block: true, reason: `rm-guard: ${getBackend(ctx).name} denied (${decision.probability.toFixed(2)}): ${command}` };
		}

		return requireHuman(ctx, command, `${getBackend(ctx).name} confidence ${decision.probability.toFixed(2)}`, "low-confidence", [intent]);
	});

	function requireHuman(
		ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } },
		command: string,
		reason: string,
		gate: string,
		intent: string[],
	) {
		pi.appendEntry("rm-guard", { command, gate, reason, intent, autoApproved: false });
		if (!ctx.hasUI) {
			return { block: true, reason: `rm-guard: "${command}" requires approval and no UI is available (${reason})` };
		}
		return ctx.ui
			.confirm("rm-guard: approve recursive delete?", `${command}\n\n${reason}`)
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
				});
			}
		}
		return config;
	};
	createRmGuard(pi, () => ensureConfig());
}
