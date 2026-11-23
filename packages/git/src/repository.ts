import { copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDiff, type FileDiff } from "@room/diff";
import { runGit } from "#/run-git.ts";

/** Where a repository comes from: GitHub, or a path on this machine. */
export type RepositorySource =
  | { kind: "github"; owner: string; name: string }
  | { kind: "local"; path: string };

export type Repository = {
  source: RepositorySource;
  /** Where git runs: the bare clone of a GitHub repository, or the local repository itself. */
  directory: string;
};

export type Branch = {
  name: string;
  sha: string;
  date: string;
  subject: string;
  author: string;
  isDefault: boolean;
};

export type Commit = {
  sha: string;
  parents: Array<string>;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerDate: string;
  subject: string;
  body: string;
};

export type CommitWithDiff = Commit & {
  files: Array<FileDiff>;
};

const cacheDirectory = process.env.ROOM_CACHE ?? join(homedir(), ".cache", "behind-the-room", "repos");

/** When each clone was last fetched, so a burst of page loads fetches once. */
const lastFetched = new Map<string, number>();
/** Clones and fetches in flight, so two requests for one repo share the work. */
const inFlight = new Map<string, Promise<Repository>>();

export function openRepository(source: RepositorySource, options: { maxAgeMs?: number } = {}): Promise<Repository> {
  if (source.kind === "local") return openLocalRepository(source.path);
  return openGithubRepository(source.owner, source.name, options.maxAgeMs ?? 30_000);
}

/**
 * A repository on this machine, used where it is: nothing is cloned or
 * fetched, so it shows exactly the branches and commits it has. The path may
 * be anywhere inside a work tree, or a bare repository; the source it returns
 * has the work tree's top folder (or the bare repository) as its path.
 */
async function openLocalRepository(path: string): Promise<Repository> {
  // Fails with git's own words when the folder is missing or isn't a repository.
  const gitDir = (await runGit(["-C", resolve(path), "rev-parse", "--absolute-git-dir"])).trim();
  const topLevel = await runGit(["-C", resolve(path), "rev-parse", "--show-toplevel"]).then(
    (output) => output.trim(),
    // A bare repository has no work tree: git runs in the repository itself.
    () => gitDir,
  );
  return { source: { kind: "local", path: topLevel }, directory: topLevel };
}

/**
 * Clones the repository on first use (bare, without file contents: git
 * fetches the blobs a diff needs when it needs them), and fetches it again
 * when the last fetch is older than `maxAgeMs`.
 */
function openGithubRepository(owner: string, name: string, maxAgeMs: number): Promise<Repository> {
  const gitDir = join(cacheDirectory, "github.com", owner, `${name}.git`);

  const existing = inFlight.get(gitDir);
  if (existing !== undefined) return existing;

  const work = (async (): Promise<Repository> => {
    const repository: Repository = { source: { kind: "github", owner: owner, name: name }, directory: gitDir };
    const url = `https://github.com/${owner}/${name}.git`;

    const cloned = await stat(gitDir).then(
      () => true,
      () => false,
    );
    if (!cloned) {
      // Clone next to the final place and move it in, so a failed or
      // interrupted clone never leaves a half repository behind.
      const temporary = `${gitDir}.cloning-${process.pid}-${Date.now()}`;
      await mkdir(join(gitDir, ".."), { recursive: true });
      try {
        await runGit(["clone", "--bare", "--filter=blob:none", "--quiet", "--", url, temporary]);
        await rename(temporary, gitDir);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      lastFetched.set(gitDir, Date.now());
      return repository;
    }

    const fetchedAt = lastFetched.get(gitDir) ?? 0;
    if (Date.now() - fetchedAt > maxAgeMs) {
      await runGit(["fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/heads/*"], { cwd: gitDir });
      lastFetched.set(gitDir, Date.now());
    }
    return repository;
  })();

  inFlight.set(gitDir, work);
  return work.finally(() => inFlight.delete(gitDir));
}

export async function listBranches(repository: Repository): Promise<Array<Branch>> {
  const head = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: repository.directory }).catch(() => "");
  const defaultBranch = head.trim().replace(/^refs\/heads\//, "");

  const output = await runGit(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:lstrip=2)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(subject)%1f%(authorname)%1e",
      "refs/heads",
    ],
    { cwd: repository.directory },
  );

  return records(output).map((fields) => {
    const name = fields[0] ?? "";
    return {
      name: name,
      sha: fields[1] ?? "",
      date: fields[2] ?? "",
      subject: fields[3] ?? "",
      author: fields[4] ?? "",
      isDefault: name === defaultBranch,
    };
  });
}

