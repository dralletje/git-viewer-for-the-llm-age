import { matchesGlob } from "node:path/posix";

/**
 * Files a review can set aside: they still show in the tree and can each be
 * opened, but they're folded into one line per rule, and not analyzed or
 * sent until opened. For every repository, for now; written from mimas's
 * conventions.
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
export function ignoredBy(paths: Array<string>): string | null {
  for (const rule of ignoreRules) {
    if (paths.some((path) => rule.patterns.some((pattern) => matchesGlob(path, pattern)))) return rule.name;
  }
  return null;
}
