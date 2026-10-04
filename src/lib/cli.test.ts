import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServerLaunch, main, parseCliArgs } from "./cli";
import { SessionError } from "./session";

test("open and ui parse a directory", () => {
  assert.deepEqual(parseCliArgs(["open", "."]), { command: "open", root: "." });
  assert.deepEqual(parseCliArgs(["ui", "--root", "/tmp/proj"]), { command: "ui", root: "/tmp/proj" });
  assert.equal(parseCliArgs(["--help"]).command, "help");
  assert.throws(() => parseCliArgs(["open"]), /needs a directory/);
  assert.throws(() => parseCliArgs(["ui"]), /--root/);
  assert.deepEqual(parseCliArgs(["init"]), { command: "init", root: "." });
  assert.deepEqual(parseCliArgs(["init", "apps/web"]), { command: "init", root: "apps/web" });
  assert.throws(() => parseCliArgs(["serve"]), SessionError);
});

test("the launch plan canonicalizes the root and keeps it off the url", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "proofloop-launch-")));
  const launch = buildServerLaunch({
    root,
    packageRoot: "/opt/proofloop",
    projectId: "prj_fixed",
    port: 38471,
  });
  assert.equal(launch.root, root);
  assert.equal(launch.env.PROOFLOOP_ROOT, root);
  assert.equal(launch.env.PROOFLOOP_PROJECT_ID, "prj_fixed");
  assert.equal(launch.url, "http://127.0.0.1:38471");
  assert.equal(launch.url.includes(root), false);
  const token = launch.env.PROOFLOOP_TOKEN ?? "";
  assert.ok(token.length >= 32);
  assert.equal(launch.url.includes(token), false);
  assert.throws(
    () =>
      buildServerLaunch({
        root,
        packageRoot: "/opt/proofloop",
        host: "0.0.0.0",
      }),
    /loopback/,
  );
  assert.deepEqual(launch.args.slice(1, 6), ["dev", "-H", "127.0.0.1", "-p", "38471"]);
  assert.equal(launch.cwd, "/opt/proofloop");
});

test("open refuses a file and does not spawn the server", async () => {
  const spawned: string[] = [];
  const code = await main(["open", path.join(process.cwd(), "package.json")], {
    packageRoot: process.cwd(),
    env: process.env,
    stderr: () => {},
    stdout: () => {},
    spawn: () => {
      spawned.push("spawn");
      return fakeChild();
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(spawned, []);
});

test("open registers the session and opens the browser url", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "proofloop-open-")));
  const opened: string[] = [];
  const lines: string[] = [];
  let spawnedRoot = "";
  let launchedToken = "";
  const code = await main(["open", root], {
    packageRoot: process.cwd(),
    env: process.env,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    open: (url) => opened.push(url),
    wait: async () => {},
    spawn: (launch) => {
      spawnedRoot = launch.env.PROOFLOOP_ROOT ?? "";
      launchedToken = launch.env.PROOFLOOP_TOKEN ?? "";
      const child = fakeChild();
      setTimeout(() => child.emit("exit", 0), 0);
      return child;
    },
  });
  assert.equal(code, 0);
  assert.equal(spawnedRoot, root);
  assert.deepEqual(opened, ["http://127.0.0.1:38471"]);
  assert.equal(lines.some((line) => line.includes(root)), false);
  assert.ok(launchedToken.length >= 32);
  assert.equal(lines.some((line) => line.includes(launchedToken)), false);
  assert.match(lines.join("\n"), /prj_/);
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    kill: () => boolean;
  };
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child as unknown as ChildProcess;
}