/** Resolves a branch name or (abbreviated) sha to a full commit sha, or null. */
export async function resolveCommit(repository: Repository, ref: string): Promise<string | null> {
  try {
    const output = await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd: repository.directory,
    });
    return output.trim();
  } catch {
    return null;
  }
}

const commitFormat = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%cI", "%s", "%b"].join("%x1f") + "%x1e";

function commitFromFields(fields: Array<string>): Commit {
  return {
    sha: fields[0] ?? "",
    parents: (fields[1] ?? "").split(" ").filter((parent) => parent !== ""),
    authorName: fields[2] ?? "",
    authorEmail: fields[3] ?? "",
    authorDate: fields[4] ?? "",
    committerName: fields[5] ?? "",
    committerDate: fields[6] ?? "",
    subject: fields[7] ?? "",
    body: (fields[8] ?? "").trim(),
  };
}

/** Commits reachable from `sha`, newest first. */
export async function listCommits(
  repository: Repository,
  sha: string,
  options: { limit?: number; skip?: number } = {},
): Promise<Array<Commit>> {
  const output = await runGit(
    [
      "log",
      `--format=${commitFormat}`,
      `--max-count=${options.limit ?? 50}`,
      `--skip=${options.skip ?? 0}`,
      "--end-of-options",
      sha,
    ],
    { cwd: repository.directory },
  );
  return records(output).map(commitFromFields);
}

/**
 * One commit and what it changed. A merge commit shows its changes against
 * its first parent: what the merge brought into the branch.
 */
export async function getCommit(repository: Repository, sha: string): Promise<CommitWithDiff | null> {
  const resolved = await resolveCommit(repository, sha);
  if (resolved === null) return null;

  const metadata = await runGit(["log", "--max-count=1", `--format=${commitFormat}`, "--end-of-options", resolved], {
    cwd: repository.directory,
  });
  const fields = records(metadata)[0];
  if (fields === undefined) return null;

  const patch = await runGit(
    [
      "diff-tree",
      "--patch",
      "--no-commit-id",
      "--root",
      "--diff-merges=first-parent",
      "--find-renames",
      // Full object ids on the `index` lines, to read the files' contents with.
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      "--end-of-options",
      resolved,
    ],
    { cwd: repository.directory },
  );

  return { ...commitFromFields(fields), files: parseDiff(patch) };
}

export type ContainedBranch = {
  name: string;
  sha: string;
  /** How many commits `head` has on top of this branch's latest commit. */
  commitsSince: number;
};

/** The branches whose latest commit is part of `head`'s history, nearest first. */
export async function listContainedBranches(repository: Repository, head: string): Promise<Array<ContainedBranch>> {
  const output = await runGit(["for-each-ref", `--merged=${head}`, "--format=%(refname:lstrip=2)%1f%(objectname)%1e", "refs/heads"], {
    cwd: repository.directory,
  });
  const branches = records(output).map((fields) => ({ name: fields[0] ?? "", sha: fields[1] ?? "" }));
  const counted = await Promise.all(
    branches.map(async (branch) => {
      const count = await runGit(["rev-list", "--count", "--end-of-options", `${branch.sha}..${head}`], { cwd: repository.directory });
      return { ...branch, commitsSince: Number(count.trim()) };
    }),
  );
  return counted.sort((a, b) => a.commitsSince - b.commitsSince || a.name.localeCompare(b.name));
}

/**
 * One file's part of a diff: of a commit (against its first parent) or
 * between two commits. Both of a renamed file's paths are asked for, so the
 * rename is still found. Null when the file didn't change there.
 */
export async function getFileDiff(
  repository: Repository,
  range: { commit: string } | { from: string; to: string },
  paths: { path: string; oldPath: string | null },
): Promise<FileDiff | null> {
  const pathspec = paths.oldPath === null || paths.oldPath === paths.path ? [paths.path] : [paths.oldPath, paths.path];
  const options = ["--patch", "--find-renames", "--full-index", "--no-color", "--no-ext-diff"];
  const args =
    "commit" in range
      ? ["diff-tree", ...options, "--no-commit-id", "--root", "--diff-merges=first-parent", "--end-of-options", range.commit, "--", ...pathspec]
      : ["diff", ...options, "--end-of-options", range.from, range.to, "--", ...pathspec];
  const patch = await runGit(args, { cwd: repository.directory });
  return parseDiff(patch).find((file) => file.path === paths.path) ?? null;
}

export type Comparison = {
  /** The base and head commits, resolved. */
  base: string;
  head: string;
  /** Where head left base: what the changes are measured against. Null when they share no history. */
  mergeBase: string | null;
  /** The commits head adds on top of the merge base, newest first. */
  commits: Array<Commit>;
  /** How many commits base has that head doesn't: how far behind head is. */
  behind: number;
  /** Everything head changed since the merge base, as one diff. */
  files: Array<FileDiff>;
};

