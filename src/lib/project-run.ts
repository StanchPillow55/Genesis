import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, ProposedAction } from "./agent";
import { selectContext } from "./context-select";
import {
  attachProof,
  buildContextPack,
  createRunState,
  markPhase,
  publicRunState,
  recordChanges,
  recordPolicy,
  recordVerifier,
  recordWorkerSummary,
  type PublicRunState,
  type RunState,
} from "./run-state";
import { applyAmendment, formatVerifier, type LoopContract } from "./contract";
import {
  proofAllowsDone,
  type ApprovalRecord,
  type ApprovalRequest,
  type PolicyBlock,
  type Proof,
  type RunStatus,
  type StopReason,
} from "./harness";
import type { CheckResult, VerifierReport } from "./verifier";
import { verifySignup } from "./verifier";
import { verifyWithWorkspace } from "./verify-run";
import type { Workspace } from "./workspace";

const SKIP = new Set(["node_modules", ".git", ".next", ".venv", "venv", "coverage", "dist"]);

export type PolicyDecisionRecord = {
  action: string;
  decision: "allow" | "deny" | "ask" | "amend";
  detail: string;
};

export type RunView = {
  status: RunStatus;
  stopReason: StopReason;
  attempt: number;
  maxAttempts: number;
  agent: { name: string; rationale: string } | null;
  approval: ApprovalRequest | null;
  approvals: ApprovalRecord[];
  changedFiles: { path: string; state: string }[];
  diff: string;
  checks: CheckResult[];
  policyDecisions: PolicyDecisionRecord[];
  proof: Proof | null;
  error: string | null;
  structured: PublicRunState | null;
};

export function emptyRunView(contract: LoopContract): RunView {
  return {
    status: "idle",
    stopReason: null,
    attempt: 0,
    maxAttempts: contract.maxAttempts,
    agent: null,
    approval: null,
    approvals: [],
    changedFiles: [],
    diff: "",
    checks: [],
    policyDecisions: [],
    proof: null,
    error: null,
    structured: null,
  };
}

export async function listProjectFiles(root: string): Promise<{ path: string; contents: string }[]> {
  const files: { path: string; contents: string }[] = [];
  await walk(root, "", files);
  return files.slice(0, 40);
}

