import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeCommand } from "./command-choke";
import {
  createMemoryWorkspace,
  normalizeWorkspacePath,
  unifiedDiff,
  WorkspaceFault,
  type Grant,
  type PolicyEngine,
  type Workspace,
  type WorkspaceAction,
  type WorkspaceFile,
  type WorkspaceResult,
} from "./workspace";

/**
 * Filesystem workspace rooted at `root`. Diff and status describe files this
 * workspace has written or deleted during the run. Shell commands run in `root`
 * only after the policy allows them.
 */
export function createFsWorkspace(options: {
  root: string;
  policy: PolicyEngine;
  timeoutMs?: number;
}): Workspace {
  const root = path.resolve(options.root);
  const touched = new Map<string, { before: string | null }>();
  const memory = createMemoryWorkspace({
    files: {},
    policy: options.policy,
    shell: (command) =>
      executeCommand(command, { cwd: root, timeoutMs: options.timeoutMs ?? 60_000 }),
  });

  return {
    decide: (action) => memory.decide(action),
    read(target, grant) {
      return readFs(root, target, options.policy, grant);
    },
    write(target, contents, grant) {
      return writeFs(root, touched, target, contents, options.policy, grant);
    },
    delete(target, grant) {
      return deleteFs(root, touched, target, options.policy, grant);
    },
    diff(target, grant) {
      return diffFs(root, touched, target, options.policy, grant);
    },
    status(grant) {
      return statusFs(root, touched, options.policy, grant);
    },
    exec(command, grant) {
      return memory.exec(command, grant);
    },
  };
}

async function readFs(
  root: string,
  target: string,
  policy: PolicyEngine,
  grant?: Grant,
): Promise<WorkspaceResult<string>> {
  const action: WorkspaceAction = { type: "read", path: target };
  const gate = gatePath(policy, action, grant);
  if (gate.ok === false) return gate;
  const full = resolveInside(root, gate.path);
  try {
    return { ok: true, decision: "allow", value: await readFile(/*turbopackIgnore: true*/ full, "utf8") };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "ENOENT") throw new WorkspaceFault(`${gate.path} is not in the workspace.`);
    throw error;
  }
}

async function writeFs(
  root: string,
  touched: Map<string, { before: string | null }>,
  target: string,
  contents: string,
  policy: PolicyEngine,
  grant?: Grant,
): Promise<WorkspaceResult<{ changed: boolean }>> {
  const action: WorkspaceAction = { type: "write", path: target, contents };
  const gate = gatePath(policy, action, grant);
  if (gate.ok === false) return gate;
  const full = resolveInside(root, gate.path);
  const before = await readOptional(full);
  if (!touched.has(gate.path)) touched.set(gate.path, { before });
  if (before === contents) return { ok: true, decision: "allow", value: { changed: false } };
  await mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ full, contents, "utf8");
  return { ok: true, decision: "allow", value: { changed: true } };
}

async function deleteFs(
  root: string,
  touched: Map<string, { before: string | null }>,
  target: string,
  policy: PolicyEngine,
  grant?: Grant,
): Promise<WorkspaceResult<{ deleted: boolean }>> {
  const action: WorkspaceAction = { type: "delete", path: target };
  const gate = gatePath(policy, action, grant);
  if (gate.ok === false) return gate;
  const full = resolveInside(root, gate.path);
  const before = await readOptional(full);
  if (!touched.has(gate.path)) touched.set(gate.path, { before });
  if (before === null) return { ok: true, decision: "allow", value: { deleted: false } };
  await rm(/*turbopackIgnore: true*/ full, { force: true });
  return { ok: true, decision: "allow", value: { deleted: true } };
}

async function diffFs(
  root: string,
  touched: Map<string, { before: string | null }>,
  target: string | undefined,
  policy: PolicyEngine,
  grant?: Grant,
): Promise<WorkspaceResult<string>> {
  const action: WorkspaceAction = target ? { type: "diff", path: target } : { type: "diff" };
  const decision = policy.decide(action);
  if (decision === "deny" || (decision === "ask" && !grant?.approved)) {
    return { ok: false, decision: decision === "ask" ? "ask" : "deny", action };
  }
  const paths = target ? [normalizeWorkspacePath(target)] : [...touched.keys()].sort();
  const parts: string[] = [];
  for (const rel of paths) {
    const record = touched.get(rel);
    const before = record?.before ?? null;
    const after = await readOptional(resolveInside(root, rel));
    const text = unifiedDiff(rel, before, after);
    if (text) parts.push(text);
  }
  return { ok: true, decision: "allow", value: parts.join("") };
}

async function statusFs(
  root: string,
  touched: Map<string, { before: string | null }>,
  policy: PolicyEngine,
  grant?: Grant,
): Promise<WorkspaceResult<{ files: WorkspaceFile[] }>> {
  const action: WorkspaceAction = { type: "status" };
  const decision = policy.decide(action);
  if (decision === "deny" || (decision === "ask" && !grant?.approved)) {
    return { ok: false, decision: decision === "ask" ? "ask" : "deny", action };
  }
  const files = [];
  for (const [rel, record] of [...touched.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const after = await readOptional(resolveInside(root, rel));
    let state: "unchanged" | "modified" | "added" | "deleted" = "unchanged";
    if (record.before === null && after !== null) state = "added";
    else if (after === null) state = "deleted";
    else if (after !== record.before) state = "modified";
    files.push({ path: rel, state });
  }
  return { ok: true, decision: "allow", value: { files } };
}

function gatePath(
  policy: PolicyEngine,
  action: WorkspaceAction & { path: string },
  grant?: Grant,
): { ok: true; path: string } | { ok: false; decision: "deny" | "ask"; action: WorkspaceAction } {
  let rel: string;
  try {
    rel = normalizeWorkspacePath(action.path);
  } catch {
    return { ok: false, decision: "deny", action };
  }
  const normalized = { ...action, path: rel } as WorkspaceAction;
  const decision = policy.decide(normalized);
  if (decision === "allow" || (decision === "ask" && grant?.approved)) {
    return { ok: true, path: rel };
  }
  return { ok: false, decision, action: normalized };
}

function resolveInside(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new WorkspaceFault(`Path is outside the workspace: ${rel}`);
  }
  return full;
}

async function readOptional(full: string): Promise<string | null> {
  try {
    return await readFile(/*turbopackIgnore: true*/ full, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "ENOENT") return null;
    throw error;
  }
}
