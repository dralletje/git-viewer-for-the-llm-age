import { getCommit, type Repository } from "@room/git";
import { analyzeChangedFiles, type ChangedFile } from "#/changes.server.ts";

/**
 * A commit with its files analyzed, as its page shows it (see
 * `analyzeChangedFiles` for which files show their code).
 *
 * A commit never changes, so the result is kept (the last 40): opening a
 * commit that was prefetched (see `prefetchCommits`), or opened before,
 * costs nothing. Null when there is no such commit.
 */
export type AnalyzedCommit = Omit<NonNullable<Awaited<ReturnType<typeof getCommit>>>, "files"> & {
  files: Array<ChangedFile>;
};

export function analyzeCommit(repository: Repository, sha: string, requested: Array<string>): Promise<AnalyzedCommit | null> {
  const key = `${repository.directory}\0${sha}\0${requested.join("\n")}`;
  const kept = analyzed.get(key);
  if (kept !== undefined) {
    // Least recently used goes first: a hit moves to the end.
    analyzed.delete(key);
    analyzed.set(key, kept);
    return kept;
  }

  const result = (async (): Promise<AnalyzedCommit | null> => {
    const commit = await getCommit(repository, sha);
    if (commit === null) return null;

    return { ...commit, files: await analyzeChangedFiles(repository, commit.files, requested) };
  })();

  analyzed.set(key, result);
  if (analyzed.size > 40) {
    const oldest = analyzed.keys().next().value;
    if (oldest !== undefined) analyzed.delete(oldest);
  }
  // A failure isn't kept: the next visit tries again.
  result.catch(() => analyzed.delete(key));
  return result;
}

const analyzed = new Map<string, Promise<AnalyzedCommit | null>>();

/**
 * Analyzes these commits in the background, one at a time, so opening them
 * later is fast. A newer call replaces what an older one still had to do:
 * the commits someone is looking at now come first.
 */
export function prefetchCommits(repository: Repository, shas: Array<string>): void {
  queue = shas.map((sha) => ({ repository, sha }));
  if (running) return;
  running = true;
  void (async () => {
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await analyzeCommit(next.repository, next.sha, []).catch(() => null);
        // Let requests that came in meanwhile go first.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      running = false;
    }
  })();
}

let queue: Array<{ repository: Repository; sha: string }> = [];
let running = false;
