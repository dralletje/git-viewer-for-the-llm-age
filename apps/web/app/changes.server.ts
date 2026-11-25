import type { FileDiff } from "@room/diff";
import type { Repository } from "@room/git";
import { analyzeFiles, type AnalyzedFile } from "#/analyze-diff.server.ts";
import { buildFileTree, filesInTreeOrder } from "#/file-tree.ts";
import { ignoredBy, readIgnoreRules } from "#/rules.server.ts";

/** A changed file as every changes page shows it: analyzed, and the rule that sets it aside, if one does. */
export type ChangedFile = AnalyzedFile & { ignoredBy: string | null };

/**
 * The changed files of a commit, a comparison or the work tree, analyzed
 * for a changes page. Tests, stories and what the repository's `.room.toml`
 * names are set aside (see rules.server.ts): listed, not read.
 *
 * Which files show their code: the ones asked for (`requested`, the page's
 * `?open=`), then, in the order the tree shows them, files that aren't set
 * aside and have at most 400 changed lines, until about 2000 lines are on
 * the page. A larger diff is rarely read line by line (lockfiles, generated
 * code), and a page with all of it doesn't load: the rest show their
 * summary, one click from their code.
 */
export async function analyzeChangedFiles(repository: Repository, files: Array<FileDiff>, requested: Array<string>): Promise<Array<ChangedFile>> {
  const { rules } = await readIgnoreRules(repository);
  const ignored = new Map(files.map((file) => [file.path, ignoredBy([file.path, file.oldPath ?? file.path], rules)]));
  const showCode = new Set<string>();
  let budget = 2000;
  for (const file of filesInTreeOrder(buildFileTree(files, (file) => file.path))) {
    const lines = file.additions + file.deletions;
    if (requested.includes(file.path)) {
      showCode.add(file.path);
    } else if (ignored.get(file.path) === null && !file.binary && lines <= 400 && lines <= budget) {
      showCode.add(file.path);
      budget -= lines;
    }
  }
  const skip = new Set([...ignored].filter(([path, rule]) => rule !== null && !requested.includes(path)).map(([path]) => path));

  const analyzed = await analyzeFiles(repository, files, { showCode, skip });
  return analyzed.map((file) => ({ ...file, ignoredBy: ignored.get(file.path) ?? null }));
}
