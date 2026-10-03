import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { parseContract } from "@/lib/contract";
import { startLocalRun } from "@/lib/run-registry";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The run expected JSON." }, { status: 400 });
  }
  const auth = authorizeRequest(request, projectIdFrom(request, body));
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const record = body && typeof body === "object" ? (body as { contract?: unknown }) : {};
  let contract;
  try {
    contract = parseContract(record.contract);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The run could not read that contract.";
    return Response.json({ error: message }, { status: 400 });
  }
  if (contract.uncertainty) {
    return Response.json({ error: contract.uncertainty }, { status: 400 });
  }
  try {
    const run = await startLocalRun({ session: auth.session, contract });
    return Response.json(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The run could not start.";
    return Response.json({ error: message }, { status: 400 });
  }
}
