import { readFileSync } from "node:fs";
import path from "node:path";

export type SeedProject = {
  validator: string;
  tests: string;
  helper: string;
};

export function loadSeedProject(): SeedProject {
  const dir = path.join(process.cwd(), "sample", "community-signup");
  return {
    validator: readFileSync(path.join(dir, "validator.ts"), "utf8"),
    tests: readFileSync(path.join(dir, "signup.test.ts"), "utf8"),
    helper: readFileSync(path.join(dir, "legacy-helper.ts"), "utf8"),
  };
}
