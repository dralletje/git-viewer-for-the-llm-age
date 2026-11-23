import { homedir } from "node:os";
import { join } from "node:path";
import { redirect } from "react-router";
import { GitError, describeLocalRepository, findLocalRepositories, openRepository, parseGithubRepository, sortByLastCommit, type RepositorySource } from "@room/git";
import { allowedRepositories, isAllowed } from "#/access.server.ts";
import { repositoryLabel, repositoryPath } from "#/paths.ts";
import type { Route } from "./+types/route.ts";
import { GithubRepositoryList, HomePage, LocalRepositoryList, RepositoryForm, RoomError } from "./components.tsx";

export const meta: Route.MetaFunction = () => [{ title: "Behind the Room" }];

export async function loader({ request }: Route.LoaderArgs) {
  const input = new URL(request.url).searchParams.get("repository")?.trim() ?? null;

  // A room started with some repositories (see access.server.ts): those, and nothing else.
  if (allowedRepositories !== null) {
    const local = await Promise.all(
      allowedRepositories.flatMap((source) => (source.kind === "local" ? [describeLocalRepository(source.path)] : [])),
    );
    const github = allowedRepositories.filter((source) => source.kind === "github");
    const shown = {
      restricted: true as const,
      repositoriesFolder: null,
      localRepositories: sortByLastCommit(local).map((repository) => ({ ...repository, href: repositoryPath({ kind: "local", path: repository.path }) })),
      githubRepositories: github.map((source) => ({ label: repositoryLabel(source), href: repositoryPath(source) })),
    };
    if (input === null) return { ...shown, input: "", error: null };

    // Whether it's missing, not a repository or not shown here: the same answer.
    const notShown = { ...shown, input: input, error: `${input} isn't one of the repositories this room shows.` };
    const source = await sourceOf(input);
    if (source === null || source === "invalid" || !isAllowed(source)) return notShown;
    throw redirect(repositoryPath(source));
  }

  // The repositories in ~/repos, ready to open with one click.
  const repositoriesFolder = join(homedir(), "repos");
  const local = await findLocalRepositories(repositoriesFolder);
  const all = {
    restricted: false as const,
    repositoriesFolder: repositoriesFolder,
    localRepositories: local.map((repository) => ({ ...repository, href: repositoryPath({ kind: "local", path: repository.path }) })),
    githubRepositories: [],
  };
  if (input === null) return { ...all, input: "", error: null };

  const source = await sourceOf(input);
  if (source === null) {
    return { ...all, input: input, error: `${input} isn't a git repository on this machine.` };
  }
  if (source === "invalid") {
    return { ...all, input: input, error: "That isn't a repository. Try owner/name, a github.com link, or a path like ~/repos/project." };
  }
  throw redirect(repositoryPath(source));
}

/**
 * What was typed: a path on this machine (to its repository's top folder,
 * when it points inside one), or a GitHub repository. Null: a path that
 * isn't in a git repository; "invalid": neither.
 */
async function sourceOf(input: string): Promise<RepositorySource | null | "invalid"> {
  if (input.startsWith("/") || input === "~" || input.startsWith("~/")) {
    const path = input.startsWith("~") ? join(homedir(), input.slice(1)) : input;
    try {
      return (await openRepository({ kind: "local", path: path })).source;
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }
  const github = parseGithubRepository(input);
  if (github === null) return "invalid";
  return { kind: "github", owner: github.owner, name: github.name };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  if (loaderData.restricted) {
    return (
      <HomePage restricted>
        {loaderData.error !== null && <RoomError message={loaderData.error} />}
        <LocalRepositoryList folder={null} repositories={loaderData.localRepositories} />
        <GithubRepositoryList repositories={loaderData.githubRepositories} />
      </HomePage>
    );
  }
  return (
    <HomePage restricted={false}>
      <RepositoryForm defaultValue={loaderData.input} error={loaderData.error} />
      <LocalRepositoryList folder={loaderData.repositoriesFolder} repositories={loaderData.localRepositories} />
    </HomePage>
  );
}
