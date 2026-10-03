import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AcceptStrategy = "branch" | "apply-uncommitted";

export type Isolation = {
  id: string;
  kind: "git-worktree" | "copy";
  sourceRoot: string;
  /** Temp directory that owns the checkout. Removed on accept and discard. */
  directory: string;
  /** Git worktree root, or the copy root. */
  worktreeRoot: string;
  /** Directory the workspace and verifier use. */
  workspaceRoot: string;
  baseRevision: string | null;
  /** Relative files present when a non-git copy was taken. */
  baselineFiles: string[];
};

export type AcceptResult = {
  strategy: AcceptStrategy;
  branch: string | null;
};

const SKIP_COPY = new Set(["node_modules", ".git", ".next", ".venv", "venv", "coverage"]);

export function proofloopBranchName(revision: string, slug: string): string {
  const hex = revision.replace(/[^a-f0-9]/gi, "");
  const short = (hex || "run").slice(0, 7);
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";
  return `proofloop/${short}-${clean}`;
}

export async function createIsolation(sourceRoot: string): Promise<Isolation> {
  const id = randomBytes(8).toString("hex");
  const resolved = path.resolve(sourceRoot);
  const top = await gitOutput(["-C", resolved, "rev-parse", "--show-toplevel"]);
  if (top !== null) {
    const revision = await gitOutput(["-C", top, "rev-parse", "HEAD"]);
    if (!revision) {
      throw new Error("This git project has no commits yet. Commit once, then run ProofLoop.");
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), "proofloop-wt-"));
    const worktreeRoot = path.join(directory, "tree");
    const added = await runGit(["-C", top, "worktree", "add", "--detach", worktreeRoot, "HEAD"]);
    if (added.code !== 0) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(added.stderr.trim() || "git worktree add failed.");
    }
    const relative = path.relative(top, resolved);
    const workspaceRoot = relative && relative !== "." ? path.join(worktreeRoot, relative) : worktreeRoot;
    await linkDependencies(resolved, workspaceRoot);
    return {
      id,
      kind: "git-worktree",
      sourceRoot: resolved,
      directory,
      worktreeRoot,
      workspaceRoot,
      baseRevision: revision,
      baselineFiles: [],
    };
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "proofloop-copy-"));
  const worktreeRoot = path.join(directory, "tree");
  await copyTree(resolved, worktreeRoot);
  await linkDependencies(resolved, worktreeRoot);
  return {
    id,
    kind: "copy",
    sourceRoot: resolved,
    directory,
    worktreeRoot,
    workspaceRoot: worktreeRoot,
    baseRevision: null,
    baselineFiles: await listFiles(resolved),
  };
}

export async function acceptIsolation(
  isolation: Isolation,
  options?: { strategy?: string; slug?: string },
): Promise<AcceptResult> {
  const requested = options?.strategy ?? "branch";
  if (requested !== "branch" && requested !== "apply-uncommitted") {
    throw new Error("In-place execution is not available. Accept with branch or apply-uncommitted.");
  }
  const strategy: AcceptStrategy = requested;
  const slug = options?.slug?.trim() || "change";
  if (isolation.kind === "git-worktree") {
    const revision = isolation.baseRevision ?? "run";
    const branch = strategy === "branch" ? proofloopBranchName(revision, slug) : null;
    if (strategy === "branch") {
      await commitWorktree(isolation, branch ?? slug);
    } else {
      await applyWorktreeDiff(isolation);
    }
    await removeWorktree(isolation);
    return { strategy, branch };
  }

  const branch = strategy === "branch" ? proofloopBranchName(isolation.id, slug) : null;
  if (strategy === "branch") {
    const retained = path.join(os.tmpdir(), "proofloop-accepted", isolation.id);
    await mkdir(path.dirname(retained), { recursive: true });
    await copyTree(isolation.workspaceRoot, retained);
  } else {
    await applyCopy(isolation);
  }
  await rm(isolation.directory, { recursive: true, force: true });
  return { strategy, branch };
}

