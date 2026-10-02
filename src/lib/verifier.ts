import ts from "typescript";
import vm from "node:vm";

export type CheckId = "username" | "password" | "email";

export type CheckResult = {
  id: CheckId;
  name: string;
  passed: boolean;
  detail: string;
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
  const sandboxModule = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: requireImpl,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(code, sandbox, { timeout: 1000, filename });
  return sandboxModule.exports;
}
