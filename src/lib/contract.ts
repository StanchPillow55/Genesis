export const PRESET_GOAL =
  "Make the signup checker healthy. Don't touch the tests. Ask me before deleting anything.";

export const POLICIES = ["allow", "deny", "require-approval"] as const;
export type Policy = (typeof POLICIES)[number];

/** Built-in signup fixture. It passes only when that run exits 0. */
export type FixtureCommand = {
  type: "fixture";
  id: "signup";
};

/** A shell command such as `npm test`. Success is exit code 0. */
export type ShellCommand = {
  type: "shell";
  command: string;
};

export type VerifierCommand = FixtureCommand | ShellCommand;

export type VerifierSpec = {
  commands: VerifierCommand[];
};

export type LoopContract = {
  goal: string;
  maxAttempts: number;
  policies: {
    modifyTests: Policy;
    delete: Policy;
    editSource: Policy;
  };
  verifier: VerifierSpec;
  uncertainty: string | null;
};

export type ContractAmendment = {
  type: "add-verifier-command";
  command: string;
};

/** Human-approved contract update. This does not execute the command. */
export function applyAmendment(contract: LoopContract, amendment: ContractAmendment): LoopContract {
  const command = amendment.command.trim();
  if (!command) {
    throw new Error("A contract amendment needs a command.");
  }
  if (amendment.type !== "add-verifier-command") {
    throw new Error("The only contract amendment is adding a verifier command.");
  }
  const exists = contract.verifier.commands.some(
    (entry) => entry.type === "shell" && entry.command === command,
  );
  if (exists) return contract;
  return {
    ...contract,
    verifier: {
      commands: [...contract.verifier.commands, { type: "shell", command }],
    },
  };
}

export function verifierCommandName(command: VerifierCommand): string {
  return command.type === "fixture" ? command.id : command.command;
}

export function formatVerifier(verifier: VerifierSpec): string {
  return verifier.commands.map(verifierCommandName).join(" && ");
}

export type CompileNotes = {
  contract: LoopContract;
  notes: string[];
};

const OUTCOME =
  /\b(healthy|pass|fix|repair|correct|working|heal|green|succeed)\b/i;
const SUBJECT =
  /\b(signup|checker|tests?|password|validator|email|username)\b/i;

export function compileWithFallback(input: string): CompileNotes {
  const text = input.trim().replace(/\s+/g, " ");
  const notes: string[] = [];

  if (!text) {
    return {
      contract: baseContract({
        goal: "",
        uncertainty:
          "The goal is empty. What should the signup checker prove before the loop stops?",
      }),
      notes: ["The goal was empty, so the harness is not allowed to run."],
    };
  }

  const modifyTests = parseModifyTests(text, notes);
  const deletePolicy = parseDelete(text, notes);
  const editSource = parseEditSource(text, notes);
  const maxAttempts = parseMaxAttempts(text, notes);
  const shellCommands = extractShellCommands(text);
  const hasOutcome = OUTCOME.test(text);
  const hasSubject = SUBJECT.test(text);
  const greeting = /^(hi|hello|hey|asdf|help|idk|something|test)\b/i.test(text);
  const uncertain =
    shellCommands.length === 0 && (greeting || text.length < 12 || !hasOutcome || !hasSubject);
  const verifier: VerifierSpec =
    shellCommands.length > 0
      ? { commands: shellCommands.map((command) => ({ type: "shell", command })) }
      : { commands: [{ type: "fixture", id: "signup" }] };

  let uncertainty: string | null = null;
  if (uncertain) {
    uncertainty =
      "This goal does not say what done means for the signup checker. Should the loop stop only when the username, password, and email checks pass?";
    notes.push(
      "The sentence is unclear, so uncertainty is set and the loop will not run until you answer.",
    );
  }

  const goal = !uncertain && /\b(healthy|pass|fix|repair|tests?)\b/i.test(text)
    ? "all tests pass"
    : text.length > 160
      ? `${text.slice(0, 157)}…`
      : text;

  if (!uncertain) {
    notes.push(`Goal compiled to “${goal}”.`);
  }
  if (shellCommands.length > 0) {
    notes.push(
      `Verifier commands are ${shellCommands.join(" and ")}. Each one must exit 0.`,
    );
  } else {
    notes.push("No shell commands were named, so the verifier is the signup fixture. It must exit 0.");
  }

  return {
    contract: {
      goal,
      maxAttempts,
      policies: {
        modifyTests,
        delete: deletePolicy,
        editSource,
      },
      verifier,
      uncertainty,
    },
    notes,
  };
}

