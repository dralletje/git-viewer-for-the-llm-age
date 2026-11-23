import { spawn } from "node:child_process";
import type { Repository } from "#/repository.ts";
import { GitError } from "#/run-git.ts";

/**
 * The contents of many blobs in one `git cat-file --batch`, as text: a map
 * from object id to contents. Ids git doesn't have are left out. In a
 * partial clone the blobs a diff showed are already there: git fetched them
 * to make the diff.
 */
export function readBlobs(repository: Repository, ids: Array<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => /^[0-9a-f]{4,64}$/.test(id));
  if (unique.length === 0) return Promise.resolve(new Map());

  return new Promise((resolve, reject) => {
    const git = spawn("git", ["cat-file", "--batch"], {
      cwd: repository.directory,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const chunks: Array<Buffer> = [];
    const errors: Array<Buffer> = [];
    git.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    git.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    git.on("error", reject);
    git.on("close", (code) => {
      if (code !== 0) {
        reject(new GitError(["cat-file", "--batch"], Buffer.concat(errors).toString("utf8")));
        return;
      }
      resolve(parseBatch(Buffer.concat(chunks)));
    });
    git.stdin.end(unique.join("\n") + "\n");
  });
}

/** `<id> <type> <size>\n<contents>\n` per object, or `<id> missing\n`. */
function parseBatch(output: Buffer): Map<string, string> {
  const blobs = new Map<string, string>();
  const decoder = new TextDecoder("utf-8");
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    offset = headerEnd + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") {
      blobs.set(header[0] ?? "", decoder.decode(output.subarray(offset, offset + size)));
    }
    offset += size + 1;
  }
  return blobs;
}
