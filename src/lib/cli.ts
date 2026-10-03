import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createLaunchToken } from "./api-guard";
import { canonicalizeRoot, createProjectId, SessionError } from "./session";

export type ParsedCli =
  | { command: "open"; root: string }
  | { command: "ui"; root: string }
  | { command: "help" };

export type ServerLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  url: string;
  projectId: string;
  root: string;
};

const HELP = `proofloop open <dir>
  Canonicalize <dir>, start the local server, and open the browser.

proofloop ui --root <dir>
  Same local server, without assuming the shell's current directory.
`;

export function parseCliArgs(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command === "open") {
    const root = rest[0];
    if (!root || root.startsWith("-")) {
      throw new SessionError("proofloop open needs a directory. Example: proofloop open .");
    }
    return { command: "open", root };
  }
  if (command === "ui") {
    const index = rest.indexOf("--root");
    const root = index === -1 ? undefined : rest[index + 1];
    if (!root || root.startsWith("-")) {
      throw new SessionError("proofloop ui needs --root <dir>.");
    }
    return { command: "ui", root };
  }
  throw new SessionError(`Unknown command "${command}". Try: proofloop open <dir>`);
}

export function buildServerLaunch(options: {
  root: string;
  packageRoot: string;
  projectId?: string;
  port?: number;
  host?: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
}): ServerLaunch {
  const root = canonicalizeRoot(options.root);
  const projectId = options.projectId ?? createProjectId();
  const port = options.port ?? 38471;
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new SessionError("The local server only binds to loopback.");
  }
  const token = options.token ?? (options.env?.PROOFLOOP_TOKEN?.trim() || createLaunchToken());
  const nextBin = path.join(options.packageRoot, "node_modules", "next", "dist", "bin", "next");
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    PROOFLOOP_ROOT: root,
    PROOFLOOP_PROJECT_ID: projectId,
    PROOFLOOP_PORT: String(port),
    PROOFLOOP_HOST: host,
    PROOFLOOP_TOKEN: token,
  };
  return {
    command: process.execPath,
    args: [nextBin, "dev", "-H", host, "-p", String(port)],
    cwd: options.packageRoot,
    env,
    url: `http://${host}:${port}`,
    projectId,
    root,
  };
}

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  open: (url: string) => void;
  spawn: (launch: ServerLaunch) => ChildProcess;
  wait: (url: string, child: ChildProcess) => Promise<void>;
  packageRoot: string;
  env: NodeJS.ProcessEnv;
};

export function defaultCliIo(packageRoot: string): CliIo {
  return {
    packageRoot,
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    open: openBrowser,
    spawn: (launch) =>
      spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: "inherit",
      }),
    wait: waitForHttp,
  };
}

export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  const packageRoot = io?.packageRoot ?? process.cwd();
  const runtime: CliIo = { ...defaultCliIo(packageRoot), ...io, packageRoot };
  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    runtime.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (parsed.command === "help") {
    runtime.stdout(HELP.trimEnd());
    return 0;
  }
  let launch: ServerLaunch;
  try {
    launch = buildServerLaunch({
      root: parsed.root,
      packageRoot: runtime.packageRoot,
      env: runtime.env,
      port: portFromEnv(runtime.env),
    });
  } catch (error) {
    runtime.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  runtime.stdout(`ProofLoop session ${launch.projectId}`);
  runtime.stdout(launch.url);
  const child = runtime.spawn(launch);
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await runtime.wait(launch.url, child);
  } catch (error) {
    runtime.stderr(error instanceof Error ? error.message : String(error));
    stop();
    return 1;
  }
  runtime.open(launch.url);
  return await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function portFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.PROOFLOOP_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SessionError("PROOFLOOP_PORT must be a port number.");
  }
  return port;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    process.stdout.write(`Open ${url}\n`);
  });
  child.unref();
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) {
      throw new Error("The local server exited before it was ready.");
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The local server did not start.");
}
