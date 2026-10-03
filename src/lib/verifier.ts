import ts from "typescript";
import vm from "node:vm";

import type { VerifierCommand } from "./contract";
import { verifierCommandName } from "./contract";

export type CheckId = "username" | "password" | "email";

export type CheckResult = {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
};

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type VerifierReport = {
  ok: boolean;
  commands: CommandResult[];
  checks: CheckResult[] | null;
  totals: { passed: number; failed: number; total: number } | null;
  crash: string | null;
};

export type VerifyResponse = {
  ok: boolean;
  checks: CheckResult[];
  totals: { passed: number; failed: number; total: number };
  crash: string | null;
};

const CHECKS: { id: CheckId; name: string; fn: string; pending: string }[] = [
  {
    id: "username",
    name: "Username",
    fn: "checkUsername",
    pending: "Accepts ada_lovelace. Rejects short names and spaces.",
  },
  {
    id: "password",
    name: "Password",
    fn: "checkPassword",
    pending: "Needs 8+ characters, a letter, and a number.",
  },
  {
    id: "email",
    name: "Email",
    fn: "checkEmail",
    pending: "Accepts ada@community.org. Rejects not-an-email.",
  },
];

export function pendingChecks(): CheckResult[] {
  return CHECKS.map((check) => ({
    id: check.id,
    name: check.name,
    passed: false,
    detail: check.pending,
  }));
}

export function verifySignup(files: { validator: string; tests: string }): VerifyResponse {
  try {
    const validatorJs = transpile(files.validator, "validator.ts");
    const testsJs = transpile(files.tests, "signup.test.ts");
    const validatorExports = execute(validatorJs, "validator.ts", () => {
      throw new Error("validator.ts tried to import another module.");
    });
    const testExports = execute(testsJs, "signup.test.ts", (id) => {
      const normalized = id.replace(/\\/g, "/");
      if (
        normalized === "./validator" ||
        normalized === "./validator.ts" ||
        normalized.endsWith("/validator")
      ) {
        return validatorExports;
      }
      throw new Error(`The signup tests tried to import "${id}", which this verifier does not provide.`);
    });

    const checks = CHECKS.map((check) => {
      const fn = testExports[check.fn];
      if (typeof fn !== "function") {
        return {
          id: check.id,
          name: check.name,
          passed: false,
          detail: `signup.test.ts does not export ${check.fn}.`,
        };
      }
      try {
        fn();
        return {
          id: check.id,
          name: check.name,
          passed: true,
          detail: "Passed when the function ran.",
        };
      } catch (error) {
        return {
          id: check.id,
          name: check.name,
          passed: false,
          detail: messageFrom(error),
        };
      }
    });
    const passed = checks.filter((check) => check.passed).length;
    return {
      ok: passed === checks.length,
      checks,
      totals: { passed, failed: checks.length - passed, total: checks.length },
      crash: null,
    };
  } catch (error) {
    const message = messageFrom(error);
    return {
      ok: false,
      checks: CHECKS.map((check) => ({
        id: check.id,
        name: check.name,
        passed: false,
        detail: "The verifier crashed before this check could run.",
      })),
      totals: { passed: 0, failed: CHECKS.length, total: CHECKS.length },
      crash: message,
    };
  }
}

export async function runVerifierCommands(
  input: {
    commands: VerifierCommand[];
    files?: { validator: string; tests: string };
  },
  runCommand: (command: string) => Promise<CommandResult>,
): Promise<VerifierReport> {
  const commands: CommandResult[] = [];
  let checks: CheckResult[] | null = null;
  let totals: VerifierReport["totals"] = null;
  let crash: string | null = null;

  for (const spec of input.commands) {
    const name = verifierCommandName(spec);
    if (spec.type === "fixture") {
      if (!input.files) {
        commands.push({
          command: name,
          exitCode: 1,
          stdout: "",
          stderr: "The signup fixture needs validator.ts and signup.test.ts.",
          timedOut: false,
        });
        continue;
      }
      const signup = verifySignup(input.files);
      checks = signup.checks;
      totals = signup.totals;
      if (signup.crash) crash = signup.crash;
      const passed = signup.ok && !signup.crash;
      commands.push({
        command: name,
        exitCode: passed ? 0 : 1,
        stdout: "",
        stderr: signup.crash ?? "",
        timedOut: false,
      });
      continue;
    }

    const result = await runCommand(spec.command);
    commands.push({
      command: name,
      exitCode: result.timedOut ? 124 : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });
  }

  const ok = crash === null && commands.length > 0 && commands.every((entry) => entry.exitCode === 0);
  return { ok, commands, checks, totals, crash };
}

function messageFrom(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function transpile(source: string, filename: string): string {
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      strict: false,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const message = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join(" ");
    throw new Error(`${filename} did not compile. ${message}`);
  }
  if (!result.outputText.trim()) {
    throw new Error(`${filename} compiled to empty output.`);
  }
  return result.outputText;
}

function execute(
  code: string,
  filename: string,
  requireImpl: (id: string) => unknown,
): Record<string, unknown> {
  // Isolated VM context running the controlled demo fixture.
  const fixtureModule = { exports: {} as Record<string, unknown> };
  const vmContext = {
    module: fixtureModule,
    exports: fixtureModule.exports,
    require: requireImpl,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(code, vmContext, { timeout: 1000, filename });
  return fixtureModule.exports;
}
