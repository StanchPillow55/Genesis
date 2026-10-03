import { GoogleGenAI } from "@google/genai";
import { parseJsonObject, parseProposedStep, type AgentBackend, type AgentContext } from "./agent";
import { geminiCredentials } from "./gemini";

const SYSTEM = `You are a coding agent inside ProofLoop. You propose one workspace step. You do not decide when the task is done.
Return ONLY JSON:
{
  "rationale": string,
  "summary": string,
  "filesTouched": string[],
  "unresolved": string | null,
  "actions": [
    { "type": "write", "path": "relative/path", "contents": "full new file contents" },
    { "type": "delete", "path": "relative/path" }
  ]
}
Rules:
- summary is one or two sentences of what this step did. filesTouched lists the paths you changed. unresolved is what is still failing, or null.
- actions may only write a whole file or delete a file. No shell commands.
- Do not paste raw command logs into the summary.
- paths stay inside the workspace. No absolute paths and no "..".
- Prefer the smallest change that could make the verifier commands exit 0.
- Do not claim the task is finished.
- Do not wrap the JSON in markdown.`;

export function createGeminiAgentBackend(options?: {
  generate?: (prompt: string) => Promise<string>;
}): AgentBackend {
  return {
    name: "gemini",
    async proposeStep(context) {
      if (!options?.generate && !geminiCredentials()) {
        throw new Error("No Gemini API key is set. A live model did not run.");
      }
      const generate = options?.generate ?? generateWithGemini;
      const text = await generate(renderPrompt(context));
      return parseProposedStep(parseJsonObject(text));
    },
  };
}

async function generateWithGemini(prompt: string): Promise<string> {
  const credentials = geminiCredentials();
  if (!credentials) {
    throw new Error("No Gemini API key is set. A live model did not run.");
  }
  const ai = new GoogleGenAI({ apiKey: credentials.apiKey });
  const response = await ai.models.generateContent({
    model: credentials.model,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      temperature: 0,
    },
  });
  if (!response.text?.trim()) {
    throw new Error("The model returned an empty step.");
  }
  return response.text;
}

function renderPrompt(context: AgentContext): string {
  const files = context.files
    .map((file) => `----- ${file.path}\n${file.contents}`)
    .join("\n\n");
  return [
    `Goal: ${context.goal}`,
    `Attempt ${context.attempt} of ${context.maxAttempts}`,
    `Verifier commands: ${context.contract.verifier.commands
      .map((command) => (command.type === "shell" ? command.command : command.id))
      .join(", ")}`,
    `Policies: modifyTests=${context.contract.policies.modifyTests}, delete=${context.contract.policies.delete}, editSource=${context.contract.policies.editSource}`,
    context.verifierFailure
      ? `Previous verifier failure: ${context.verifierFailure}`
      : "No verifier has failed yet in this run.",
    "Workspace files:",
    files || "(empty)",
  ].join("\n\n");
}
