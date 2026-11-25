import { matchesGlob } from "node:path/posix";
import { parse } from "smol-toml";
import type { Repository } from "@room/git";
import { readRoomToml } from "#/room-toml.server.ts";

/**
 * Files a review can set aside: they still show in the tree and can each be
 * opened, but they're folded into one line per rule, and not analyzed or
 * sent until opened. Tests and stories for every repository (written from
 * mimas's conventions); a repository adds its own in its `.room.toml`.
 */
export type IgnoreRule = {
  name: string;
  /** Globs on the path from the repository's root; `**` crosses folders. */
  patterns: Array<string>;
};

export const ignoreRules: Array<IgnoreRule> = [
  {
    name: "tests",
    patterns: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
      "tests/**",
      "**/tests/**",
      "test/**",
      "**/test/**",
      "**/__mocks__/**",
      "**/__snapshots__/**",
      "**/test-support/**",
      "e2e/**",
      "**/e2e/**",
      "**/vitest.config.*",
      "**/jest.config.*",
      "**/playwright.config.*",
      "**/test-setup.*",
    ],
  },
  {
    name: "stories",
    patterns: ["**/*.stories.*", "**/__stories__/**", "**/.storybook/**", "**/story-support/**", "**/src/storybook/**", "**/tsconfig.storybook.json"],
  },
];

/** The rule that sets this file aside, or null. A rename counts when either path matches. */
export function ignoredBy(paths: Array<string>, rules: Array<IgnoreRule>): string | null {
  for (const rule of rules) {
    if (paths.some((path) => rule.patterns.some((pattern) => matchesGlob(path, pattern)))) return rule.name;
  }
  return null;
}

/**
 * The rules a `.room.toml` adds, and what's wrong with them (each problem
 * leaves out the rule it's in, or all of them when the file doesn't parse):
 *
 *   [[ignore]]
 *   name = "generated"
 *   files = ["**\/generated/**", "**\/*.gen.ts"]
 *
 * A rule without a name is "set aside": the line it's folded into says
 * "3 set aside changed".
 */
export function parseIgnoreRules(text: string): { rules: Array<IgnoreRule>; problems: Array<string> } {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return { rules: [], problems: [`.room.toml doesn't parse: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = (parsed as { ignore?: unknown }).ignore;
  if (entries === undefined) return { rules: [], problems: [] };
  if (!Array.isArray(entries)) return { rules: [], problems: ["`ignore` isn't a list of [[ignore]]."] };

  const rules: Array<IgnoreRule> = [];
  const problems: Array<string> = [];
  entries.forEach((entry: unknown, index) => {
    const rule = entry as Record<string, unknown>;
    const name = rule.name === undefined ? "set aside" : rule.name;
    const files = rule.files;
    if (typeof name !== "string" || name.trim() === "") {
      problems.push(`Ignore rule ${index + 1}: its name isn't a string.`);
    } else if (!Array.isArray(files) || files.length === 0 || !files.every((item) => typeof item === "string")) {
      problems.push(`Ignore rule "${name}": files is a list of globs.`);
    } else {
      rules.push({ name, patterns: files });
    }
  });
  return { rules, problems };
}

/**
 * The rules for a repository: tests and stories, then its `.room.toml`'s
 * (as it is now, see `readRoomToml`). The first rule a file matches names
 * the line it's folded into.
 */
export async function readIgnoreRules(repository: Repository): Promise<{ rules: Array<IgnoreRule>; problems: Array<string> }> {
  const text = await readRoomToml(repository);
  if (text === null) return { rules: ignoreRules, problems: [] };
  const own = parseIgnoreRules(text);
  return { rules: [...ignoreRules, ...own.rules], problems: own.problems };
}
