import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mayInvokeRm } from "../src/detect.ts";

test("routes plain recursive and nonrecursive rm", () => {
	assert.equal(mayInvokeRm("rm -rf node_modules"), true);
	assert.equal(mayInvokeRm("rm dist/foo.txt"), true);
	assert.equal(mayInvokeRm("rm"), true);
});

test("routes rm behind paths, prefixes, and pipes", () => {
	assert.equal(mayInvokeRm("/bin/rm -rf /tmp/x"), true);
	assert.equal(mayInvokeRm("sudo rm -rf /var/log"), true);
	assert.equal(mayInvokeRm("find . -name '*.js' | xargs rm"), true);
	assert.equal(mayInvokeRm("sh -c 'rm -rf build'"), true);
	assert.equal(mayInvokeRm("git rm --cached config.json"), true);
});

test("routes rm inside quotes, substitutions, and heredocs", () => {
	assert.equal(mayInvokeRm('echo "rm -rf /tmp/cache"'), true);
	assert.equal(mayInvokeRm("echo 'run rm later'"), true);
	assert.equal(mayInvokeRm("out=$(rm -rf dist)"), true);
	assert.equal(mayInvokeRm("cat <<EOF\nrm -rf build\nEOF"), true);
});

test("routes variable, glob, and outside-cwd deletion forms conservatively", () => {
	assert.equal(mayInvokeRm("rm -rf $BUILD_DIR"), true);
	assert.equal(mayInvokeRm("rm -rf ${TMPDIR}/x"), true);
	assert.equal(mayInvokeRm("rm -rf build-*"), true);
	assert.equal(mayInvokeRm("rm ~/notes/old.txt"), true);
	assert.equal(mayInvokeRm("rm -rf /etc/nginx/conf.d"), true);
	assert.equal(mayInvokeRm("rm -rf ../sibling/output"), true);
});

test("passes commands without candidate rm text", () => {
	assert.equal(mayInvokeRm("ls -la"), false);
	assert.equal(mayInvokeRm("npm test"), false);
	assert.equal(mayInvokeRm('git commit -m "confirm the fix"'), false);
	assert.equal(mayInvokeRm("grep -r pattern src"), false);
	assert.equal(mayInvokeRm("echo firmwarm confirm"), false);
	assert.equal(mayInvokeRm("./rmtool --all"), false);
	assert.equal(mayInvokeRm('find "/home/user/pi-rm-guard/victim" -name marker -delete'), false);
});
