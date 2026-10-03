import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_GOAL, compileWithFallback } from "./contract";
import type { ProjectConfig } from "./project-config";
import { compileForProject } from "./project-compile";
import { createMemoryWorkspace, policyFromContract } from "./workspace";

const config: ProjectConfig = {
  version: 1,
  agent: { provider: "gemini" },
  verify: { commands: ["pytest"] },
  write: { globs: ["src/**"] },
  delete: "deny",
  attempts: 3,
  accept: "branch",
};

test("the sample project still yields the fixture contract", () => {
  const compiled = compileForProject({ goal: PRESET_GOAL, kind: "sample", config: null });
  assert.deepEqual(compiled.contract, compileWithFallback(PRESET_GOAL).contract);
  assert.deepEqual(compiled.contract.verifier, { commands: [{ type: "fixture", id: "signup" }] });
  assert.equal(compiled.contract.uncertainty, null);
});

test("config supplies the verifier and overrides a model command", () => {
  const model = compileWithFallback("Make the repo healthy when npm test and npm run build both succeed.").contract;
  const compiled = compileForProject({
    goal: "Fix the currently failing tests.",
    kind: "project",
    config,
    model,
  });
  assert.equal(compiled.contract.uncertainty, null);
  assert.equal(compiled.contract.goal, model.goal);
  assert.deepEqual(compiled.contract.verifier.commands, [{ type: "shell", command: "pytest" }]);
  assert.equal(compiled.contract.maxAttempts, 3);
  assert.equal(compiled.contract.policies.delete, "deny");
  assert.deepEqual(compiled.contract.writeGlobs, ["src/**"]);
  assert.equal(compiled.contract.acceptStrategy, "branch");
  assert.match(compiled.notes.join(" "), /overrides model-inferred/);
});

test("an unclear goal still sets uncertainty when config exists", () => {
  const compiled = compileForProject({ goal: "hello there", kind: "project", config });
  assert.ok(compiled.contract.uncertainty);
  assert.deepEqual(compiled.contract.verifier.commands, [{ type: "shell", command: "pytest" }]);
});

test("a project without config does not invent verifier commands", () => {
  const compiled = compileForProject({
    goal: "Fix the currently failing tests.",
    kind: "project",
    config: null,
  });
  assert.match(compiled.contract.uncertainty ?? "", /proofloop.yaml/);
});

test("write globs deny a path outside the contract", async () => {
  const compiled = compileForProject({
    goal: "Fix the currently failing tests.",
    kind: "project",
    config,
  });
  const workspace = createMemoryWorkspace({
    files: { "src/note.txt": "broken\n", "other.txt": "nope\n" },
    policy: policyFromContract({
      ...compiled.contract,
      policies: { ...compiled.contract.policies, delete: "allow" },
    }),
  });
  const allowed = await workspace.write("src/note.txt", "fixed\n");
  assert.equal(allowed.ok, true);
  const blocked = await workspace.write("other.txt", "fixed\n", { approved: true });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.decision, "deny");
  const deleted = await workspace.delete("other.txt", { approved: true });
  assert.equal(deleted.ok, false);
  if (!deleted.ok) assert.equal(deleted.decision, "deny");
});
