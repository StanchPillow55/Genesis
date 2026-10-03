import type { LoopContract } from "./contract";
import { parseContract } from "./contract";
import { normalizeWorkspacePath } from "./workspace";

export type ProposedAction =
  | { type: "write"; path: string; contents: string }
  | { type: "delete"; path: string };

export type ProposedStep = {
  rationale: string;
  actions: ProposedAction[];
};

export type AgentFile = {
  path: string;
  contents: string;
};

export type AgentContext = {
  goal: string;
  attempt: number;
  maxAttempts: number;
  files: AgentFile[];
  verifierFailure: string | null;
  contract: LoopContract;
};

export type AgentBackend = {
  name: string;
  proposeStep(context: AgentContext): Promise<ProposedStep>;
};

export function parseProposedStep(value: unknown): ProposedStep {
  const record = objectRecord(value, "The agent did not return a step object.");
  if (typeof record.rationale !== "string" || !record.rationale.trim()) {
    throw new Error("The agent step needs a rationale.");
  }
  if (!Array.isArray(record.actions)) {
    throw new Error("The agent step needs an actions array.");
  }
  if (record.actions.length > 20) {
    throw new Error("The agent proposed too many actions for one step.");
  }
  return {
    rationale: record.rationale.trim(),
    actions: record.actions.map((action) => parseAction(action)),
  };
}

export function parseAgentContext(value: unknown): AgentContext {
  const record = objectRecord(value, "The agent expected a step context.");
  const attempt = wholeNumber(record.attempt, "attempt");
  const maxAttempts = wholeNumber(record.maxAttempts, "maxAttempts");
  if (!Array.isArray(record.files) || record.files.length > 40) {
    throw new Error("The agent context needs the workspace files.");
  }
  const files = record.files.map((file) => {
    const entry = objectRecord(file, "Each file needs a path and contents.");
    if (typeof entry.path !== "string" || typeof entry.contents !== "string") {
      throw new Error("Each file needs a path and contents.");
    }
    if (entry.contents.length > 50_000) {
      throw new Error(`${entry.path} is too large to send to an agent.`);
    }
    return { path: normalizeWorkspacePath(entry.path), contents: entry.contents };
  });
  let verifierFailure: string | null = null;
  if (typeof record.verifierFailure === "string" && record.verifierFailure.trim()) {
    verifierFailure = record.verifierFailure.trim();
  } else if (record.verifierFailure != null && record.verifierFailure !== "") {
    throw new Error("verifierFailure must be a string or null.");
  }
  return {
    goal: typeof record.goal === "string" ? record.goal : "",
    attempt,
    maxAttempts,
    files,
    verifierFailure,
    contract: parseContract(record.contract),
  };
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function parseAction(value: unknown): ProposedAction {
  const record = objectRecord(value, "Each action must write a file or delete a file.");
  if (record.type === "delete" && typeof record.path === "string") {
    return { type: "delete", path: normalizeWorkspacePath(record.path) };
  }
  if (record.type === "write" && typeof record.path === "string" && typeof record.contents === "string") {
    if (record.contents.length > 50_000) {
      throw new Error(`${record.path} is too large to write.`);
    }
    return { type: "write", path: normalizeWorkspacePath(record.path), contents: record.contents };
  }
  throw new Error("Each action must write a file or delete a file.");
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function wholeNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${field} must be a whole number.`);
  }
  return number;
}
