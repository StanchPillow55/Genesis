import { verifySignup } from "@/lib/verifier";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The verifier expected JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "The verifier needs validator.ts and signup.test.ts source." },
      { status: 400 },
    );
  }

  const record = body as { validator?: unknown; tests?: unknown };
  if (typeof record.validator !== "string" || typeof record.tests !== "string") {
    return Response.json(
      { error: "The verifier needs validator.ts and signup.test.ts source." },
      { status: 400 },
    );
  }
  if (record.validator.length > 50_000 || record.tests.length > 50_000) {
    return Response.json(
      { error: "Those files are too large for this prototype verifier." },
      { status: 413 },
    );
  }

  return Response.json(verifySignup({ validator: record.validator, tests: record.tests }));
}
