import { strict as assert } from "node:assert";
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
	try {
		const c = resolveConfig(fakePi({ rmGuard: { backend: "classifier", model: "gemma4" } }));
		assert.equal(c.backend, "decisions");
		assert.equal(c.decisionsModel, "other");
	} finally {
		delete process.env.RM_GUARD_BACKEND;
		delete process.env.RM_GUARD_MODEL;
	}
});

test("missing getSettings is tolerated", () => {
	const c = resolveConfig({} as never);
	assert.equal(c.backend, "classifier");
});
