import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSeedProject, loadSignupFiles } from "./sample-project";
import {
  canonicalizeRoot,
  createSessionRegistry,
  publicSession,
  SAMPLE_PROJECT_ID,
  SessionError,
} from "./session";

test("register, resolve, and reject an unknown project", () => {
  const registry = createSessionRegistry(() => new Date("2026-01-02T03:04:05.000Z"));
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "proofloop-session-")));
  const session = registry.registerProject(root, "proj_test");
  assert.equal(session.projectId, "proj_test");
  assert.equal(session.root, root);
  assert.equal(session.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(session.kind, "project");
  assert.equal(registry.resolve("proj_test")?.root, root);
  assert.equal(registry.resolve("missing"), null);
  assert.equal(registry.resolve(""), null);
});

test("canonicalizeRoot rejects files and missing paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "proofloop-not-dir-"));
  const file = path.join(root, "notes.txt");
  writeFileSync(file, "not a project");
  assert.throws(() => canonicalizeRoot(file), SessionError);
  assert.throws(() => canonicalizeRoot(path.join(root, "missing")), /Not a directory/);
  assert.throws(() => canonicalizeRoot("   "), /required/);
  assert.equal(canonicalizeRoot(root), realpathSync(root));
});

test("the sample session still loads the three signup files", () => {
  const registry = createSessionRegistry();
  const session = registry.registerSample();
  assert.equal(session.projectId, SAMPLE_PROJECT_ID);
  assert.equal(session.kind, "sample");
  const files = loadSignupFiles(session.root);
  const seed = loadSeedProject();
  assert.equal(files.validator, seed.validator);
  assert.equal(files.tests, seed.tests);
  assert.equal(files.helper, seed.helper);
  assert.match(files.validator, /validatePassword/);
  assert.match(files.tests, /checkPassword/);
  assert.match(files.helper, /Stale draft/);

  const view = publicSession(session);
  assert.equal("root" in view, false);
  assert.equal(view.projectId, "sample");
  assert.equal(JSON.stringify(view).includes(session.root), false);
  assert.equal(registry.registerSample().projectId, session.projectId);
});
