import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedOutBranch, countWorkingChanges, getWorkingChanges, openRepository } from "#/repository.ts";
import { runGit } from "#/run-git.ts";

test("current changes: staged, not staged and new files, without touching the index", async () => {
  const folder = await mkdtemp(join(tmpdir(), "room-working-"));
  try {
    const git = (args: Array<string>) => runGit(["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: folder });
    await git(["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(folder, "staged.ts"), "export const a = 1;\n");
    await writeFile(join(folder, "edited.ts"), "export const b = 1;\n");
    await writeFile(join(folder, ".gitignore"), "ignored.ts\n");
    await git(["add", "--all"]);
    await git(["commit", "--quiet", "--message=first"]);

    await writeFile(join(folder, "staged.ts"), "export const a = 2;\n");
    await git(["add", "staged.ts"]);
    await writeFile(join(folder, "edited.ts"), "export const b = 2;\n");
    await writeFile(join(folder, "new.ts"), "export const c = 3;\n");
    await writeFile(join(folder, "ignored.ts"), "export const d = 4;\n");
    const indexBefore = await readFile(join(folder, ".git", "index"));

    const repository = await openRepository({ kind: "local", path: folder });
    assert.equal(await checkedOutBranch(repository), "main");
    assert.equal(await countWorkingChanges(repository), 3);

    const changes = await getWorkingChanges(repository);
    assert.deepEqual(changes.files.map((file) => file.path).sort(), ["edited.ts", "new.ts", "staged.ts"]);
    assert.equal(changes.head, (await runGit(["rev-parse", "HEAD"], { cwd: folder })).trim());
    // The repository's own index is as it was: only staged.ts staged.
    assert.deepEqual(await readFile(join(folder, ".git", "index")), indexBefore);
    assert.equal((await git(["diff", "--cached", "--name-only"])).trim(), "staged.ts");
    // The new contents can be read like a commit's.
    const added = changes.files.find((file) => file.path === "new.ts");
    assert.equal((await git(["cat-file", "blob", added?.newBlob ?? ""])).toString(), "export const c = 3;\n");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