/**
 * What `head` changed relative to `base`, as a pull request shows it: the
 * diff from where head left base (their merge base) to head, so what base
 * did since doesn't show as head undoing it.
 */
export async function getComparison(repository: Repository, base: string, head: string): Promise<Comparison | null> {
  const [baseSha, headSha] = await Promise.all([resolveCommit(repository, base), resolveCommit(repository, head)]);
  if (baseSha === null || headSha === null) return null;

  const mergeBase = await runGit(["merge-base", "--end-of-options", baseSha, headSha], { cwd: repository.directory }).then(
    (output) => output.trim(),
    // Exits 1 when there is none: unrelated histories.
    () => null,
  );
  if (mergeBase === null) {
    return { base: baseSha, head: headSha, mergeBase: null, commits: [], behind: 0, files: [] };
  }

  const [log, behind, patch] = await Promise.all([
    runGit(["log", `--format=${commitFormat}`, "--max-count=500", "--end-of-options", `${mergeBase}..${headSha}`], { cwd: repository.directory }),
    runGit(["rev-list", "--count", "--end-of-options", `${headSha}..${baseSha}`], { cwd: repository.directory }),
    runGit(
      ["diff", "--patch", "--find-renames", "--full-index", "--no-color", "--no-ext-diff", "--end-of-options", mergeBase, headSha],
      { cwd: repository.directory },
    ),
  ]);

  return {
    base: baseSha,
    head: headSha,
    mergeBase,
    commits: records(log).map(commitFromFields),
    behind: Number(behind.trim()),
    files: parseDiff(patch),
  };
}

/** git's id for a tree with nothing in it: what a repository without commits compares with. */
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The branch checked out in a local repository's work tree, or null: a
 * GitHub repository or a bare one has no work tree, and a detached HEAD no branch.
 */
export async function checkedOutBranch(repository: Repository): Promise<string | null> {
  if (repository.source.kind !== "local") return null;
  const bare = await runGit(["rev-parse", "--is-bare-repository"], { cwd: repository.directory });
  if (bare.trim() === "true") return null;
  const head = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: repository.directory }).catch(() => "");
  const branch = head.trim().replace(/^refs\/heads\//, "");
  return branch === "" ? null : branch;
}

/**
 * How many files differ from the last commit in a local work tree: staged,
 * not staged, and new (but not ignored) ones. Cheap: nothing is read.
 */
export async function countWorkingChanges(repository: Repository): Promise<number> {
  // Without refreshing the index as it goes: that would take its lock, and git commands of yours could fail meanwhile.
  const status = await runGit(["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], { cwd: repository.directory });
  return status.split("\n").filter((line) => line !== "").length;
}

export type WorkingChanges = {
  /** The commit they're on top of; null in a repository without commits. */
  head: string | null;
  /** What the changes are measured against: `head`, or the empty tree. */
  base: string;
  /** The work tree as it was when asked, as a tree object. */
  tree: string;
  files: Array<FileDiff>;
};

/**
 * What changed in a local work tree since its last commit, staged or not,
 * new files included (ignored ones not): as a commit of everything would
 * show it, without making one. The work tree is added to a temporary copy of
 * the index and written as a tree: the repository's own index, branches and
 * files stay as they are; git only gains the new files' contents as loose
 * objects (which `git gc` removes in time), so they can be read like a commit's.
 */
export async function getWorkingChanges(repository: Repository): Promise<WorkingChanges> {
  const cwd = repository.directory;
  const head = await resolveCommit(repository, "HEAD");
  const index = (await runGit(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd })).trim();

  const temporary = await mkdtemp(join(tmpdir(), "room-index-"));
  let tree: string;
  try {
    const copy = join(temporary, "index");
    // No index yet (nothing ever staged): git starts an empty one.
    await copyFile(index, copy).catch(() => undefined);
    await runGit(["add", "--all"], { cwd, env: { GIT_INDEX_FILE: copy } });
    tree = (await runGit(["write-tree"], { cwd, env: { GIT_INDEX_FILE: copy } })).trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const base = head ?? emptyTree;
  const patch = await runGit(
    ["diff", "--patch", "--find-renames", "--full-index", "--no-color", "--no-ext-diff", "--end-of-options", base, tree],
    { cwd },
  );
  return { head, base, tree, files: parseDiff(patch) };
}

/** Splits `%x1f`-separated fields in `%x1e`-terminated records. */
function records(output: string): Array<Array<string>> {
  return output
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => record.split("\x1f"));
}
