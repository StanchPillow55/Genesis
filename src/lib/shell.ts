import { spawn } from "node:child_process";
import type { CommandResult } from "./verifier";

const OUTPUT_CAP = 16_000;

export async function runShellCommand(
  command: string,
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CommandResult> {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      command,
      exitCode: 1,
      stdout: "",
      stderr: "Verifier command is empty.",
      timedOut: false,
    };
  }

  const timeoutMs = options?.timeoutMs ?? 60_000;
  const cwd = options?.cwd ?? process.cwd();

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", trimmed], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = clip(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = clip(stderr + chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      finish({
        command: trimmed,
        exitCode: 1,
        stdout,
        stderr: clip(error.message),
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      finish({
        command: trimmed,
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut ? clip(`${stderr}\nTimed out after ${timeoutMs}ms.`) : stderr,
        timedOut,
      });
    });
  });
}

function clip(value: string): string {
  if (value.length <= OUTPUT_CAP) return value;
  return value.slice(-OUTPUT_CAP);
}
