import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import {
  acceptLocalRun,
  decideLocalRun,
  discardLocalRun,
  getLocalRun,
  pauseLocalRun,
  resumeLocalRun,
  stopLocalRun,
} from "@/lib/run-registry";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = authorizeRequest(request, projectIdFrom(request));
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const run = getLocalRun(auth.session.projectId, id);
  if (!run) return Response.json({ error: "Unknown run." }, { status: 404 });
  return Response.json(run);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const action = body && typeof body === "object" && "action" in body ? (body as { action?: unknown }).action : "";
  const decision = body && typeof body === "object" && "decision" in body ? (body as { decision?: unknown }).decision : "";
  try {
    const run = await applyAction(auth.session.projectId, id, action, decision);
    if (!run) return Response.json({ error: "Unknown run." }, { status: 404 });
    return Response.json(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The run could not be updated.";
    return Response.json({ error: message }, { status: 400 });
  }
}

async function applyAction(projectId: string, runId: string, action: unknown, decision: unknown) {
  if (action === "pause") return pauseLocalRun(projectId, runId);
  if (action === "resume") return resumeLocalRun(projectId, runId);
  if (action === "stop") return stopLocalRun(projectId, runId);
  if (action === "accept") return acceptLocalRun(projectId, runId);
  if (action === "discard") return discardLocalRun(projectId, runId);
  if (action === "approval") {
    if (decision !== "allow" && decision !== "deny") {
      throw new Error("Approval needs allow or deny.");
    }
    return decideLocalRun(projectId, runId, decision);
  }
  throw new Error("Unknown run action.");
}
