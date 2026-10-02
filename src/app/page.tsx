import { ProofLoopApp } from "@/components/proof-loop-app";
import { geminiCredentials } from "@/lib/gemini";
import { loadSeedProject } from "@/lib/sample-project";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <ProofLoopApp
      seed={loadSeedProject()}
      geminiConfigured={geminiCredentials() !== null}
    />
  );
}
