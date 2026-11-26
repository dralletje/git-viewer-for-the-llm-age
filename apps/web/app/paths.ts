import type { RepositorySource } from "@room/git";

/**
 * Where a repository's pages live. GitHub: `/owner/name`. Local:
 * `/local/<path>`, the path as ONE encoded segment (`%2Fhome%2F...`), which
 * React Router hands back decoded as `params.repo`. A GitHub repository name
 * never starts with "/", so `/local/name` stays GitHub's user "local".
 */
export function repositoryPath(source: RepositorySource): string {
  if (source.kind === "local") return `/local/${encodeURIComponent(source.path)}`;
  return `/${source.owner}/${source.name}`;
}

/** "owner/name", or the local path. */
export function repositoryLabel(source: RepositorySource): string {
  if (source.kind === "local") return source.path;
  return `${source.owner}/${source.name}`;
}

/**
 * The branch is ONE encoded segment (`release%2F13.x`), so commit pages can
 * nest below it; React Router hands it back decoded as `params.branch`.
 */
export function branchPath(repository: string, branch: string): string {
  return `${repository}/branch/${encodeURIComponent(branch)}`;
}

/**
 * What a branch changed relative to `base` (a branch name or a commit), as
 * a pull request shows it. The base is a query parameter, so a plain form
 * with a <select name="base"> can ask for it.
 */
export function comparePath(repository: string, branch: string, base: string, commits: number): string {
  const query = new URLSearchParams({ base: base });
  if (commits > 50) query.set("commits", String(commits));
  return `${branchPath(repository, branch)}/compare?${query}`;
}

/** One file's analyzed changes, as data: what opening a file whose code isn't on the page fetches. */
export function fileChangesPath(
  repository: string,
  range: { commit: string } | { from: string; to: string },
  file: { path: string; oldPath: string | null },
): string {
  const query = new URLSearchParams("commit" in range ? { commit: range.commit } : { from: range.from, to: range.to });
  query.set("path", file.path);
  if (file.oldPath !== null && file.oldPath !== file.path) query.set("old", file.oldPath);
  return `${repository}/file?${query}`;
}

/**
 * What a change does to what the repository's files can reach, as data:
 * `head` against `base` (commits or trees; no base: nothing before). What a
 * page of changes fetches once it's shown, since the scan can take a while.
 */
export function reachPath(repository: string, change: { head: string; base: string | null }): string {
  const query = new URLSearchParams({ head: change.head });
  if (change.base !== null) query.set("base", change.base);
  return `${repository}/reach?${query}`;
}

/** The import links to and from a change's files, before and after, as data: what the graph tabs fetch. */
export function graphPath(repository: string, change: { head: string; base: string | null }): string {
  const query = new URLSearchParams({ head: change.head });
  if (change.base !== null) query.set("base", change.base);
  return `${repository}/graph?${query}`;
}

/**
 * One declaration's code at `head`, lines `start` to `end` of `path`, and
 * its `parts` further down (`parts=9-9,12-13`): what an unchanged
 * declaration in the graph fetches when opened.
 */
export function declarationPath(
  repository: string,
  declaration: { head: string; path: string; start: number; end: number; parts: Array<{ startLine: number; endLine: number }> },
): string {
  const query = new URLSearchParams({ head: declaration.head, path: declaration.path, start: String(declaration.start), end: String(declaration.end) });
  if (declaration.parts.length > 0) {
    query.set("parts", declaration.parts.map((part) => `${part.startLine}-${part.endLine}`).join(","));
  }
  return `${repository}/declaration?${query}`;
}

/** What changed in the work tree since the last commit, on the branch that's checked out. */
export function workingChangesPath(repository: string, branch: string): string {
  return `${branchPath(repository, branch)}/changes`;
}

/** A commit, seen from a branch: the branch's commit list stays beside it. */
export function commitPath(repository: string, branch: string, sha: string): string {
  return `${branchPath(repository, branch)}/commit/${sha}`;
}

/**
 * "2026-11-19 14:03" in the committer's own time zone, as git recorded it.
 * Text from the ISO date, so the server and the browser render the same.
 */
export function formatDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
