const MAX_FILES = 40;
const MAX_BYTES = 50_000;

const PATH_PATTERN =
  /(?:^|[\s"'`(])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+)(?::\d+)?/g;

export type ContextFile = {
  path: string;
  contents: string;
};

export function selectContext(input: {
  goal: string;
  verifierOutput: string;
  changedPaths: string[];
  files: ContextFile[];
}): ContextFile[] {
  const byPath = new Map<string, ContextFile>();
  for (const file of input.files) {
    if (!file.path || file.contents.includes("\u0000") || file.contents.length > MAX_BYTES) continue;
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }

  const mentioned = new Set(pathsIn(input.verifierOutput));
  const changed = new Set(input.changedPaths);
  const namedInGoal = new Set(
    [...byPath.keys()].filter((file) => goalNames(input.goal, file)),
  );

  const ranked = [...byPath.values()].sort((left, right) => {
    const score = rank(left.path, mentioned, changed, namedInGoal) - rank(right.path, mentioned, changed, namedInGoal);
    if (score !== 0) return score;
    return left.path.localeCompare(right.path);
  });

  const selected: ContextFile[] = [];
  let bytes = 0;
  const manifestBody = [...byPath.keys()].sort().join("\n");
  const manifest: ContextFile = {
    path: "proofloop-manifest.txt",
    contents: manifestBody.length > 4_000 ? `${manifestBody.slice(0, 4_000)}\n…` : manifestBody,
  };
  const manifestBytes = manifest.contents.length;

  for (const file of ranked) {
    if (selected.length >= MAX_FILES - 1) break;
    if (bytes + file.contents.length + manifestBytes > MAX_BYTES) continue;
    selected.push(file);
    bytes += file.contents.length;
  }
  if (selected.length < MAX_FILES && bytes + manifestBytes <= MAX_BYTES && manifest.contents.length > 0) {
    selected.push(manifest);
  }
  return selected;
}

function rank(
  file: string,
  mentioned: Set<string>,
  changed: Set<string>,
  namedInGoal: Set<string>,
): number {
  if (mentioned.has(file) || [...mentioned].some((entry) => entry.endsWith(`/${file}`) || file.endsWith(`/${entry}`))) {
    return 0;
  }
  if (changed.has(file)) return 1;
  if (namedInGoal.has(file)) return 2;
  return 3;
}

function goalNames(goal: string, file: string): boolean {
  const base = file.split("/").at(-1) ?? file;
  return goal.includes(file) || goal.includes(base);
}

function pathsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const value = match[1];
    if (!value || found.includes(value)) continue;
    found.push(value);
  }
  return found;
}
