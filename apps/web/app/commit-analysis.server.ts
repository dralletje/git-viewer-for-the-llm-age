import { getCommit, type Repository } from "@room/git";
import { analyzeFiles, type AnalyzedFile } from "#/analyze-diff.server.ts";
import { buildFileTree, filesInTreeOrder } from "#/file-tree.ts";
import { ignoredBy } from "#/rules.server.ts";

/**
 * A commit with its files analyzed, as its page shows it. Tests and stories
 * are set aside (see rules.server.ts): listed, not read.
 *
 * Which files show their code: the ones asked for (`requested`), then, in
 * the order the tree shows them, files that aren't set aside and have at
 * most 400 changed lines, until about 2000 lines are on the page. A larger
 * diff is rarely read line by line (lockfiles, generated code), and a page
 * with all of it doesn't load: the rest show their summary, one click from
 * their code.
 *
 * A commit never changes, so the result is kept (the last 40): opening a
 * commit that was prefetched (see `prefetchCommits`), or opened before,
 * costs nothing. Null when there is no such commit.
 */
export type AnalyzedCommit = Omit<NonNullable<Awaited<ReturnType<typeof getCommit>>>, "files"> & {
  files: Array<AnalyzedFile & { ignoredBy: string | null }>;
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

    const ignored = new Map(commit.files.map((file) => [file.path, ignoredBy([file.path, file.oldPath ?? file.path])]));
    const showCode = new Set<string>();
    let budget = 2000;
    for (const file of filesInTreeOrder(buildFileTree(commit.files, (file) => file.path))) {
      const lines = file.additions + file.deletions;
      if (requested.includes(file.path)) {
        showCode.add(file.path);
      } else if (ignored.get(file.path) === null && !file.binary && lines <= 400 && lines <= budget) {
        showCode.add(file.path);
        budget -= lines;
      }
    }
    const skip = new Set([...ignored].filter(([path, rule]) => rule !== null && !requested.includes(path)).map(([path]) => path));

    const files = await analyzeFiles(repository, commit.files, { showCode, skip });
    return { ...commit, files: files.map((file) => ({ ...file, ignoredBy: ignored.get(file.path) ?? null })) };
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
