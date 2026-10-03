import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { parseAgentContext } from "@/lib/agent";
import { createGeminiAgentBackend } from "@/lib/gemini-agent";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The agent expected JSON." }, { status: 400 });
  }
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let context;
  try {
    context = parseAgentContext(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent could not read that context.";
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const step = await createGeminiAgentBackend().proposeStep(context);
    return Response.json({ step, backend: "gemini" as const });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent did not propose a step.";
    const status = /live model did not run|No Gemini API key|empty step/.test(message) ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
}
