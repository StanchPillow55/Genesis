import { getSessionRegistry, launchPublicSession } from "@/lib/session-store";
import { publicSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return Response.json({ session: launchPublicSession() });
  }
  const session = getSessionRegistry().resolve(projectId);
  if (!session) {
    return Response.json({ error: "Unknown project." }, { status: 404 });
  }
  return Response.json({ session: publicSession(session) });
}
