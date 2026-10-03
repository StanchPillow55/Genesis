import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export type SessionKind = "sample" | "project";

/** Server-side record. The browser receives PublicSession, never `root`. */
export type ProjectSession = {
  projectId: string;
  root: string;
  createdAt: string;
  kind: SessionKind;
};

export type PublicSession = {
  projectId: string;
  createdAt: string;
  kind: SessionKind;
};

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export const SAMPLE_PROJECT_ID = "sample";

export function canonicalizeRoot(input: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) {
    throw new SessionError("A project root is required.");
  }
  const resolved = path.resolve(trimmed);
  let info;
  try {
    info = statSync(resolved);
  } catch {
    throw new SessionError(`Not a directory: ${input}`);
  }
  if (!info.isDirectory()) {
    throw new SessionError(`Not a directory: ${input}`);
  }
  try {
    return realpathSync(resolved);
  } catch {
    throw new SessionError(`Not a directory: ${input}`);
  }
}

export function createProjectId(): string {
  return `prj_${randomBytes(16).toString("base64url")}`;
}

export type SessionRegistry = {
  registerProject(root: string, projectId?: string): ProjectSession;
  registerSample(sampleRoot?: string): ProjectSession;
  resolve(projectId: string): ProjectSession | null;
  list(): ProjectSession[];
};

export function createSessionRegistry(now: () => Date = () => new Date()): SessionRegistry {
  const sessions = new Map<string, ProjectSession>();

  function put(session: ProjectSession): ProjectSession {
    const existing = sessions.get(session.projectId);
    if (existing) {
      if (existing.root === session.root && existing.kind === session.kind) return existing;
      throw new SessionError(`Session ${session.projectId} is already registered.`);
    }
    sessions.set(session.projectId, session);
    return session;
  }

  return {
    registerProject(root, projectId = createProjectId()) {
      return put({
        projectId,
        root: canonicalizeRoot(root),
        createdAt: now().toISOString(),
        kind: "project",
      });
    },
    registerSample(sampleRoot) {
      const existing = sessions.get(SAMPLE_PROJECT_ID);
      if (existing) return existing;
      const root = canonicalizeRoot(
        sampleRoot ?? path.join(process.cwd(), "sample", "community-signup"),
      );
      return put({
        projectId: SAMPLE_PROJECT_ID,
        root,
        createdAt: now().toISOString(),
        kind: "sample",
      });
    },
    resolve(projectId) {
      if (!projectId) return null;
      return sessions.get(projectId) ?? null;
    },
    list() {
      return [...sessions.values()];
    },
  };
}

/** Fields safe to send to the browser. `root` stays on the server. */
export function publicSession(session: ProjectSession): PublicSession {
  return {
    projectId: session.projectId,
    createdAt: session.createdAt,
    kind: session.kind,
  };
}
