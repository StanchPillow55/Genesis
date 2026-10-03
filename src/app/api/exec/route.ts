import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
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
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
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
    root: auth.session.root,
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
    if (result.decision === "amend" && result.amendment) {
      return Response.json(
        {
          error: "That command is not in the contract. Update the contract before it can run.",
          amendment: result.amendment,
        },
        { status: 409 },
      );
    }
    return Response.json(
      { error: `Policy returned ${result.decision} before the command ran.` },
      { status: 403 },
    );
  }
  return Response.json({ result: result.value });
}
