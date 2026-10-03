import { verifierCommandName, type VerifierCommand } from "./contract";
import type { CheckResult, CommandResult, VerifierReport, VerifyResponse } from "./verifier";

export async function verifyWithWorkspace(
  workspace: {
    read(path: string): Promise<{ ok: true; value: string } | { ok: false; decision?: string }>;
    exec(command: string): Promise<{ ok: true; value: CommandResult } | { ok: false; decision?: string }>;
  },
  commands: VerifierCommand[],
  signup: (files: { validator: string; tests: string }) => Promise<VerifyResponse> | VerifyResponse,
): Promise<VerifierReport> {
  const results: CommandResult[] = [];
  let checks: CheckResult[] | null = null;
  let totals: VerifierReport["totals"] = null;
  let crash: string | null = null;

  for (const spec of commands) {
    const name = verifierCommandName(spec);
    if (spec.type === "fixture") {
      const validator = await workspace.read("validator.ts");
      const tests = await workspace.read("signup.test.ts");
      if (!validator.ok || !tests.ok) {
        results.push({
          command: name,
          exitCode: 1,
          stdout: "",
          stderr: "The workspace refused to read the signup fixture.",
          timedOut: false,
        });
        continue;
      }
      const report = await signup({ validator: validator.value, tests: tests.value });
      checks = report.checks;
      totals = report.totals;
      if (report.crash) crash = report.crash;
      const passed = report.ok && !report.crash;
      results.push({
        command: name,
        exitCode: passed ? 0 : 1,
        stdout: "",
        stderr: report.crash ?? "",
        timedOut: false,
      });
      continue;
    }

    const exec = await workspace.exec(spec.command);
    if (!exec.ok) {
      results.push({
        command: name,
        exitCode: 1,
        stdout: "",
        stderr: `Policy returned ${exec.decision ?? "deny"} before the command ran.`,
        timedOut: false,
      });
      continue;
    }
    results.push({ ...exec.value, command: name });
  }

  const ok = crash === null && results.length > 0 && results.every((entry) => entry.exitCode === 0);
  return { ok, commands: results, checks, totals, crash };
}