export async function discardIsolation(isolation: Isolation): Promise<void> {
  if (isolation.kind === "git-worktree") {
    await removeWorktree(isolation);
    return;
  }
  await rm(isolation.directory, { recursive: true, force: true });
}

async function commitWorktree(isolation: Isolation, branch: string): Promise<void> {
  const existing = await runGit(["-C", isolation.sourceRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.code === 0) {
    throw new Error(`Branch ${branch} already exists.`);
  }
  const added = await runGit([
    "-C",
    isolation.worktreeRoot,
    "add",
    "-A",
    "--",
    ".",
    ":!node_modules",
    ":!.venv",
    ":!venv",
  ]);
  if (added.code !== 0) {
    throw new Error(added.stderr.trim() || "git add failed in the worktree.");
  }
  const cached = await runGit(["-C", isolation.worktreeRoot, "diff", "--cached", "--quiet"]);
  if (cached.code !== 0) {
    const committed = await runGit(["-C", isolation.worktreeRoot, "commit", "-m", `ProofLoop: ${branch}`]);
    if (committed.code !== 0) {
      throw new Error(
        committed.stderr.trim() ||
          "Git could not commit the worktree. This repository needs user.name and user.email.",
      );
    }
  }
  const checkedOut = await runGit(["-C", isolation.worktreeRoot, "checkout", "-b", branch]);
  if (checkedOut.code !== 0) {
    throw new Error(checkedOut.stderr.trim() || `Could not create ${branch}.`);
  }
}

async function applyWorktreeDiff(isolation: Isolation): Promise<void> {
  const added = await runGit([
    "-C",
    isolation.worktreeRoot,
    "add",
    "-A",
    "--",
    ".",
    ":!node_modules",
    ":!.venv",
    ":!venv",
  ]);
  if (added.code !== 0) {
    throw new Error(added.stderr.trim() || "git add failed in the worktree.");
  }
  const diff = await runGit(["-C", isolation.worktreeRoot, "diff", "--cached", "--binary"]);
  if (!diff.stdout.trim()) return;
  const applied = await runGit(["-C", isolation.sourceRoot, "apply", "--binary"], diff.stdout);
  if (applied.code !== 0) {
    throw new Error(applied.stderr.trim() || "The worktree diff did not apply onto the original tree.");
  }
}

async function applyCopy(isolation: Isolation): Promise<void> {
  const current = await listFiles(isolation.workspaceRoot);
  const currentSet = new Set(current);
  for (const relative of current) {
    const from = path.join(isolation.workspaceRoot, relative);
    const to = path.join(isolation.sourceRoot, relative);
    const [next, previous] = await Promise.all([readFile(from), readOptional(to)]);
    if (previous !== null && previous.equals(next)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, next);
  }
  for (const relative of isolation.baselineFiles) {
    if (currentSet.has(relative)) continue;
    await rm(path.join(isolation.sourceRoot, relative), { force: true });
  }
}

async function removeWorktree(isolation: Isolation): Promise<void> {
  const removed = await runGit(["-C", isolation.sourceRoot, "worktree", "remove", "--force", isolation.worktreeRoot]);
  if (removed.code !== 0) {
    await rm(isolation.worktreeRoot, { recursive: true, force: true });
    await runGit(["-C", isolation.sourceRoot, "worktree", "prune"]);
  }
  await rm(isolation.directory, { recursive: true, force: true });
}

async function linkDependencies(source: string, workspace: string): Promise<void> {
  for (const name of ["node_modules", ".venv", "venv"]) {
    const from = path.join(source, name);
    const to = path.join(workspace, name);
    try {
      const info = await stat(from);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      await stat(to);
      continue;
    } catch {
      await symlink(from, to, "dir");
    }
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_COPY.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
    } else if (entry.isFile()) {
      await cp(src, dest);
    }
  }
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIP_COPY.has(entry.name)) continue;
    const relative = prefix ? path.posix.join(prefix.split(path.sep).join("/"), entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function gitOutput(args: string[]): Promise<string | null> {
  const result = await runGit(args);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

function runGit(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
