import assert from "node:assert/strict";
import test from "node:test";
import { POST as postAgent } from "../app/api/agent/route";
import { POST as postExec } from "../app/api/exec/route";
import { GET as getSession } from "../app/api/session/route";
import { POST as postVerify } from "../app/api/verify/route";
import { authorizeRequest, createLaunchToken, isLoopbackHost } from "./api-guard";
import { PROJECT_HEADER, TOKEN_HEADER } from "./local-api";
import { getSessionRegistry } from "./session-store";

const TOKEN = "test-launch-token-please-do-not-log";

test("loopback hosts are the only ones accepted", () => {
  assert.equal(isLoopbackHost("127.0.0.1:38471"), true);
  assert.equal(isLoopbackHost("localhost:38471"), true);
  assert.equal(isLoopbackHost("[::1]:38471"), true);
  assert.equal(isLoopbackHost("0.0.0.0:38471"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
  assert.equal(isLoopbackHost(null), false);
});

test("missing token is 401 and a bad origin or unknown project is 403", () => {
  const previous = process.env.PROOFLOOP_TOKEN;
  process.env.PROOFLOOP_TOKEN = TOKEN;
  try {
    const missing = authorizeRequest(localRequest({ token: null }), "sample");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 401);

    const wrong = authorizeRequest(localRequest({ token: "nope" }), "sample");
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.status, 401);

    const evilOrigin = authorizeRequest(
      localRequest({ token: TOKEN, origin: "https://evil.example" }),
      "sample",
    );
    assert.equal(evilOrigin.ok, false);
    if (!evilOrigin.ok) assert.equal(evilOrigin.status, 403);

    const publicHost = authorizeRequest(
      localRequest({ token: TOKEN, host: "example.com", origin: "http://example.com" }),
      "sample",
    );
    assert.equal(publicHost.ok, false);
    if (!publicHost.ok) assert.equal(publicHost.status, 403);

    const unknown = authorizeRequest(localRequest({ token: TOKEN }), "does-not-exist");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.status, 403);

    const allowed = authorizeRequest(localRequest({ token: TOKEN }), "sample");
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.equal(allowed.session.kind, "sample");
      assert.equal(allowed.session.projectId, "sample");
    }
  } finally {
    restoreToken(previous);
  }
});

test("session, exec, verify, and agent routes enforce the launch token", async () => {
  const previous = process.env.PROOFLOOP_TOKEN;
  process.env.PROOFLOOP_TOKEN = TOKEN;
  try {
    const noToken = await getSession(localRequest({ token: null, path: "/api/session?projectId=sample" }));
    assert.equal(noToken.status, 401);

    const badOrigin = await postExec(
      jsonRequest({
        token: TOKEN,
        origin: "http://evil.example",
        body: { command: "node -e \"process.exit(0)\"" },
      }),
    );
    assert.equal(badOrigin.status, 403);

    const unknown = await postVerify(
      jsonRequest({
        token: TOKEN,
        projectId: "missing-project",
        body: { validator: "export {}", tests: "export {}" },
      }),
    );
    assert.equal(unknown.status, 403);

    const agent = await postAgent(
      jsonRequest({
        token: null,
        body: { goal: "x", attempt: 1, maxAttempts: 1, files: [], verifierFailure: null, contract: {} },
      }),
    );
    assert.equal(agent.status, 401);
  } finally {
    restoreToken(previous);
  }
});

test("exec and verify use the session root, never a root in the body", async () => {
  const previous = process.env.PROOFLOOP_TOKEN;
  process.env.PROOFLOOP_TOKEN = TOKEN;
  try {
    const session = getSessionRegistry().resolve("sample");
    assert.ok(session);
    const command = "node -e \"process.stdout.write(process.cwd())\"";
    const response = await postExec(
      jsonRequest({
        token: TOKEN,
        body: {
          command,
          root: "/tmp/not-the-session",
          verifier: { commands: [{ type: "shell", command }] },
        },
      }),
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { result?: { stdout?: string; exitCode?: number } };
    assert.equal(payload.result?.exitCode, 0);
    assert.equal(payload.result?.stdout, session.root);

    const verified = await postVerify(
      jsonRequest({
        token: TOKEN,
        body: {
          root: "/tmp/not-the-session",
          commands: [{ type: "shell", command }],
        },
      }),
    );
    assert.equal(verified.status, 200);
    const report = (await verified.json()) as { commands?: { stdout?: string; exitCode?: number }[] };
    assert.equal(report.commands?.[0]?.exitCode, 0);
    assert.equal(report.commands?.[0]?.stdout, session.root);
  } finally {
    restoreToken(previous);
  }
});

test("launch tokens are unguessable and stay out of the url", () => {
  const token = createLaunchToken();
  assert.ok(token.length >= 32);
  assert.equal(token.includes("/"), false);
});

function localRequest(options: {
  token: string | null;
  origin?: string;
  host?: string;
  path?: string;
  projectId?: string;
}): Request {
  const headers = new Headers();
  headers.set("host", options.host ?? "127.0.0.1:38471");
  headers.set("origin", options.origin ?? "http://127.0.0.1:38471");
  if (options.token) headers.set(TOKEN_HEADER, options.token);
  if (options.projectId) headers.set(PROJECT_HEADER, options.projectId);
  return new Request(`http://127.0.0.1:38471${options.path ?? "/api/exec"}`, { headers });
}

function jsonRequest(options: {
  token: string | null;
  origin?: string;
  projectId?: string;
  body: unknown;
}): Request {
  const headers = new Headers();
  headers.set("host", "127.0.0.1:38471");
  headers.set("origin", options.origin ?? "http://127.0.0.1:38471");
  headers.set("content-type", "application/json");
  if (options.token) headers.set(TOKEN_HEADER, options.token);
  headers.set(PROJECT_HEADER, options.projectId ?? "sample");
  return new Request("http://127.0.0.1:38471/api/exec", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });
}

function restoreToken(previous: string | undefined) {
  if (previous === undefined) delete process.env.PROOFLOOP_TOKEN;
  else process.env.PROOFLOOP_TOKEN = previous;
}
