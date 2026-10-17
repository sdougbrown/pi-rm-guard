import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRmGuard, type RmGuardConfig } from "../src/index.ts";
import type { DecisionInput } from "../src/backends.ts";

function branchEntry(message: unknown) {
	return { type: "message", id: "e", parentId: null, timestamp: "t", message };
}

function defaultBranch() {
	return [
		branchEntry({ role: "user", content: "please clean up the build artifacts" }),
		branchEntry({
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "du -sh node_modules" } }],
		}),
		branchEntry({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "2.1G node_modules" }] }),
	];
}

interface HarnessOptions {
	probabilities?: { approve: number; ask: number; deny: number };
	classifyError?: string;
	hasUI?: boolean;
	uiApprove?: boolean;
	threshold?: number;
	prompt?: string;
	command: string;
	branch?: unknown[];
	delayMs?: number;
	timeoutMs?: number;
	classifier?: string;
}

function harness(options: HarnessOptions) {
	const { probabilities = { approve: 0.9, ask: 0.05, deny: 0.05 }, command } = options;
	const appended: unknown[] = [];
	const stateCaptures: Record<string, unknown>[] = [];
	let confirmCalls = 0;
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
			handlers[name] = fn;
		},
		appendEntry(_type: string, data: unknown) {
			appended.push(data);
		},
	};
	const registry = {
		findOfType: (_type: string, provider: string, id: string) => {
			assert.equal(`${provider}/${id}`, options.classifier ?? "typesafe/jev-latest");
			return { id };
		},
		classify: async (_model: unknown, callCtx: { state: Record<string, unknown> }) => {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.classifyError) throw new Error(options.classifyError);
			stateCaptures.push(callCtx.state);
			return { answers: { action: { probabilities } }, stopReason: "stop" };
		},
	};
	const ctx = {
		cwd: "/repo",
		hasUI: options.hasUI ?? true,
		ui: {
			confirm: async () => {
				confirmCalls++;
				return options.uiApprove ?? true;
			},
			notify: () => {},
		},
		sessionManager: { getBranch: () => options.branch ?? defaultBranch() },
		modelRegistry: registry,
	};
	const config: RmGuardConfig = {
		backend: "classifier",
		classifier: options.classifier ?? "typesafe/jev-latest",
		classifierApiKey: undefined,
		decisionsUrl: "http://unused/v1/decisions",
		decisionsModel: "m",
		timeoutMs: options.timeoutMs ?? 1000,
		threshold: options.threshold,
		registerProvider: false,
		providerApiKey: undefined,
	};
	createRmGuard(pi as never, () => config);
	return {
		ctx,
		decide: async () => {
			await handlers.before_agent_start({ prompt: options.prompt ?? "clean the build cache" }, ctx);
			return handlers.tool_call({ toolName: "bash", input: { command } }, ctx);
		},
		callTool: async (toolName: string, command: string) => {
			return handlers.tool_call({ toolName, input: { command } }, ctx);
		},
		appended,
		stateCaptures,
		get confirmCount() {
			return confirmCalls;
		},
	};
}

test("non-rm commands pass untouched without consulting the model", async () => {
	const h = harness({ command: "ls -la" });
	const result = await h.decide();
	assert.equal(result, undefined);
	assert.equal(h.stateCaptures.length, 0);
});

test("variable, glob, home, and outside-cwd rm reach the decision model", async () => {
	for (const command of ["rm -rf $BUILD_DIR", "rm -rf build-*", "rm -rf ~/notes/old", "rm -rf /etc/nginx/conf.d"]) {
		const h = harness({ command });
		assert.equal(await h.decide(), undefined, command);
		assert.equal(h.confirmCount, 0, command);
		assert.equal(h.stateCaptures.length, 1, command);
	}
});

test("decision input carries raw command, cwd, user requests, and session evidence", async () => {
	const h = harness({ command: "rm -rf $BUILD_DIR" });
	await h.decide();
	const state = h.stateCaptures[0] as DecisionInput & { description: string };
	assert.equal(state.command, "rm -rf $BUILD_DIR");
	assert.equal(state.cwd, "/repo");
	assert.ok(state.userRequests.includes("clean the build cache"), "includes current prompt");
	assert.ok(state.userRequests.includes("please clean up the build artifacts"), "includes branch user message");
	assert.ok(state.evidence.some((e) => e.includes("du -sh node_modules")), "includes tool call");
	assert.ok(state.evidence.some((e) => e.includes("2.1G node_modules")), "includes tool result");
});

