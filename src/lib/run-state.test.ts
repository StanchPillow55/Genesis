import assert from "node:assert/strict";
import test from "node:test";
import { parseProposedStep } from "./agent";
import type { LoopContract } from "./contract";
import {
  attachProof,
  buildContextPack,
  createRunState,
  markPhase,
  packForwardsRawLogs,
  publicRunState,
  recordVerifier,
  recordWorkerSummary,
} from "./run-state";

const contract: LoopContract = {
  goal: "Fix the currently failing tests.",
  maxAttempts: 2,
  policies: { modifyTests: "deny", delete: "deny", editSource: "allow" },
  verifier: { commands: [{ type: "shell", command: "node check.js" }] },
  uncertainty: null,
};

test("every fact has provenance and raw logs stay out of the context pack", () => {
  const at = "2026-04-01T00:00:00.000Z";
  let state = createRunState(contract, at, ["modifyTests=deny", "delete=deny"]);
  assert.equal(state.phase, "create");
  assert.equal(state.goal.provenance.source, "user");
  assert.equal(state.contract.provenance.source, "compiler");
  assert.equal(state.constraints.provenance.source, "config");

  const raw = "RAWLOG secret stack from the verifier process";
  state = recordVerifier(state, [{ command: "node check.js", exitCode: 1 }], raw, at);
  state = markPhase(state, "use");
  const pack = buildContextPack(
    state,
    [
      { path: "note.txt", contents: "broken\n" },
      { path: "extra.ts", contents: "x".repeat(8_000) },
    ],
    30,
  );
  assert.equal(pack.currentFailure, "node check.js exited 1");
  assert.equal(packForwardsRawLogs(pack, raw), false);
  assert.ok(pack.sourceFiles.length < 2);
  assert.ok(pack.estimatedTokens <= 30);
  assert.equal(state.artifacts[0]?.body, raw);

  state = recordWorkerSummary(state, "Cleared the broken marker.", at);
  assert.equal(state.phase, "summarize");
  state = attachProof(state, "proof-1", at);
  state = markPhase(state, "fold");
  state = markPhase(state, "discard");
  assert.equal(state.phase, "discard");
  assert.equal(state.artifacts.find((artifact) => artifact.kind === "verifier-log")?.body, "");
  const after = publicRunState(state);
  assert.deepEqual(after.summaries, ["Cleared the broken marker."]);
  assert.equal(after.proofArtifact, "proof-1");
  assert.equal(JSON.stringify(after).includes(raw), false);
});

test("the agent step can carry a structured result without a transcript", () => {
  const step = parseProposedStep({
    rationale: "Write the fix.",
    summary: "Replaced the broken marker.",
    filesTouched: ["note.txt"],
    unresolved: null,
    actions: [{ type: "write", path: "note.txt", contents: "fixed\n" }],
  });
  assert.equal(step.result?.summary, "Replaced the broken marker.");
  assert.deepEqual(step.result?.filesTouched, ["note.txt"]);
  assert.equal(step.actions[0]?.type, "write");
});
