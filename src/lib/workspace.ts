import type { ContractAmendment, LoopContract, Policy } from "./contract";
import { anyGlobMatches } from "./globs";
import type { CommandResult } from "./verifier";

export type PolicyDecision = "allow" | "deny" | "ask" | "amend";

export type WorkspaceAction =
  | { type: "read"; path: string }
  | { type: "write"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "diff"; path?: string }
  | { type: "status" }
  | { type: "exec"; command: string };

export type PolicyEngine = {
  decide(action: WorkspaceAction): PolicyDecision;
};

export type Grant = { approved: true };

export type WorkspaceFileState = "unchanged" | "modified" | "added" | "deleted";

export type WorkspaceFile = {
  path: string;
  state: WorkspaceFileState;
};

export type { ContractAmendment } from "./contract";

export type WorkspaceDenied = {
  ok: false;
  decision: "deny" | "ask" | "amend";
  action: WorkspaceAction;
  amendment?: ContractAmendment;
};

export type WorkspaceOk<T> = {
  ok: true;
  decision: "allow";
  value: T;
};

export type WorkspaceResult<T> = WorkspaceOk<T> | WorkspaceDenied;

export type Workspace = {
  decide(action: WorkspaceAction): PolicyDecision;
  read(path: string, grant?: Grant): Promise<WorkspaceResult<string>>;
  write(path: string, contents: string, grant?: Grant): Promise<WorkspaceResult<{ changed: boolean }>>;
  delete(path: string, grant?: Grant): Promise<WorkspaceResult<{ deleted: boolean }>>;
  diff(path?: string, grant?: Grant): Promise<WorkspaceResult<string>>;
  status(grant?: Grant): Promise<WorkspaceResult<{ files: WorkspaceFile[] }>>;
  exec(command: string, grant?: Grant): Promise<WorkspaceResult<CommandResult>>;
};

export class WorkspaceFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFault";
  }
}

type FileSlot = {
  baseline: string | null;
  current: string | null;
};

export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new WorkspaceFault(`Path is outside the workspace: ${input}`);
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new WorkspaceFault(`Path is outside the workspace: ${input}`);
  }
  return parts.join("/");
}

export function policyFromContract(contract: LoopContract): PolicyEngine {
  return {
    decide(action) {
      if (action.type === "read" || action.type === "diff" || action.type === "status") {
        return "allow";
      }
      if (action.type === "exec") {
        const named = contract.verifier.commands.some(
          (command) => command.type === "shell" && command.command === action.command,
        );
        return named ? "allow" : "amend";
      }
      if (action.type === "write" || action.type === "delete") {
        if (
          contract.writeGlobs &&
          contract.writeGlobs.length > 0 &&
          !anyGlobMatches(contract.writeGlobs, action.path)
        ) {
          return "deny";
        }
      }
      if (action.type === "delete") return decisionFor(contract.policies.delete);
      if (action.type === "write") {
        const rule = isTestPath(action.path) ? contract.policies.modifyTests : contract.policies.editSource;
        return decisionFor(rule);
      }
      return "deny";
    },
  };
}

