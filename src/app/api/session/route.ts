import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { launchPublicSession } from "@/lib/session-store";
import { publicSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requested = projectIdFrom(request);
  const auth = authorizeRequest(request, requested ?? launchPublicSession().projectId);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  return Response.json({ session: publicSession(auth.session) });
}
