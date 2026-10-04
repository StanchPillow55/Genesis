import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_HEADER, TOKEN_HEADER } from "./local-api";
import { getSessionRegistry } from "./session-store";
import type { ProjectSession } from "./session";

export type GuardFailure = {
  ok: false;
  status: 401 | 403;
  error: string;
};

export type GuardSuccess = {
  ok: true;
  session: ProjectSession;
};

let memoryToken: string | null = null;

/** Per-launch secret. The CLI injects PROOFLOOP_TOKEN. Dev falls back to a pid file. */
export function launchToken(): string {
  const fromEnv = process.env.PROOFLOOP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (memoryToken) return memoryToken;
  const file = path.join(os.tmpdir(), "proofloop-tokens", `${process.pid}.token`);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) {
      memoryToken = existing;
      return existing;
    }
  } catch {
    // First caller in this process creates the file.
  }
  const created = randomBytes(32).toString("base64url");
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, created, { flag: "wx", mode: 0o600 });
    memoryToken = created;
    return created;
  } catch {
    const existing = readFileSync(file, "utf8").trim();
    memoryToken = existing;
    return existing;
  }
}

export function createLaunchToken(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizeRequest(request: Request, projectId: string | null | undefined): GuardSuccess | GuardFailure {
  const presented = presentedToken(request);
  if (!presented || !tokensMatch(presented, launchToken())) {
    return { ok: false, status: 401, error: "Missing or invalid launch token." };
  }
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!isLoopbackHost(host) || !originAllowed(origin, host)) {
    return {
      ok: false,
      status: 403,
      error: "This local API only accepts loopback requests from its own origin.",
    };
  }
  if (!projectId || !projectId.trim()) {
    return { ok: false, status: 403, error: "Unknown project." };
  }
  const session = getSessionRegistry().resolve(projectId.trim());
  if (!session) {
    return { ok: false, status: 403, error: "Unknown project." };
  }
  return { ok: true, session };
}

export function projectIdFrom(request: Request, body?: unknown): string | null {
  const header = request.headers.get(PROJECT_HEADER);
  if (header?.trim()) return header.trim();
  const query = new URL(request.url).searchParams.get("projectId");
  if (query?.trim()) return query.trim();
  if (body && typeof body === "object" && "projectId" in body) {
    const value = (body as { projectId?: unknown }).projectId;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const hostname = hostnameOf(host);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function presentedToken(request: Request): string | null {
  const header = request.headers.get(TOKEN_HEADER);
  if (header?.trim()) return header.trim();
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function tokensMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!isLoopbackHost(url.host)) return false;
  return url.host.toLowerCase() === host.trim().toLowerCase();
}

function hostnameOf(host: string | null | undefined): string {
  if (!host) return "";
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? "" : trimmed.slice(1, end);
  }
  return trimmed.split(":")[0] ?? "";
}
