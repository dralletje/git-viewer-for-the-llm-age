import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCommit, openRepository, resolveCommit } from "@room/git";
import { commitReach } from "#/reach.server.ts";

/** git in the test's own repository, as a fixed user: the machine may have no identity set. */
function runGitForTest(folder: string, args: Array<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: folder, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`git ${args.join(" ")}: ${stderr}`));
      else resolve(stdout);
    });
  });
}

test("a commit that adds an import to old code: the origin isn't new, the import is", async () => {
  const folder = await mkdtemp(join(tmpdir(), "room-reach-"));
  try {
    const git = (args: Array<string>) => runGitForTest(folder, args);
    await git(["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(folder, "db.ts"), 'import { Pool } from "pg";\nexport const pool = new Pool();\n');
    await writeFile(join(folder, "app.ts"), "export const handler = () => 1;\n");
    await git(["add", "--all"]);
    await git(["commit", "--quiet", "--message=first"]);
    await writeFile(join(folder, "app.ts"), 'import { pool } from "./db.ts";\nexport const handler = () => pool.query("select 1");\n');
    await git(["commit", "--quiet", "--all", "--message=second"]);

    const repository = await openRepository({ kind: "local", path: folder });
    const commit = await getCommit(repository, (await resolveCommit(repository, "HEAD")) ?? "");
    assert.ok(commit !== null);
    const reach = await commitReach(repository, commit);
    assert.equal(reach.status, "scanned");
    if (reach.status !== "scanned") return;

    assert.equal(reach.gained.length, 1);
    const group = reach.gained[0];
    assert.equal(group?.capability, "database");
    assert.deepEqual(group?.origin, { path: "db.ts", line: 1, via: "pg", name: "Pool", isNew: false });
    assert.deepEqual(group?.newImports, [{ path: "app.ts", line: 1, via: "./db.ts", name: "pool" }]);
    assert.deepEqual(
      reach.files["app.ts"]?.map((entry) => [entry.capability, entry.isNew, entry.chain.map((step) => step.isNew)]),
      [["database", true, [true, false]]],
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
