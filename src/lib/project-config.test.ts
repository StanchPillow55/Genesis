import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject, loadProjectConfig, parseProjectConfig, suggestProjectConfig } from "./project-config";

test("init suggests npm test from package.json and does not infer at runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-init-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node check.js" } }),
    );
    const suggested = suggestProjectConfig(root);
    assert.deepEqual(suggested.config.verify.commands, ["npm test"]);
    assert.match(suggested.reasons.join(" "), /package.json/);
    assert.equal(loadProjectConfig(root), null);

    const wrote = initProject(root);
    assert.equal(wrote.config.verify.commands[0], "npm test");
    assert.equal(wrote.config.accept, "branch");
    assert.equal(wrote.config.delete, "require-approval");
    const loaded = loadProjectConfig(root);
    assert.deepEqual(loaded?.verify.commands, ["npm test"]);
    assert.equal(await readFile(wrote.file, "utf8").then((text) => text.includes(root)), false);
    assert.throws(() => initProject(root), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init suggests pytest from Python metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-py-"));
  try {
    await writeFile(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    const suggested = suggestProjectConfig(root);
    assert.deepEqual(suggested.config.verify.commands, ["pytest"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid config names the field", () => {
  assert.throws(() => parseProjectConfig("version: 1\nagent:\n  provider: gemini\n"), /verify/);
  assert.throws(
    () =>
      parseProjectConfig(`version: 1
agent:
  provider: gemini
verify:
  commands: []
write:
  globs:
    - "**/*"
delete: require-approval
attempts: 4
accept: branch
`),
    /verify.commands/,
  );
  assert.throws(
    () =>
      parseProjectConfig(`version: 1
agent:
  provider: other
verify:
  commands:
    - npm test
write:
  globs:
    - "**/*"
delete: require-approval
attempts: 4
accept: branch
`),
    /agent.provider/,
  );
  assert.throws(
    () =>
      parseProjectConfig(`version: 1
agent:
  provider: gemini
verify:
  commands:
    - npm test
write:
  globs:
    - "**/*"
delete: sometimes
attempts: 4
accept: branch
`),
    /delete/,
  );
});
