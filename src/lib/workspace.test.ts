import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PRESET_GOAL, compileWithFallback } from "./contract";
import { loadSeedProject } from "./sample-project";
import { runShellCommand } from "./shell";
import { createFsWorkspace } from "./workspace-fs";
import { createMemoryWorkspace, policyFromContract } from "./workspace";

const seed = loadSeedProject();

test("policy runs before a write, delete, or command on the signup fixture", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  let shellCalls = 0;
  const workspace = createMemoryWorkspace({
    files: {
      "validator.ts": seed.validator,
      "signup.test.ts": seed.tests,
      "legacy-helper.ts": seed.helper,
    },
    policy: policyFromContract(contract),
    shell: async (command) => {
      shellCalls += 1;
      return runShellCommand(command, { timeoutMs: 15_000 });
    },
  });

  const escaped = await workspace.read("../package.json");
  assert.equal(escaped.ok, false);
  if (!escaped.ok) assert.equal(escaped.decision, "deny");

  const blocked = await workspace.write("signup.test.ts", "export {}");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.decision, "deny");
  const tests = await workspace.read("signup.test.ts");
  assert.equal(tests.ok, true);
  if (tests.ok) assert.equal(tests.value, seed.tests);

  const asked = await workspace.delete("legacy-helper.ts");
  assert.equal(asked.ok, false);
  if (!asked.ok) assert.equal(asked.decision, "ask");
  const helper = await workspace.read("legacy-helper.ts");
  assert.equal(helper.ok, true);

  const removed = await workspace.delete("legacy-helper.ts", { approved: true });
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.value.deleted, true);
  await assert.rejects(() => workspace.read("legacy-helper.ts"));

  const written = await workspace.write(
    "validator.ts",
    seed.validator.replace("password.length >= 4", "password.length >= 8"),
  );
  assert.equal(written.ok, true);
  const diff = await workspace.diff("validator.ts");
  assert.equal(diff.ok, true);
  if (diff.ok) assert.match(diff.value, /\+ {2}return password.length >= 8;/);
  const status = await workspace.status();
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.value.files.find((file) => file.path === "validator.ts")?.state, "modified");
    assert.equal(status.value.files.find((file) => file.path === "legacy-helper.ts")?.state, "deleted");
    assert.equal(status.value.files.find((file) => file.path === "signup.test.ts")?.state, "unchanged");
  }

  const deniedCommand = await workspace.exec("npm test");
  assert.equal(deniedCommand.ok, false);
  assert.equal(shellCalls, 0);

  contract.verifier = { commands: [{ type: "shell", command: "node -e \"process.exit(0)\"" }] };
  const allowedWorkspace = createMemoryWorkspace({
    files: { "validator.ts": seed.validator },
    policy: policyFromContract(contract),
    shell: async (command) => {
      shellCalls += 1;
      return runShellCommand(command, { timeoutMs: 15_000 });
    },
  });
  const allowed = await allowedWorkspace.exec("node -e \"process.exit(0)\"");
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.value.exitCode, 0);
  assert.equal(shellCalls, 1);
});

test("filesystem workspace writes, diffs, and execs inside its root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-workspace-"));
  try {
    const contract = compileWithFallback(PRESET_GOAL).contract;
    const workspace = createFsWorkspace({
      root,
      policy: policyFromContract({
        ...contract,
        policies: { modifyTests: "deny", delete: "allow", editSource: "allow" },
        verifier: { commands: [{ type: "shell", command: "node -e \"process.exit(0)\"" }] },
      }),
      timeoutMs: 15_000,
    });

    const written = await workspace.write("note.txt", "hello\n");
    assert.equal(written.ok, true);
    const read = await workspace.read("note.txt");
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value, "hello\n");
    const diff = await workspace.diff("note.txt");
    assert.equal(diff.ok, true);
    if (diff.ok) assert.match(diff.value, /\+hello/);

    const outside = await workspace.read("../package.json");
    assert.equal(outside.ok, false);

    const removed = await workspace.delete("note.txt");
    assert.equal(removed.ok, true);
    const status = await workspace.status();
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.value.files.find((file) => file.path === "note.txt")?.state, "deleted");

    const exec = await workspace.exec("node -e \"process.exit(0)\"");
    assert.equal(exec.ok, true);
    if (exec.ok) assert.equal(exec.value.exitCode, 0);
    const blocked = await workspace.exec("node -e \"process.exit(1)\"");
    assert.equal(blocked.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