export async function runProjectLoop(options: {
  workspace: Workspace;
  contract: LoopContract;
  backend: AgentBackend;
  signal: AbortSignal;
  shouldPause: () => boolean;
  waitResume: () => Promise<void>;
  waitApproval: (request: ApprovalRequest) => Promise<"allow" | "deny">;
  onUpdate: (view: RunView) => void;
  listFiles?: () => Promise<{ path: string; contents: string }[]>;
}): Promise<RunView> {
  const { workspace, contract, backend, signal, shouldPause, waitResume, waitApproval, onUpdate } = options;
  const view = emptyRunView(contract);
  const at = () => new Date().toISOString();
  let state: RunState = createRunState(contract, at(), [
    `modifyTests=${contract.policies.modifyTests}`,
    `delete=${contract.policies.delete}`,
    `editSource=${contract.policies.editSource}`,
  ]);
  const blocked: PolicyBlock[] = [];
  const filesChanged = new Set<string>();
  let verifierFailure: string | null = null;
  view.status = "running";
  view.structured = publicRunState(state);
  publish();

  for (let attempt = 1; attempt <= contract.maxAttempts; attempt += 1) {
    if (signal.aborted) throw abortError();
    await holdForPause();
    view.attempt = attempt;
    publish();

    const before = await verify();
    if (!before) return view;
    if (commandsPassed(before) && filesChanged.size > 0) {
      return finishProof(attempt, before);
    }
    verifierFailure = state.failures.at(-1)?.value ?? failureText(checksFromReport(before));
    view.checks = checksFromReport(before);
    state = markPhase(state, "use");
    view.structured = publicRunState(state);
    publish();

    const listed = options.listFiles ? await options.listFiles() : await filesFromWorkspace(workspace);
    const selected = selectContext({
      goal: contract.goal,
      verifierOutput: verifierFailure ?? "",
      changedPaths: [...filesChanged],
      files: listed,
    });
    const pack = buildContextPack(state, selected, 8_000);
    const files = pack.sourceFiles;
    let proposal;
    try {
      proposal = await backend.proposeStep({
        goal: contract.goal,
        attempt,
        maxAttempts: contract.maxAttempts,
        files,
        verifierFailure: pack.currentFailure,
        contract,
      });
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
      view.status = "stopped";
      view.stopReason = "crash";
      publish();
      return view;
    }
    view.agent = { name: backend.name, rationale: proposal.rationale };
    state = recordWorkerSummary(state, proposal.result?.summary ?? proposal.rationale, at());
    view.structured = publicRunState(state);
    publish();

    for (const action of proposal.actions) {
      await applyAction(action);
      await holdForPause();
    }

    const after = await verify();
    if (!after) return view;
    if (commandsPassed(after)) {
      return finishProof(attempt, after);
    }
    verifierFailure = failureText(view.checks);
    if (attempt === contract.maxAttempts) {
      view.status = "stopped";
      view.stopReason = "max-attempts";
      publish();
      return view;
    }
  }

  view.status = "stopped";
  view.stopReason = "max-attempts";
  publish();
  return view;

  function publish() {
    onUpdate(cloneView(view));
  }

  async function verify(): Promise<VerifierReport | null> {
    try {
      const report = await verifyWithWorkspace(workspace, contract.verifier.commands, verifySignup);
      view.checks = checksFromReport(report);
      await refreshDiff();
      const raw = report.commands
        .map((entry) => `${entry.command}\n${entry.stdout}\n${entry.stderr}`)
        .join("\n");
      state = recordVerifier(
        state,
        report.commands.map((entry) => ({ command: entry.command, exitCode: entry.exitCode })),
        raw,
        at(),
      );
      state = recordChanges(state, view.changedFiles, at());
      view.structured = publicRunState(state);
      if (report.crash) {
        view.error = report.crash;
        view.status = "stopped";
        view.stopReason = "crash";
        publish();
        return null;
      }
      publish();
      return report;
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
      view.status = "stopped";
      view.stopReason = "crash";
      publish();
      return null;
    }
  }

  function commandsPassed(report: VerifierReport): boolean {
    return report.commands.length > 0 && report.commands.every((entry) => entry.exitCode === 0);
  }

  function failureText(checks: CheckResult[]): string {
    return checks
      .filter((check) => !check.passed)
      .map((check) => `${check.name}: ${check.detail}`)
      .join(" ");
  }

  function finishProof(attempt: number, report: VerifierReport): RunView {
    const proof: Proof = {
      commands: report.commands.map((entry) => ({ command: entry.command, exitCode: entry.exitCode })),
      testTotals: report.totals,
      filesChanged: [...filesChanged],
      policyResult: {
        blocked: blocked.map((entry) => ({ ...entry })),
        approvals: view.approvals.map((entry) => ({ ...entry })),
      },
      attemptCount: attempt,
      maxAttempts: contract.maxAttempts,
      verifier: formatVerifier(contract.verifier),
    };
    if (!proofAllowsDone(proof, contract)) {
      view.error = "The verifier commands exited 0, but the proof record does not satisfy the contract.";
      view.status = "stopped";
      view.stopReason = "crash";
      view.proof = null;
      view.structured = publicRunState(state);
      publish();
      return view;
    }
    state = attachProof(state, `proof-${attempt}`, at());
    state = markPhase(state, "fold");
    state = markPhase(state, "discard");
    view.proof = proof;
    view.status = "proved";
    view.stopReason = null;
    view.structured = publicRunState(state);
    publish();
    return view;
  }

  async function holdForPause() {
    if (!shouldPause()) return;
    view.status = "stopped";
    view.stopReason = "paused";
    publish();
    await waitResume();
    if (signal.aborted) throw abortError();
    view.status = "running";
    view.stopReason = null;
    publish();
  }

  async function applyAction(action: ProposedAction) {
    if (action.type === "amendment") {
      const answer = await ask({
        id: `amend-${action.command}`,
        title: `Add ${action.command} to the contract?`,
        detail:
          "This command is outside the contract. Adding it does not run it. The verifier can run it only after the contract names it.",
      });
      view.approvals.push({ action: `amend verifier ${action.command}`, decision: answer });
      view.policyDecisions.push({
        action: action.command,
        decision: "amend",
        detail: answer === "allow" ? "Added to the contract. Not executed by the approval." : "Left out of the contract.",
      });
      if (answer === "allow") {
        contract.verifier = applyAmendment(contract, {
          type: "add-verifier-command",
          command: action.command,
        }).verifier;
      }
      publish();
      return;
    }

    const workspaceAction =
      action.type === "delete"
        ? { type: "delete" as const, path: action.path }
        : { type: "write" as const, path: action.path, contents: action.contents };
    const decision = workspace.decide(workspaceAction);
    if (decision === "deny") {
      blocked.push({
        file: action.path,
        policy: action.type === "delete" ? "delete" : isTestPath(action.path) ? "modifyTests" : "editSource",
        reason: `${action.type} ${action.path} was denied.`,
      });
      const denied = {
        action: `${action.type} ${action.path}`,
        decision: "deny" as const,
        detail: "The contract denied this edit. The file was not changed.",
      };
      view.policyDecisions.push(denied);
      state = recordPolicy(state, denied, at());
      view.structured = publicRunState(state);
      publish();
      return;
    }
    let grant: { approved: true } | undefined;
    if (decision === "ask") {
      const answer = await ask({
        id: `${action.type}-${action.path}`,
        title: action.type === "delete" ? `Delete ${action.path}?` : `Allow a change to ${action.path}?`,
        detail: "The contract requires approval. Deny leaves the file alone.",
      });
      view.approvals.push({ action: `${action.type} ${action.path}`, decision: answer });
      view.policyDecisions.push({
        action: `${action.type} ${action.path}`,
        decision: "ask",
        detail: answer === "allow" ? "Allowed once." : "Denied.",
      });
      if (answer !== "allow") {
        publish();
        return;
      }
      grant = { approved: true };
    } else {
      view.policyDecisions.push({
        action: `${action.type} ${action.path}`,
        decision: "allow",
        detail: "The contract allows this edit.",
      });
    }

    if (action.type === "delete") {
      const removed = await workspace.delete(action.path, grant);
      if (removed.ok && removed.value.deleted) filesChanged.add(action.path);
    } else {
      const written = await workspace.write(action.path, action.contents, grant);
      if (written.ok && written.value.changed) filesChanged.add(action.path);
    }
    await refreshDiff();
    publish();
  }

  async function ask(request: ApprovalRequest): Promise<"allow" | "deny"> {
    view.approval = request;
    view.status = "waiting-for-approval";
    publish();
    const answer = await waitApproval(request);
    if (signal.aborted) throw abortError();
    view.approval = null;
    view.status = "running";
    publish();
    return answer;
  }

  async function refreshDiff() {
    const diff = await workspace.diff();
    view.diff = diff.ok ? diff.value : "";
    const status = await workspace.status();
    view.changedFiles = status.ok ? status.value.files.filter((file) => file.state !== "unchanged") : [];
  }
}

