import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mayDeleteForceRecursive } from "../src/detect.ts";

test("routes recursive-force rm in every flag arrangement", () => {
	assert.equal(mayDeleteForceRecursive("rm -rf node_modules"), true, "rm -rf node_modules");
	assert.equal(mayDeleteForceRecursive("rm -fr dist"), true, "rm -fr dist");
	assert.equal(mayDeleteForceRecursive("rm -r -f build"), true, "rm -r -f build");
	assert.equal(mayDeleteForceRecursive("rm -Rf cache"), true, "rm -Rf cache");
	assert.equal(mayDeleteForceRecursive("rm --recursive --force tmp"), true, "rm --recursive --force tmp");
	assert.equal(mayDeleteForceRecursive("rm tmp -rf"), true, "rm tmp -rf");
});

test("routes recursive-force rm behind paths, prefixes, and pipes", () => {
	assert.equal(mayDeleteForceRecursive("/bin/rm -rf /tmp/x"), true, "/bin/rm -rf /tmp/x");
	assert.equal(mayDeleteForceRecursive("sudo rm -rf /var/log"), true, "sudo rm -rf /var/log");
	assert.equal(mayDeleteForceRecursive("find . -name '*.js' | xargs rm -rf"), true, "find . -name '*.js' | xargs rm -rf");
	assert.equal(mayDeleteForceRecursive("sh -c 'rm -rf build'"), true, "sh -c 'rm -rf build'");
	assert.equal(mayDeleteForceRecursive("out=$(rm -rf dist)"), true, "out=$(rm -rf dist)");
	assert.equal(mayDeleteForceRecursive("cat <<EOF\nrm -rf build\nEOF"), true, "cat <<EOF\nrm -rf build\nEOF");
});

test("routes recursive-force rm that a partial parser would miss", () => {
	assert.equal(mayDeleteForceRecursive("rm -r $(x; echo y) -f"), true, "rm -r $(x; echo y) -f");
	assert.equal(mayDeleteForceRecursive("rm -r a\\;b -f"), true, "rm -r a\\;b -f");
	assert.equal(mayDeleteForceRecursive("rm -r dir &> log -f"), true, "rm -r dir &> log -f");
	assert.equal(mayDeleteForceRecursive("rm -r 2>&1 -f"), true, "rm -r 2>&1 -f");
	assert.equal(mayDeleteForceRecursive('rm -r "a&b" -f'), true, 'rm -r "a&b" -f');
	assert.equal(mayDeleteForceRecursive("rm -r 'a;b' -f"), true, "rm -r 'a;b' -f");
	assert.equal(mayDeleteForceRecursive("rm '-r' '-f' build"), true, "rm '-r' '-f' build");
});

test("routes unambiguous long-option prefixes", () => {
	assert.equal(mayDeleteForceRecursive("rm --rec -f dir"), true);
	assert.equal(mayDeleteForceRecursive("rm -r --fo dir"), true);
	assert.equal(mayDeleteForceRecursive("rm --rec=x --force dir"), true);
	assert.equal(mayDeleteForceRecursive("rm --recursion-hint -f dir"), false);
});

test("routes recursive-force rm with variable, glob, and outside-cwd targets", () => {
	assert.equal(mayDeleteForceRecursive("rm -rf $BUILD_DIR"), true, "rm -rf $BUILD_DIR");
	assert.equal(mayDeleteForceRecursive("rm -rf ${TMPDIR}/x"), true, "rm -rf ${TMPDIR}/x");
	assert.equal(mayDeleteForceRecursive("rm -rf build-*"), true, "rm -rf build-*");
	assert.equal(mayDeleteForceRecursive("rm -rf /etc/nginx/conf.d"), true, "rm -rf /etc/nginx/conf.d");
	assert.equal(mayDeleteForceRecursive("rm -rf ../sibling/output"), true, "rm -rf ../sibling/output");
});

test("over-routes flag-like text near rm rather than missing a route", () => {
	assert.equal(mayDeleteForceRecursive("rm -r x; rm -f y"), true, "rm -r x; rm -f y");
	assert.equal(mayDeleteForceRecursive("ls -rf; rm tmp"), true, "ls -rf; rm tmp");
	assert.equal(mayDeleteForceRecursive("rm -- -rf"), true, "rm -- -rf");
});

test("does not route plain or partial-flag rm", () => {
	assert.equal(mayDeleteForceRecursive("rm dist/foo.txt"), false, "rm dist/foo.txt");
	assert.equal(mayDeleteForceRecursive("rm"), false, "rm");
	assert.equal(mayDeleteForceRecursive("rm -f build.log"), false, "rm -f build.log");
	assert.equal(mayDeleteForceRecursive("rm -r dist"), false, "rm -r dist");
	assert.equal(mayDeleteForceRecursive("rm -i notes.txt"), false, "rm -i notes.txt");
	assert.equal(mayDeleteForceRecursive("rm ~/notes/old.txt"), false, "rm ~/notes/old.txt");
	assert.equal(mayDeleteForceRecursive("git rm --cached config.json"), false, "git rm --cached config.json");
});

test("does not route rm in other commands' words", () => {
	assert.equal(mayDeleteForceRecursive("grep -rf pattern src"), false, "grep -rf pattern src");
	assert.equal(mayDeleteForceRecursive("echo firmwarm confirm"), false, "echo firmwarm confirm");
	assert.equal(mayDeleteForceRecursive("./rmtool --all"), false, "./rmtool --all");
	assert.equal(mayDeleteForceRecursive("echo 'run rm later'"), false, "echo 'run rm later'");
});

test("passes commands without candidate rm text", () => {
	assert.equal(mayDeleteForceRecursive("ls -la"), false, "ls -la");
	assert.equal(mayDeleteForceRecursive("npm test"), false, "npm test");
	assert.equal(mayDeleteForceRecursive('git commit -m "confirm the fix"'), false, 'git commit -m "confirm the fix"');
	assert.equal(mayDeleteForceRecursive('find "/home/user/pi-rm-guard/victim" -name marker -delete'), false, 'find "/home/user/pi-rm-guard/victim" -name marker -delete');
});
