import path from "node:path";
import {
  createSessionRegistry,
  publicSession,
  SAMPLE_PROJECT_ID,
  type ProjectSession,
  type PublicSession,
  type SessionRegistry,
} from "./session";

let registry: SessionRegistry | null = null;

export function getSessionRegistry(): SessionRegistry {
  if (!registry) {
    registry = createSessionRegistry();
    registry.registerSample(path.join(process.cwd(), "sample", "community-signup"));
    const root = process.env.PROOFLOOP_ROOT?.trim();
    if (root) {
      const projectId = process.env.PROOFLOOP_PROJECT_ID?.trim() || undefined;
      registry.registerProject(root, projectId);
    }
  }
  return registry;
}

/** The session this process was launched for, or the built-in sample. */
export function launchSession(): ProjectSession {
  const sessions = getSessionRegistry();
  const projectId = process.env.PROOFLOOP_PROJECT_ID?.trim();
  if (projectId) {
    const found = sessions.resolve(projectId);
    if (found) return found;
  }
  const sample = sessions.resolve(SAMPLE_PROJECT_ID);
  if (!sample) {
    throw new Error("The sample session is not registered.");
  }
  return sample;
}

export function launchPublicSession(): PublicSession {
  return publicSession(launchSession());
}
