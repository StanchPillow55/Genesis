import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { parseVerifier, type VerifierCommand } from "@/lib/contract";
import { executeCommand } from "@/lib/command-choke";
import { verifySignup } from "@/lib/verifier";
import { verifyWithWorkspace } from "@/lib/verify-run";
import { createMemoryWorkspace, policyFromContract } from "@/lib/workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The verifier expected JSON." }, { status: 400 });
  }
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "The verifier needs commands, or validator.ts and signup.test.ts source." },
      { status: 400 },
    );
  }

  const record = body as {
    validator?: unknown;
    tests?: unknown;
    commands?: unknown;
    verifier?: unknown;
  };
  const validator = typeof record.validator === "string" ? record.validator : undefined;
  const tests = typeof record.tests === "string" ? record.tests : undefined;
  if ((validator && validator.length > 50_000) || (tests && tests.length > 50_000)) {
    return Response.json(
      { error: "Those files are too large for this prototype verifier." },
      { status: 413 },
    );
  }

  let commands: VerifierCommand[];
  try {
    commands = parseCommands(record.commands ?? record.verifier, validator, tests);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The verifier could not read those commands.";
    return Response.json({ error: message }, { status: 400 });
  }

  if (commands.some((command) => command.type === "fixture") && (validator === undefined || tests === undefined)) {
    return Response.json(
      { error: "The signup fixture needs validator.ts and signup.test.ts source." },
      { status: 400 },
    );
  }

  const files: Record<string, string> = {};
  if (validator !== undefined) files["validator.ts"] = validator;
  if (tests !== undefined) files["signup.test.ts"] = tests;
  const workspace = createMemoryWorkspace({
    files,
    policy: policyFromContract({
      goal: "run verifier",
      maxAttempts: 1,
      policies: { modifyTests: "deny", delete: "deny", editSource: "deny" },
      verifier: { commands },
      uncertainty: null,
    }),
    shell: (command) => executeCommand(command, { cwd: auth.session.root, timeoutMs: 60_000 }),
  });
  const report = await verifyWithWorkspace(workspace, commands, verifySignup);
  return Response.json(report);
}

function parseCommands(value: unknown, validator: string | undefined, tests: string | undefined): VerifierCommand[] {
  if (value === undefined) {
    if (validator === undefined || tests === undefined) {
      throw new Error("The verifier needs commands, or validator.ts and signup.test.ts source.");
    }
    return [{ type: "fixture", id: "signup" }];
  }
  return parseVerifier(value).commands;
}
