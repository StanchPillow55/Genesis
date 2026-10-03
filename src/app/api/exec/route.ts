import { parseVerifier } from "@/lib/contract";
import { policyFromContract } from "@/lib/workspace";
import { createFsWorkspace } from "@/lib/workspace-fs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The workspace expected JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "The workspace expected a command." }, { status: 400 });
  }
  const record = body as { command?: unknown; verifier?: unknown };
  if (typeof record.command !== "string" || !record.command.trim()) {
    return Response.json({ error: "The workspace expected a shell command." }, { status: 400 });
  }
  if (record.command.length > 2_000) {
    return Response.json({ error: "That command is too long." }, { status: 400 });
  }

  let verifier;
  try {
    verifier = parseVerifier(record.verifier ?? { commands: [{ type: "shell", command: record.command.trim() }] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The workspace could not read the verifier.";
    return Response.json({ error: message }, { status: 400 });
  }

  const workspace = createFsWorkspace({
    root: process.cwd(),
    policy: policyFromContract({
      goal: "run verifier",
      maxAttempts: 1,
      policies: { modifyTests: "deny", delete: "deny", editSource: "deny" },
      verifier,
      uncertainty: null,
    }),
    timeoutMs: 60_000,
  });
  const result = await workspace.exec(record.command.trim());
  if (!result.ok) {
    return Response.json(
      { error: `Policy returned ${result.decision} before the command ran.` },
      { status: 403 },
    );
  }
  return Response.json({ result: result.value });
}
