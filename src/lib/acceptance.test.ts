import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGeminiAgentBackend } from "./gemini-agent";
import { compileForProject } from "./project-compile";
import { loadProjectConfig, serializeProjectConfig, type ProjectConfig } from "./project-config";
import { acceptLocalRun, discardLocalRun, getLocalRun, startLocalRun } from "./run-registry";

test("proofloop open flow: config plus goal, one agent, worktree proof, accept branch", async () => {
  const previous = process.env.PROOFLOOP_RAW;
  process.env.PROOFLOOP_RAW = "RAWLOG-SENTINEL";
  const root = await initRepo();
  try {
    const config = loadProjectConfig(root);
    assert.ok(config);
    assert.deepEqual(config.verify.commands, ["node check.js"]);
    const compiled = compileForProject({
      goal: "Fix the currently failing tests.",
      kind: "project",
      config,
    });
    assert.equal(compiled.contract.uncertainty, null);
    assert.deepEqual(compiled.contract.verifier.commands, [{ type: "shell", command: "node check.js" }]);
    assert.equal(compiled.contract.acceptStrategy, "branch");

    let sawFailure = false;
    let sawNote = false;
    let sawRawLog = false;
    const backend = createGeminiAgentBackend({
      generate: async (prompt) => {
        sawFailure = prompt.includes("node check.js exited 1");
        sawNote = prompt.includes("note.txt");
        sawRawLog = prompt.includes("RAWLOG-SENTINEL");
        return JSON.stringify({
          rationale: "Clear the broken marker.",
          summary: "Wrote a fixed note.",
          filesTouched: ["note.txt"],
          unresolved: null,
          actions: [{ type: "write", path: "note.txt", contents: "fixed\n" }],
        });
      },
    });

    const session = {
      projectId: "prj_accept",
      root,
      createdAt: "2026-04-01T00:00:00.000Z",
      kind: "project" as const,
    };
    const started = await startLocalRun({ session, contract: compiled.contract, backend });
    const finished = await waitFor(session.projectId, started.runId);
    assert.equal(sawFailure, true);
    assert.equal(sawNote, true);
    assert.equal(sawRawLog, false);
    assert.equal(finished.view.status, "proved");
    assert.equal(finished.view.structured?.phase, "discard");
    assert.equal(finished.view.proof?.commands[0]?.exitCode, 0);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "broken\n");

    const accepted = await acceptLocalRun(session.projectId, started.runId);
    assert.equal(compiled.contract.goal, "all tests pass");
    assert.match(accepted?.accepted?.branch ?? "", /^proofloop\/[0-9a-f]+-all-tests-pass$/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
    assert.equal(
      execFileSync("git", ["show", `${accepted?.accepted?.branch}:note.txt`], { cwd: root, encoding: "utf8" }),
      "fixed\n",
    );
  } finally {
    restore(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("discard after a project run leaves the original tree clean", async () => {
  const root = await initRepo();
  try {
    const config = loadProjectConfig(root);
    assert.ok(config);
    const compiled = compileForProject({
      goal: "Fix the currently failing tests.",
      kind: "project",
      config,
    });
    const backend = createGeminiAgentBackend({
      generate: async () =>
        JSON.stringify({
          rationale: "Leave the file.",
          summary: "No edit.",
          filesTouched: [],
          unresolved: "note.txt is still broken",
          actions: [],
        }),
    });
    const session = {
      projectId: "prj_discard_accept",
      root,
      createdAt: "2026-04-01T00:00:00.000Z",
      kind: "project" as const,
    };
    const started = await startLocalRun({
      session,
      contract: { ...compiled.contract, maxAttempts: 1 },
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

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-accept-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "proofloop@example.com"]);
  git(["config", "user.name", "ProofLoop"]);
  await writeFile(
    path.join(root, "check.js"),
    "const fs = require('fs');\nconst text = fs.readFileSync('note.txt', 'utf8');\nif (text.includes('broken')) {\n  console.error(process.env.PROOFLOOP_RAW || '');\n  process.exit(1);\n}\n",
  );
  await writeFile(path.join(root, "note.txt"), "broken\n");
  const config: ProjectConfig = {
    version: 1,
    agent: { provider: "gemini" },
    verify: { commands: ["node check.js"] },
    write: { globs: ["**/*"] },
    delete: "deny",
    attempts: 2,
    accept: "branch",
  };
  await writeFile(path.join(root, "proofloop.yaml"), serializeProjectConfig(config));
  git(["add", "check.js", "note.txt", "proofloop.yaml"]);
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

function restore(previous: string | undefined) {
  if (previous === undefined) delete process.env.PROOFLOOP_RAW;
  else process.env.PROOFLOOP_RAW = previous;
}
