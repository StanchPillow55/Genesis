import assert from "node:assert/strict";
import test from "node:test";
import { selectContext } from "./context-select";

test("context prefers verifier paths, then edits, then the goal, under the caps", () => {
  const files = [
    { path: "src/other.ts", contents: "export const other = 1;\n" },
    { path: "src/a.ts", contents: "export const named = true;\n" },
    { path: "src/b.ts", contents: "export const broken = true;\n" },
    { path: "note.txt", contents: "broken\n" },
    { path: "skip.bin", contents: "a".repeat(60_000) },
  ];
  const selected = selectContext({
    goal: "Update src/a.ts",
    verifierOutput: "FAIL src/b.ts:12 expected 1",
    changedPaths: ["note.txt"],
    files,
  });
  assert.deepEqual(
    selected.map((file) => file.path),
    ["src/b.ts", "note.txt", "src/a.ts", "src/other.ts", "proofloop-manifest.txt"],
  );
  const bytes = selected.reduce((sum, file) => sum + file.contents.length, 0);
  assert.ok(bytes <= 50_000);
  assert.ok(selected.length <= 40);
  assert.equal(selected.some((file) => file.path === "skip.bin"), false);
  assert.match(selected.at(-1)?.contents ?? "", /src\/b\.ts/);
});

test("a large tree still stops at 40 files and 50KB", () => {
  const files = Array.from({ length: 80 }, (_, index) => ({
    path: `src/file-${String(index).padStart(2, "0")}.ts`,
    contents: "x".repeat(2_000),
  }));
  files.push({ path: "src/broken.ts", contents: "export const broken = true;\n" });
  const selected = selectContext({
    goal: "Fix the currently failing tests.",
    verifierOutput: "Error: src/broken.ts:3",
    changedPaths: [],
    files,
  });
  assert.equal(selected[0]?.path, "src/broken.ts");
  assert.ok(selected.length <= 40);
  assert.ok(selected.reduce((sum, file) => sum + file.contents.length, 0) <= 50_000);
  assert.equal(selected.at(-1)?.path, "proofloop-manifest.txt");
});
