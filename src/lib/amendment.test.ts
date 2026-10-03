import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseProposedStep, type AgentBackend } from "./agent";
import { applyAmendment, compileWithFallback, PRESET_GOAL, type LoopContract } from "./contract";
import { runHarness, type HarnessEvent } from "./harness";
import { loadSeedProject } from "./sample-project";
import { executeCommand } from "./command-choke";
import { runVerifierCommands } from "./verifier";
import { createFsWorkspace } from "./workspace-fs";
import { createMemoryWorkspace, policyFromContract } from "./workspace";
import { createIsolation, discardIsolation } from "./worktree";
import { execFileSync } from "node:child_process";

const seed = loadSeedProject();

test("an out-of-contract command is an amendment, and approval alone does not run it", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  let shellCalls = 0;
  const workspace = createMemoryWorkspace({
    files: { "validator.ts": seed.validator },
    policy: policyFromContract(contract),
    shell: async (command) => {
      shellCalls += 1;
      return executeCommand(command, { timeoutMs: 15_000 });
    },
  });

  const blocked = await workspace.exec("npm test");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.decision, "amend");
    assert.deepEqual(blocked.amendment, { type: "add-verifier-command", command: "npm test" });
  }
  const granted = await workspace.exec("npm test", { approved: true });
  assert.equal(granted.ok, false);
  if (!granted.ok) assert.equal(granted.decision, "amend");
  assert.equal(shellCalls, 0);

  const command = "node -e \"process.exit(0)\"";
  const updated = applyAmendment(contract, { type: "add-verifier-command", command });
  const allowed = createMemoryWorkspace({
    files: { "validator.ts": seed.validator },
    policy: policyFromContract(updated),
    shell: async (invoked) => {
      shellCalls += 1;
      return executeCommand(invoked, { timeoutMs: 15_000 });
    },
  });
  const stillBlocked = await allowed.exec("npm test", { approved: true });
  assert.equal(stillBlocked.ok, false);
  if (!stillBlocked.ok) assert.equal(stillBlocked.decision, "amend");
  assert.equal(shellCalls, 0);
  const named = await allowed.exec(command);
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.value.exitCode, 0);
  assert.equal(shellCalls, 1);
});

test("the signup fixture stays a preset while contract commands run in the worktree", async () => {
  const preset = compileWithFallback(PRESET_GOAL).contract;
  assert.deepEqual(preset.verifier, { commands: [{ type: "fixture", id: "signup" }] });

  const root = await mkdtemp(path.join(tmpdir(), "proofloop-verify-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "proofloop@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "ProofLoop"], { cwd: root });
    await writeFile(path.join(root, "check.js"), "process.exit(1);\n");
    execFileSync("git", ["add", "check.js"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });

    const isolation = await createIsolation(root);
    try {
      const contract: LoopContract = {
        ...preset,
        verifier: { commands: [{ type: "shell", command: "node check.js" }] },
      };
      const workspace = createFsWorkspace({
        root: isolation.workspaceRoot,
        policy: policyFromContract(contract),
        timeoutMs: 15_000,
      });
      const report = await runVerifierCommands(contract.verifier, (command) =>
        workspace.exec(command).then((result) => {
          if (!result.ok) {
            throw new Error(`Policy returned ${result.decision}`);
          }
          return result.value;
        }),
      );
      assert.equal(report.ok, false);
      assert.equal(report.commands[0]?.exitCode, 1);
      assert.equal(report.commands[0]?.command, "node check.js");

      const outside = await workspace.exec("npm test", { approved: true });
      assert.equal(outside.ok, false);
      if (!outside.ok) assert.equal(outside.decision, "amend");
    } finally {
      await discardIsolation(isolation);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a proposed shell action amends the contract and does not execute during approval", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  contract.maxAttempts = 1;
  const calls: string[] = [];
  const backend: AgentBackend = {
    name: "amendment-double",
    async proposeStep() {
      return parseProposedStep({
        rationale: "The contract should also run node.",
        actions: [{ type: "exec", command: "node -e \"process.exit(0)\"" }],
      });
    },
  };
  const events: HarnessEvent[] = [];
  for await (const event of runHarness({
    contract,
    seed: { validator: seed.validator, tests: seed.tests, helper: seed.helper },
    paceMs: 0,
    signal: new AbortController().signal,
    signup: async () => ({
      ok: false,
      checks: [],
      totals: { passed: 0, failed: 1, total: 1 },
      crash: null,
    }),
    shell: async (command) => {
      calls.push(command);
      return executeCommand(command, { timeoutMs: 15_000 });
    },
    backend,
    shouldPause: () => false,
    waitResume: async () => {},
    waitApproval: async () => "allow",
  })) {
    events.push(event);
  }
  assert.deepEqual(calls, ["node -e \"process.exit(0)\""]);
  const titles = events
    .filter((event) => event.type === "timeline")
    .map((event) => (event.type === "timeline" ? event.event.title : ""));
  const amended = titles.indexOf("Contract amended");
  const verified = titles.findIndex((title) => title.startsWith("Verifier"));
  assert.ok(amended >= 0);
  assert.ok(verified > amended);
  assert.equal(contract.verifier.commands.some((entry) => entry.type === "shell"), true);
});

test("production workspaces reach the shell only through the command choke point", () => {
  const workspaceFs = readFileSync(new URL("./workspace-fs.ts", import.meta.url), "utf8");
  const verifyRoute = readFileSync(new URL("../app/api/verify/route.ts", import.meta.url), "utf8");
  const execRoute = readFileSync(new URL("../app/api/exec/route.ts", import.meta.url), "utf8");
  assert.equal(workspaceFs.includes("runShellCommand"), false);
  assert.match(workspaceFs, /executeCommand/);
  assert.equal(verifyRoute.includes("runShellCommand"), false);
  assert.match(verifyRoute, /executeCommand/);
  assert.equal(execRoute.includes("runShellCommand"), false);
  assert.match(execRoute, /workspace\.exec/);
});
