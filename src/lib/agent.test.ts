import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_GOAL, compileWithFallback } from "./contract";
import { createGeminiAgentBackend } from "./gemini-agent";
import { loadSeedProject } from "./sample-project";

const seed = loadSeedProject();

test("gemini backend does not invent a step when no API key is set", async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const backend = createGeminiAgentBackend();
    await assert.rejects(
      () => backend.proposeStep(context()),
      /A live model did not run/,
    );
  } finally {
    restore("GEMINI_API_KEY", previousGemini);
    restore("GOOGLE_API_KEY", previousGoogle);
  }
});

test("injected generator drives the gemini adapter without a live API call", async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  let calls = 0;
  try {
    const backend = createGeminiAgentBackend({
      generate: async () => {
        calls += 1;
        return JSON.stringify({
          rationale: "Replace the weak password rule.",
          actions: [{ type: "write", path: "validator.ts", contents: "export const fixed = true;\n" }],
        });
      },
    });
    const step = await backend.proposeStep(context());
    assert.equal(calls, 1);
    assert.equal(backend.name, "gemini");
    assert.equal(step.rationale, "Replace the weak password rule.");
    assert.deepEqual(step.actions, [
      { type: "write", path: "validator.ts", contents: "export const fixed = true;\n" },
    ]);
  } finally {
    restore("GEMINI_API_KEY", previousGemini);
    restore("GOOGLE_API_KEY", previousGoogle);
  }
});

function context() {
  return {
    goal: "all tests pass",
    attempt: 1,
    maxAttempts: 4,
    files: [
      { path: "validator.ts", contents: seed.validator },
      { path: "signup.test.ts", contents: seed.tests },
    ],
    verifierFailure: null,
    contract: compileWithFallback(PRESET_GOAL).contract,
  };
}

function restore(name: "GEMINI_API_KEY" | "GOOGLE_API_KEY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
