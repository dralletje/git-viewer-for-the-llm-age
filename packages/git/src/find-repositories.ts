import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { runGit } from "#/run-git.ts";

export type LocalRepository = {
  name: string;
  path: string;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
  /** Committer date of HEAD; null for a repository without commits. */
  lastCommitDate: string | null;
  lastCommitSubject: string | null;
};

/**
 * The git repositories directly inside `folder` (not deeper), most recently
 * committed to first. A folder that is merely inside another repository
 * doesn't count: only one that is its own repository's top folder.
 */
export async function findLocalRepositories(folder: string): Promise<Array<LocalRepository>> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

  const found = await Promise.all(
    folders.map(async (entry): Promise<LocalRepository | null> => {
      const path = join(folder, entry.name);
      // The way up to the top folder: empty when this folder is the top.
      const upToTop = await runGit(["-C", path, "rev-parse", "--show-cdup"]).then(
        (output) => output.trim(),
        () => null,
      );
      if (upToTop !== "") return null;
      return describeLocalRepository(path);
    }),
  );

  return sortByLastCommit(found.filter((repository) => repository !== null));
}

/** A repository's top folder (or a bare repository), as a list of them shows it: named after its folder. */
export async function describeLocalRepository(path: string): Promise<LocalRepository> {
  const branch = await runGit(["-C", path, "branch", "--show-current"]).then(
    (output) => output.trim(),
    () => "",
  );
  const head = await runGit(["-C", path, "log", "--max-count=1", "--format=%cI%x1f%s"]).then(
    (output) => output.trim().split("\x1f"),
    () => [],
  );
  return {
    name: basename(path),
    path: path,
    branch: branch === "" ? null : branch,
    lastCommitDate: head[0] ?? null,
    lastCommitSubject: head[1] ?? null,
  };
}

/** Most recently committed to first; then by name. */
export function sortByLastCommit(repositories: Array<LocalRepository>): Array<LocalRepository> {
  return [...repositories].sort((a, b) => Date.parse(b.lastCommitDate ?? "0") - Date.parse(a.lastCommitDate ?? "0") || a.name.localeCompare(b.name));
}
