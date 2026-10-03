import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { POST as createIsolationRoute } from "../app/api/isolations/route";
import { POST as acceptRoute } from "../app/api/isolations/[id]/accept/route";
import { POST as discardRoute } from "../app/api/isolations/[id]/discard/route";
import { TOKEN_HEADER, PROJECT_HEADER } from "./local-api";
import { getSessionRegistry } from "./session-store";
import { acceptIsolation, createIsolation, discardIsolation, proofloopBranchName } from "./worktree";

const TOKEN = "worktree-launch-token";

test("branch names stay under proofloop/", () => {
  assert.equal(
    proofloopBranchName("abcdef1234567890", "Fix the currently failing tests."),
    "proofloop/abcdef1-fix-the-currently-failing-tests",
  );
});

test("a git worktree accepts onto a proofloop branch and discard leaves the tree clean", async () => {
  const root = await initRepo();
  try {
    const accepted = await createIsolation(root);
    await writeFile(path.join(accepted.workspaceRoot, "note.txt"), "after\n");
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");
    assert.equal(git(root, ["status", "--porcelain"]), "");

    const result = await acceptIsolation(accepted, { strategy: "branch", slug: "Fix the note" });
    assert.equal(result.strategy, "branch");
    assert.match(result.branch ?? "", /^proofloop\/[0-9a-f]{7}-fix-the-note$/);
    assert.equal(git(root, ["status", "--porcelain"]), "");
    assert.equal(git(root, ["show", `${result.branch}:note.txt`]), "after\n");
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");
    await assert.rejects(() => readFile(path.join(accepted.worktreeRoot, "note.txt"), "utf8"));

    const discarded = await createIsolation(root);
    await writeFile(path.join(discarded.workspaceRoot, "note.txt"), "nope\n");
    await discardIsolation(discarded);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");
    assert.equal(git(root, ["status", "--porcelain"]), "");
    assert.equal(git(root, ["branch", "--list", "proofloop/*"]).trim().split("\n").filter(Boolean).length, 1);
    await assert.rejects(() => readFile(path.join(discarded.worktreeRoot, "note.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply-uncommitted copies the worktree diff back without a commit", async () => {
  const root = await initRepo();
  try {
    const head = git(root, ["rev-parse", "HEAD"]);
    const isolation = await createIsolation(root);
    await writeFile(path.join(isolation.workspaceRoot, "note.txt"), "patched\n");
    const result = await acceptIsolation(isolation, { strategy: "apply-uncommitted", slug: "patch" });
    assert.equal(result.branch, null);
    assert.equal(git(root, ["rev-parse", "HEAD"]), head);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "patched\n");
    assert.match(git(root, ["status", "--porcelain"]), /note\.txt/);
    assert.equal(git(root, ["branch", "--list", "proofloop/*"]).trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-git project uses a temp copy with the same accept and discard results", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-plain-"));
  try {
    await writeFile(path.join(root, "note.txt"), "before\n");
    const discarded = await createIsolation(root);
    assert.equal(discarded.kind, "copy");
    await writeFile(path.join(discarded.workspaceRoot, "note.txt"), "hidden\n");
    await discardIsolation(discarded);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");

    const applied = await createIsolation(root);
    await writeFile(path.join(applied.workspaceRoot, "note.txt"), "copied\n");
    await acceptIsolation(applied, { strategy: "apply-uncommitted" });
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "copied\n");

    const branched = await createIsolation(root);
    await writeFile(path.join(branched.workspaceRoot, "note.txt"), "kept-aside\n");
    const result = await acceptIsolation(branched, { strategy: "branch", slug: "snapshot" });
    assert.match(result.branch ?? "", /^proofloop\//);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "copied\n");
    const refused = await createIsolation(root);
    await assert.rejects(() => acceptIsolation(refused, { strategy: "in-place" }), /In-place/);
    await discardIsolation(refused);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the isolation API returns an id and a branch, not a filesystem path", async () => {
  const previous = process.env.PROOFLOOP_TOKEN;
  process.env.PROOFLOOP_TOKEN = TOKEN;
  const root = await initRepo();
  try {
    const session = getSessionRegistry().registerProject(root);
    const created = await createIsolationRoute(
      jsonRequest(session.projectId, {}),
    );
    assert.equal(created.status, 200);
    const payload = (await created.json()) as { isolationId: string; kind: string };
    assert.equal(payload.kind, "git-worktree");
    assert.equal(JSON.stringify(payload).includes(root), false);

    const accepted = await acceptRoute(jsonRequest(session.projectId, { slug: "from-api" }), {
      params: Promise.resolve({ id: payload.isolationId }),
    });
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as { branch: string; strategy: string };
    assert.equal(body.strategy, "branch");
    assert.match(body.branch, /^proofloop\/.+-from-api$/);
    assert.equal(JSON.stringify(body).includes(root), false);

    const again = await createIsolationRoute(jsonRequest(session.projectId, {}));
    const second = (await again.json()) as { isolationId: string };
    const discarded = await discardRoute(jsonRequest(session.projectId, {}), {
      params: Promise.resolve({ id: second.isolationId }),
    });
    assert.equal(discarded.status, 200);
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    restoreToken(previous);
    await rm(root, { recursive: true, force: true });
  }
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "proofloop-repo-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "proofloop@example.com"]);
  git(root, ["config", "user.name", "ProofLoop"]);
  await writeFile(path.join(root, "note.txt"), "before\n");
  git(root, ["add", "note.txt"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function jsonRequest(projectId: string, body: unknown): Request {
  const headers = new Headers();
  headers.set("host", "127.0.0.1:38471");
  headers.set("origin", "http://127.0.0.1:38471");
  headers.set("content-type", "application/json");
  headers.set(TOKEN_HEADER, TOKEN);
  headers.set(PROJECT_HEADER, projectId);
  return new Request("http://127.0.0.1:38471/api/isolations", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, projectId }),
  });
}

function restoreToken(previous: string | undefined) {
  if (previous === undefined) delete process.env.PROOFLOOP_TOKEN;
  else process.env.PROOFLOOP_TOKEN = previous;
}
