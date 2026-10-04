import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { takeIsolation } from "@/lib/isolation-store";
import { discardIsolation } from "@/lib/worktree";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const isolation = takeIsolation(auth.session.projectId, id);
  if (!isolation) {
    return Response.json({ error: "Unknown worktree." }, { status: 404 });
  }
  await discardIsolation(isolation);
  return Response.json({ discarded: true });
}
