import { validGithubRepository, type RepositorySource } from "@room/git";
import { isAllowed } from "#/access.server.ts";

/**
 * The repository the `$owner.$repo` params point at (see `repositoryPath`),
 * or null: also when this server doesn't show it (see access.server.ts), so
 * every page of it is a 404, as if it didn't exist.
 */
export function repositoryFromParams(owner: string, repo: string): RepositorySource | null {
  if (owner === "local" && repo.startsWith("/")) {
    const local: RepositorySource = { kind: "local", path: repo };
    return isAllowed(local) ? local : null;
  }
  const github = validGithubRepository(owner, repo);
  if (github === null) return null;
  const source: RepositorySource = { kind: "github", owner: github.owner, name: github.name };
  return isAllowed(source) ? source : null;
}
