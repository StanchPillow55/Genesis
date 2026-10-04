import type { AgentBackend, ProposedAction, ProposedStep } from "./agent";
import { applyAmendment, formatVerifier, verifierCommandName, type LoopContract } from "./contract";
import type { CheckResult, CommandResult, VerifierReport, VerifyResponse } from "./verifier";
import { verifyWithWorkspace } from "./verify-run";
import { createMemoryWorkspace, policyFromContract, unifiedDiff, type Workspace } from "./workspace";

export type ProjectFiles = {
  validator: string;
  tests: string;
  helper: string | null;
};

export type TimelineKind =
  | "goal-created"
  | "contract-compiled"
  | "attempt"
  | "read"
  | "edit"
  | "verify-fail"
  | "verify-pass"
  | "policy-block"
  | "approval"
  | "stop";

export type TimelineEvent = {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  at: string;
};

export type PolicyBlock = {
  file: string;
  policy: "modifyTests" | "delete" | "editSource";
  reason: string;
};

export type ApprovalRecord = {
  action: string;
  decision: "allow" | "deny";
};

export type Proof = {
  commands: { command: string; exitCode: number }[];
  testTotals: { passed: number; failed: number; total: number } | null;
  filesChanged: string[];
  policyResult: {
    blocked: PolicyBlock[];
    approvals: ApprovalRecord[];
  };
  attemptCount: number;
  maxAttempts: number;
  verifier: string;
};

export type RunStatus = "idle" | "running" | "waiting-for-approval" | "proved" | "stopped";

export type StopReason = "paused" | "max-attempts" | "crash" | null;

export type ApprovalRequest = {
  id: string;
  title: string;
  detail: string;
};

export type HarnessFocus = "intent" | "harness" | "verifier";

export type HarnessEvent =
  | { type: "status"; status: RunStatus; reason?: StopReason }
  | { type: "timeline"; event: TimelineEvent }
  | { type: "files"; files: ProjectFiles }
  | { type: "checks"; checks: CheckResult[] | "running" | "idle" }
  | { type: "attempt"; current: number; max: number }
  | { type: "proof"; proof: Proof }
  | { type: "proof-clear" }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "approval-clear" }
  | { type: "focus"; focus: HarnessFocus }
  | { type: "error"; message: string };

export type HarnessOptions = {
  contract: LoopContract;
  seed: ProjectFiles;
  paceMs: number;
  signal: AbortSignal;
  signup: (files: { validator: string; tests: string }) => Promise<VerifyResponse>;
  shell: (command: string) => Promise<CommandResult>;
  backend: AgentBackend;
  shouldPause: () => boolean;
  waitResume: () => Promise<void>;
  waitApproval: (request: ApprovalRequest) => Promise<"allow" | "deny">;
};

export function proofAllowsDone(
  proof: Proof | null | undefined,
  contract: LoopContract | null | undefined,
): proof is Proof {
  if (!proof || !contract || contract.uncertainty) return false;
  const expected = contract.verifier.commands.map(verifierCommandName);
  if (expected.length === 0 || proof.commands.length !== expected.length) return false;
  const commandsOk = expected.every((command, index) => {
    const result = proof.commands[index];
    return result?.command === command && result.exitCode === 0;
  });
  const { filesChanged, policyResult, attemptCount, verifier } = proof;
  return (
    commandsOk &&
    filesChanged.length > 0 &&
    Array.isArray(policyResult.blocked) &&
    Array.isArray(policyResult.approvals) &&
    Number.isInteger(attemptCount) &&
    attemptCount >= 1 &&
    attemptCount <= contract.maxAttempts &&
    proof.maxAttempts === contract.maxAttempts &&
    verifier.trim().length > 0
  );
}

