import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApprovalRecord, Proof, RunStatus, StopReason } from "@/lib/harness";

type CheckView = {
  id: string;
  name: string;
  state: "not-run" | "running" | "passed" | "failed";
  detail: string;
};

type PolicyRow = {
  action: string;
  decision: string;
  detail: string;
};

export function RunSurface({
  status,
  stopReason,
  attempt,
  maxAttempts,
  agent,
  approvals,
  changedFiles,
  diff,
  checks,
  policyDecisions,
  proof,
  structured,
  sessionKind,
  acceptedBranch,
  discarded,
  onAccept,
  onDiscard,
}: {
  status: RunStatus;
  stopReason: StopReason;
  attempt: number;
  maxAttempts: number | null;
  agent: { name: string; rationale: string } | null;
  approvals: ApprovalRecord[];
  changedFiles: { path: string; state: string }[];
  diff: string;
  checks: CheckView[];
  policyDecisions: PolicyRow[];
  proof: Proof | null;
  structured: {
    phase: string;
    goal: string;
    failure: string | null;
    summaries: string[];
    proofArtifact: string | null;
    constraints: string[];
  } | null;
  sessionKind: "sample" | "project";
  acceptedBranch: string | null;
  discarded: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const settled = status === "proved" || (status === "stopped" && stopReason !== "paused");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>This attempt</CardTitle>
          <CardDescription>
            {maxAttempts ? `Attempt ${attempt} of ${maxAttempts}.` : "The harness has not started."} The agent proposes an edit. It does not decide that the loop is done.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {agent ? (
            <>
              <p className="font-medium">{agent.name}</p>
              <p className="leading-relaxed text-muted-foreground">{agent.rationale}</p>
            </>
          ) : (
            <p className="leading-relaxed text-muted-foreground">No agent step yet. Compile a contract, then run the loop.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approvals</CardTitle>
          <CardDescription>
            Deletes and other gated edits wait here. A command outside the contract is an amendment. Adding it does not run it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {approvals.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">No approval has been requested.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {approvals.map((entry) => (
                <li key={`${entry.action}-${entry.decision}`} className="flex items-start justify-between gap-3">
                  <span>{entry.action}</span>
                  <Badge variant="outline">{entry.decision === "allow" ? "Approved" : "Denied"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Changed files</CardTitle>
          <CardDescription>The diff of this run. This is not a browser for the rest of the project.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {changedFiles.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">No files have changed in this run.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {changedFiles.map((file) => (
                <li key={file.path}>
                  <Badge variant="outline">
                    {file.path} · {file.state}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {diff ? (
            <pre className="max-h-80 overflow-auto rounded-lg bg-[#1c1915] p-3 font-mono text-[12px] leading-5 text-[#f3ead7] whitespace-pre-wrap">
              {diff}
            </pre>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verifier</CardTitle>
          <CardDescription>Commands named in the contract. A shell command passes only when it exits 0.</CardDescription>
        </CardHeader>
        <CardContent>
          {checks.every((check) => check.state === "not-run") ? (
            <p className="text-sm leading-relaxed text-muted-foreground">The verifier has not run in this attempt.</p>
          ) : (
            <ul className="divide-y divide-border">
              {checks.map((check) => (
                <li key={check.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{check.name}</span>
                    <span className="mt-1 block text-muted-foreground">{check.detail}</span>
                  </span>
                  <span className="text-xs tracking-wide text-muted-foreground uppercase">
                    {check.state === "passed" ? "Pass" : check.state === "failed" ? "Fail" : check.state === "running" ? "Running" : "Not run"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Policy</CardTitle>
          <CardDescription>Allow, deny, ask, or amend. Deny leaves the file untouched.</CardDescription>
        </CardHeader>
        <CardContent>
          {policyDecisions.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">No policy decision yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {policyDecisions.map((entry, index) => (
                <li key={`${entry.action}-${index}`}>
                  <span className="font-medium">{entry.decision}</span>
                  <span className="text-muted-foreground"> · {entry.action}. {entry.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {structured ? (
        <Card>
          <CardHeader>
            <CardTitle>Run state</CardTitle>
            <CardDescription>
              Phase {structured.phase}. Agents share this record, not a transcript. Raw verifier logs are not part of it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{structured.goal}</p>
            <p className="text-muted-foreground">{structured.constraints.join(" · ")}</p>
            {structured.failure ? <p>Failure: {structured.failure}</p> : null}
            {structured.summaries.map((summary) => (
              <p key={summary}>{summary}</p>
            ))}
            {structured.proofArtifact ? <p>Proof artifact {structured.proofArtifact}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Accept or discard</CardTitle>
          <CardDescription>
            {sessionKind === "sample"
              ? "The sample stays in memory. Open a project to keep a proofloop branch or throw the worktree away."
              : "Accept creates a proofloop branch from the worktree. Discard deletes the worktree and leaves your checkout as it was."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {acceptedBranch ? <p className="text-sm">Accepted as {acceptedBranch}.</p> : null}
          {discarded ? <p className="text-sm">Discarded. The original tree was left untouched.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={onAccept} disabled={sessionKind !== "project" || !settled || Boolean(acceptedBranch) || discarded}>
              Accept branch
            </Button>
            <Button type="button" variant="outline" onClick={onDiscard} disabled={sessionKind !== "project" || discarded || Boolean(acceptedBranch)}>
              Discard
            </Button>
          </div>
        </CardContent>
      </Card>

      {proof && status === "proved" ? null : status === "stopped" && stopReason === "max-attempts" ? (
        <p className="text-sm text-muted-foreground">
          Stopped at attempt {attempt} of {maxAttempts}. There is no proof, so this is not done.
        </p>
      ) : null}
    </div>
  );
}
