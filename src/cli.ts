import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lib/cli";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

main(process.argv.slice(2), { packageRoot }).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
