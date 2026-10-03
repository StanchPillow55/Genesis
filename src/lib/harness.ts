import { formatVerifier, verifierCommandName, type LoopContract } from "./contract";
import {
  applyCompletePasswordFix,
  applyIncompletePasswordFix,
  isPasswordRuleComplete,
  proposeTestCheat,
} from "./edits";
import type { CheckResult, CommandResult, VerifierReport, VerifyResponse } from "./verifier";
import { verifyWithWorkspace } from "./verify-run";
import { createMemoryWorkspace, policyFromContract, type Workspace } from "./workspace";

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
  const { contract, seed, signal, signup, shell, shouldPause, waitResume, waitApproval } = options;
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

    files = await readProject(workspace);
    yield timeline(
      "read",
      "Read validator.ts",
      "Signup checker source, read through the workspace. The password rule is what the failing check is about.",
    );
    yield* beat();
    yield timeline(
      "read",
      "Read signup.test.ts",
      "Three checks: username, password, and email. The harness may not rewrite these when modifyTests is deny.",
    );
    yield* beat();
    if (files.helper !== null) {
      yield timeline(
        "read",
        "Read legacy-helper.ts",
        "A stale draft, read through the workspace. The signup tests do not import it.",
      );
      yield* beat();
    }

    if (attempt === 1) {
      const cheat = proposeTestCheat(files.tests);
      if (cheat.ok) {
        const decision = workspace.decide({
          type: "write",
          path: "signup.test.ts",
          contents: cheat.source,
        });
        if (decision === "deny") {
          blocked.push({
            file: "signup.test.ts",
            policy: "modifyTests",
            reason: "The agent proposed weakening the password assertion.",
          });
          yield timeline(
            "policy-block",
            "Blocked edit to signup.test.ts",
            `modifyTests is deny, so the test file was not written.\n${cheat.diff ?? ""}`.trim(),
          );
        } else if (decision === "ask") {
          const request: ApprovalRequest = {
            id: "modify-tests",
            title: "Allow a change to signup.test.ts?",
            detail:
              "The agent wants to flip the longpassword assertion so a weak password rule would pass. modifyTests is require approval.",
          };
          const answer = yield* askForApproval(request);
          approvals.push({ action: "modify signup.test.ts", decision: answer });
          if (answer === "allow") {
            const written = await workspace.write("signup.test.ts", cheat.source, { approved: true });
            if (written.ok && written.value.changed) {
              filesChanged.add("signup.test.ts");
              files = await readProject(workspace);
              yield { type: "files", files: cloneFiles(files) };
              yield timeline(
                "edit",
                "Edited signup.test.ts",
                "You allowed the test change once. The verifier will run the edited checks.",
              );
            }
          } else {
            yield timeline(
              "approval",
              "Test edit denied",
              "signup.test.ts stays as written. The loop continues.",
            );
          }
        } else {
          const written = await workspace.write("signup.test.ts", cheat.source);
          if (written.ok && written.value.changed) {
            filesChanged.add("signup.test.ts");
            files = await readProject(workspace);
            yield { type: "files", files: cloneFiles(files) };
            yield timeline(
              "edit",
              "Edited signup.test.ts",
              `modifyTests is allow, so the harness applied the agent's test edit.\n${cheat.diff ?? ""}`.trim(),
            );
          }
        }
        yield* beat();
      }

      if (files.helper !== null) {
        const decision = workspace.decide({ type: "delete", path: "legacy-helper.ts" });
        if (decision === "deny") {
          blocked.push({
            file: "legacy-helper.ts",
            policy: "delete",
            reason: "The agent proposed deleting the stale helper.",
          });
          yield timeline(
            "policy-block",
            "Blocked delete of legacy-helper.ts",
            "delete is deny. The file stays on disk in this workspace, and the loop continues.",
          );
        } else if (decision === "ask") {
          const request: ApprovalRequest = {
            id: "delete-helper",
            title: "Delete legacy-helper.ts?",
            detail:
              "The agent wants to delete a stale helper that nothing imports. The contract says delete requires approval. Deny leaves the file in place and the loop continues. Allow once removes only that file.",
          };
          const answer = yield* askForApproval(request);
          approvals.push({ action: "delete legacy-helper.ts", decision: answer });
          if (answer === "allow") {
            const removed = await workspace.delete("legacy-helper.ts", { approved: true });
            if (removed.ok && removed.value.deleted) {
              filesChanged.add("legacy-helper.ts");
              files = await readProject(workspace);
              yield { type: "files", files: cloneFiles(files) };
              yield timeline(
                "edit",
                "Deleted legacy-helper.ts",
                "You allowed the delete once. The signup tests do not import that file, so the checker still runs.",
              );
            }
          } else {
            yield timeline(
              "approval",
              "Delete denied",
              "legacy-helper.ts stays. The harness did not remove it, and the loop continues.",
            );
          }
        } else {
          const removed = await workspace.delete("legacy-helper.ts");
          if (removed.ok && removed.value.deleted) {
            filesChanged.add("legacy-helper.ts");
            files = await readProject(workspace);
            yield { type: "files", files: cloneFiles(files) };
            yield timeline(
              "edit",
              "Deleted legacy-helper.ts",
              "delete is allow, so the harness removed the stale helper without stopping for approval.",
            );
          }
        }
        yield* beat();
      }
    }

    if (!isPasswordRuleComplete(files.validator)) {
      const useIncomplete =
        attempt === 1 && files.validator.includes("return password.length >= 4;");
      const proposed = useIncomplete
        ? applyIncompletePasswordFix(files.validator)
        : applyCompletePasswordFix(files.validator);
      if (!proposed.ok) {
        yield timeline("edit", "Source edit did not apply", proposed.reason);
      } else {
        const decision = workspace.decide({
          type: "write",
          path: "validator.ts",
          contents: proposed.source,
        });
        const detail = useIncomplete
          ? "Raised the password length to 8. A letter and a number are still not required."
          : "Password rule now requires 8 characters, a letter, and a number.";
        if (decision === "deny") {
          blocked.push({
            file: "validator.ts",
            policy: "editSource",
            reason: useIncomplete
              ? "The agent proposed raising the password length without requiring a number."
              : "The agent proposed the full password rule.",
          });
          yield timeline(
            "policy-block",
            "Blocked edit to validator.ts",
            "editSource is deny. The checker source was not modified.",
          );
        } else if (decision === "ask") {
          const request: ApprovalRequest = {
            id: `edit-source-${attempt}`,
            title: useIncomplete ? "Allow a partial password edit?" : "Allow the password fix?",
            detail: useIncomplete
              ? "The agent wants to change the password rule to length >= 8 and stop there. editSource is require approval."
              : "The agent wants to require 8 characters, a letter, and a number. editSource is require approval.",
          };
          const answer = yield* askForApproval(request);
          approvals.push({
            action: useIncomplete ? "partial edit validator.ts" : "fix validator.ts",
            decision: answer,
          });
          if (answer === "allow") {
            const written = await workspace.write("validator.ts", proposed.source, { approved: true });
            if (written.ok && written.value.changed) {
              filesChanged.add("validator.ts");
              files = await readProject(workspace);
              yield { type: "files", files: cloneFiles(files) };
              yield timeline("edit", "Edited validator.ts", detail);
            }
          } else {
            yield timeline(
              "approval",
              "Source edit denied",
              "validator.ts stays as it is. The loop continues to the verifier.",
            );
          }
        } else {
          const written = await workspace.write("validator.ts", proposed.source);
          if (written.ok && written.value.changed) {
            filesChanged.add("validator.ts");
            files = await readProject(workspace);
            yield { type: "files", files: cloneFiles(files) };
            yield timeline(
              "edit",
              "Edited validator.ts",
              useIncomplete
                ? "Raised the password length to 8. A letter and a number are still not required, so this attempt is incomplete on purpose."
                : detail,
            );
          }
        }
      }
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
