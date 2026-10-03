import { runShellCommand } from "./shell";
import type { CommandResult } from "./verifier";

/**
 * The only production path that starts a verifier shell.
 * A sandbox can wrap this function later. Callers still pass through workspace.exec,
 * which allows a command only when the current contract names it.
 */
export function executeCommand(
  command: string,
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CommandResult> {
  return runShellCommand(command, options);
}
