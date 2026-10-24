import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mayDeleteForceRecursive } from "../src/detect.ts";

test("routes recursive-force rm in every flag arrangement", () => {
	assert.equal(mayDeleteForceRecursive("rm -rf node_modules"), true);
	assert.equal(mayDeleteForceRecursive("rm -fr dist"), true);
	assert.equal(mayDeleteForceRecursive("rm -r -f build"), true);
	assert.equal(mayDeleteForceRecursive("rm -Rf cache"), true);
	assert.equal(mayDeleteForceRecursive("rm --recursive --force tmp"), true);
	assert.equal(mayDeleteForceRecursive("rm tmp -rf"), true);
});

test("routes recursive-force rm behind paths, prefixes, and pipes", () => {
	assert.equal(mayDeleteForceRecursive("/bin/rm -rf /tmp/x"), true);
	assert.equal(mayDeleteForceRecursive("sudo rm -rf /var/log"), true);
	assert.equal(mayDeleteForceRecursive("find . -name '*.js' | xargs rm -rf"), true);
	assert.equal(mayDeleteForceRecursive("sh -c 'rm -rf build'"), true);
	assert.equal(mayDeleteForceRecursive("out=$(rm -rf dist)"), true);
	assert.equal(mayDeleteForceRecursive("cat <<EOF\nrm -rf build\nEOF"), true);
});

test("routes recursive-force rm with variable, glob, and outside-cwd targets", () => {
	assert.equal(mayDeleteForceRecursive("rm -rf $BUILD_DIR"), true);
	assert.equal(mayDeleteForceRecursive("rm -rf ${TMPDIR}/x"), true);
	assert.equal(mayDeleteForceRecursive("rm -rf build-*"), true);
	assert.equal(mayDeleteForceRecursive("rm -rf /etc/nginx/conf.d"), true);
	assert.equal(mayDeleteForceRecursive("rm -rf ../sibling/output"), true);
});

test("does not route plain or partial-flag rm", () => {
	assert.equal(mayDeleteForceRecursive("rm dist/foo.txt"), false);
	assert.equal(mayDeleteForceRecursive("rm"), false);
	assert.equal(mayDeleteForceRecursive("rm -f build.log"), false);
	assert.equal(mayDeleteForceRecursive("rm -r dist"), false);
	assert.equal(mayDeleteForceRecursive("rm -i notes.txt"), false);
	assert.equal(mayDeleteForceRecursive("rm -- -rf"), false);
	assert.equal(mayDeleteForceRecursive("rm ~/notes/old.txt"), false);
	assert.equal(mayDeleteForceRecursive("git rm --cached config.json"), false);
});

test("does not route rm in other commands' flags or words", () => {
	assert.equal(mayDeleteForceRecursive("ls -rf; rm tmp"), false);
	assert.equal(mayDeleteForceRecursive("grep -rf pattern src"), false);
	assert.equal(mayDeleteForceRecursive("echo firmwarm confirm"), false);
	assert.equal(mayDeleteForceRecursive("./rmtool --all"), false);
	assert.equal(mayDeleteForceRecursive("echo 'run rm later'"), false);
});

test("passes commands without candidate rm text", () => {
	assert.equal(mayDeleteForceRecursive("ls -la"), false);
	assert.equal(mayDeleteForceRecursive("npm test"), false);
	assert.equal(mayDeleteForceRecursive('git commit -m "confirm the fix"'), false);
	assert.equal(mayDeleteForceRecursive('find "/home/user/pi-rm-guard/victim" -name marker -delete'), false);
});