export async function* runHarness(options: HarnessOptions): AsyncGenerator<HarnessEvent> {
  const { contract, seed, signal, signup, shell, backend, shouldPause, waitResume, waitApproval } = options;
  const workspace = createMemoryWorkspace({
    files: {
      "validator.ts": seed.validator,
      "signup.test.ts": seed.tests,
      ...(seed.helper !== null ? { "legacy-helper.ts": seed.helper } : {}),
    },
    policy: policyFromContract(contract),
    shell,
  });
  let files = await readProject(workspace);
  const blocked: PolicyBlock[] = [];
  const approvals: ApprovalRecord[] = [];
  const filesChanged = new Set<string>();
  let verifierFailure: string | null = null;
  let sequence = 0;

  const timeline = (kind: TimelineKind, title: string, detail: string): HarnessEvent => ({
    type: "timeline",
    event: {
      id: `step-${sequence++}`,
      kind,
      title,
      detail,
      at: stamp(),
    },
  });

  yield { type: "files", files: cloneFiles(files) };
  yield { type: "checks", checks: "idle" };
  yield { type: "proof-clear" };
  yield { type: "attempt", current: 0, max: contract.maxAttempts };
  yield { type: "focus", focus: "harness" };
  yield { type: "status", status: "running", reason: null };

  const beat = async function* (): AsyncGenerator<HarnessEvent> {
    await pace(options.paceMs, signal, shouldPause);
    if (signal.aborted) throw abortError();
    if (!shouldPause()) return;
    yield { type: "status", status: "stopped", reason: "paused" };
    yield timeline(
      "stop",
      "Paused",
      "You paused the harness. The verifier has not signed off, so this is not done. Resume continues the same attempt.",
    );
    await waitResume();
    if (signal.aborted) throw abortError();
    yield { type: "status", status: "running", reason: null };
    yield timeline("stop", "Resumed", "The harness picked up the same attempt.");
  };

  for (let attempt = 1; attempt <= contract.maxAttempts; attempt++) {
    if (signal.aborted) throw abortError();
    yield* beat();
    yield { type: "attempt", current: attempt, max: contract.maxAttempts };
    yield timeline(
      "attempt",
      `Attempt ${attempt} of ${contract.maxAttempts}`,
      "The harness opened this attempt. Completion still depends on the verifier.",
    );

    const snapshot = orderedSnapshot(await workspaceSnapshot(workspace));
    files = await readProject(workspace);
    for (const file of snapshot) {
      yield timeline("read", `Read ${file.path}`, readDetail(file.path));
      yield* beat();
    }

    let proposal: ProposedStep;
    try {
      proposal = await backend.proposeStep({
        goal: contract.goal,
        attempt,
        maxAttempts: contract.maxAttempts,
        files: snapshot,
        verifierFailure,
        contract,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
      yield timeline("stop", "Stopped", "The agent did not propose a step. Nothing was marked done.");
      yield { type: "status", status: "stopped", reason: "crash" };
      return;
    }

    yield timeline("edit", `${backend.name} proposed a step`, proposal.rationale);
    for (const action of proposal.actions) {
      yield* applyProposed(action, attempt);
      yield* beat();
    }


    yield { type: "focus", focus: "verifier" };
    yield { type: "checks", checks: "running" };
    let report: VerifierReport;
    try {
      files = await readProject(workspace);
      report = await verifyThroughWorkspace(workspace, contract, signup);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "focus", focus: "harness" };
      yield {
        type: "error",
        message: `The verifier did not return a result. ${message}`,
      };
      yield timeline(
        "stop",
        "Stopped",
        "The verifier crashed before it could score the contract commands. Nothing was marked done.",
      );
      yield { type: "status", status: "stopped", reason: "crash" };
      return;
    }
    yield { type: "focus", focus: "harness" };
    const checks = checksFromReport(report);
    yield { type: "checks", checks };

    if (report.crash) {
      yield {
        type: "error",
        message: `The verifier crashed: ${report.crash}`,
      };
      yield timeline(
        "stop",
        "Stopped",
        "The verifier crashed before it could score the contract commands. Nothing was marked done.",
      );
      yield { type: "status", status: "stopped", reason: "crash" };
      return;
    }

    const commandsPassed =
      report.commands.length > 0 && report.commands.every((entry) => entry.exitCode === 0);
    if (commandsPassed) {
      const proof: Proof = {
        commands: report.commands.map((entry) => ({
          command: entry.command,
          exitCode: entry.exitCode,
        })),
        testTotals: report.totals,
        filesChanged: [...filesChanged],
        policyResult: {
          blocked: blocked.map((entry) => ({ ...entry })),
          approvals: approvals.map((entry) => ({ ...entry })),
        },
        attemptCount: attempt,
        maxAttempts: contract.maxAttempts,
        verifier: formatVerifier(contract.verifier),
      };
      if (!proofAllowsDone(proof, contract)) {
        yield {
          type: "error",
          message:
            "The verifier commands exited 0, but the proof record does not satisfy the contract. Status stays stopped.",
        };
        yield timeline(
          "stop",
          "Stopped without proof",
          "A passing run without a proof object that satisfies the contract is not done.",
        );
        yield { type: "status", status: "stopped", reason: "crash" };
        return;
      }
      const passedDetail = report.checks
        ? "Username, password, and email all passed by running the functions. The harness did not ask a model."
        : report.commands.map((entry) => `${entry.command} exited 0.`).join(" ");
      yield timeline("verify-pass", "Verifier passed", passedDetail);
      yield { type: "proof", proof };
      yield timeline(
        "stop",
        "Stopped with proof",
        `Attempt ${attempt} of ${contract.maxAttempts}. The verifier passed, so the harness stopped.`,
      );
      yield { type: "status", status: "proved", reason: null };
      return;
    }

    const failing = checks.filter((check) => !check.passed);
    const failingDetail = failing.map((check) => `${check.name}: ${check.detail}`).join(" ");
    verifierFailure = failingDetail;
    yield timeline(
      "verify-fail",
      "Verifier failed",
      `${failingDetail} The loop continues because the verifier failed, not because a model said to keep going.`,
    );

    if (attempt === contract.maxAttempts) {
      yield timeline(
        "stop",
        "Stopped at the attempt limit",
        `Reached attempt ${attempt} of ${contract.maxAttempts}. The verifier did not pass, so this is not done.`,
      );
      yield { type: "status", status: "stopped", reason: "max-attempts" };
      return;
    }
    yield* beat();
  }

  async function* applyProposed(action: ProposedAction, attempt: number): AsyncGenerator<HarnessEvent> {
    if (action.type === "amendment") {
      const answer = yield* askForApproval({
        id: `amend-${attempt}-${action.command}`,
        title: `Add ${action.command} to the contract?`,
        detail:
          "This command is not in the contract. Approving adds it to the verifier. That approval does not run the command. Deny leaves the contract unchanged.",
      });
      approvals.push({ action: `amend verifier ${action.command}`, decision: answer });
      if (answer !== "allow") {
        yield timeline(
          "approval",
          "Amendment denied",
          `${action.command} stays out of the contract and did not run.`,
        );
        return;
      }
      const next = applyAmendment(contract, { type: "add-verifier-command", command: action.command });
      contract.verifier = next.verifier;
      yield timeline(
        "approval",
        "Contract amended",
        `${action.command} is now a verifier command. The approval did not execute it.`,
      );
      return;
    }
    const workspaceAction =
      action.type === "delete"
        ? { type: "delete" as const, path: action.path }
        : { type: "write" as const, path: action.path, contents: action.contents };
    const decision = workspace.decide(workspaceAction);
    const copy = actionCopy(action, attempt);
    const diff = action.type === "write" ? await writeDiff(workspace, action.path, action.contents) : "";
    if (decision === "deny") {
      blocked.push({ file: action.path, policy: policyField(action), reason: copy.blockReason });
      yield timeline(
        "policy-block",
        copy.blockTitle,
        diff ? `${copy.blockDetail}\n${diff}`.trim() : copy.blockDetail,
      );
      return;
    }
    let grant: { approved: true } | undefined;
    if (decision === "ask") {
      const answer = yield* askForApproval({
        id: copy.approvalId,
        title: copy.approvalTitle,
        detail: copy.approvalDetail,
      });
      approvals.push({ action: copy.approvalAction, decision: answer });
      if (answer !== "allow") {
        yield timeline("approval", copy.deniedTitle, copy.deniedDetail);
        return;
      }
      grant = { approved: true };
    }
    if (action.type === "delete") {
      const removed = await workspace.delete(action.path, grant);
      if (removed.ok && removed.value.deleted) {
        filesChanged.add(action.path);
        files = await readProject(workspace);
        yield { type: "files", files: cloneFiles(files) };
        yield timeline("edit", copy.editTitle, decision === "ask" ? copy.approvedDetail : copy.editDetail);
      }
      return;
    }
    const written = await workspace.write(action.path, action.contents, grant);
    if (!written.ok || !written.value.changed) return;
    filesChanged.add(action.path);
    files = await readProject(workspace);
    yield { type: "files", files: cloneFiles(files) };
    const detail = decision === "ask" ? copy.approvedDetail : copy.editDetail;
    yield timeline("edit", copy.editTitle, action.path.endsWith(".test.ts") && diff ? `${detail}\n${diff}`.trim() : detail);
  }

  async function* askForApproval(
    request: ApprovalRequest,
  ): AsyncGenerator<HarnessEvent, "allow" | "deny"> {
    const answerPromise = waitApproval(request);
    yield { type: "status", status: "waiting-for-approval", reason: null };
    yield timeline("approval", "Waiting for approval", request.detail);
    yield { type: "approval-request", request };
    const answer = await answerPromise;
    if (signal.aborted) throw abortError();
    yield { type: "approval-clear" };
    yield { type: "status", status: "running", reason: null };
    return answer;
  }
}

async function workspaceSnapshot(workspace: Workspace): Promise<{ path: string; contents: string }[]> {
  const status = await workspace.status();
  if (!status.ok) throw new Error("The workspace refused to report status.");
  const files: { path: string; contents: string }[] = [];
  for (const file of status.value.files) {
    if (file.state === "deleted") continue;
    const read = await workspace.read(file.path);
    if (read.ok) files.push({ path: file.path, contents: read.value });
  }
  return files;
}

function orderedSnapshot(files: { path: string; contents: string }[]): { path: string; contents: string }[] {
  const preferred = ["validator.ts", "signup.test.ts", "legacy-helper.ts"];
  return [...files].sort((left, right) => {
    const leftIndex = preferred.indexOf(left.path);
    const rightIndex = preferred.indexOf(right.path);
    if (leftIndex === -1 && rightIndex === -1) return left.path.localeCompare(right.path);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

function readDetail(path: string): string {
  if (path === "validator.ts") {
    return "Signup checker source, read through the workspace. The password rule is what the failing check is about.";
  }
  if (path === "signup.test.ts") {
    return "Three checks: username, password, and email. The harness may not rewrite these when modifyTests is deny.";
  }
  if (path === "legacy-helper.ts") {
    return "A stale draft, read through the workspace. The signup tests do not import it.";
  }
  return "Read through the workspace.";
}

async function writeDiff(workspace: Workspace, path: string, contents: string): Promise<string> {
  const current = await workspace.read(path).catch(() => null);
  if (!current || !current.ok) return "";
  return unifiedDiff(path, current.value, contents);
}

function policyField(action: ProposedAction): "modifyTests" | "delete" | "editSource" {
  if (action.type === "delete") return "delete";
  if (/(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(action.path) || action.path.includes("__tests__/")) {
    return "modifyTests";
  }
  return "editSource";
}

function actionCopy(action: ProposedAction, attempt: number): {
  blockTitle: string;
  blockDetail: string;
  blockReason: string;
  approvalId: string;
  approvalTitle: string;
  approvalDetail: string;
  approvalAction: string;
  deniedTitle: string;
  deniedDetail: string;
  editTitle: string;
  editDetail: string;
  approvedDetail: string;
} {
  if (action.type === "delete") {
    return {
      blockTitle: `Blocked delete of ${action.path}`,
      blockDetail: "delete is deny. The file stays on disk in this workspace, and the loop continues.",
      blockReason: "The agent proposed deleting the stale helper.",
      approvalId: "delete-helper",
      approvalTitle: `Delete ${action.path}?`,
      approvalDetail:
        "The agent wants to delete a stale helper that nothing imports. The contract says delete requires approval. Deny leaves the file in place and the loop continues. Allow once removes only that file.",
      approvalAction: `delete ${action.path}`,
      deniedTitle: "Delete denied",
      deniedDetail: `${action.path} stays. The harness did not remove it, and the loop continues.`,
      editTitle: `Deleted ${action.path}`,
      editDetail: "delete is allow, so the harness removed the stale helper without stopping for approval.",
      approvedDetail: "You allowed the delete once. The signup tests do not import that file, so the checker still runs.",
    };
  }
  const partial = action.contents.includes("password.length >= 8") && !action.contents.includes("hasNumber");
  const full = action.contents.includes("const hasNumber");
  if (action.path === "signup.test.ts") {
    return {
      blockTitle: "Blocked edit to signup.test.ts",
      blockDetail: "modifyTests is deny, so the test file was not written.",
      blockReason: "The agent proposed weakening the password assertion.",
      approvalId: "modify-tests",
      approvalTitle: "Allow a change to signup.test.ts?",
      approvalDetail:
        "The agent wants to flip the longpassword assertion so a weak password rule would pass. modifyTests is require approval.",
      approvalAction: "modify signup.test.ts",
      deniedTitle: "Test edit denied",
      deniedDetail: "signup.test.ts stays as written. The loop continues.",
      editTitle: "Edited signup.test.ts",
      editDetail: "modifyTests is allow, so the harness applied the agent's test edit.",
      approvedDetail: "You allowed the test change once. The verifier will run the edited checks.",
    };
  }
  if (action.path === "validator.ts" && (partial || full)) {
    return {
      blockTitle: "Blocked edit to validator.ts",
      blockDetail: "editSource is deny. The checker source was not modified.",
      blockReason: partial
        ? "The agent proposed raising the password length without requiring a number."
        : "The agent proposed the full password rule.",
      approvalId: `edit-source-${attempt}`,
      approvalTitle: partial ? "Allow a partial password edit?" : "Allow the password fix?",
      approvalDetail: partial
        ? "The agent wants to change the password rule to length >= 8 and stop there. editSource is require approval."
        : "The agent wants to require 8 characters, a letter, and a number. editSource is require approval.",
      approvalAction: partial ? "partial edit validator.ts" : "fix validator.ts",
      deniedTitle: "Source edit denied",
      deniedDetail: "validator.ts stays as it is. The loop continues to the verifier.",
      editTitle: "Edited validator.ts",
      editDetail: partial
        ? "Raised the password length to 8. A letter and a number are still not required, so this attempt is incomplete on purpose."
        : "Password rule now requires 8 characters, a letter, and a number.",
      approvedDetail: partial
        ? "Raised the password length to 8. A letter and a number are still not required."
        : "Password rule now requires 8 characters, a letter, and a number.",
    };
  }
  const field = policyField(action);
  return {
    blockTitle: `Blocked edit to ${action.path}`,
    blockDetail: `${field} is deny, so ${action.path} was not written.`,
    blockReason: `The agent proposed a write to ${action.path}.`,
    approvalId: `edit-${action.path}-${attempt}`,
    approvalTitle: `Allow a change to ${action.path}?`,
    approvalDetail: `The agent wants to write ${action.path}. ${field} is require approval.`,
    approvalAction: `modify ${action.path}`,
    deniedTitle: "Edit denied",
    deniedDetail: `${action.path} stays as it is. The loop continues.`,
    editTitle: `Edited ${action.path}`,
    editDetail: `${field} is allow, so the harness wrote ${action.path}.`,
    approvedDetail: `You allowed the write to ${action.path} once.`,
  };
}

async function readProject(workspace: Workspace): Promise<ProjectFiles> {
  const validator = await workspace.read("validator.ts");
  const tests = await workspace.read("signup.test.ts");
  if (!validator.ok || !tests.ok) {
    throw new Error("The workspace refused to read the signup fixture.");
  }
  const helper = await workspace.read("legacy-helper.ts").catch(() => null);
  return {
    validator: validator.value,
    tests: tests.value,
    helper: helper && helper.ok ? helper.value : null,
  };
}

function verifyThroughWorkspace(
  workspace: Workspace,
  contract: LoopContract,
  signup: (files: { validator: string; tests: string }) => Promise<VerifyResponse>,
): Promise<VerifierReport> {
  return verifyWithWorkspace(workspace, contract.verifier.commands, signup);
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

function cloneFiles(files: ProjectFiles): ProjectFiles {
  return { validator: files.validator, tests: files.tests, helper: files.helper };
}

function stamp(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

async function pace(ms: number, signal: AbortSignal, shouldPause: () => boolean): Promise<void> {
  if (ms <= 0) {
    if (signal.aborted) throw abortError();
    return;
  }
  const steps = Math.max(1, Math.ceil(ms / 40));
  for (let index = 0; index < steps; index++) {
    if (signal.aborted) throw abortError();
    if (shouldPause()) return;
    await sleep(Math.min(40, ms), signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
