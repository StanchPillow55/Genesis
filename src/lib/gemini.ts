import { GoogleGenAI } from "@google/genai";
import { parseContract, type LoopContract } from "./contract";

const SYSTEM = `You compile a natural-language goal into a loop contract for ProofLoop.
ProofLoop checks a community-event signup validator. The only verifier is the signup tests (username, password, email).
Return ONLY JSON with this shape:
{
  "goal": string,
  "maxAttempts": number,
  "policies": {
    "modifyTests": "allow" | "deny" | "require-approval",
    "delete": "allow" | "deny" | "require-approval",
    "editSource": "allow" | "deny" | "require-approval"
  },
  "verifier": "run the signup tests",
  "uncertainty": string | null
}
Rules:
- goal is a short statement of done, usually "all tests pass", when the user wants the checker fixed or the tests green.
- maxAttempts is an integer from 1 to 20. Use 4 when the user does not name a limit.
- "don't touch the tests", "don't modify tests", and "leave the tests alone" mean modifyTests is "deny".
- "ask before deleting" or "ask me before deleting" means delete is "require-approval".
- "never delete" means delete is "deny".
- editSource is "allow" unless the user restricts source edits.
- verifier is always "run the signup tests".
- If the goal does not say what completion means, set uncertainty to one specific question for the human and do not invent a confident goal. Otherwise uncertainty is null.
- Do not wrap the JSON in markdown.`;

export function geminiCredentials(): { apiKey: string; model: string } | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey?.trim()) return null;
  return {
    apiKey: apiKey.trim(),
    model: process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
  };
}

export async function compileWithGemini(goal: string): Promise<{ contract: LoopContract; model: string }> {
  const credentials = geminiCredentials();
  if (!credentials) {
    throw new Error("No Gemini API key is set.");
  }
  const ai = new GoogleGenAI({ apiKey: credentials.apiKey });
  const response = await ai.models.generateContent({
    model: credentials.model,
    contents: goal,
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      temperature: 0,
    },
  });
  const text = response.text;
  if (!text?.trim()) {
    throw new Error("The model returned an empty contract.");
  }
  return { contract: parseContract(parseJson(text)), model: credentials.model };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}
