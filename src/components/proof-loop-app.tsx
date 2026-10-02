"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PRESET_GOAL,
  contractToJson,
  parseContract,
  type LoopContract,
} from "@/lib/contract";
import {
  proofAllowsDone,
  runHarness,
  type ApprovalRequest,
  type HarnessEvent,
  type HarnessFocus,
  type ProjectFiles,
  type Proof,
  type RunStatus,
  type StopReason,
  type TimelineEvent,
} from "@/lib/harness";
import type { SeedProject } from "@/lib/sample-project";
import type { VerifyResponse } from "@/lib/verifier";
import { cn } from "@/lib/utils";

type CheckView = {
  id: "username" | "password" | "email";
  name: string;
  state: "not-run" | "running" | "passed" | "failed";
  detail: string;
};

type CompilerMode = "gemini" | "fallback" | null;

const INITIAL_CHECKS: CheckView[] = [
  {
    id: "username",
    name: "Username",
    state: "not-run",
    detail: "Accepts ada_lovelace. Rejects short names and spaces.",
  },
  {
    id: "password",
    name: "Password",
    state: "not-run",
    detail: "Needs 8+ characters, a letter, and a number.",
  },
  {
    id: "email",
    name: "Email",
    state: "not-run",
    detail: "Accepts ada@community.org. Rejects not-an-email.",
  },
];

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: "Idle",
  running: "Running",
  "waiting-for-approval": "Waiting for approval",
  proved: "Proved",
  stopped: "Stopped",
};

