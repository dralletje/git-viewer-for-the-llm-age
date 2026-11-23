import type { RepositorySource } from "@room/git";

/**
 * Which repositories this server shows. `room` starts it with
 * ROOM_REPOSITORIES set to the ones it was given: a JSON array of
 * RepositorySource, local paths already at their top folder (as
 * openRepository gives them). Any other repository is as if it didn't
 * exist. Unset (`room --all`, `pnpm dev`): every repository on this
 * machine, and any GitHub one git can clone.
 *
 * Null: all of them. Read once, when the server starts; a value that isn't
 * such a list stops it there, rather than showing everything.
 */
export const allowedRepositories: Array<RepositorySource> | null = readAllowed(process.env.ROOM_REPOSITORIES);

function readAllowed(value: string | undefined): Array<RepositorySource> | null {
  if (value === undefined) return null;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("ROOM_REPOSITORIES isn't a list of repositories.");
  return parsed.map((entry: unknown): RepositorySource => {
    if (typeof entry === "object" && entry !== null && "kind" in entry) {
      if (entry.kind === "local" && "path" in entry && typeof entry.path === "string" && entry.path.startsWith("/")) {
        return { kind: "local", path: entry.path };
      }
      if (entry.kind === "github" && "owner" in entry && "name" in entry && typeof entry.owner === "string" && typeof entry.name === "string") {
        return { kind: "github", owner: entry.owner, name: entry.name };
      }
    }
    throw new Error(`ROOM_REPOSITORIES has something that isn't a repository: ${JSON.stringify(entry)}`);
  });
}

/** This server shows this repository. A local one by its top folder exactly; a GitHub one by owner and name, in any case. */
export function isAllowed(source: RepositorySource): boolean {
  if (allowedRepositories === null) return true;
  return allowedRepositories.some((allowed) => {
    if (allowed.kind === "local" && source.kind === "local") return allowed.path === source.path;
    if (allowed.kind === "github" && source.kind === "github") {
      return allowed.owner.toLowerCase() === source.owner.toLowerCase() && allowed.name.toLowerCase() === source.name.toLowerCase();
    }
    return false;
  });
}
