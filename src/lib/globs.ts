export function globMatches(glob: string, file: string): boolean {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = glob[index] ?? "";
    if (char === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${source}$`).test(file);
}

export function anyGlobMatches(globs: string[], file: string): boolean {
  return globs.some((glob) => globMatches(glob, file));
}
