import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveConfig, type RmGuardSettings } from "../src/index.ts";

function fakePi(settings: { rmGuard?: RmGuardSettings }) {
	return { getSettings: () => settings };
}

test("defaults: classifier backend with jev", () => {
	const c = resolveConfig(fakePi({}));
	assert.equal(c.backend, "classifier");
	assert.equal(c.classifier, "typesafe/jev-latest");
	assert.equal(c.decisionsUrl, "http://localhost:4000/v1/decisions");
	assert.equal(c.registerProvider, false);
});

test("settings block overrides defaults", () => {
	const c = resolveConfig(fakePi({
		rmGuard: { backend: "decisions", url: "http://grace:4000/v1/decisions", model: "gemma4", registerProvider: true, threshold: 0.9, timeoutMs: 500 },
	}));
	assert.equal(c.backend, "decisions");
	assert.equal(c.decisionsUrl, "http://grace:4000/v1/decisions");
	assert.equal(c.decisionsModel, "gemma4");
	assert.equal(c.registerProvider, true);
	assert.equal(c.threshold, 0.9);
	assert.equal(c.timeoutMs, 500);
});

test("env overrides settings", async () => {
	process.env.RM_GUARD_BACKEND = "decisions";
	process.env.RM_GUARD_MODEL = "other";
	process.env.RM_GUARD_THRESHOLD = "0.97";
	try {
		const c = resolveConfig(fakePi({ rmGuard: { backend: "classifier", model: "gemma4", threshold: 0.2 } }));
		assert.equal(c.backend, "decisions");
		assert.equal(c.decisionsModel, "other");
		assert.equal(c.threshold, 0.97);
	} finally {
		delete process.env.RM_GUARD_BACKEND;
		delete process.env.RM_GUARD_MODEL;
		delete process.env.RM_GUARD_THRESHOLD;
	}
});

test("unknown explicit backends are configuration errors, not another engine", () => {
	assert.throws(() => resolveConfig(fakePi({ rmGuard: { backend: "classifer" } })), /classifer/);
	process.env.RM_GUARD_BACKEND = "decison";
	try {
		assert.throws(() => resolveConfig(fakePi({ rmGuard: { backend: "classifier" } })), /decison/);
	} finally {
		delete process.env.RM_GUARD_BACKEND;
	}
});

test("missing getSettings is tolerated", () => {
	const c = resolveConfig({} as never);
	assert.equal(c.backend, "classifier");
});

test("a throwing getSettings falls back to defaults instead of propagating", () => {
	const c = resolveConfig({ getSettings: () => { throw new Error("settings not yet loaded"); } } as never);
	assert.equal(c.backend, "classifier");
	assert.equal(c.classifier, "typesafe/jev-latest");
	assert.equal(c.decisionsUrl, "http://localhost:4000/v1/decisions");
});

test("legacy key-file fallback: trimmed key from $HOME/.secrets/jev.key", () => {
	const tmpHome = mkdtempSync(join(tmpdir(), "rm-guard-home-"));
	const keyFile = join(tmpHome, ".secrets", "jev.key");
	const savedHome = process.env.HOME;
	const savedKey = process.env.TYPESAFE_API_KEY;
	try {
		mkdirSync(dirname(keyFile), { recursive: true });
		delete process.env.TYPESAFE_API_KEY;
		process.env.HOME = tmpHome;
		writeFileSync(keyFile, "  jev-secret-key-123  \n");
		assert.equal(resolveConfig(fakePi({})).classifierApiKey, "jev-secret-key-123");
		writeFileSync(keyFile, "   \n\t\n");
		assert.equal(resolveConfig(fakePi({})).classifierApiKey, undefined);
	} finally {
		if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = savedKey;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(tmpHome, { recursive: true, force: true });
	}
});
