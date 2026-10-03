import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { rememberIsolation } from "@/lib/isolation-store";
import { createIsolation } from "@/lib/worktree";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The worktree request expected JSON." }, { status: 400 });
  }
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.session.kind === "sample") {
    return Response.json(
      { error: "The sample session stays in memory. Open a project to use a worktree." },
      { status: 400 },
    );
  }
  try {
    const isolation = await createIsolation(auth.session.root);
    rememberIsolation(auth.session.projectId, isolation);
    return Response.json({ isolationId: isolation.id, kind: isolation.kind });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The worktree could not be created.";
    return Response.json({ error: message }, { status: 400 });
  }
}
