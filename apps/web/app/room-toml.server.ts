import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles, readBlobs, type Repository } from "@room/git";

/**
 * The text of the `.room.toml` at the repository's root, as it is now: a
 * local repository's work tree (so it can be edited and seen at once), a
 * GitHub one's default branch. Not the commit's own: it describes the
 * repository, so it holds for every commit shown, also older ones and
 * other branches'. Null: there's none.
 */
export async function readRoomToml(repository: Repository): Promise<string | null> {
  if (repository.source.kind === "local") {
    return readFile(join(repository.source.path, ".room.toml"), "utf-8").catch(() => null);
  }
  const file = (await listFiles(repository, "HEAD").catch(() => [])).find((entry) => entry.path === ".room.toml");
  if (file === undefined) return null;
  return (await readBlobs(repository, [file.blob])).get(file.blob) ?? null;
}
