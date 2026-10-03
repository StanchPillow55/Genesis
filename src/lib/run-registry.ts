import { randomBytes } from "node:crypto";
import type { AgentBackend } from "./agent";
import { executeCommand } from "./command-choke";
import type { LoopContract } from "./contract";
import { createGeminiAgentBackend } from "./gemini-agent";
import { geminiCredentials } from "./gemini";
import type { ApprovalRequest } from "./harness";
import { listProjectFiles, runProjectLoop, type RunView } from "./project-run";
import { loadSeedProject } from "./sample-project";
import type { ProjectSession } from "./session";
import { policyFromContract, createMemoryWorkspace } from "./workspace";
import { createFsWorkspace } from "./workspace-fs";
import { acceptIsolation, createIsolation, discardIsolation, type Isolation } from "./worktree";

export type RunRecord = {
  runId: string;
  projectId: string;
  view: RunView;
  accepted: { strategy: string; branch: string | null } | null;
  discarded: boolean;
};

type LiveRun = RunRecord & {
  contract: LoopContract;
  isolation: Isolation | null;
  abort: AbortController;
  paused: boolean;
  resumeWait: (() => void) | null;
  approvalWait: ((decision: "allow" | "deny") => void) | null;
};

const runs = new Map<string, LiveRun>();

export async function startLocalRun(options: {
  session: ProjectSession;
  contract: LoopContract;
  backend?: AgentBackend;
}): Promise<RunRecord> {
  const contract: LoopContract = structuredClone(options.contract);
  const isolation = options.session.kind === "project" ? await createIsolation(options.session.root) : null;
  const workspace = isolation
    ? createFsWorkspace({
        root: isolation.workspaceRoot,
        policy: policyFromContract(contract),
      })
    : createMemoryWorkspace({
        files: sampleFiles(),
        policy: policyFromContract(contract),
        shell: (command) => executeCommand(command, { cwd: options.session.root, timeoutMs: 60_000 }),
      });
  const abort = new AbortController();
  const run: LiveRun = {
    runId: `run_${randomBytes(8).toString("hex")}`,
    projectId: options.session.projectId,
    view: {
      status: "running",
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
    },
    accepted: null,
    discarded: false,
    contract,
    isolation,
    abort,
    paused: false,
    resumeWait: null,
    approvalWait: null,
  };
  runs.set(run.runId, run);
  void runProjectLoop({
    workspace,
    contract,
    backend: options.backend ?? defaultBackend(),
    signal: abort.signal,
    shouldPause: () => run.paused,
    waitResume: () =>
      new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          abort.signal.removeEventListener("abort", onAbort);
          reject(abortError());
        };
        abort.signal.addEventListener("abort", onAbort, { once: true });
        run.resumeWait = () => {
          abort.signal.removeEventListener("abort", onAbort);
          run.paused = false;
          resolve();
        };
      }),
    waitApproval: (request: ApprovalRequest) =>
      new Promise<"allow" | "deny">((resolve, reject) => {
        const onAbort = () => {
          abort.signal.removeEventListener("abort", onAbort);
          reject(abortError());
        };
        abort.signal.addEventListener("abort", onAbort, { once: true });
        run.approvalWait = (decision) => {
          abort.signal.removeEventListener("abort", onAbort);
          resolve(decision);
        };
        void request;
      }),
    onUpdate: (view) => {
      run.view = view;
    },
    listFiles: isolation ? () => listProjectFiles(isolation.workspaceRoot) : undefined,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      if (run.view.status === "running" || run.view.status === "waiting-for-approval") {
        run.view = { ...run.view, status: "stopped", stopReason: null, approval: null };
      }
      return;
    }
    run.view = {
      ...run.view,
      status: "stopped",
      stopReason: "crash",
      error: error instanceof Error ? error.message : String(error),
    };
  });
  return publicRun(run);
}

export function getLocalRun(projectId: string, runId: string): RunRecord | null {
  const run = runs.get(runId);
  if (!run || run.projectId !== projectId) return null;
  return publicRun(run);
}

export function pauseLocalRun(projectId: string, runId: string): RunRecord | null {
  const run = live(projectId, runId);
  if (!run) return null;
  run.paused = true;
  return publicRun(run);
}

export function resumeLocalRun(projectId: string, runId: string): RunRecord | null {
  const run = live(projectId, runId);
  if (!run) return null;
  run.paused = false;
  run.resumeWait?.();
  run.resumeWait = null;
  return publicRun(run);
}

export function stopLocalRun(projectId: string, runId: string): RunRecord | null {
  const run = live(projectId, runId);
  if (!run) return null;
  run.abort.abort();
  run.view = { ...run.view, status: "stopped", stopReason: null, approval: null };
  return publicRun(run);
}

export function decideLocalRun(
  projectId: string,
  runId: string,
  decision: "allow" | "deny",
): RunRecord | null {
  const run = live(projectId, runId);
  if (!run) return null;
  const decide = run.approvalWait;
  run.approvalWait = null;
  decide?.(decision);
  return publicRun(run);
}

export async function acceptLocalRun(projectId: string, runId: string): Promise<RunRecord | null> {
  const run = live(projectId, runId);
  if (!run) return null;
  if (run.view.status === "running" || run.view.status === "waiting-for-approval") {
    throw new Error("Stop the run before accepting it.");
  }
  if (!run.isolation) {
    throw new Error("This sample run stays in memory. There is no worktree to accept.");
  }
  if (run.accepted || run.discarded) return publicRun(run);
  const result = await acceptIsolation(run.isolation, { strategy: "branch", slug: run.contract.goal });
  run.isolation = null;
  run.accepted = result;
  return publicRun(run);
}

export async function discardLocalRun(projectId: string, runId: string): Promise<RunRecord | null> {
  const run = live(projectId, runId);
  if (!run) return null;
  if (run.view.status === "running" || run.view.status === "waiting-for-approval") {
    run.abort.abort();
    run.view = { ...run.view, status: "stopped", stopReason: null, approval: null };
  }
  if (run.isolation) {
    await discardIsolation(run.isolation);
    run.isolation = null;
  }
  run.discarded = true;
  return publicRun(run);
}

function live(projectId: string, runId: string): LiveRun | null {
  const run = runs.get(runId);
  if (!run || run.projectId !== projectId) return null;
  return run;
}

function publicRun(run: LiveRun): RunRecord {
  return {
    runId: run.runId,
    projectId: run.projectId,
    view: run.view,
    accepted: run.accepted,
    discarded: run.discarded,
  };
}

function sampleFiles(): Record<string, string> {
  const seed = loadSeedProject();
  return {
    "validator.ts": seed.validator,
    "signup.test.ts": seed.tests,
    "legacy-helper.ts": seed.helper,
  };
}

function defaultBackend(): AgentBackend {
  if (geminiCredentials()) return createGeminiAgentBackend();
  return {
    name: "gemini",
    async proposeStep() {
      throw new Error("No Gemini API key is set. A live model did not run.");
    },
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