async function filesFromWorkspace(workspace: Workspace): Promise<{ path: string; contents: string }[]> {
  const status = await workspace.status();
  if (!status.ok) return [];
  const files: { path: string; contents: string }[] = [];
  for (const file of status.value.files) {
    if (file.state === "deleted") continue;
    const read = await workspace.read(file.path);
    if (read.ok) files.push({ path: file.path, contents: read.value });
  }
  return files;
}

async function walk(root: string, prefix: string, files: { path: string; contents: string }[]): Promise<void> {
  if (files.length >= 40) return;
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= 40) return;
    if (SKIP.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relative, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const contents = await readFile(path.join(root, relative), "utf8").catch(() => null);
    if (contents === null || contents.includes("\u0000") || contents.length > 50_000) continue;
    files.push({ path: relative, contents });
  }
}

function checksFromReport(report: VerifierReport): CheckResult[] {
  if (report.checks) return report.checks;
  return report.commands.map((entry) => ({
    id: entry.command,
    name: entry.command,
    passed: entry.exitCode === 0,
    detail: entry.timedOut
      ? "The command timed out."
      : entry.exitCode === 0
        ? "Exited 0."
        : `Exited ${entry.exitCode}.${entry.stderr ? ` ${entry.stderr}` : ""}`,
  }));
}

function isTestPath(file: string): boolean {
  return /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("__tests__/");
}

function cloneView(view: RunView): RunView {
  return {
    ...view,
    agent: view.agent ? { ...view.agent } : null,
    approval: view.approval ? { ...view.approval } : null,
    approvals: view.approvals.map((entry) => ({ ...entry })),
    changedFiles: view.changedFiles.map((entry) => ({ ...entry })),
    checks: view.checks.map((entry) => ({ ...entry })),
    policyDecisions: view.policyDecisions.map((entry) => ({ ...entry })),
    structured: view.structured ? { ...view.structured, summaries: [...view.structured.summaries], constraints: [...view.structured.constraints] } : null,
    proof: view.proof
      ? {
          ...view.proof,
          commands: view.proof.commands.map((entry) => ({ ...entry })),
          filesChanged: [...view.proof.filesChanged],
          policyResult: {
            blocked: view.proof.policyResult.blocked.map((entry) => ({ ...entry })),
            approvals: view.proof.policyResult.approvals.map((entry) => ({ ...entry })),
          },
        }
      : null,
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