export function ProofLoopApp({
  seed,
  geminiConfigured,
}: {
  seed: SeedProject;
  geminiConfigured: boolean;
}) {
  const seedFiles = useMemo<ProjectFiles>(
    () => ({ validator: seed.validator, tests: seed.tests, helper: seed.helper }),
    [seed],
  );
  const [goal, setGoal] = useState("");
  const [contractText, setContractText] = useState("");
  const [compilePhase, setCompilePhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [compilerMode, setCompilerMode] = useState<CompilerMode>(null);
  const [compilerModel, setCompilerModel] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [stopReason, setStopReason] = useState<StopReason>(null);
  const [attempt, setAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState<number | null>(null);
  const [files, setFiles] = useState<ProjectFiles>(seedFiles);
  const [checks, setChecks] = useState<CheckView[]>(INITIAL_CHECKS);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [proof, setProof] = useState<Proof | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [focus, setFocus] = useState<HarnessFocus | null>(null);

  const runId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pauseRef = useRef(false);
  const resumeRef = useRef<(() => void) | null>(null);
  const approvalRef = useRef<((decision: "allow" | "deny") => void) | null>(null);
  const proofRef = useRef<Proof | null>(null);
  const compileEvents = useRef<TimelineEvent[]>([]);
  const timelineEnd = useRef<HTMLDivElement | null>(null);

  const locked =
    status === "running" ||
    status === "waiting-for-approval" ||
    (status === "stopped" && stopReason === "paused");

  const parsed = useMemo(() => {
    if (!contractText.trim()) return { contract: null as LoopContract | null, problem: null as string | null };
    try {
      return { contract: parseContract(JSON.parse(contractText) as unknown), problem: null };
    } catch (caught) {
      return {
        contract: null,
        problem: caught instanceof Error ? caught.message : "This contract is not valid JSON.",
      };
    }
  }, [contractText]);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: "nearest" });
  }, [timeline]);

  function apply(event: HarnessEvent) {
    switch (event.type) {
      case "status":
        if (event.status === "proved" && !proofAllowsDone(proofRef.current)) {
          setStatus("stopped");
          setStopReason("crash");
          setError("The harness tried to mark this done without a complete proof object.");
          return;
        }
        setStatus(event.status);
        setStopReason(event.reason ?? null);
        return;
      case "timeline":
        setTimeline((current) => [...current, event.event]);
        return;
      case "files":
        setFiles(event.files);
        return;
      case "checks":
        if (event.checks === "idle") {
          setChecks(INITIAL_CHECKS);
          return;
        }
        if (event.checks === "running") {
          setChecks((current) =>
            current.map((check) => ({ ...check, state: "running", detail: "Running this check now." })),
          );
          return;
        }
        setChecks(
          event.checks.map((check) => ({
            id: check.id,
            name: check.name,
            state: check.passed ? "passed" : "failed",
            detail: check.detail,
          })),
        );
        return;
      case "attempt":
        setAttempt(event.current);
        setMaxAttempts(event.max);
        return;
      case "proof":
        proofRef.current = event.proof;
        setProof(proofAllowsDone(event.proof) ? event.proof : null);
        return;
      case "proof-clear":
        proofRef.current = null;
        setProof(null);
        return;
      case "approval-request":
        setApproval(event.request);
        return;
      case "approval-clear":
        setApproval(null);
        return;
      case "focus":
        setFocus(event.focus);
        return;
      case "error":
        setError(event.message);
        return;
      default:
        return;
    }
  }

  async function onCompile() {
    const sentence = goal.trim();
    if (!sentence) {
      setCompilePhase("error");
      setError("Write a goal before compiling. An empty sentence is not a contract.");
      return;
    }
    setCompilePhase("loading");
    setError(null);
    setWarning(null);
    setFocus("intent");
    try {
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: sentence }),
      });
      const data = (await response.json()) as {
        error?: string;
        contract?: LoopContract;
        compiler?: CompilerMode;
        model?: string;
        notes?: string[];
        warning?: string;
      };
      if (!response.ok || !data.contract) {
        setCompilePhase("error");
        setError(data.error ?? "The compiler could not write a contract.");
        return;
      }
      setContractText(contractToJson(data.contract));
      setCompilerMode(data.compiler ?? "fallback");
      setCompilerModel(data.model ?? null);
      setNotes(data.notes ?? []);
      setWarning(data.warning ?? null);
      setCompilePhase("ready");
      const created = stampEvent(
        "goal-created",
        "Goal created",
        sentence,
      );
      const compiled = stampEvent(
        "contract-compiled",
        data.compiler === "gemini" ? "Contract compiled by Gemini" : "Contract compiled locally",
        data.compiler === "gemini"
          ? `Gemini turned the sentence into a loop contract${data.model ? ` (${data.model})` : ""}.`
          : "No Gemini key is in this session, so the local compiler read the sentence itself.",
      );
      compileEvents.current = [created, compiled];
      setTimeline((current) => {
        const kept = status === "idle" || status === "proved" || (status === "stopped" && stopReason !== "paused")
          ? []
          : current;
        return [...kept, created, compiled];
      });
    } catch {
      setCompilePhase("error");
      setError("The compiler did not answer. Check that the dev server is still running, then try again.");
    }
  }

  function onRun() {
    if (status === "stopped" && stopReason === "paused") {
      pauseRef.current = false;
      const resume = resumeRef.current;
      resumeRef.current = null;
      resume?.();
      return;
    }
    if (!contractText.trim()) {
      setError("Compile a contract first. The harness does not start from a sentence.");
      return;
    }
    if (parsed.problem || !parsed.contract) {
      setError(parsed.problem ?? "This contract is not JSON the harness can read.");
      return;
    }
    if (parsed.contract.uncertainty) {
      setError(parsed.contract.uncertainty);
      return;
    }
    void startLoop(parsed.contract);
  }

  async function startLoop(contract: LoopContract) {
    const id = ++runId.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    pauseRef.current = false;
    proofRef.current = null;
    setError(null);
    setApproval(null);
    setProof(null);
    setStatus("running");
    setStopReason(null);
    setFiles(seedFiles);
    setChecks(INITIAL_CHECKS);
    setAttempt(0);
    setMaxAttempts(contract.maxAttempts);
    setTimeline(compileEvents.current);
    setFocus("harness");

    try {
      for await (const event of runHarness({
        contract,
        seed: seedFiles,
        paceMs: 680,
        signal: controller.signal,
        verify: async (current) => {
          const response = await fetch("/api/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(current),
          });
          const data = (await response.json()) as VerifyResponse & { error?: string };
          if (!response.ok) {
            throw new Error(data.error ?? "The verifier request failed.");
          }
          return data;
        },
        shouldPause: () => pauseRef.current,
        waitResume: () =>
          new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              controller.signal.removeEventListener("abort", onAbort);
              reject(abortError());
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            resumeRef.current = () => {
              controller.signal.removeEventListener("abort", onAbort);
              resolve();
            };
          }),
        waitApproval: () =>
          new Promise<"allow" | "deny">((resolve, reject) => {
            const onAbort = () => {
              controller.signal.removeEventListener("abort", onAbort);
              reject(abortError());
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            approvalRef.current = (decision) => {
              controller.signal.removeEventListener("abort", onAbort);
              resolve(decision);
            };
          }),
      })) {
        if (id !== runId.current) return;
        apply(event);
      }
    } catch (caught) {
      if (id !== runId.current) return;
      if (caught instanceof Error && caught.name === "AbortError") return;
      setStatus("stopped");
      setStopReason("crash");
      setError(caught instanceof Error ? caught.message : "The harness stopped unexpectedly.");
    }
  }

  function onPause() {
    pauseRef.current = true;
  }

  function onReset() {
    runId.current += 1;
    abortRef.current?.abort();
    pauseRef.current = false;
    proofRef.current = null;
    setStatus("idle");
    setStopReason(null);
    setFiles(seedFiles);
    setChecks(INITIAL_CHECKS);
    setTimeline(compileEvents.current);
    setProof(null);
    setApproval(null);
    setAttempt(0);
    setError(null);
    setFocus(contractText ? "intent" : null);
  }

  function decide(decision: "allow" | "deny") {
    const resolve = approvalRef.current;
    approvalRef.current = null;
    setApproval(null);
    resolve?.(decision);
  }

  function answerUncertainty() {
    if (!parsed.contract) {
      setError(parsed.problem ?? "Fix the contract JSON before answering.");
      return;
    }
    const next: LoopContract = {
      ...parsed.contract,
      goal: parsed.contract.goal || "all tests pass",
      uncertainty: null,
    };
    setContractText(contractToJson(next));
    setError(null);
  }

  const attemptLabel = maxAttempts
    ? `Attempt ${attempt} / ${maxAttempts}`
    : "Attempt — / —";
  const runLabel =
    status === "stopped" && stopReason === "paused"
      ? "Resume"
      : parsed.contract?.uncertainty
        ? "Run loop"
        : status === "proved" || (status === "stopped" && stopReason !== "paused")
          ? "Run again"
          : "Run loop";

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-foreground/15">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-medium tracking-[0.22em] text-muted-foreground uppercase">
              ProofLoop
            </p>
            <h1 className="mt-2 font-serif text-3xl leading-tight text-balance sm:text-4xl">
              Agents shouldn&apos;t stop because they think they&apos;re done.
            </h1>
            <p className="mt-2 font-serif text-xl text-foreground/80 italic sm:text-2xl">
              They should stop because they can prove they&apos;re done.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={status} />
            <Badge variant="outline">
              {compilerMode === "gemini"
                ? `Gemini${compilerModel ? ` · ${compilerModel}` : ""}`
                : compilerMode === "fallback"
                  ? "Local compiler"
                  : geminiConfigured
                    ? "Gemini key found"
                    : "Local compiler ready"}
            </Badge>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-20 border-b border-foreground/10 bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm sm:px-6">
          <span className="font-medium tabular-nums">{attemptLabel}</span>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <ul className="flex flex-wrap gap-2">
            {checks.map((check) => (
              <li key={check.id} className="inline-flex items-center gap-1.5">
                <CheckMark state={check.state} />
                <span>{check.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {approval ? (
        <div className="border-b border-amber-800/30 bg-amber-100 text-amber-950">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-medium tracking-[0.16em] uppercase">Approval gate</p>
              <p className="mt-1 font-medium">{approval.title}</p>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed">{approval.detail}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={() => decide("allow")}>
                Allow once
              </Button>
              <Button type="button" variant="outline" onClick={() => decide("deny")}>
                Deny
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>The loop is holding.</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {warning ? (
          <Alert>
            <AlertTitle>Gemini did not answer.</AlertTitle>
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        ) : null}

        <section className="grid gap-3 md:grid-cols-3">
          <LayerCard
            index="01"
            title="LLM interprets intent"
            body="Gemini, or the local compiler, turns the sentence into a contract. It does not run the loop."
            active={focus === "intent"}
          />
          <LayerCard
            index="02"
            title="Harness controls execution"
            body="Attempts, policies, approval, and stop are code. The model is not asked whether to continue."
            active={focus === "harness"}
          />
          <LayerCard
            index="03"
            title="Verifier decides completion"
            body="The signup tests run in this process. Pass or fail comes from the functions."
            active={focus === "verifier"}
          />
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(280px,360px)]">
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Goal</CardTitle>
                <CardDescription>
                  Say what done means. Mention tests, deletes, or a max attempt count if you care about them.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Label htmlFor="goal" className="sr-only">
                  Goal
                </Label>
                <Textarea
                  id="goal"
                  value={goal}
                  disabled={locked || compilePhase === "loading"}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="Make the signup checker healthy…"
                  className="min-h-28"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={locked || compilePhase === "loading"}
                    onClick={() => setGoal(PRESET_GOAL)}
                  >
                    Signup checker preset
                  </Button>
                  <Button
                    type="button"
                    disabled={locked || compilePhase === "loading" || !goal.trim()}
                    onClick={() => void onCompile()}
                  >
                    {compilePhase === "loading" ? "Compiling…" : "Compile contract"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Loop contract</CardTitle>
                <CardDescription>
                  Inspect it and edit the JSON. The harness enforces this object. It does not improvise past it.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {compilePhase === "loading" ? (
                  <p className="text-sm text-muted-foreground">Reading the goal and writing a contract…</p>
                ) : null}
                {!contractText && compilePhase !== "loading" ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    No contract yet. A goal is a sentence. A contract is what the harness is allowed to do.
                  </p>
                ) : null}
                {contractText ? (
                  <Textarea
                    aria-label="Loop contract JSON"
                    value={contractText}
                    disabled={locked}
                    onChange={(event) => setContractText(event.target.value)}
                    className="min-h-64 font-mono text-xs leading-5"
                    spellCheck={false}
                  />
                ) : null}
                {parsed.contract?.uncertainty ? (
                  <Alert>
                    <AlertTitle>The contract refuses to run.</AlertTitle>
                    <AlertDescription className="flex flex-col gap-3">
                      <span>{parsed.contract.uncertainty}</span>
                      <Button type="button" variant="outline" onClick={answerUncertainty} disabled={locked}>
                        Answer: stop when the signup tests pass
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {notes.length > 0 ? (
                  <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                    {notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={onRun}
                    disabled={
                      status === "running" ||
                      status === "waiting-for-approval" ||
                      compilePhase === "loading" ||
                      Boolean(parsed.contract?.uncertainty)
                    }
                  >
                    <Play />
                    {runLabel}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onPause}
                    disabled={status !== "running"}
                  >
                    <Pause />
                    Pause
                  </Button>
                  <Button type="button" variant="ghost" onClick={onReset}>
                    <RotateCcw />
                    Reset
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Verification</CardTitle>
                <CardDescription>
                  Three checks in the community-event signup checker. They execute here. A model does not score them.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {checks.every((check) => check.state === "not-run") ? (
                  <p className="text-sm text-muted-foreground">
                    These three checks have not been executed yet. The password check starts failing because the rule only requires four characters.
                  </p>
                ) : null}
                <ul className="divide-y divide-border">
                  {checks.map((check) => (
                    <li key={check.id} className="flex items-start gap-3 py-2">
                      <CheckMark state={check.state} />
                      <div className="min-w-0">
                        <p className="font-medium">{check.name}</p>
                        <p className="text-sm text-muted-foreground">{check.detail}</p>
                      </div>
                      <span className="ml-auto text-xs tracking-wide text-muted-foreground uppercase">
                        {check.state === "not-run"
                          ? "Not run"
                          : check.state === "running"
                            ? "Running"
                            : check.state === "passed"
                              ? "Pass"
                              : "Fail"}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Signup checker</CardTitle>
                <CardDescription>
                  Neighborhood organizers run this before someone claims a volunteer shift. The password rule is too weak.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="validator">
                  <TabsList>
                    <TabsTrigger value="validator">validator.ts</TabsTrigger>
                    <TabsTrigger value="tests">signup.test.ts</TabsTrigger>
                    <TabsTrigger value="helper">legacy-helper.ts</TabsTrigger>
                  </TabsList>
                  <TabsContent value="validator" className="pt-3">
                    <FileMeta changed={files.validator !== seedFiles.validator} />
                    <CodeView source={files.validator} baseline={seedFiles.validator} />
                  </TabsContent>
                  <TabsContent value="tests" className="pt-3">
                    <FileMeta changed={files.tests !== seedFiles.tests} />
                    <CodeView source={files.tests} baseline={seedFiles.tests} />
                  </TabsContent>
                  <TabsContent value="helper" className="pt-3">
                    {files.helper === null ? (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        legacy-helper.ts was removed after you allowed it. The signup tests do not import it, so the checker still runs.
                      </p>
                    ) : (
                      <>
                        <FileMeta changed={false} />
                        <CodeView source={files.helper} baseline={seedFiles.helper ?? ""} />
                      </>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Proof</CardTitle>
                <CardDescription>
                  Status cannot be proved until this record has totals, files, policy, and an attempt count.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {proof && status === "proved" ? (
                  <ProofPanel proof={proof} />
                ) : (
                  <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
                    <p>
                      No proof on file. A green check from a model is not evidence. The loop stays open until the signup tests pass and this panel lists test totals, files changed, the policy result, and the attempt count.
                    </p>
                    {status === "stopped" && stopReason === "max-attempts" ? (
                      <p>
                        The harness stopped at attempt {attempt} of {maxAttempts}. There is no proof object, so this is not done.
                      </p>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Timeline</CardTitle>
                <CardDescription>The record of this loop. Pause holds it. Reset returns the checker to the buggy seed.</CardDescription>
              </CardHeader>
              <CardContent>
                {timeline.length === 0 ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Nothing has been recorded. Compile a goal to open the record.
                  </p>
                ) : (
                  <ol className="max-h-[32rem] space-y-3 overflow-auto pr-1">
                    {timeline.map((event) => (
                      <li key={event.id} className="border-l-2 border-foreground/15 pl-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="text-sm font-medium">{event.title}</p>
                          <time className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{event.at}</time>
                        </div>
                        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{labelKind(event.kind)}</p>
                        <p className="mt-1 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground/80">{event.detail}</p>
                      </li>
                    ))}
                    <div ref={timelineEnd} />
                  </ol>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span
      aria-live="polite"
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium",
        status === "proved" && "border-emerald-800/40 bg-emerald-100 text-emerald-950",
        status === "waiting-for-approval" && "border-amber-800/40 bg-amber-100 text-amber-950",
        status === "running" && "border-sky-800/30 bg-sky-100 text-sky-950",
        status === "stopped" && "border-border bg-muted text-foreground",
        status === "idle" && "border-border bg-card text-muted-foreground",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function LayerCard({
  index,
  title,
  body,
  active,
}: {
  index: string;
  title: string;
  body: string;
  active: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10",
        active && "ring-2 ring-primary",
      )}
    >
      <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
        {index}
        {active ? " · active" : ""}
      </p>
      <p className="mt-1 font-medium">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function CheckMark({ state }: { state: CheckView["state"] }) {
  const symbol = state === "passed" ? "✓" : state === "failed" ? "✕" : state === "running" ? "…" : "·";
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
        state === "passed" && "border-emerald-800/40 bg-emerald-100 text-emerald-950",
        state === "failed" && "border-red-800/30 bg-red-100 text-red-950",
        state === "running" && "border-sky-800/30 bg-sky-100 text-sky-950",
        state === "not-run" && "border-border text-muted-foreground",
      )}
    >
      {symbol}
    </span>
  );
}

function FileMeta({ changed }: { changed: boolean }) {
  return (
    <p className="mb-2 text-xs text-muted-foreground">
      {changed ? "Changed by the harness in this run." : "Unchanged from the seed."}
    </p>
  );
}

function CodeView({ source, baseline }: { source: string; baseline: string }) {
  const current = source.split("\n");
  const previous = baseline.split("\n");
  return (
    <div className="max-h-80 overflow-auto rounded-lg bg-[#1c1915] text-[#f3ead7]">
      <pre className="p-3 font-mono text-[12px] leading-5">
        {current.map((line, index) => {
          const changed = line !== previous[index];
          return (
            <div
              key={`${index}-${line}`}
              className={cn("px-2", changed && "bg-amber-200/15")}
            >
              <span className="mr-3 inline-block w-6 text-right text-[#f3ead7]/40 select-none">
                {index + 1}
              </span>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function ProofPanel({ proof }: { proof: Proof }) {
  return (
    <div className="space-y-3">
      <p className="font-serif text-3xl text-emerald-900 italic">Proved</p>
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-xs tracking-wide text-muted-foreground uppercase">Test totals</dt>
          <dd>
            {proof.testTotals.passed} passed, {proof.testTotals.failed} failed, {proof.testTotals.total} total
          </dd>
        </div>
        <div>
          <dt className="text-xs tracking-wide text-muted-foreground uppercase">Files changed</dt>
          <dd>{proof.filesChanged.join(", ")}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-wide text-muted-foreground uppercase">Policy result</dt>
          <dd className="space-y-1">
            {proof.policyResult.blocked.length === 0 ? <p>Nothing blocked.</p> : null}
            {proof.policyResult.blocked.map((entry) => (
              <p key={`${entry.file}-${entry.policy}`}>
                Blocked {entry.file} ({entry.policy}). {entry.reason}
              </p>
            ))}
            {proof.policyResult.approvals.map((entry) => (
              <p key={entry.action}>
                {entry.action}: {entry.decision === "allow" ? "allowed once" : "denied"}
              </p>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs tracking-wide text-muted-foreground uppercase">Attempts</dt>
          <dd>
            {proof.attemptCount} of {proof.maxAttempts}
          </dd>
        </div>
        <div>
          <dt className="text-xs tracking-wide text-muted-foreground uppercase">Verifier</dt>
          <dd>{proof.verifier}</dd>
        </div>
      </dl>
    </div>
  );
}

function labelKind(kind: TimelineEvent["kind"]): string {
  switch (kind) {
    case "goal-created":
      return "Goal created";
    case "contract-compiled":
      return "Contract compiled";
    case "attempt":
      return "Attempt";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "verify-fail":
      return "Verify fail";
    case "verify-pass":
      return "Verify pass";
    case "policy-block":
      return "Policy block";
    case "approval":
      return "Approval";
    case "stop":
      return "Stop";
  }
}

function stampEvent(kind: TimelineEvent["kind"], title: string, detail: string): TimelineEvent {
  return {
    id: crypto.randomUUID(),
    kind,
    title,
    detail,
    at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }),
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