export function parseContract(input: unknown): LoopContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("This contract is not a JSON object the harness can read.");
  }
  const raw = input as Record<string, unknown>;
  const goal = requiredString(raw.goal, "goal");
  const maxAttempts = parseAttemptCount(raw.maxAttempts);
  const policies = raw.policies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) {
    throw new Error("Contract policies are missing.");
  }
  const policyRecord = policies as Record<string, unknown>;
  const verifier = parseVerifier(raw.verifier);
  let uncertainty: string | null = null;
  if (typeof raw.uncertainty === "string" && raw.uncertainty.trim()) {
    uncertainty = raw.uncertainty.trim();
  } else if (raw.uncertainty != null && raw.uncertainty !== "") {
    throw new Error("uncertainty must be a string or null.");
  }
  if (!goal && !uncertainty) {
    throw new Error("The contract has no goal. Say what done means, or set uncertainty so the harness asks.");
  }
  return {
    goal,
    maxAttempts,
    policies: {
      modifyTests: parsePolicy(policyRecord.modifyTests, "modifyTests"),
      delete: parsePolicy(policyRecord.delete, "delete"),
      editSource: parsePolicy(policyRecord.editSource, "editSource"),
    },
    verifier,
    uncertainty,
  };
}

export function contractToJson(contract: LoopContract): string {
  return JSON.stringify(contract, null, 2);
}

function baseContract(partial: Partial<LoopContract> & { uncertainty: string | null }): LoopContract {
  return {
    goal: partial.goal ?? "",
    maxAttempts: partial.maxAttempts ?? 4,
    policies: partial.policies ?? {
      modifyTests: "allow",
      delete: "allow",
      editSource: "allow",
    },
    verifier: partial.verifier ?? { commands: [{ type: "fixture", id: "signup" }] },
    uncertainty: partial.uncertainty,
  };
}

function parseModifyTests(text: string, notes: string[]): Policy {
  if (
    /\b(don'?t|do not|never|must not)\s+(touch|modify|change|edit|alter)\b[^.]*\btests?\b/i.test(text) ||
    /\b(leave|keep)\s+the\s+tests?\s+(alone|unchanged|as-is|as is)\b/i.test(text) ||
    /\btests?\b[^.]*\b(read[- ]only|untouched)\b/i.test(text)
  ) {
    notes.push("Read “don't touch the tests” as modifyTests = deny.");
    return "deny";
  }
  if (/\b(ask|approval|confirm)\b[^.]*\btests?\b|\btests?\b[^.]*\b(ask|approval)\b/i.test(text)) {
    notes.push("Read an approval request around tests as modifyTests = require approval.");
    return "require-approval";
  }
  notes.push("No limit on tests was stated, so modifyTests = allow.");
  return "allow";
}

function parseDelete(text: string, notes: string[]): Policy {
  if (
    /\bask me before delet/i.test(text) ||
    /\b(ask|approval|confirm|check with me)\b[^.]*\b(delet|remov)/i.test(text) ||
    /\b(delet|remov)\w*[^.]*\bbefore\b[^.]*\b(ask|approval|confirm)/i.test(text) ||
    /\b(delet|remov)\w*[^.]*\b(ask|approval|confirm|permission)\b/i.test(text)
  ) {
    notes.push("Read “ask before deleting” as delete = require approval.");
    return "require-approval";
  }
  if (/\b(never|don'?t|do not|must not)\s+(delete|remove)\b/i.test(text)) {
    notes.push("Read a hard ban on deletes as delete = deny.");
    return "deny";
  }
  notes.push("No delete limit was stated, so delete = allow.");
  return "allow";
}

function parseEditSource(text: string, notes: string[]): Policy {
  if (
    /\b(don'?t|do not|never|must not)\s+(touch|edit|change|modify)\b[^.]*\b(source|code|validator)\b/i.test(text)
  ) {
    notes.push("Read a ban on source edits as editSource = deny.");
    return "deny";
  }
  if (/\b(ask|approval|confirm)\b[^.]*\b(edit|change|modify)\b[^.]*\b(source|code|validator)\b/i.test(text)) {
    notes.push("Read an approval request around source edits as editSource = require approval.");
    return "require-approval";
  }
  notes.push("Source edits are allowed.");
  return "allow";
}

function parseMaxAttempts(text: string, notes: string[]): number {
  const patterns = [
    /\bmax(?:imum)?\s+attempts?\s*(?:of|is|:|=)?\s*(\d+)\b/i,
    /\battempts?\s*(?:of|:|=)\s*(\d+)\b/i,
    /\b(\d+)\s+attempts?\b/i,
    /\btry\s+(\d+)\s+times?\b/i,
    /\bno more than\s+(\d+)\s+(?:attempts?|tries|times)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = clampAttempts(Number(match[1]));
    notes.push(`Read maxAttempts = ${value} from the sentence.`);
    return value;
  }
  notes.push("No attempt limit was stated, so maxAttempts = 4.");
  return 4;
}

function parseAttemptCount(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(number)) {
    throw new Error("maxAttempts must be a whole number.");
  }
  if (number < 1 || number > 20) {
    throw new Error("maxAttempts must be between 1 and 20.");
  }
  return number;
}

function shellCommandPattern(): RegExp {
  return /\b(?:npm|pnpm|yarn|bun)\s+run\s+[A-Za-z0-9:_-]+|\b(?:npm|pnpm|yarn|bun|npx)\s+[A-Za-z0-9:_-]+|\bcargo\s+(?:test|build|check)\b|\bpytest\b|\bgo\s+test\b|\bmake\s+[A-Za-z0-9:_-]+/g;
}

export function extractShellCommands(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(shellCommandPattern())) {
    const command = match[0].replace(/\s+/g, " ").trim();
    if (!found.includes(command)) found.push(command);
  }
  return found;
}

export function parseVerifier(value: unknown): VerifierSpec {
  if (typeof value === "string") {
    return { commands: commandsFromVerifierText(value) };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error("verifier must name at least one command.");
    }
    return { commands: value.map((entry) => parseVerifierCommand(entry)) };
  }
  if (value && typeof value === "object" && "commands" in value) {
    const commands = (value as { commands?: unknown }).commands;
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error("verifier.commands must list at least one command.");
    }
    return { commands: commands.map((entry) => parseVerifierCommand(entry)) };
  }
  throw new Error("verifier must name shell commands that exit 0, or the signup fixture.");
}

