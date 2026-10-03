import { ProofLoopApp } from "@/components/proof-loop-app";
import { geminiCredentials } from "@/lib/gemini";
import { loadSeedProject } from "@/lib/sample-project";
import { launchPublicSession } from "@/lib/session-store";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const session = launchPublicSession();
  return (
    <ProofLoopApp
      seed={loadSeedProject()}
      geminiConfigured={geminiCredentials() !== null}
      session={session}
    />
  );
}
