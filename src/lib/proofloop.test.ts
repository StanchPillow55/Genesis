import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_GOAL, compileWithFallback } from "./contract";
import { runHarness, proofAllowsDone, type HarnessEvent, type Proof } from "./harness";
import { loadSeedProject } from "./sample-project";
import { verifySignup } from "./verifier";

const seed = loadSeedProject();

test("fallback compiler reads the preset sentence", () => {
  const compiled = compileWithFallback(PRESET_GOAL);
  assert.equal(compiled.contract.goal, "all tests pass");
  assert.equal(compiled.contract.maxAttempts, 4);
  assert.equal(compiled.contract.policies.modifyTests, "deny");
  assert.equal(compiled.contract.policies.delete, "require-approval");
  assert.equal(compiled.contract.policies.editSource, "allow");
  assert.equal(compiled.contract.verifier, "run the signup tests");
  assert.equal(compiled.contract.uncertainty, null);
  assert.match(compiled.notes.join(" "), /modifyTests = deny/);
  assert.match(compiled.notes.join(" "), /require approval/);
});

test("fallback compiler reads attempt limits and delete bans", () => {
  const compiled = compileWithFallback(
    "Fix the signup checker, max attempts 2. Never delete anything. Don't modify the tests.",
  );
  assert.equal(compiled.contract.maxAttempts, 2);
  assert.equal(compiled.contract.policies.delete, "deny");
  assert.equal(compiled.contract.policies.modifyTests, "deny");
  assert.equal(compiled.contract.uncertainty, null);
});

test("fallback compiler asks when the goal is unclear", () => {
  const compiled = compileWithFallback("hello there");
  assert.ok(compiled.contract.uncertainty);
  const vague = compileWithFallback("Make it nicer");
  assert.ok(vague.contract.uncertainty);
});

test("signup tests actually fail, then fail again, then pass", () => {
  const initial = verifySignup({ validator: seed.validator, tests: seed.tests });
  assert.equal(initial.crash, null);
  assert.deepEqual(initial.totals, { passed: 2, failed: 1, total: 3 });
  assert.equal(initial.checks.find((check) => check.id === "password")?.passed, false);
  assert.match(initial.checks.find((check) => check.id === "password")?.detail ?? "", /short/);

  const partial = seed.validator.replace(
    "return password.length >= 4;",
    "return password.length >= 8;",
  );
  const mid = verifySignup({ validator: partial, tests: seed.tests });
  assert.equal(mid.checks.find((check) => check.id === "password")?.passed, false);
  assert.match(mid.checks.find((check) => check.id === "password")?.detail ?? "", /longpassword/);

  const fixed = seed.validator.replace(
    /export function validatePassword\(password: string\): boolean \{[\s\S]*?\n\}/,
    `export function validatePassword(password: string): boolean {
  const longEnough = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  return longEnough && hasLetter && hasNumber;
}`,
  );
  const done = verifySignup({ validator: fixed, tests: seed.tests });
  assert.equal(done.ok, true);
  assert.equal(done.totals.passed, 3);
});

test("harness blocks test edits, asks before delete, and stops on proof", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  const events = await collect({
    contract,
    decision: "deny",
  });
  const statuses = events.filter((event) => event.type === "status");
  assert.ok(statuses.some((event) => event.type === "status" && event.status === "waiting-for-approval"));
  const last = statuses.at(-1);
  assert.ok(last && last.type === "status" && last.status === "proved");

  const proof = events.find((event) => event.type === "proof");
  assert.ok(proof && proof.type === "proof");
  assert.equal(proofAllowsDone(proof.proof), true);
  assert.equal(proof.proof.attemptCount, 2);
  assert.equal(proof.proof.testTotals.passed, 3);
  assert.deepEqual(proof.proof.filesChanged, ["validator.ts"]);
  assert.equal(proof.proof.policyResult.blocked.some((entry) => entry.file === "signup.test.ts"), true);
  assert.deepEqual(proof.proof.policyResult.approvals, [
    { action: "delete legacy-helper.ts", decision: "deny" },
  ]);

  const files = events.filter((event) => event.type === "files");
  const lastFiles = files.at(-1);
  assert.ok(lastFiles && lastFiles.type === "files");
  assert.equal(lastFiles.files.tests, seed.tests);
  assert.equal(lastFiles.files.helper, seed.helper);
  assert.match(lastFiles.files.validator, /const hasNumber/);
  assert.match(
    events
      .filter((event) => event.type === "timeline")
      .map((event) => (event.type === "timeline" ? event.event.detail : ""))
      .join("\n"),
    /verifier failed/,
  );
});

test("max attempts stops the loop without a proof object", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  contract.maxAttempts = 1;
  const events = await collect({ contract, decision: "deny" });
  const last = events.filter((event) => event.type === "status").at(-1);
  assert.ok(last && last.type === "status");
  assert.equal(last.status, "stopped");
  assert.equal(last.reason, "max-attempts");
  assert.equal(events.some((event) => event.type === "proof"), false);
});

test("allow once deletes only the stale helper", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  const events = await collect({ contract, decision: "allow" });
  const proof = events.find((event) => event.type === "proof");
  assert.ok(proof && proof.type === "proof");
  assert.deepEqual(proof.proof.filesChanged, ["legacy-helper.ts", "validator.ts"]);
  const lastFiles = events.filter((event) => event.type === "files").at(-1);
  assert.ok(lastFiles && lastFiles.type === "files");
  assert.equal(lastFiles.files.helper, null);
  assert.equal(lastFiles.files.tests, seed.tests);
  assert.equal(proof.proof.attemptCount, 2);
});

test("pause holds the harness until resume", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  let pauses = 0;
  const events: HarnessEvent[] = [];
  for await (const event of runHarness({
    contract,
    seed: { validator: seed.validator, tests: seed.tests, helper: seed.helper },
    paceMs: 0,
    signal: new AbortController().signal,
    verify: async (files) => verifySignup(files),
    shouldPause: () => pauses === 0,
    waitResume: () => {
      pauses += 1;
      return new Promise<void>((resolve) => setTimeout(resolve, 15));
    },
    waitApproval: async () => "deny",
  })) {
    events.push(event);
  }
  assert.ok(events.some((event) => event.type === "status" && event.reason === "paused"));
  assert.ok(
    events.some(
      (event) => event.type === "timeline" && event.event.title === "Resumed",
    ),
  );
  const last = events.filter((event) => event.type === "status").at(-1);
  assert.ok(last && last.type === "status" && last.status === "proved");
});

test("a passing total without files changed is not proof", async () => {
  const contract = compileWithFallback(PRESET_GOAL).contract;
  const events = await collect({ contract, decision: "deny" });
  const proofEvent = events.find((event) => event.type === "proof");
  assert.ok(proofEvent && proofEvent.type === "proof");
  const stripped: Proof = { ...proofEvent.proof, filesChanged: [] };
  assert.equal(proofAllowsDone(stripped), false);
  assert.equal(proofAllowsDone(null), false);
});

async function collect({
  contract,
  decision,
}: {
  contract: ReturnType<typeof compileWithFallback>["contract"];
  decision: "allow" | "deny";
}): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of runHarness({
    contract,
    seed: { validator: seed.validator, tests: seed.tests, helper: seed.helper },
    paceMs: 0,
    signal: new AbortController().signal,
    verify: async (files) => verifySignup(files),
    shouldPause: () => false,
    waitResume: async () => {},
    waitApproval: async () => decision,
  })) {
    events.push(event);
  }
  return events;
}