function parseVerifierCommand(value: unknown): VerifierCommand {
  if (typeof value === "string") {
    const commands = commandsFromVerifierText(value);
    if (commands.length !== 1) {
      throw new Error("Each verifier entry must be one shell command or the signup fixture.");
    }
    return commands[0];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Each verifier entry must be one shell command or the signup fixture.");
  }
  const record = value as Record<string, unknown>;
  if (record.type === "fixture") {
    if (record.id !== "signup") {
      throw new Error("The only built-in fixture is signup.");
    }
    return { type: "fixture", id: "signup" };
  }
  if (record.type === "shell" || typeof record.command === "string") {
    if (typeof record.command !== "string" || !record.command.trim()) {
      throw new Error("A shell verifier needs a command string.");
    }
    return { type: "shell", command: record.command.trim() };
  }
  throw new Error("Each verifier entry must be one shell command or the signup fixture.");
}

function commandsFromVerifierText(value: string): VerifierCommand[] {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("verifier must name at least one command.");
  }
  if (/^(run the signup tests|signup)$/i.test(trimmed)) {
    return [{ type: "fixture", id: "signup" }];
  }
  const extracted = extractShellCommands(trimmed);
  const remainder = trimmed
    .replace(shellCommandPattern(), " ")
    .replace(/\b(and|then|both|must|succeed|succeeds|pass|passes|exit|code)\b/gi, " ")
    .replace(/&&/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "");
  if (extracted.length > 0 && remainder.length === 0) {
    return extracted.map((command) => ({ type: "shell", command }));
  }
  return [{ type: "shell", command: trimmed }];
}

function parsePolicy(value: unknown, field: string): Policy {
  if (typeof value !== "string") {
    throw new Error(`${field} must be allow, deny, or require-approval.`);
  }
  const normalized = value.toLowerCase().trim().replace(/[\s_]+/g, "-");
  if (normalized === "require-approval" || normalized === "approval" || normalized === "ask") {
    return "require-approval";
  }
  if (normalized === "deny" || normalized === "denied" || normalized === "block") {
    return "deny";
  }
  if (normalized === "allow" || normalized === "allowed") {
    return "allow";
  }
  throw new Error(`${field} must be allow, deny, or require-approval.`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value.trim();
}

function clampAttempts(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(20, Math.max(1, Math.trunc(value)));
}
