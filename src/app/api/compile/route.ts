import { authorizeRequest, projectIdFrom } from "@/lib/api-guard";
import { compileWithFallback } from "@/lib/contract";
import { compileWithGemini, geminiCredentials } from "@/lib/gemini";
import { compileForProject } from "@/lib/project-compile";
import { loadProjectConfig } from "@/lib/project-config";
import { launchPublicSession } from "@/lib/session-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "The compiler expected a JSON body with a goal." },
      { status: 400 },
    );
  }

  const goal =
    body && typeof body === "object" && "goal" in body && typeof body.goal === "string"
      ? body.goal
      : "";

  if (!goal.trim()) {
    return Response.json(
      { error: "Write a goal before compiling. An empty sentence is not a contract." },
      { status: 400 },
    );
  }

  const auth = authorizeRequest(
    request,
    projectIdFrom(request, body) ?? launchPublicSession().projectId,
  );
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  if (auth.session.kind === "sample") {
    return compileSample(goal.trim());
  }

  const config = loadProjectConfig(auth.session.root);
  let model = null;
  let compiler: "gemini" | "fallback" = "fallback";
  let modelName: string | null = null;
  let warning: string | undefined;
  if (geminiCredentials()) {
    try {
      const result = await compileWithGemini(goal.trim());
      model = result.contract;
      compiler = "gemini";
      modelName = result.model;
    } catch (error) {
      console.error("Gemini compile failed", error);
      warning =
        "The model call failed. The goal came from the local parser. Verifier and policy still come from proofloop.yaml when it exists.";
    }
  }
  const compiled = compileForProject({
    goal: goal.trim(),
    kind: "project",
    config,
    model,
  });
  return Response.json({
    contract: compiled.contract,
    compiler,
    ...(modelName ? { model: modelName } : {}),
    notes: compiled.notes,
    ...(warning ? { warning } : {}),
  });
}

async function compileSample(goal: string) {
  if (geminiCredentials()) {
    try {
      const result = await compileWithGemini(goal);
      return Response.json({
        contract: result.contract,
        compiler: "gemini" as const,
        model: result.model,
        notes: [
          `${result.model} compiled this contract from the sentence. The local parser was not used. The model does not decide when the loop stops.`,
        ],
      });
    } catch (error) {
      console.error("Gemini compile failed", error);
      const fallback = compileWithFallback(goal);
      return Response.json({
        contract: fallback.contract,
        compiler: "fallback" as const,
        notes: fallback.notes,
        warning:
          "The model call failed. This contract came from the local compiler instead. The loop still will not be marked done without a proof object.",
      });
    }
  }

  const fallback = compileWithFallback(goal);
  return Response.json({
    contract: fallback.contract,
    compiler: "fallback" as const,
    notes: fallback.notes,
  });
}
