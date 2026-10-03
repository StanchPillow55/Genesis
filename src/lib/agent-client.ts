import type { AgentBackend, AgentContext, ProposedStep } from "./agent";

/** Browser-side Gemini backend. The API key stays on the server. */
export function createRemoteGeminiBackend(): AgentBackend {
  return {
    name: "gemini",
    async proposeStep(context: AgentContext): Promise<ProposedStep> {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
      });
      const data = (await response.json()) as { error?: string; step?: ProposedStep };
      if (!response.ok || !data.step) {
        throw new Error(data.error ?? "The agent did not propose a step.");
      }
      return data.step;
    },
  };
}
