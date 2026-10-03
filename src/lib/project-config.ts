import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { Policy } from "./contract";

export type AcceptStrategy = "branch" | "apply-uncommitted";

export type ProjectConfig = {
  version: 1;
  agent: { provider: "gemini" };
  verify: { commands: string[] };
  write: { globs: string[] };
  delete: Policy;
  attempts: number;
  accept: AcceptStrategy;
};

const FILE_NAME = "proofloop.yaml";

export function configPath(root: string): string {
  return path.join(root, FILE_NAME);
}

export function loadProjectConfig(root: string): ProjectConfig | null {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  return parseProjectConfig(readFileSync(file, "utf8"), FILE_NAME);
}

export function parseProjectConfig(text: string, filename = FILE_NAME): ProjectConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    throw new Error(`${filename} is not valid YAML. ${message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${filename} must be a mapping.`);
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`${filename}: version must be 1.`);
  }
  const agent = mapping(record.agent, `${filename}: agent`);
  if (agent.provider !== "gemini") {
    throw new Error(`${filename}: agent.provider must be gemini.`);
  }
  const verify = mapping(record.verify, `${filename}: verify`);
  const commands = stringList(verify.commands, `${filename}: verify.commands`);
  if (commands.length === 0) {
    throw new Error(`${filename}: verify.commands must list at least one command.`);
  }
  const write = mapping(record.write, `${filename}: write`);
  const globs = stringList(write.globs, `${filename}: write.globs`);
  if (globs.length === 0) {
    throw new Error(`${filename}: write.globs must list at least one glob.`);
  }
  return {
    version: 1,
    agent: { provider: "gemini" },
    verify: { commands },
    write: { globs },
    delete: parseDelete(record.delete, filename),
    attempts: parseAttempts(record.attempts, filename),
    accept: parseAccept(record.accept, filename),
  };
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return stringify({
    version: config.version,
    agent: config.agent,
    verify: config.verify,
    write: config.write,
    delete: config.delete,
    attempts: config.attempts,
    accept: config.accept,
  });
}

export function suggestProjectConfig(root: string): { config: ProjectConfig; reasons: string[] } {
  const reasons: string[] = [];
  const packageTest = readPackageTest(root);
  const python = readPythonTest(root);
  let commands: string[];
  if (packageTest) {
    commands = [packageTest];
    reasons.push(`package.json has a test script, so verify.commands suggests ${packageTest}.`);
  } else if (python) {
    commands = [python];
    reasons.push(`Python metadata mentions pytest, so verify.commands suggests ${python}.`);
  } else {
    commands = ["npm test"];
    reasons.push("No test script was found. verify.commands suggests npm test for you to edit.");
  }
  reasons.push("This suggestion is written into proofloop.yaml. Runtime does not detect commands on its own.");
  return {
    config: {
      version: 1,
      agent: { provider: "gemini" },
      verify: { commands },
      write: { globs: ["**/*"] },
      delete: "require-approval",
      attempts: 4,
      accept: "branch",
    },
    reasons,
  };
}

export function initProject(root: string): { file: string; reasons: string[]; config: ProjectConfig } {
  const file = configPath(root);
  if (existsSync(file)) {
    throw new Error(`${FILE_NAME} already exists. Edit it, or remove it before running proofloop init again.`);
  }
  const suggested = suggestProjectConfig(root);
  writeFileSync(file, serializeProjectConfig(suggested.config), "utf8");
  return { file, reasons: suggested.reasons, config: suggested.config };
}

function readPackageTest(root: string): string | null {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: { test?: unknown } };
    const test = parsed.scripts?.test;
    if (typeof test !== "string" || !test.trim() || test.trim() === 'echo "Error: no test specified" && exit 1') {
      return null;
    }
    return "npm test";
  } catch {
    return null;
  }
}

function readPythonTest(root: string): string | null {
  const pyproject = path.join(root, "pyproject.toml");
  if (existsSync(pyproject) && /pytest/i.test(readFileSync(pyproject, "utf8"))) return "pytest";
  if (existsSync(path.join(root, "pytest.ini"))) return "pytest";
  const requirements = path.join(root, "requirements.txt");
  if (existsSync(requirements) && /^pytest([=<>\s]|$)/im.test(readFileSync(requirements, "utf8"))) return "pytest";
  return null;
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a list of strings.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return entry.trim();
  });
}

function parseDelete(value: unknown, filename: string): Policy {
  if (value === "allow" || value === "deny" || value === "require-approval") return value;
  throw new Error(`${filename}: delete must be allow, deny, or require-approval.`);
}

function parseAttempts(value: unknown, filename: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error(`${filename}: attempts must be a whole number from 1 to 20.`);
  }
  return value;
}

function parseAccept(value: unknown, filename: string): AcceptStrategy {
  if (value === "branch" || value === "apply-uncommitted") return value;
  throw new Error(`${filename}: accept must be branch or apply-uncommitted.`);
}