test("model approve passes the command through", async () => {
	const h = harness({ command: "rm -rf node_modules", probabilities: { approve: 0.95, ask: 0.03, deny: 0.02 } });
	assert.equal(await h.decide(), undefined);
	assert.equal(h.confirmCount, 0);
});

test("confident model deny blocks the command", async () => {
	const h = harness({ command: "rm -rf src", probabilities: { approve: 0.001, ask: 0.001, deny: 0.998 } });
	const result = (await h.decide()) as { block: boolean; reason: string };
	assert.equal(result.block, true);
	assert.equal(h.confirmCount, 0);
});

test("model ask defers to confirm UI; user decision controls the result", async () => {
	const approved = harness({ command: "rm -rf notes", probabilities: { approve: 0.1, ask: 0.85, deny: 0.05 }, uiApprove: true });
	assert.equal(await approved.decide(), undefined);
	assert.equal(approved.confirmCount, 1);

	const rejected = harness({ command: "rm -rf notes", probabilities: { approve: 0.1, ask: 0.85, deny: 0.05 }, uiApprove: false });
	const result = (await rejected.decide()) as { block: boolean };
	assert.equal(result.block, true);
	assert.equal(rejected.confirmCount, 1);
});

test("below-threshold approve defers to the human (RM_GUARD_THRESHOLD honored)", async () => {
	const h = harness({ command: "rm -rf dist", probabilities: { approve: 0.85, ask: 0.1, deny: 0.05 }, threshold: 0.9 });
	const result = (await h.decide()) as { block?: boolean };
	assert.equal(h.confirmCount, 1);
	// user approves the deferred command
	assert.equal(result, undefined);
});

test("model error defers to confirm UI, blocks when no UI", async () => {
	const withUI = harness({ command: "rm -rf dist", classifyError: "rate limited" });
	assert.equal(await withUI.decide(), undefined);
	assert.equal(withUI.confirmCount, 1);

	const noUI = harness({ command: "rm -rf dist", classifyError: "rate limited", hasUI: false });
	const result = (await noUI.decide()) as { block: boolean; reason: string };
	assert.equal(result.block, true);
	assert.match(result.reason, /rate limited/);
});

test("model ask blocks when no UI is available", async () => {
	const h = harness({ command: "rm -rf notes", probabilities: { approve: 0.1, ask: 0.85, deny: 0.05 }, hasUI: false });
	const result = (await h.decide()) as { block: boolean };
	assert.equal(result.block, true);
});

test("classifier ids containing slashes reach the registry intact", async () => {
	const h = harness({ command: "rm -rf dist", classifier: "openrouter/typesafe/jev-1.13" });
	assert.equal(await h.decide(), undefined);
	assert.equal(h.stateCaptures.length, 1);
});

test("configured classifier timeout escalates instead of accepting a late approval", async () => {
	const h = harness({ command: "rm -rf dist", delayMs: 40, timeoutMs: 5, hasUI: false });
	const result = await h.decide() as { block: boolean; reason: string };
	assert.equal(result?.block, true);
	assert.match(result.reason, /timed out/);
});

test("long requests retain the actual trailing instruction", async () => {
	const h = harness({ command: "rm -rf $CACHE", prompt: "background context ".repeat(500) + "remove the generated cache, but keep my source files" });
	await h.decide();
	assert.match(JSON.stringify(h.stateCaptures[0].userRequests), /keep my source files/);
});

test("tool calls keep their order in the model evidence", async () => {
	const h = harness({ command: "rm -rf dist", branch: [branchEntry({ role: "assistant", content: [
		{ type: "toolCall", name: "bash", arguments: { command: "git status" } },
		{ type: "toolCall", name: "bash", arguments: { command: "du -sh dist" } },
	] })] });
	await h.decide();
	const evidence = h.stateCaptures[0].evidence as string[];
	assert.match(evidence[0], /git status/);
	assert.match(evidence[1], /du -sh dist/);
});

test("non-bash tool calls pass untouched", async () => {
	const h = harness({ command: "anything" });
	const result = await h.callTool("edit", "rm -rf dist");
	assert.equal(result, undefined);
	assert.equal(h.stateCaptures.length, 0);
});
