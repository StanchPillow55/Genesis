import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { rememberIsolation, takeIsolation } from "@/lib/isolation-store";
import { acceptIsolation, type AcceptStrategy } from "@/lib/worktree";

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
  const record = body && typeof body === "object" ? (body as { strategy?: unknown; slug?: unknown }) : {};
  if (record.strategy === "in-place") {
    rememberIsolation(auth.session.projectId, isolation);
    return Response.json(
      { error: "In-place execution is not available. Accept with branch or apply-uncommitted." },
      { status: 400 },
    );
  }
  const strategy: AcceptStrategy = record.strategy === "apply-uncommitted" ? "apply-uncommitted" : "branch";
  const slug = typeof record.slug === "string" ? record.slug : undefined;
  try {
    const result = await acceptIsolation(isolation, { strategy, slug });
    return Response.json({ strategy: result.strategy, branch: result.branch });
  } catch (error) {
    rememberIsolation(auth.session.projectId, isolation);
    const message = error instanceof Error ? error.message : "The worktree could not be accepted.";
    return Response.json({ error: message }, { status: 400 });
  }
}
