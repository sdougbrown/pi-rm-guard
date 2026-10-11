import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDecisionsBackend, createJevBackend, type DecisionBackend } from "./backends.ts";
import { analyzeCommand } from "./guard.ts";

export interface RmGuardConfig {
	backend: "decisions" | "jev";
	threshold?: number;
	decisionsUrl: string;
	decisionsModel: string;
	timeoutMs: number;
	jevModelId: string;
	jevApiKey: string | undefined;
}

export function configFromEnv(): RmGuardConfig {
	return {
		backend: (process.env.RM_GUARD_BACKEND as RmGuardConfig["backend"]) ?? "decisions",
		threshold: process.env.RM_GUARD_THRESHOLD ? Number(process.env.RM_GUARD_THRESHOLD) : undefined,
		decisionsUrl: process.env.RM_GUARD_URL ?? "http://localhost:4000/v1/decisions",
		decisionsModel: process.env.RM_GUARD_MODEL ?? "gemma4",
		timeoutMs: Number(process.env.RM_GUARD_TIMEOUT_MS ?? "1500"),
		jevModelId: process.env.RM_GUARD_JEV_MODEL ?? "jev-latest",
		jevApiKey: process.env.TYPESAFE_API_KEY ?? readKeyFile(process.env.RM_GUARD_JEV_KEY_FILE ?? "~/.secrets/jev.key"),
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

export function createRmGuard(pi: ExtensionAPI, config: RmGuardConfig) {
	const backend: DecisionBackend =
		config.backend === "jev"
			? createJevBackend(pi.modelRegistry, { modelId: config.jevModelId, apiKey: config.jevApiKey })
			: createDecisionsBackend({ url: config.decisionsUrl, model: config.decisionsModel, timeoutMs: config.timeoutMs });
	const threshold = config.threshold ?? backend.defaultThreshold;

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
		if (analysis.kind === "defer") {
			return requireHuman(ctx, command, analysis.reason, "ineligible", []);
		}

		const recent = recentUserMessages(pi, 2);
		const intentParts = [...recent, currentPrompt].filter((m) => m.length > 0 && !recent.includes(m));
		const intent = intentParts.join(" | ") || "(no recent user request in session)";
		const decision = await backend.decide({ command, intent });

		if ("error" in decision) {
			return requireHuman(ctx, command, `decision model unavailable: ${decision.error}`, "model-error", [intent]);
		}

		pi.appendEntry("rm-guard", {
			command,
			backend: backend.name,
			intent,
			probability: decision.probability,
			targets: analysis.targets,
			autoApproved: decision.probability >= threshold,
		});

		if (decision.probability >= threshold) {
			if (ctx.hasUI) ctx.ui.notify(`rm-guard auto-approved (${decision.probability.toFixed(2)}): ${command}`, "info");
			return undefined;
		}

		return requireHuman(ctx, command, `${backend.name} confidence ${decision.probability.toFixed(2)} < ${threshold}`, "low-confidence", [intent]);
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
	createRmGuard(pi, configFromEnv());
}