export function createMemoryWorkspace(options: {
  files: Record<string, string>;
  policy: PolicyEngine;
  shell?: (command: string) => Promise<CommandResult>;
}): Workspace {
  const slots = new Map<string, FileSlot>();
  for (const [path, contents] of Object.entries(options.files)) {
    const normalized = normalizeWorkspacePath(path);
    slots.set(normalized, { baseline: contents, current: contents });
  }

  function authorize(action: WorkspaceAction, grant?: Grant): WorkspaceDenied | { action: WorkspaceAction } {
    const normalized = normalizeAction(action);
    if (!normalized.ok) return normalized.denied;
    const decision = options.policy.decide(normalized.action);
    if (decision === "allow" || (decision === "ask" && grant?.approved)) {
      return { action: normalized.action };
    }
    const denied: WorkspaceDenied = { ok: false, decision, action: normalized.action };
    if (decision === "amend" && normalized.action.type === "exec") {
      denied.amendment = { type: "add-verifier-command", command: normalized.action.command };
    }
    return denied;
  }

  return {
    decide(action) {
      const normalized = normalizeAction(action);
      if (!normalized.ok) return "deny";
      return options.policy.decide(normalized.action);
    },
    async read(path, grant) {
      const action: WorkspaceAction = { type: "read", path };
      const gate = authorize(action, grant);
      if ("ok" in gate) return gate;
      const slot = slots.get(pathOf(gate.action));
      if (!slot || slot.current === null) {
        throw new WorkspaceFault(`${pathOf(gate.action)} is not in the workspace.`);
      }
      return { ok: true, decision: "allow", value: slot.current };
    },
    async write(path, contents, grant) {
      const action: WorkspaceAction = { type: "write", path, contents };
      const gate = authorize(action, grant);
      if ("ok" in gate) return gate;
      const key = pathOf(gate.action);
      const slot = slots.get(key) ?? { baseline: null, current: null };
      const changed = slot.current !== contents;
      slots.set(key, { baseline: slot.baseline, current: contents });
      return { ok: true, decision: "allow", value: { changed } };
    },
    async delete(path, grant) {
      const action: WorkspaceAction = { type: "delete", path };
      const gate = authorize(action, grant);
      if ("ok" in gate) return gate;
      const key = pathOf(gate.action);
      const slot = slots.get(key);
      if (!slot || slot.current === null) {
        return { ok: true, decision: "allow", value: { deleted: false } };
      }
      slots.set(key, { baseline: slot.baseline, current: null });
      return { ok: true, decision: "allow", value: { deleted: true } };
    },
    async diff(path, grant) {
      const action: WorkspaceAction = path ? { type: "diff", path } : { type: "diff" };
      const gate = authorize(action, grant);
      if ("ok" in gate) return gate;
      const paths = path ? [pathOf(gate.action)] : [...slots.keys()].sort();
      const text = paths
        .map((entry) => {
          const slot = slots.get(entry);
          if (!slot) return "";
          return unifiedDiff(entry, slot.baseline, slot.current);
        })
        .filter((entry) => entry.length > 0)
        .join("");
      return { ok: true, decision: "allow", value: text };
    },
    async status(grant) {
      const action: WorkspaceAction = { type: "status" };
      const gate = authorize(action, grant);
      if ("ok" in gate) return gate;
      const files = [...slots.entries()]
        .map(([path, slot]) => ({ path, state: fileState(slot) }))
        .sort((left, right) => left.path.localeCompare(right.path));
      return { ok: true, decision: "allow", value: { files } };
    },
    async exec(command, grant) {
      const action: WorkspaceAction = { type: "exec", command };
      const gate = authorize(action, grant);
      if ("ok" in gate) return gate;
      if (!options.shell) {
        throw new WorkspaceFault("This workspace has no shell runner.");
      }
      const value = await options.shell(commandOf(gate.action));
      return { ok: true, decision: "allow", value };
    },
  };
}

export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return "";
  const previous = before === null ? [] : splitLines(before);
  const next = after === null ? [] : splitLines(after);
  const lines = diffLines(previous, next)
    .map((entry) => `${entry.type === " " ? " " : entry.type}${entry.line}`)
    .join("\n");
  return `--- a/${path}\n+++ b/${path}\n${lines}\n`;
}

function decisionFor(policy: Policy): PolicyDecision {
  if (policy === "allow") return "allow";
  if (policy === "deny") return "deny";
  return "ask";
}

function isTestPath(path: string): boolean {
  return /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
}

function fileState(slot: FileSlot): WorkspaceFileState {
  if (slot.baseline === null && slot.current !== null) return "added";
  if (slot.current === null) return "deleted";
  if (slot.current !== slot.baseline) return "modified";
  return "unchanged";
}

function normalizeAction(
  action: WorkspaceAction,
): { ok: true; action: WorkspaceAction } | { ok: false; denied: WorkspaceDenied } {
  if (action.type === "status" || action.type === "exec" || (action.type === "diff" && !action.path)) {
    return { ok: true, action };
  }
  try {
    const path = normalizeWorkspacePath(action.type === "diff" ? action.path ?? "" : action.path);
    if (action.type === "diff") return { ok: true, action: { type: "diff", path } };
    if (action.type === "write") return { ok: true, action: { ...action, path } };
    return { ok: true, action: { type: action.type, path } };
  } catch (error) {
    const denied: WorkspaceDenied = {
      ok: false,
      decision: "deny",
      action,
    };
    if (error instanceof WorkspaceFault) return { ok: false, denied };
    throw error;
  }
}

function pathOf(action: WorkspaceAction): string {
  if (action.type === "read" || action.type === "write" || action.type === "delete") return action.path;
  if (action.type === "diff" && action.path) return action.path;
  throw new WorkspaceFault("This action has no path.");
}

function commandOf(action: WorkspaceAction): string {
  if (action.type !== "exec") throw new WorkspaceFault("This action is not a command.");
  return action.command;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLines(
  before: string[],
  after: string[],
): Array<{ type: " " | "+" | "-"; line: string }> {
  const n = before.length;
  const m = after.length;
  const scores: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      scores[i][j] =
        before[i] === after[j] ? scores[i + 1][j + 1] + 1 : Math.max(scores[i + 1][j], scores[i][j + 1]);
    }
  }
  const out: Array<{ type: " " | "+" | "-"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ type: " ", line: before[i] });
      i += 1;
      j += 1;
    } else if (scores[i + 1][j] >= scores[i][j + 1]) {
      out.push({ type: "-", line: before[i] });
      i += 1;
    } else {
      out.push({ type: "+", line: after[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "-", line: before[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "+", line: after[j] });
    j += 1;
  }
  return out;
}
