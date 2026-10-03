import type { LoopContract } from "./contract";
import type { ContextFile } from "./context-select";

export type FactSource = "user" | "config" | "compiler" | "verifier" | "policy" | "agent" | "harness" | "worktree";

export type Provenance = {
  source: FactSource;
  detail: string;
  at: string;
};

export type Fact<T> = {
  value: T;
  provenance: Provenance;
};

export type ContextPhase = "create" | "use" | "summarize" | "prove" | "fold" | "discard";

export type RunArtifact = {
  id: string;
  kind: "verifier-log" | "worker-result" | "proof";
  body: string;
};

export type RunState = {
  contract: Fact<LoopContract>;
  goal: Fact<string>;
  constraints: Fact<string[]>;
  failures: Fact<string>[];
  changedFiles: Fact<{ path: string; state: string }[]>;
  verifierResults: Fact<{ command: string; exitCode: number }[]>[];
  policyDecisions: Fact<{ action: string; decision: string; detail: string }>[];
  proofArtifacts: Fact<string>[];
  workerSummaries: Fact<string>[];
  artifacts: RunArtifact[];
  phase: ContextPhase;
};

export type ContextPack = {
  contract: LoopContract;
  projectState: string;
  currentFailure: string | null;
  changedFiles: string[];
  constraints: string[];
  sourceFiles: ContextFile[];
  prerequisiteSummaries: string[];
  estimatedTokens: number;
};

export type PublicRunState = {
  phase: ContextPhase;
  goal: string;
  failure: string | null;
  summaries: string[];
  proofArtifact: string | null;
  constraints: string[];
};

export function fact<T>(value: T, source: FactSource, detail: string, at: string): Fact<T> {
  return { value, provenance: { source, detail, at } };
}

export function createRunState(contract: LoopContract, at: string, constraints: string[]): RunState {
  return {
    contract: fact(contract, "compiler", "Loop contract for this run.", at),
    goal: fact(contract.goal, "user", "Goal on the contract.", at),
    constraints: fact(constraints, "config", "Constraints copied from the contract policies.", at),
    failures: [],
    changedFiles: [],
    verifierResults: [],
    policyDecisions: [],
    proofArtifacts: [],
    workerSummaries: [],
    artifacts: [],
    phase: "create",
  };
}

export function recordVerifier(
  state: RunState,
  results: { command: string; exitCode: number }[],
  rawLog: string,
  at: string,
): RunState {
  const failed = results.filter((entry) => entry.exitCode !== 0);
  const summary = failed.length
    ? failed.map((entry) => `${entry.command} exited ${entry.exitCode}`).join("; ")
    : results.map((entry) => `${entry.command} exited 0`).join("; ");
  const artifactId = `verifier-${state.artifacts.length + 1}`;
  return {
    ...state,
    failures: failed.length ? [...state.failures, fact(summary, "verifier", artifactId, at)] : state.failures,
    verifierResults: [...state.verifierResults, fact(results, "verifier", artifactId, at)],
    artifacts: [...state.artifacts, { id: artifactId, kind: "verifier-log", body: rawLog }],
  };
}

export function recordPolicy(
  state: RunState,
  decision: { action: string; decision: string; detail: string },
  at: string,
): RunState {
  return {
    ...state,
    policyDecisions: [...state.policyDecisions, fact(decision, "policy", decision.detail, at)],
  };
}

export function recordChanges(
  state: RunState,
  files: { path: string; state: string }[],
  at: string,
): RunState {
  return {
    ...state,
    changedFiles: [...state.changedFiles, fact(files, "worktree", "Worktree status for this attempt.", at)],
  };
}

export function recordWorkerSummary(state: RunState, summary: string, at: string): RunState {
  const artifactId = `worker-${state.workerSummaries.length + 1}`;
  return {
    ...state,
    phase: "summarize",
    workerSummaries: [...state.workerSummaries, fact(summary, "agent", artifactId, at)],
    artifacts: [...state.artifacts, { id: artifactId, kind: "worker-result", body: summary }],
  };
}

export function markPhase(state: RunState, phase: ContextPhase): RunState {
  if (phase === "discard") {
    return {
      ...state,
      phase,
      artifacts: state.artifacts.map((artifact) =>
        artifact.kind === "verifier-log" ? { ...artifact, body: "" } : artifact,
      ),
    };
  }
  return { ...state, phase };
}

export function attachProof(state: RunState, proofId: string, at: string): RunState {
  return {
    ...state,
    phase: "prove",
    proofArtifacts: [...state.proofArtifacts, fact(proofId, "harness", "Proof accepted by the contract.", at)],
    artifacts: [...state.artifacts, { id: proofId, kind: "proof", body: proofId }],
  };
}

export function buildContextPack(state: RunState, files: ContextFile[], budgetTokens: number): ContextPack {
  const currentFailure = state.failures.at(-1)?.value ?? null;
  const changed = state.changedFiles.at(-1)?.value.map((file) => file.path) ?? [];
  const summaries = state.workerSummaries.map((entry) => entry.value);
  const constraints = state.constraints.value;
  const sourceFiles: ContextFile[] = [];
  let tokens = estimate(state.contract.value.goal) + estimate(currentFailure ?? "") + estimate(summaries.join("\n"));
  for (const file of files) {
    const next = estimate(file.path) + estimate(file.contents);
    if (tokens + next > budgetTokens) break;
    sourceFiles.push(file);
    tokens += next;
  }
  return {
    contract: state.contract.value,
    projectState: changed.length ? `Changed: ${changed.join(", ")}` : "No files changed yet.",
    currentFailure,
    changedFiles: changed,
    constraints,
    sourceFiles,
    prerequisiteSummaries: summaries,
    estimatedTokens: tokens,
  };
}

export function publicRunState(state: RunState): PublicRunState {
  return {
    phase: state.phase,
    goal: state.goal.value,
    failure: state.failures.at(-1)?.value ?? null,
    summaries: state.workerSummaries.map((entry) => entry.value),
    proofArtifact: state.proofArtifacts.at(-1)?.value ?? null,
    constraints: state.constraints.value,
  };
}

export function packForwardsRawLogs(pack: ContextPack, rawLog: string): boolean {
  if (!rawLog) return false;
  const blob = JSON.stringify(pack);
  return blob.includes(rawLog);
}

function estimate(value: string): number {
  return Math.ceil(value.length / 4);
}
