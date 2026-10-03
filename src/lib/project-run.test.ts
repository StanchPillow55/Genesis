import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentBackend } from "./agent";
import type { LoopContract } from "./contract";
import { startLocalRun, acceptLocalRun, discardLocalRun, getLocalRun } from "./run-registry";

test("a project run proves in a worktree and accept creates a proofloop branch", async () => {
  const root = await initRepo("broken\n");
  try {
    const backend: AgentBackend = {
      name: "fix-note",
      async proposeStep(context) {
        const note = context.files.find((file) => file.path === "note.txt");
        assert.ok(note);
        assert.match(context.verifierFailure ?? "", /check\.js|Exited/);
        return {
          rationale: "Clear the broken marker.",
          actions: [{ type: "write", path: "note.txt", contents: "fixed\n" }],
        };
      },
    };
    const session = { projectId: "prj_run", root, createdAt: "2026-01-01T00:00:00.000Z", kind: "project" as const };
    const started = await startLocalRun({ session, contract: failingContract(), backend });
    const finished = await waitFor(session.projectId, started.runId);
    assert.equal(finished.view.status, "proved");
    assert.equal(finished.view.proof?.commands[0]?.exitCode, 0);
    assert.deepEqual(finished.view.proof?.filesChanged, ["note.txt"]);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "broken\n");
    assert.match(finished.view.diff, /\+fixed/);
    assert.equal(finished.view.agent?.name, "fix-note");
    assert.ok(finished.view.policyDecisions.some((entry) => entry.decision === "allow"));

    const accepted = await acceptLocalRun(session.projectId, started.runId);
    assert.match(accepted?.accepted?.branch ?? "", /^proofloop\/.+-fix-the-currently-failing-tests$/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
    assert.equal(
      execFileSync("git", ["show", `${accepted?.accepted?.branch}:note.txt`], { cwd: root, encoding: "utf8" }),
      "fixed\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discard removes the worktree and leaves the original tree clean", async () => {
  const root = await initRepo("broken\n");
  try {
    const backend: AgentBackend = {
      name: "idle",
      async proposeStep() {
        return { rationale: "Leave it.", actions: [] };
      },
    };
    const session = { projectId: "prj_discard", root, createdAt: "2026-01-01T00:00:00.000Z", kind: "project" as const };
    const started = await startLocalRun({
      session,
      contract: { ...failingContract(), maxAttempts: 1 },
      backend,
    });
    const finished = await waitFor(session.projectId, started.runId);
    assert.equal(finished.view.status, "stopped");
    assert.equal(finished.view.proof, null);
    const discarded = await discardLocalRun(session.projectId, started.runId);
    assert.equal(discarded?.discarded, true);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "broken\n");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
    assert.equal(execFileSync("git", ["branch", "--list", "proofloop/*"], { cwd: root, encoding: "utf8" }).trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function failingContract(): LoopContract {
  return {
    goal: "Fix the currently failing tests.",
    maxAttempts: 2,
    policies: { modifyTests: "deny", delete: "deny", editSource: "allow" },
    verifier: { commands: [{ type: "shell", command: "node check.js" }] },
    uncertainty: null,
  };
}

async function initRepo(note: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-run-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "proofloop@example.com"]);
  git(["config", "user.name", "ProofLoop"]);
  await writeFile(
    path.join(root, "check.js"),
    "const fs = require('fs');\nconst text = fs.readFileSync('note.txt', 'utf8');\nif (text.includes('broken')) process.exit(1);\n",
  );
  await writeFile(path.join(root, "note.txt"), note);
  git(["add", "check.js", "note.txt"]);
  git(["commit", "-m", "init"]);
  return root;
}

async function waitFor(projectId: string, runId: string) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const run = getLocalRun(projectId, runId);
    if (run && run.view.status !== "running" && run.view.status !== "waiting-for-approval") return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The run did not finish.");
}
