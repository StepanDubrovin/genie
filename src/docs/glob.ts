/** Match POSIX repository-relative paths against the docs `paths` glob subset. */
export function isValidRepoGlob(pattern: string): boolean {
  if (!pattern || pattern.startsWith("/") || pattern.includes("\\") || /^[A-Za-z]:/.test(pattern)) return false;
  return !pattern.split("/").some((part) => part === ".." || part === ".");
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** `*` stays within a segment, `**` crosses segments, `?` matches one non-slash. */
export function globToRegExp(pattern: string): RegExp {
  if (!isValidRepoGlob(pattern)) throw new Error(`invalid repository glob: ${pattern}`);
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegex(char);
  }
  return new RegExp(`${source}$`);
}

export function globMatches(pattern: string, repoPath: string): boolean {
  if (repoPath.includes("\\") || repoPath.startsWith("/")) return false;
  return globToRegExp(pattern).test(repoPath);
}

export function matchesAnyGlob(patterns: readonly string[] | null | undefined, repoPath: string): string | undefined {
  return patterns?.find((pattern) => globMatches(pattern, repoPath));
}
