import { spawn } from "node:child_process";
import type { Repository } from "#/repository.ts";
import { GitError, runGit } from "#/run-git.ts";

/** One file in a commit's tree. */
export type TreeFile = {
  path: string;
  /** Its blob's object id. */
  blob: string;
};

/**
 * Every file in a commit, in git's order: regular files and executables
 * (symbolic links and submodules aren't files to read). Reads trees only,
 * which a partial clone has: it fetches nothing.
 */
export async function listFiles(repository: Repository, commit: string): Promise<Array<TreeFile>> {
  const output = await runGit(["ls-tree", "-r", "-z", "--full-tree", "--format=%(objectmode) %(objectname) %(path)", "--end-of-options", commit], {
    cwd: repository.directory,
  });
  const files: Array<TreeFile> = [];
  for (const entry of output.split("\0")) {
    const match = /^(100644|100755) ([0-9a-f]+) (.+)$/s.exec(entry);
    if (match === null) continue;
    files.push({ path: match[3] ?? "", blob: match[2] ?? "" });
  }
  return files;
}

/**
 * Makes sure git has these blobs here: in a clone of GitHub without file
 * contents (`--filter=blob:none`), fetches the missing ones in one go. Left
 * to itself, git fetches a missing blob when it's read, one fetch per blob:
 * for a whole repository that's thousands. A local repository has them all.
 */
export async function fetchMissingBlobs(repository: Repository, commit: string, blobs: Array<string>): Promise<number> {
  if (repository.source.kind === "local" || blobs.length === 0) return 0;

  // The commit's objects git doesn't have, marked with "?". Listing them doesn't fetch them.
  const listing = await runGit(["rev-list", "--objects", "--no-walk", "--missing=print", "--end-of-options", commit], {
    cwd: repository.directory,
  });
  const missingHere = new Set(
    listing
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1).trim()),
  );
  const wanted = [...new Set(blobs)].filter((blob) => missingHere.has(blob));
  if (wanted.length === 0) return 0;

  // What git itself runs to fetch a missing object (promisor-remote.c), for all of them at once.
  const args = [
    "-c",
    "fetch.negotiationAlgorithm=noop",
    "fetch",
    "origin",
    "--no-tags",
    "--no-write-fetch-head",
    "--recurse-submodules=no",
    "--filter=blob:none",
    "--stdin",
  ];
  await new Promise<void>((resolve, reject) => {
    const git = spawn("git", args, {
      cwd: repository.directory,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const errors: Array<Buffer> = [];
    git.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    git.on("error", reject);
    git.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new GitError(args, Buffer.concat(errors).toString("utf8")));
    });
    git.stdin.end(wanted.join("\n") + "\n");
  });
  return wanted.length;
}
