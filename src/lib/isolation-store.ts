import type { Isolation } from "./worktree";

type Recorded = {
  projectId: string;
  isolation: Isolation;
};

const records = new Map<string, Recorded>();

export function rememberIsolation(projectId: string, isolation: Isolation): void {
  records.set(isolation.id, { projectId, isolation });
}

export function takeIsolation(projectId: string, isolationId: string): Isolation | null {
  const recorded = records.get(isolationId);
  if (!recorded || recorded.projectId !== projectId) return null;
  records.delete(isolationId);
  return recorded.isolation;
}

export function peekIsolation(projectId: string, isolationId: string): Isolation | null {
  const recorded = records.get(isolationId);
  if (!recorded || recorded.projectId !== projectId) return null;
  return recorded.isolation;
}
