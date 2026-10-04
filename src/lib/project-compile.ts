import { compileWithFallback, type CompileNotes, type LoopContract } from "./contract";
import type { ProjectConfig } from "./project-config";

export function compileForProject(input: {
  goal: string;
  kind: "sample" | "project";
  config: ProjectConfig | null;
  model?: LoopContract | null;
}): CompileNotes {
  if (input.kind === "sample") {
    return compileWithFallback(input.goal);
  }
  if (!input.config) {
    const local = compileWithFallback(input.goal);
    return {
      contract: {
        ...local.contract,
        uncertainty:
          "This project has no proofloop.yaml. Run proofloop init, then say what done means.",
      },
      notes: [
        "No proofloop.yaml was found. Detection does not choose verifier commands at runtime.",
      ],
    };
  }

  const local = compileWithFallback(input.goal);
  const model = input.model ?? null;
  const uncertainty = local.contract.uncertainty ?? model?.uncertainty ?? null;
  const goal = model?.goal.trim() || local.contract.goal;
  const notes = [
    "Verifier commands, write globs, delete policy, and the attempt limit come from proofloop.yaml.",
  ];
  if (model) {
    notes.push("The model set the goal and uncertainty. It does not decide when the loop stops.");
    const modelCommands = model.verifier.commands
      .map((command) => (command.type === "shell" ? command.command : command.id))
      .join(", ");
    const configCommands = input.config.verify.commands.join(", ");
    if (modelCommands !== configCommands) {
      notes.push(
        `Config overrides model-inferred verifier commands. Using ${configCommands} instead of ${modelCommands}.`,
      );
    }
  } else if (uncertainty) {
    notes.push("The goal is unclear, so uncertainty is set and the loop will not run until you answer.");
  } else {
    notes.push("No model key is set. The local parser set the goal and uncertainty.");
  }

  return {
    contract: {
      goal,
      maxAttempts: input.config.attempts,
      policies: {
        modifyTests: "allow",
        delete: input.config.delete,
        editSource: "allow",
      },
      verifier: {
        commands: input.config.verify.commands.map((command) => ({ type: "shell" as const, command })),
      },
      uncertainty,
      writeGlobs: input.config.write.globs,
      acceptStrategy: input.config.accept,
    },
    notes,
  };
}
